import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell, Notification } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import type { DriveState, Game, RemoveOptions, RunStatus, Settings } from '../shared/types'
import { artPath, gridArt, gridSearch, importArt } from './art'
import { DriveWatcher, ejectDevice, findDiscSet, listDrives } from './drive'
import { heroicImport, heroicPreview } from './heroic'
import { gameForDisc, Launcher } from './launcher'
import { logDir } from './paths'
import { removalInfo, removeGame } from './remove'
import { runnerInfo } from './runners'
import { store } from './store'

app.setName('DiscPlay')
app.setPath('userData', process.env.DISCPLAY_DATA || path.join(app.getPath('appData'), 'discplay'))
protocol.registerSchemesAsPrivileged([
  { scheme: 'dpart', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
])

// One DiscPlay per profile: a second start just brings the window back (two would fight over the
// drive and could start two games in one prefix). DISCPLAY_PLAN only prints, so it may run alongside.
const primary = !!process.env.DISCPLAY_PLAN || app.requestSingleInstanceLock()
if (!primary) app.exit(0)

let win: BrowserWindow | null = null
/** The window was closed while a game ran: DiscPlay stays in the background and quits when it ends. */
let quitWhenIdle = false
let quitting = false
const drive = new DriveWatcher(store.getSettings().driveDevice)
const launcher = new Launcher(drive)

function send(channel: string, ...args: unknown[]) {
  win?.webContents.send(channel, ...args)
}

function createWindow() {
  const settings = store.getSettings()
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    frame: false,
    backgroundColor: settings.theme === 'midnight' ? '#070b14' : '#e9edf2',
    fullscreen: settings.startFullscreen,
    title: 'DiscPlay',
    icon: path.join(__dirname, '../build/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  })
  const devUrl = process.env.DISCPLAY_DEV_URL
  if (devUrl) win.loadURL(devUrl)
  else win.loadFile(path.join(__dirname, '../dist/index.html'))
  win.on('close', (e) => {
    if (quitting) return
    const what = launcher.activity()
    if (!what) return
    e.preventDefault()
    askBeforeClosing(what)
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Dev aid: DISCPLAY_SCREENSHOT=/path.png captures the window after a delay and quits.
  if (process.env.DISCPLAY_DEBUG) win.webContents.on('console-message', (e: any) => console.log('[ui]', e.message))
  const shot = process.env.DISCPLAY_SCREENSHOT
  if (shot) {
    win.webContents.once('did-finish-load', () => {
      const delay = Number(process.env.DISCPLAY_SCREENSHOT_DELAY || 3500)
      if (process.env.DISCPLAY_SCREENSHOT_JS) setTimeout(() => win!.webContents.executeJavaScript(process.env.DISCPLAY_SCREENSHOT_JS!), 1200)
      setTimeout(async () => {
        const img = await win!.webContents.capturePage()
        fs.writeFileSync(shot, img.toPNG())
        app.quit()
      }, delay)
    })
  }
}

/** Closing while something runs: never leave a game or installer without its disc and bookkeeping. */
async function askBeforeClosing(what: 'game' | 'install' | 'waiting') {
  if (!win) return
  if (what === 'waiting') {
    await launcher.stop()
    return win.close()
  }
  const status = launcher.status
  const title = 'gameId' in status ? store.get(status.gameId)?.title : undefined
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'DiscPlay',
    message: what === 'install' ? 'An installer is still running.' : `${title ?? 'A game'} is still running.`,
    detail:
      what === 'install'
        ? 'Closing DiscPlay stops the installer and removes what it installed so far.'
        : 'DiscPlay can keep running in the background and close by itself when the game ends, so its disc is released and the play time is saved.',
    buttons: what === 'install' ? ['Stop installer and close', 'Cancel'] : ['Keep playing, close later', 'Stop the game', 'Cancel'],
    defaultId: 0,
    cancelId: what === 'install' ? 1 : 2,
  })
  if (what === 'install') {
    if (r.response !== 0) return
    quitWhenIdle = true
    await launcher.stop()
    return
  }
  if (r.response === 0) {
    quitWhenIdle = true
    win.hide()
  } else if (r.response === 1) {
    quitWhenIdle = true
    await launcher.stop()
  }
}

function notifyDisc(d: DriveState) {
  if (!win || win.isFocused()) return
  const game = gameForDisc(d)
  if (game && Notification.isSupported())
    new Notification({ title: 'DiscPlay', body: `${game.title} is in the drive – ready to play.`, silent: true }).show()
}

function registerIpc() {
  ipcMain.handle('library:get', () => store.library())
  ipcMain.handle('library:save', (_e, g: Game) => {
    const saved = store.save(g)
    send('library', store.library())
    launcher.libraryChanged()
    return saved
  })
  ipcMain.handle('library:removalInfo', (_e, id: string) => removalInfo(id))
  ipcMain.handle('library:delete', (_e, id: string, opts?: RemoveOptions) => {
    const st = launcher.status
    const ids = [id, ...(opts?.addons ? removalInfo(id).addonGames.map((g) => g.id) : [])]
    if (launcher.activity() && 'gameId' in st && ids.includes(st.gameId)) throw new Error('Stop the game before removing it.')
    if (opts?.prefix && launcher.activity()) throw new Error('Wait until nothing is running before deleting a Windows environment.')
    const removed = removeGame(id, opts)
    send('library', store.library())
    return removed
  })
  ipcMain.handle('settings:get', () => store.getSettings())
  ipcMain.handle('settings:save', (_e, s: Settings) => {
    const saved = store.saveSettings(s)
    drive.setDevice(saved.driveDevice)
    return saved
  })
  ipcMain.handle('runners:get', () => runnerInfo())
  ipcMain.handle('drive:get', () => drive.state)
  ipcMain.handle('drive:list', () => listDrives())
  ipcMain.handle('drive:eject', async () => {
    await ejectDevice(drive.device)
    drive.soon(800)
  })
  ipcMain.handle('game:launch', (_e, id: string) => {
    const g = store.get(id)
    if (!g) throw new Error('Unknown game')
    launcher.launch(g) // status is reported through events
  })
  ipcMain.handle('game:stop', () => launcher.stop())
  ipcMain.handle('game:cancelWait', () => launcher.cancelWait())
  ipcMain.handle('game:status', () => launcher.status)
  ipcMain.handle('game:log', (_e, id: string) => {
    try {
      return fs.readFileSync(path.join(logDir(), `${id}.log`), 'utf8').slice(-60000)
    } catch {
      return 'No log yet – launch the game first.'
    }
  })
  ipcMain.handle('heroic:preview', () => heroicPreview())
  ipcMain.handle('heroic:import', async (_e, apps: string[]) => {
    const n = await heroicImport(apps)
    send('library', store.library())
    return n
  })
  ipcMain.handle('dialog:pick', async (_e, o: { title: string; filters?: Electron.FileFilter[]; directory?: boolean; defaultPath?: string }) => {
    const r = await dialog.showOpenDialog(win!, {
      title: o.title,
      defaultPath: o.defaultPath,
      filters: o.filters,
      properties: [o.directory ? 'openDirectory' : 'openFile', 'showHiddenFiles'],
    })
    return r.canceled ? undefined : r.filePaths[0]
  })
  ipcMain.handle('art:import', (_e, id: string, kind: keyof Game['art'], src: string) => importArt(id, kind, src))
  ipcMain.handle('art:search', (_e, term: string) => gridSearch(term))
  ipcMain.handle('art:list', (_e, gid: number, kind: keyof Game['art']) => gridArt(gid, kind))
  ipcMain.handle('install:run', async (_e, req) => {
    const r = await launcher.install(req, (line) => send('install-log', line))
    return r
  })
  ipcMain.handle('install:discard', (_e, prefix: string) => launcher.discardInstall(prefix))
  ipcMain.handle('disc:set', (_e, file: string) => findDiscSet(file))
  ipcMain.handle('disc:session', () => launcher.discSession())
  ipcMain.handle('disc:swap', (_e, i: number) => launcher.swapDisc(i))
  ipcMain.handle('disc:eject', () => launcher.ejectSessionDisc())
  ipcMain.handle('shell:open', (_e, p: string) => shell.openPath(p))
  ipcMain.handle('window', (_e, a: string) => {
    if (!win) return
    if (a === 'minimize') win.minimize()
    else if (a === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize()
    else if (a === 'fullscreen') win.setFullScreen(!win.isFullScreen())
    else if (a === 'close') win.close()
  })
}

app.on('second-instance', () => {
  if (!win) return
  quitWhenIdle = false
  win.show()
  if (win.isMinimized()) win.restore()
  win.focus()
})

app.whenReady().then(async () => {
  if (!primary) return
  // Dry run: DISCPLAY_PLAN="<title words>" prints the launch command for a game and quits.
  if (process.env.DISCPLAY_PLAN) {
    const q = process.env.DISCPLAY_PLAN.toLowerCase()
    const g = store.library().find((x) => x.title.toLowerCase().includes(q))
    if (!g) console.log('no game matching', q)
    else {
      const p = launcher.plan(g, g.executable, g.args)
      console.log(JSON.stringify({ cmd: p.cmd, cwd: p.cwd, WINEPREFIX: p.env.WINEPREFIX, PROTONPATH: p.env.PROTONPATH, GAMEID: p.env.GAMEID, disc: g.disc }, null, 2))
    }
    app.exit(0)
    return
  }
  protocol.handle('dpart', (req) => {
    const name = decodeURIComponent(new URL(req.url).pathname.replace(/^\//, ''))
    const file = artPath(name)
    if (!file) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(file).toString())
  })
  registerIpc()
  createWindow()
  drive.on('change', (d: DriveState, prev: DriveState) => {
    send('drive', d)
    if (d.hasDisc && (!prev.hasDisc || prev.label !== d.label)) notifyDisc(d)
  })
  drive.start()
  let wasPlaying = false
  launcher.on('status', (s: RunStatus) => {
    send('status', s)
    // A game ended: come back to the front, so a gamepad player isn't left at the desktop.
    const playing = s.state === 'running'
    if (wasPlaying && !playing && !quitWhenIdle && win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.moveTop()
      win.focus()
    }
    wasPlaying = playing
    if (quitWhenIdle && !launcher.activity()) {
      quitting = true
      app.quit()
    }
  })
  launcher.on('library', () => send('library', store.library()))
  launcher.on('disc', (info) => send('disc-session', info))
  launcher.on('notice', (text) => send('notice', text))
  // A game from an earlier DiscPlay that was closed or crashed mid-game: pick it up, or clean up after it.
  await launcher.recover()
})

app.on('before-quit', () => {
  quitting = true
})

app.on('window-all-closed', () => {
  drive.stop()
  app.quit()
})
