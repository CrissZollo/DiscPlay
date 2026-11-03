import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { DiscSessionInfo, DriveState, ExeCandidate, Game, InstallRequest, InstallResult, RunStatus } from '../shared/types'
import { DiscSession } from './discs'
import { DriveWatcher, inspectDisc } from './drive'
import { logDir } from './paths'
import { listExes, looksLikeGameExe, prefixReady, realPrefix } from './prefix'
import { findProtons, findUmu, protonWineserver, umuCommand } from './runners'
import { store } from './store'
import { childEnv, run, slug, splitCommand, which } from './util'

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

export class Launcher extends EventEmitter {
  status: RunStatus = { state: 'idle' }
  private child?: ChildProcess
  private cancelWaiting?: () => void
  private recheckDisc?: () => void
  private cleanup: (() => Promise<void>)[] = []
  private current?: Game
  private session?: DiscSession

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
    const onChange = (info: DiscSessionInfo) => this.emit('disc', info)
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
      const proton = game.protonPath || store.getSettings().defaultProton || findProtons()[0]?.path
      if (!proton) throw new Error('No Proton version found. Install GE-Proton (e.g. with ProtonUp-Qt).')
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
      const session = this.openSession(new DiscSession(null, { owner: game.id, prefix, letter }, images))
      await session.useImage(0)
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
    // Follow disc swaps for the whole session: the game's own discs, or any disc no other game claims
    // (e.g. disc 2 of a set whose label was never recorded).
    const session = this.openSession(
      new DiscSession(this.drive, { owner: game.id, prefix, letter, accept: (d) => labelMatches(game, d) || !gameForDisc(d) }),
    )
    session.follow()
    if (!labelMatches(game, this.drive.state)) return
    this.set({ state: 'preparing', gameId: game.id, message: 'Spinning up the disc…' })
    const mp = await session.useDrive()
    if (!mp && disc.required) throw new Error('The disc could not be mounted.')
  }

  async launch(game: Game) {
    if (this.busy()) throw new Error('A game is already running.')
    this.current = game
    this.cleanup = []
    this.set({ state: 'preparing', gameId: game.id, message: 'Getting ready…' })
    try {
      if (!game.executable) throw new Error('No executable set for this game.')
      await this.prepareDisc(game)
      const p = this.plan(game, game.executable, game.args)
      const logFile = path.join(logDir(), `${game.id}.log`)
      const out = fs.openSync(logFile, 'w')
      fs.writeSync(out, `DiscPlay launch ${new Date().toISOString()}\n`)
      fs.writeSync(out, `cwd: ${p.cwd}\ncommand: ${JSON.stringify(p.cmd)}\n`)
      for (const k of ['WINEPREFIX', 'PROTONPATH', 'GAMEID']) if (p.env[k]) fs.writeSync(out, `${k}=${p.env[k]}\n`)
      fs.writeSync(out, '\n')
      const startedAt = Date.now()
      const child = spawn(p.cmd[0], p.cmd.slice(1), { cwd: p.cwd, env: p.env, detached: true, stdio: ['ignore', out, out] })
      this.child = child
      fs.closeSync(out)
      child.on('error', (e) => this.finish(game, startedAt, e.message))
      child.on('exit', (code) => this.finish(game, startedAt, code && code !== 0 && Date.now() - startedAt < 5000 ? `The game exited right away (code ${code}). Check the log.` : undefined))
      this.set({ state: 'running', gameId: game.id, pid: child.pid, startedAt })
      store.save({ ...(store.get(game.id) ?? game), lastPlayed: startedAt })
      this.emit('library')
    } catch (e) {
      await this.runCleanup()
      if (e instanceof Cancelled) this.set({ state: 'idle' })
      else this.set({ state: 'error', gameId: game.id, message: (e as Error).message })
    }
  }

  private async finish(game: Game, startedAt: number, error?: string) {
    if (!this.child) return
    this.child = undefined
    // umu/Proton may leave the prefix's wineserver running a moment; wait for it before unmounting.
    if (game.runner !== 'native' && game.prefix) await this.waitPrefix(game, 15000)
    await this.runCleanup()
    const saved = store.get(game.id)
    if (saved) {
      saved.playtimeSeconds = (saved.playtimeSeconds || 0) + Math.round((Date.now() - startedAt) / 1000)
      store.save(saved)
      this.emit('library')
    }
    this.set(error ? { state: 'error', gameId: game.id, message: error } : { state: 'idle' })
  }

  private async runCleanup() {
    const steps = this.cleanup.splice(0)
    for (const s of steps.reverse()) await s().catch(() => {})
  }

  private async waitPrefix(game: Game, timeout: number) {
    const ws = game.runner === 'umu' ? protonWineserver(game.protonPath) : which('wineserver')
    if (!ws || !game.prefix) return
    await run(ws, ['-w'], { timeout, env: childEnv({ WINEPREFIX: realPrefix(game.prefix) }) })
  }

  /** The library changed: a game waiting for its disc may now accept the one that is in. */
  libraryChanged() {
    this.recheckDisc?.()
  }

  cancelWait() {
    this.cancelWaiting?.()
  }

  async stop() {
    if (this.cancelWaiting) return this.cancelWait()
    const game = this.current
    const child = this.child
    if (!child?.pid) return
    if (game && game.runner !== 'native' && game.prefix) {
      const ws = game.runner === 'umu' ? protonWineserver(game.protonPath) : which('wineserver')
      if (ws) await run(ws, ['-k'], { env: childEnv({ WINEPREFIX: realPrefix(game.prefix) }) })
    }
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {}
    setTimeout(() => {
      try {
        if (this.child === child) process.kill(-child.pid!, 'SIGKILL')
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
    const letter = target?.disc.letter || 'd'
    const discSource = req.from === 'image' ? 'image' : req.from === 'drive' ? 'drive' : 'none'
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
          prefix: req.prefix || path.join(settings.prefixBase, slug(req.title)),
          protonPath: req.protonPath || settings.defaultProton || findProtons()[0]?.path,
          env: {},
          disc: { source: discSource, labels: [], images, imagePath: images[0], letter, required: false },
          art: {},
          color: '',
          addedAt: Date.now(),
          playtimeSeconds: 0,
        }
    const prefix = base.prefix!
    this.cleanup = []
    this.current = undefined
    this.set({ state: 'preparing', gameId: 'install', message: target ? `Preparing the add-on installer for ${target.title}…` : 'Preparing the installer…' })
    try {
      // 1. Make the prefix (new games only), so the disc can be linked into it
      fs.mkdirSync(prefix, { recursive: true })
      if (!prefixReady(prefix)) {
        if (target) throw new Error(`The Wine prefix of ${target.title} is missing or not set up: ${prefix}`)
        log(`Creating Wine prefix ${prefix} (first time takes a minute)…`)
        this.set({ state: 'preparing', gameId: 'install', message: 'Creating a fresh Windows environment…' })
        await this.runLogged(this.plan(base, '', []), log)
      }

      // 2. Put disc 1 in and keep the drive letter following disc changes
      let session: DiscSession | undefined
      if (req.from === 'image') {
        session = this.openSession(new DiscSession(null, { owner: 'install', prefix, letter, log }, images))
        log(`Mounting ${path.basename(images[0])}${images.length > 1 ? ` (disc 1 of ${images.length})` : ''}`)
        await session.useImage(0)
      } else if (req.from === 'drive') {
        log(`Mounting the disc in ${this.drive.device}`)
        await this.drive.refresh()
        session = this.openSession(new DiscSession(this.drive, { owner: 'install', prefix, letter, log }))
        if (!(await session.useDrive())) throw new Error('No disc could be mounted. Is it in the drive?')
        session.follow()
      }
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
      // Many setups re-run themselves from %TEMP% (so the disc can be swapped) and exit at once: wait for the prefix to go idle.
      log('Installer closed, waiting for Wine to settle…')
      // The wait can be cut short from the UI (cancelWait) if something lingers in the prefix.
      await Promise.race([
        this.waitPrefix(base, 6 * 60 * 60 * 1000),
        new Promise<void>((resolve) => (this.cancelWaiting = resolve)),
      ])
      this.cancelWaiting = undefined

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
      return {
        candidates,
        labels,
        targetExecutable: target?.executable,
        game: target
          ? { prefix, runner: target.runner, protonPath: target.protonPath, wineBinary: target.wineBinary, wrapper: target.wrapper, env: { ...target.env }, disc }
          : { prefix, protonPath: base.protonPath, disc, runner: 'umu' },
      }
    } finally {
      await this.runCleanup()
      this.set({ state: 'idle' })
    }
  }

  private runLogged(p: Plan, log: (l: string) => void) {
    return new Promise<number>((resolve, reject) => {
      const child = spawn(p.cmd[0], p.cmd.slice(1), { cwd: p.cwd, env: p.env, stdio: ['ignore', 'pipe', 'pipe'] })
      const onData = (b: Buffer) =>
        b
          .toString()
          .split('\n')
          .filter((l) => l.trim() && !/^ProtonFixes|fixme:/.test(l))
          .forEach(log)
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('error', reject)
      child.on('exit', (c) => resolve(c ?? 0))
    })
  }
}

class Cancelled extends Error {}
