import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell, Notification } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import type { DriveState, Game, Settings } from '../shared/types'
import { artPath, gridArt, gridSearch, importArt } from './art'
import { DriveWatcher, ejectDevice, findDiscSet } from './drive'
import { heroicImport, heroicPreview } from './heroic'
import { gameForDisc, Launcher } from './launcher'
import { logDir } from './paths'
import { runnerInfo } from './runners'
import { store } from './store'

app.setName('DiscPlay')
app.setPath('userData', process.env.DISCPLAY_DATA || path.join(app.getPath('appData'), 'discplay'))
protocol.registerSchemesAsPrivileged([
  { scheme: 'dpart', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
])

let win: BrowserWindow | null = null
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
  ipcMain.handle('library:delete', (_e, id: string) => {
    store.remove(id)
    send('library', store.library())
  })
  ipcMain.handle('settings:get', () => store.getSettings())
  ipcMain.handle('settings:save', (_e, s: Settings) => {
    const saved = store.saveSettings(s)
    drive.setDevice(saved.driveDevice)
    return saved
  })
  ipcMain.handle('runners:get', () => runnerInfo())
  ipcMain.handle('drive:get', () => drive.state)
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

app.whenReady().then(() => {
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
  launcher.on('status', (s) => send('status', s))
  launcher.on('library', () => send('library', store.library()))
  launcher.on('disc', (info) => send('disc-session', info))
})

app.on('window-all-closed', () => {
  drive.stop()
  app.quit()
})
