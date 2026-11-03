import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { DiscSessionInfo, DriveState, ExeCandidate, Game, InstallRequest, InstallResult, RunStatus } from '../shared/types'
import { DiscSession, type SavedMount } from './discs'
import { DriveWatcher, inspectDisc } from './drive'
import { releaseLeftover } from './images'
import { bootId, leftoverLoops } from './loops'
import { configDir, logDir } from './paths'
import { listExes, looksLikeGameExe, prefixReady, realPrefix, restoreDriveLinks, type DriveLinks } from './prefix'
import { findUmu, protonWineserver, resolveProton, umuCommand } from './runners'
import { store } from './store'
import { childEnv, isExecutable, run, sleep, slug, splitCommand, which } from './util'

function labelMatches(game: Game, drive: DriveState) {
  if (!drive.hasDisc) return false
  // Labels can be added while a game waits or runs (a disc linked from the UI), so read the saved game.
  game = store.get(game.id) ?? game
  if (!game.disc.labels.length) return true
  const have = (drive.label ?? '').trim().toLowerCase()
  return game.disc.labels.some((l) => l.trim().toLowerCase() === have)
}

/** All images of a disc spec, disc 1 first (older libraries only have imagePath). */
export function discImages(disc: Game['disc']) {
  return disc.images?.length ? disc.images : disc.imagePath ? [disc.imagePath] : []
}

export function gameForDisc(drive: DriveState) {
  if (!drive.hasDisc || !drive.label) return undefined
  const label = drive.label.trim().toLowerCase()
  return store.library().find((g) => g.disc.labels.some((l) => l.trim().toLowerCase() === label))
}

interface Plan {
  cmd: string[]
  env: NodeJS.ProcessEnv
  cwd: string
}

type WineSetup = Pick<Game, 'runner' | 'prefix' | 'protonPath' | 'wineBinary'>

/** The wineserver of a game's Wine/Proton build, used to wait for or kill everything in its prefix. */
function wineserverFor(game: WineSetup) {
  if (game.runner === 'umu') return protonWineserver(game.protonPath)
  if (game.wineBinary) {
    const ws = path.join(path.dirname(game.wineBinary), 'wineserver')
    if (isExecutable(ws)) return ws
  }
  return which('wineserver')
}

/** Whether any process of a process group is still alive. */
function groupAlive(pgid: number) {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** A running game, saved to disk so a restarted DiscPlay can pick it up again or clean up after it. */
interface SavedRun {
  gameId: string
  /** Process group of the launch command (it is started detached, so it leads its own group) */
  pgid: number
  startedAt: number
  /** Updated every 30 s while the game runs; counts as the end time if DiscPlay died with the game */
  lastSeen: number
  boot: string
  disc?: { kind: 'drive' | 'image'; mounts: SavedMount[]; current: number; original?: DriveLinks }
}

const runFile = () => path.join(configDir(), 'running.json')

function readRun(): SavedRun | undefined {
  try {
    return JSON.parse(fs.readFileSync(runFile(), 'utf8')) as SavedRun
  } catch {
    return undefined
  }
}

function writeRun(r?: SavedRun) {
  try {
    if (r) fs.writeFileSync(runFile(), JSON.stringify(r, null, 2))
    else fs.rmSync(runFile(), { force: true })
  } catch {}
}

interface ActiveRun {
  game: Game
  pgid?: number
  startedAt: number
  exitCode?: number | null
  heartbeat: NodeJS.Timeout
  settling?: Promise<void>
}

/** A prefix name that isn't taken yet: "Game", or "Game 2", "Game 3"… when an earlier install left one. */
function freePrefix(p: string) {
  const free = (q: string) => !fs.existsSync(q) || isEmptyDir(q)
  if (free(p)) return p
  for (let n = 2; ; n++) if (free(`${p} ${n}`)) return `${p} ${n}`
}

function isEmptyDir(p: string) {
  try {
    return fs.readdirSync(p).length === 0
  } catch {
    return false
  }
}

export class Launcher extends EventEmitter {
  status: RunStatus = { state: 'idle' }
  private active?: ActiveRun
  private cancelWaiting?: () => void
  private recheckDisc?: () => void
  private abortInstall?: () => Promise<void>
  private installPgid?: number
  private cleanup: (() => Promise<void>)[] = []
  private session?: DiscSession
  /** Fresh prefixes made by an install that no game uses yet. The install dialog may throw them away. */
  private discardable = new Map<string, WineSetup>()

  constructor(private drive: DriveWatcher) {
    super()
  }

  private set(s: RunStatus) {
    this.status = s
    this.emit('status', s)
  }

  discSession(): DiscSessionInfo | null {
    return this.session?.info() ?? null
  }

  swapDisc(index: number) {
    if (!this.session) throw new Error('Nothing is using a disc right now.')
    return this.session.useImage(index)
  }

  ejectSessionDisc() {
    if (!this.session) throw new Error('Nothing is using a disc right now.')
    return this.session.eject()
  }

  /** Start a disc session; it is closed with the other cleanup steps. */
  private openSession(session: DiscSession) {
    this.session = session
    const onChange = (info: DiscSessionInfo) => {
      this.emit('disc', info)
      this.saveRun()
    }
    session.on('change', onChange)
    this.cleanup.push(async () => {
      session.off('change', onChange)
      await session.close()
      if (this.session === session) {
        this.session = undefined
        this.emit('disc', null)
      }
    })
    this.emit('disc', session.info())
    return session
  }

  busy() {
    return this.status.state === 'preparing' || this.status.state === 'running' || this.status.state === 'waiting-disc'
  }

  /** What is going on, for the quit question: a game, an installer, or nothing. */
  activity(): 'game' | 'install' | 'waiting' | undefined {
    if (this.abortInstall) return 'install'
    if (this.status.state === 'waiting-disc') return 'waiting'
    if (this.active || this.busy()) return 'game'
  }

  /** Resolve how to start a program in this game's environment. */
  plan(game: Game, exe: string, args: string[]): Plan {
    const env = childEnv(game.env)
    let cmd: string[]
    if (game.runner === 'native') {
      cmd = [exe, ...args]
    } else if (game.runner === 'wine') {
      if (game.prefix) env.WINEPREFIX = realPrefix(game.prefix)
      cmd = [game.wineBinary || which('wine') || 'wine', exe, ...args]
    } else {
      const umu = findUmu()
      if (!umu) throw new Error('umu-launcher was not found. Install umu-launcher (or Heroic, which ships it).')
      const proton = resolveProton(game.protonPath).path
      if (!proton)
        throw new Error(
          game.protonPath
            ? `${path.basename(game.protonPath)} is no longer installed and no other Proton version was found. Install GE-Proton (e.g. with ProtonUp-Qt).`
            : 'No Proton version found. Install GE-Proton (e.g. with ProtonUp-Qt).',
        )
      if (game.prefix) env.WINEPREFIX = game.prefix
      env.PROTONPATH = proton
      env.GAMEID ??= 'umu-default'
      env.STORE ??= 'none'
      cmd = [...umuCommand(umu), exe, ...args]
    }
    if (game.wrapper?.trim()) cmd = [...splitCommand(game.wrapper), ...cmd]
    const cwd = game.workingDir || (path.isAbsolute(exe) ? path.dirname(exe) : process.env.HOME || '/')
    return { cmd, env, cwd: fs.existsSync(cwd) ? cwd : process.env.HOME || '/' }
  }

  /**
   * Check that everything the game needs is still there before anything is mounted, so a moved
   * program, a deleted prefix or an unplugged drive gives a clear message instead of a cryptic
   * Wine error. Returns notes for problems DiscPlay works around.
   */
  private preflight(game: Game): string[] {
    const notes: string[] = []
    const exe = game.executable
    if (!exe) throw new Error('No program is set for this game. Choose it in the editor.')
    if (path.isAbsolute(exe) && !fs.existsSync(exe))
      throw new Error(`The game's program is missing: ${exe}. It may have been moved or uninstalled – choose it again in the editor.`)
    if (game.runner === 'native' && path.isAbsolute(exe) && !isExecutable(exe))
      throw new Error(`${path.basename(exe)} is not executable. Make it executable (chmod +x) or check the runner in the editor.`)
    if (game.runner !== 'native' && game.prefix && !fs.existsSync(game.prefix))
      throw new Error(`The game's Wine prefix is missing: ${game.prefix}. If it is on another drive, make sure that drive is mounted.`)
    if (game.runner === 'wine' && game.wineBinary && !isExecutable(game.wineBinary))
      throw new Error(`The Wine build set for this game is missing: ${game.wineBinary}`)
    if (game.runner === 'umu') {
      const note = resolveProton(game.protonPath).note
      if (note) notes.push(note)
    }
    const wrapper = game.wrapper?.trim() ? splitCommand(game.wrapper)[0] : undefined
    if (wrapper && !wrapper.includes('=')) {
      const found = wrapper.includes('/') ? fs.existsSync(wrapper) : !!which(wrapper)
      if (!found) throw new Error(`The wrapper command is missing: ${wrapper}. Fix or clear it in the editor.`)
    }
    if (game.disc.source === 'image') {
      const images = discImages(game.disc)
      if (!images.length) throw new Error('No disc image is set for this game. Choose it in the editor.')
      if (!fs.existsSync(images[0]))
        throw new Error(`The disc image is missing: ${images[0]}. If it is on an external drive, make sure that drive is plugged in and mounted.`)
      const gone = images.slice(1).filter((f) => !fs.existsSync(f))
      if (gone.length) notes.push(`Disc image${gone.length > 1 ? 's' : ''} not found: ${gone.map((f) => path.basename(f)).join(', ')}. You can't swap to ${gone.length > 1 ? 'them' : 'it'} until ${gone.length > 1 ? 'they are' : 'it is'} back.`)
    }
    return notes
  }

  /** Wait until the drive holds this game's disc. Resolves false when cancelled. */
  private waitForDisc(game: Game) {
    return new Promise<boolean>((resolve) => {
      const check = (d: DriveState) => {
        if (labelMatches(game, d)) done(true)
        else this.set({ state: 'waiting-disc', gameId: game.id, label: game.disc.labels[0], found: d.hasDisc ? d.label : undefined })
      }
      const done = (ok: boolean) => {
        this.drive.off('change', check)
        this.cancelWaiting = undefined
        this.recheckDisc = undefined
        resolve(ok)
      }
      this.cancelWaiting = () => done(false)
      this.recheckDisc = () => check(this.drive.state)
      this.drive.on('change', check)
      check(this.drive.state)
    })
  }

  private driveSession(game: Game) {
    const prefix = game.runner !== 'native' ? game.prefix : undefined
    // Follow disc swaps for the whole session: the game's own discs, or any disc no other game claims
    // (e.g. disc 2 of a set whose label was never recorded).
    return new DiscSession(this.drive, {
      owner: game.id,
      prefix,
      letter: game.disc.letter || 'd',
      accept: (d) => labelMatches(game, d) || !gameForDisc(d),
    })
  }

  /**
   * Mount the game's disc (physical or image) and point its Wine drive letter at it. The disc stays
   * followed while the game runs, so multi-disc games can ask for another disc.
   */
  private async prepareDisc(game: Game) {
    const { disc } = game
    const prefix = game.runner !== 'native' ? game.prefix : undefined
    const letter = disc.letter || 'd'
    const images = discImages(disc)
    if (disc.source === 'image' && images.length) {
      this.set({ state: 'preparing', gameId: game.id, message: 'Mounting disc image…' })
      const session = this.openSession(
        new DiscSession(
          null,
          {
            owner: game.id,
            prefix,
            letter,
            progress: (message) => this.set({ state: 'preparing', gameId: game.id, message }),
            notice: (text) => this.emit('notice', text),
          },
          images,
        ),
      )
      await session.useImage(0)
      this.set({ state: 'preparing', gameId: game.id, message: 'Starting…' })
      return
    }
    if (disc.source !== 'drive') return
    await this.drive.refresh()
    if (!labelMatches(game, this.drive.state)) {
      if (disc.required) {
        const ok = await this.waitForDisc(game)
        if (!ok) throw new Cancelled()
      }
    }
    const session = this.openSession(this.driveSession(game))
    session.follow()
    if (!labelMatches(game, this.drive.state)) return
    this.set({ state: 'preparing', gameId: game.id, message: 'Spinning up the disc…' })
    const mp = await session.useDrive()
    if (!mp && disc.required) throw new Error('The disc could not be mounted.')
  }

  async launch(game: Game) {
    if (this.busy()) throw new Error('A game is already running.')
    this.cleanup = []
    this.set({ state: 'preparing', gameId: game.id, message: 'Getting ready…' })
    try {
      for (const note of this.preflight(game)) this.emit('notice', note)
      await this.prepareDisc(game)
      const p = this.plan(game, game.executable, game.args)
      const logFile = path.join(logDir(), `${game.id}.log`)
      const out = fs.openSync(logFile, 'w')
      fs.writeSync(out, `DiscPlay launch ${new Date().toISOString()}\n`)
      fs.writeSync(out, `cwd: ${p.cwd}\ncommand: ${JSON.stringify(p.cmd)}\n`)
      for (const k of ['WINEPREFIX', 'PROTONPATH', 'GAMEID']) if (p.env[k]) fs.writeSync(out, `${k}=${p.env[k]}\n`)
      fs.writeSync(out, '\n')
      const startedAt = Date.now()
      // Detached: the game leads its own process group, which outlives DiscPlay if it is closed.
      const child = spawn(p.cmd[0], p.cmd.slice(1), { cwd: p.cwd, env: p.env, detached: true, stdio: ['ignore', out, out] })
      fs.closeSync(out)
      const a = this.track(game, startedAt, child.pid)
      child.once('error', (e) => this.end(a, e.message))
      child.once('exit', (code) => {
        a.exitCode = code
        this.settle(a)
      })
      this.set({ state: 'running', gameId: game.id, pid: child.pid, startedAt })
      store.save({ ...(store.get(game.id) ?? game), lastPlayed: startedAt })
      this.emit('library')
    } catch (e) {
      await this.runCleanup()
      if (e instanceof Cancelled) this.set({ state: 'idle' })
      else this.set({ state: 'error', gameId: game.id, message: (e as Error).message })
    }
  }

  private track(game: Game, startedAt: number, pgid?: number): ActiveRun {
    const a: ActiveRun = { game, startedAt, pgid, heartbeat: setInterval(() => this.saveRun(), 30000) }
    this.active = a
    this.saveRun()
    return a
  }

  private saveRun() {
    const a = this.active
    if (!a?.pgid) return
    const s = this.session
    writeRun({
      gameId: a.game.id,
      pgid: a.pgid,
      startedAt: a.startedAt,
      lastSeen: Date.now(),
      boot: bootId(),
      disc: s ? { kind: s.kind, mounts: s.mountList(), current: s.currentImage, original: s.originalLinks() } : undefined,
    })
  }

  /**
   * The launched command is gone. Many old games start through a loader, an autorun menu or a
   * copy-protection stub that hands off to the real game and exits, so wait for everything the
   * game started (its process group, then its Wine prefix) before the disc is released. No time
   * limit: Stop ends it.
   */
  private settle(a: ActiveRun) {
    a.settling ??= (async () => {
      if (a.pgid) while (groupAlive(a.pgid)) await sleep(1500)
      if (a.game.runner !== 'native' && a.game.prefix) await this.waitPrefix(a.game)
      const quick = !!a.exitCode && Date.now() - a.startedAt < 10000
      await this.end(a, quick ? `The game exited right away (code ${a.exitCode}). Check the log.` : undefined)
    })()
    return a.settling
  }

  private async end(a: ActiveRun, error?: string) {
    if (this.active !== a) return
    this.active = undefined
    clearInterval(a.heartbeat)
    await this.runCleanup()
    writeRun(undefined)
    this.addPlaytime(a.game.id, Date.now() - a.startedAt)
    this.set(error ? { state: 'error', gameId: a.game.id, message: error } : { state: 'idle' })
  }

  private addPlaytime(gameId: string, ms: number) {
    const saved = store.get(gameId)
    if (!saved || ms <= 0) return
    saved.playtimeSeconds = (saved.playtimeSeconds || 0) + Math.round(ms / 1000)
    store.save(saved)
    this.emit('library')
  }

  /**
   * At start-up: pick up a game an earlier DiscPlay process left running (it was closed or crashed
   * mid-game), or finish its bookkeeping if the game is over too. Then release disc images that
   * were left mounted.
   */
  async recover() {
    const r = readRun()
    const game = r ? store.get(r.gameId) : undefined
    let adopted = false
    if (r && game && r.boot === bootId()) {
      adopted = groupAlive(r.pgid) || (game.runner !== 'native' && !!game.prefix && !(await this.prefixIdle(game)))
      if (adopted) this.adopt(r, game)
    }
    if (r && !adopted) {
      writeRun(undefined)
      if (game?.prefix && game.runner !== 'native' && r.disc?.original) restoreDriveLinks(game.prefix, game.disc.letter || 'd', r.disc.original)
      if (game && r.boot === bootId()) this.addPlaytime(game.id, r.lastSeen - r.startedAt)
    }
    const keep = new Set(adopted ? (r?.disc?.mounts.map((m) => m.device) ?? []) : [])
    for (const l of leftoverLoops()) if (!keep.has(l.loop)) await releaseLeftover(l).catch(() => {})
  }

  private adopt(r: SavedRun, game: Game) {
    this.cleanup = []
    const prefix = game.runner !== 'native' ? game.prefix : undefined
    if (r.disc?.kind === 'image') {
      const s = this.openSession(new DiscSession(null, { owner: game.id, prefix, letter: game.disc.letter || 'd' }, discImages(game.disc)))
      s.adopt(r.disc.mounts, r.disc.current, r.disc.original)
      this.emit('disc', s.info())
    } else if (r.disc?.kind === 'drive') {
      const s = this.openSession(this.driveSession(game))
      s.adopt([], -1, r.disc.original)
      s.follow()
    }
    const a = this.track(game, r.startedAt, r.pgid)
    this.set({ state: 'running', gameId: game.id, pid: r.pgid, startedAt: r.startedAt })
    this.settle(a)
  }

  private async runCleanup() {
    const steps = this.cleanup.splice(0)
    for (const s of steps.reverse()) await s().catch(() => {})
  }

  /** Wait until nothing runs in the prefix any more (timeout 0: no limit). */
  private async waitPrefix(game: WineSetup, timeout = 0) {
    const ws = wineserverFor(game)
    if (!ws || !game.prefix) return
    await run(ws, ['-w'], { timeout, env: childEnv({ WINEPREFIX: realPrefix(game.prefix) }) })
  }

  /** True when nothing runs in the prefix (wineserver -w returns at once). */
  private async prefixIdle(game: WineSetup) {
    const ws = wineserverFor(game)
    if (!ws || !game.prefix) return true
    const r = await run(ws, ['-w'], { timeout: 2000, env: childEnv({ WINEPREFIX: realPrefix(game.prefix) }) })
    return !r.timedOut
  }

  /** Kill everything running in the prefix. */
  private async killPrefix(game: WineSetup) {
    const ws = wineserverFor(game)
    if (ws && game.prefix) await run(ws, ['-k'], { env: childEnv({ WINEPREFIX: realPrefix(game.prefix) }) })
  }

  /** The library changed: a game waiting for its disc may now accept the one that is in. */
  libraryChanged() {
    this.recheckDisc?.()
  }

  cancelWait() {
    this.cancelWaiting?.()
  }

  /** Stop whatever is going on: stop waiting for a disc, stop an installer, or end the game. */
  async stop() {
    if (this.status.state === 'waiting-disc') return this.cancelWait()
    if (this.abortInstall) return this.abortInstall()
    const a = this.active
    if (!a) return
    if (a.game.runner !== 'native' && a.game.prefix) await this.killPrefix(a.game)
    const pgid = a.pgid
    if (!pgid) return
    try {
      process.kill(-pgid, 'SIGTERM')
    } catch {}
    setTimeout(() => {
      try {
        if (this.active === a && groupAlive(pgid)) process.kill(-pgid, 'SIGKILL')
      } catch {}
    }, 5000)
  }

  /**
   * Install a game from a disc: create a prefix (or use an existing game's, for add-ons), link the disc
   * as D:, run its setup program, then report the new .exe files so the user can pick the game.
   * Multi-disc installs: a physical drive is followed through every disc swap; image sets are swapped
   * from the UI. Every disc label seen is reported back.
   */
  async install(req: InstallRequest, log: (line: string) => void): Promise<InstallResult> {
    if (this.busy()) throw new Error('Something is already running.')
    const settings = store.getSettings()
    const target = req.targetId ? store.get(req.targetId) : undefined
    if (req.targetId && !target) throw new Error('The game to install the add-on into is no longer in the library.')
    if (target && target.runner === 'native') throw new Error('Add-ons can only be installed into Windows games (Proton or Wine).')
    if (target && !target.prefix) throw new Error(`${target.title} has no Wine prefix set. Set it in the editor first.`)
    const images = req.from === 'image' ? (req.images ?? []).filter(Boolean) : []
    if (req.from === 'image' && !images.length) throw new Error('Choose the disc image(s) first.')
    const missing = images.find((f) => !fs.existsSync(f))
    if (missing) throw new Error(`The disc image is missing: ${missing}`)
    const letter = target?.disc.letter || 'd'
    const discSource = req.from === 'image' ? 'image' : req.from === 'drive' ? 'drive' : 'none'
    // A new game gets a prefix of its own. Never reuse one an earlier (maybe failed) install left behind.
    const prefix = target ? target.prefix! : req.prefix || freePrefix(path.join(settings.prefixBase, slug(req.title)))
    const created = !target && (!fs.existsSync(prefix) || isEmptyDir(prefix))
    let protonPath = target?.protonPath
    if (!target) {
      const proton = resolveProton(req.protonPath || settings.defaultProton)
      if (proton.note) log(proton.note)
      protonPath = proton.path
    }
    const base: Game = target
      ? {
          // Same runner, prefix, Proton and env as the game, but no wrapper: wrappers are written for the game, not its installers.
          ...target,
          id: 'install',
          executable: '',
          args: [],
          wrapper: undefined,
          workingDir: undefined,
          disc: { ...target.disc, source: discSource, labels: [], images, imagePath: images[0] },
        }
      : {
          id: 'install',
          title: req.title,
          runner: 'umu',
          executable: '',
          args: [],
          prefix,
          protonPath,
          env: {},
          disc: { source: discSource, labels: [], images, imagePath: images[0], letter, required: false },
          art: {},
          color: '',
          addedAt: Date.now(),
          playtimeSeconds: 0,
        }
    let aborted = false
    let failed = true
    const checkAborted = () => {
      if (aborted) throw new Error('The installation was stopped.')
    }
    this.abortInstall = async () => {
      if (aborted) return
      aborted = true
      log('Stopping the installer…')
      await this.killPrefix(base)
      if (this.installPgid)
        try {
          process.kill(-this.installPgid, 'SIGTERM')
        } catch {}
      this.cancelWaiting?.()
    }
    this.cleanup = []
    this.set({ state: 'preparing', gameId: 'install', message: target ? `Preparing the add-on installer for ${target.title}…` : 'Preparing the installer…' })
    try {
      // 1. Make the prefix (new games only), so the disc can be linked into it
      fs.mkdirSync(prefix, { recursive: true })
      if (!prefixReady(prefix)) {
        if (target) throw new Error(`The Wine prefix of ${target.title} is missing or not set up: ${prefix}`)
        log(`Creating Wine prefix ${prefix} (first time takes a minute)…`)
        this.set({ state: 'preparing', gameId: 'install', message: 'Creating a fresh Windows environment…' })
        await this.runLogged(this.plan(base, '', []), log)
        checkAborted()
      }

      // 2. Put disc 1 in and keep the drive letter following disc changes
      let session: DiscSession | undefined
      if (req.from === 'image') {
        const progress = (message: string) => this.set({ state: 'preparing', gameId: 'install', message })
        session = this.openSession(new DiscSession(null, { owner: 'install', prefix, letter, log, progress }, images))
        log(`Mounting ${path.basename(images[0])}${images.length > 1 ? ` (disc 1 of ${images.length})` : ''}`)
        await session.useImage(0)
      } else if (req.from === 'drive') {
        log(`Mounting the disc in ${this.drive.device}`)
        await this.drive.refresh()
        session = this.openSession(new DiscSession(this.drive, { owner: 'install', prefix, letter, log }))
        if (!(await session.useDrive())) throw new Error('No disc could be mounted. Is it in the drive?')
        session.follow()
      }
      checkAborted()
      const root = session?.root
      let setup = req.setupPath
      if (root && !setup) setup = inspectDisc(root).setup
      if (!setup) throw new Error('No setup program was found on the disc. Pick it manually.')

      // 3. Run setup
      const before = listExes(prefix)
      const L = letter.toUpperCase()
      const exe = root ? `${L}:\\${setup.replace(/\//g, '\\')}` : setup
      log(`Running ${exe}`)
      this.set({ state: 'preparing', gameId: 'install', message: 'Installer running – follow it on screen' })
      const p = this.plan(base, exe, [])
      // Run from the prefix, not the disc: a working folder on the disc keeps it busy, and then it can't be ejected for the next one.
      p.cwd = prefix
      await this.runLogged(p, log)
      checkAborted()
      // Many setups re-run themselves from %TEMP% (so the disc can be swapped) and exit at once: wait for the prefix to go idle.
      log('Installer closed, waiting for Wine to settle…')
      // The wait can be cut short from the UI (cancelWait) if something lingers in the prefix.
      await Promise.race([this.waitPrefix(base), new Promise<void>((resolve) => (this.cancelWaiting = resolve))])
      this.cancelWaiting = undefined
      checkAborted()

      // 4. What did it install?
      const after = listExes(prefix)
      const candidates: ExeCandidate[] = []
      for (const [p2, st] of after) {
        const prev = before.get(p2)
        if (!prev || prev.mtime !== st.mtime) candidates.push({ path: p2, ...st })
      }
      candidates.sort((a, b) => Number(looksLikeGameExe(b.path)) - Number(looksLikeGameExe(a.path)) || b.size - a.size)
      const labels = session?.seenLabels() ?? []
      log(`Found ${candidates.length} new or updated program(s).${labels.length > 1 ? ` Discs used: ${labels.join(', ')}.` : ''}`)
      const disc: Game['disc'] = { ...base.disc, labels: req.from === 'drive' ? labels : [] }
      failed = false
      if (created) this.discardable.set(prefix, base)
      return {
        candidates,
        labels,
        targetExecutable: target?.executable,
        createdPrefix: created ? prefix : undefined,
        game: target
          ? { prefix, runner: target.runner, protonPath: target.protonPath, wineBinary: target.wineBinary, wrapper: target.wrapper, env: { ...target.env }, disc }
          : { prefix, protonPath, disc, runner: 'umu' },
      }
    } catch (e) {
      // Whatever the installer left running must go before its disc is unmounted.
      await this.killPrefix(base).catch(() => {})
      throw aborted ? new Error('The installation was stopped.') : e
    } finally {
      this.abortInstall = undefined
      this.cancelWaiting = undefined
      await this.runCleanup()
      // A new game's half-made prefix is useless, and a retry should start clean.
      if (failed && created) {
        log(`Removing the unfinished Wine prefix ${prefix}`)
        fs.rmSync(prefix, { recursive: true, force: true })
      }
      this.set({ state: 'idle' })
    }
  }

  /** Throw away the prefix a new-game install made, when the user closes the installer without adding the game. */
  async discardInstall(prefix: string) {
    const setup = this.discardable.get(prefix)
    if (!setup) throw new Error('Only the Windows environment made by the last install can be removed here.')
    if (store.library().some((g) => g.prefix === prefix)) throw new Error('A game in the library uses this Windows environment.')
    if (this.busy()) throw new Error('Wait until nothing is running.')
    this.discardable.delete(prefix)
    await this.killPrefix(setup)
    fs.rmSync(prefix, { recursive: true, force: true })
  }

  private runLogged(p: Plan, log: (l: string) => void) {
    return new Promise<number>((resolve, reject) => {
      // Own process group, so Stop can end the installer and everything it started.
      const child = spawn(p.cmd[0], p.cmd.slice(1), { cwd: p.cwd, env: p.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      this.installPgid = child.pid
      const onData = (b: Buffer) =>
        b
          .toString()
          .split('\n')
          .filter((l) => l.trim() && !/^ProtonFixes|fixme:/.test(l))
          .forEach(log)
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('error', (e) => {
        this.installPgid = undefined
        reject(e)
      })
      child.on('exit', (c) => {
        this.installPgid = undefined
        resolve(c ?? 0)
      })
    })
  }
}

class Cancelled extends Error {}
