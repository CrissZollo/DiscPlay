import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { Game } from '../shared/types'
import { looksLikeGameExe, realPrefix } from './prefix'

/**
 * SafeDisc 2.x–4.x (Macrovision) loads a kernel driver, secdrv.sys, which Wine cannot run: the game
 * just exits a few seconds after start (`ZwLoadDriver ... SecDrv: c0000142` in a debug log).
 * SafeDiscShim (github.com/RibShark/SafeDiscShim, GPLv3, bundled in resources/safedisc) answers the
 * driver's calls in user mode. On Windows it is injected through an AppCompat database, which Wine
 * ignores, so the game is started through safedisc-run.exe: it loads the shim, which hooks
 * CreateProcess, and starts the game exe so the shim is injected into it (and into whatever that
 * starts). The original disc is still checked; this is not a crack.
 */

const MARKER = Buffer.from('BoG_ *90.0&!!  Yy>', 'latin1')
const RUNNER = 'safedisc-run.exe'
const MAX_SCAN = 256 * 1024 * 1024
const MAX_SIBLINGS = 8

export interface SafeDisc {
  /** The protected exe (the game's own, or a sibling it starts) */
  file: string
  /** e.g. "4.00.002"; undefined when only the section names gave it away */
  version?: string
  /** SafeDisc 1.x has no secdrv driver, so the shim isn't needed */
  shim: boolean
}

const cache = new Map<string, SafeDisc | null>()

/** Section names of a PE file. */
function peSections(buf: Buffer) {
  const names: string[] = []
  if (buf.length < 0x40 || buf.toString('latin1', 0, 2) !== 'MZ') return names
  const pe = buf.readUInt32LE(0x3c)
  if (pe + 24 > buf.length || buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') return names
  const count = buf.readUInt16LE(pe + 6)
  const table = pe + 24 + buf.readUInt16LE(pe + 20)
  for (let i = 0; i < count && table + i * 40 + 8 <= buf.length; i++)
    names.push(buf.toString('latin1', table + i * 40, table + i * 40 + 8).replace(/\0+$/, ''))
  return names
}

/** SafeDisc in one exe: its version marker, or its stxt371/stxt774 sections. Cached by size + mtime. */
export function scanExe(file: string): SafeDisc | null {
  let st: fs.Stats
  try {
    st = fs.statSync(file)
  } catch {
    return null
  }
  if (!st.isFile() || st.size > MAX_SCAN) return null
  const key = `${file}\0${st.size}\0${st.mtimeMs}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  let found: SafeDisc | null = null
  try {
    const buf = fs.readFileSync(file)
    const i = buf.indexOf(MARKER)
    const v = i >= 0 && i + 44 <= buf.length ? [0, 4, 8].map((o) => buf.readUInt32LE(i + 32 + o)) : undefined
    const valid = v && v[0] >= 1 && v[0] <= 4 && v[1] < 100 && v[2] < 1000 ? v : undefined
    const stxt = peSections(buf).some((n) => /^stxt(371|774)$/i.test(n))
    if (valid || stxt)
      found = {
        file,
        version: valid ? `${valid[0]}.${String(valid[1]).padStart(2, '0')}.${String(valid[2]).padStart(3, '0')}` : undefined,
        shim: !valid || valid[0] >= 2,
      }
  } catch {}
  cache.set(key, found)
  return found
}

/**
 * Does this game need SafeDiscShim? Looks at the game's exe, then at a few other programs next to
 * it (a loader that starts the protected exe with CreateProcess is followed by the shim too).
 * Games already started through safedisc-run.exe by hand are left alone.
 */
export function detectSafeDisc(game: Game): SafeDisc | null {
  if (game.runner === 'native' || !game.prefix) return null
  const exe = game.executable
  if (!exe || !path.isAbsolute(exe) || path.basename(exe).toLowerCase() === RUNNER) return null
  const own = scanExe(exe)
  if (own) return own.shim ? own : null
  const dir = path.dirname(exe)
  let siblings: string[] = []
  try {
    siblings = fs.readdirSync(dir).filter((f) => /\.exe$/i.test(f) && f !== path.basename(exe) && f.toLowerCase() !== RUNNER && looksLikeGameExe(f))
  } catch {}
  for (const f of siblings.slice(0, MAX_SIBLINGS)) {
    const r = scanExe(path.join(dir, f))
    if (r?.shim) return r
  }
  return null
}

export function describe(sd: SafeDisc) {
  return `SafeDisc${sd.version ? ` ${sd.version}` : ''}`
}

function resourceDir() {
  return app.isPackaged ? path.join(process.resourcesPath, 'safedisc') : path.join(app.getAppPath(), 'resources', 'safedisc')
}

/** Where safedisc-run.exe goes in a prefix (outside the game folder, so uninstalls don't trip on it). */
export function runnerPath(prefix: string) {
  return path.join(realPrefix(prefix), 'drive_c', 'DiscPlay', RUNNER)
}

/** The system folder 32-bit programs load from: syswow64 in a 64-bit prefix, system32 in a 32-bit one. */
function system32(prefix: string) {
  const win = path.join(realPrefix(prefix), 'drive_c', 'windows')
  return path.join(win, fs.existsSync(path.join(win, 'syswow64')) ? 'syswow64' : 'system32')
}

function sameContent(a: string, b: string) {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b))
  } catch {
    return false
  }
}

function isShim(file: string) {
  try {
    return fs.readFileSync(file).includes('SafeDiscShim')
  } catch {
    return false
  }
}

/**
 * Put SafeDiscShim's drvmgt.dll and safedisc-run.exe into the prefix. A SafeDiscShim already there
 * (any version, e.g. installed by hand) is kept; any other drvmgt.dll is backed up once first.
 * Returns what was done, for the log.
 */
export function installShim(prefix: string): string[] {
  const res = resourceDir()
  const srcDll = path.join(res, 'drvmgt.dll')
  const srcRun = path.join(res, RUNNER)
  if (!fs.existsSync(srcDll) || !fs.existsSync(srcRun))
    throw new Error(`DiscPlay's SafeDisc support files are missing (${res}). Reinstall DiscPlay.`)
  const done: string[] = []
  const dll = path.join(system32(prefix), 'drvmgt.dll')
  if (!isShim(dll)) {
    if (fs.existsSync(dll) && !fs.existsSync(`${dll}.discplay-backup`)) {
      fs.copyFileSync(dll, `${dll}.discplay-backup`)
      done.push(`backed up the old ${dll}`)
    }
    fs.mkdirSync(path.dirname(dll), { recursive: true })
    fs.copyFileSync(srcDll, dll)
    done.push(`installed SafeDiscShim to ${dll}`)
  }
  const run = runnerPath(prefix)
  if (!sameContent(run, srcRun)) {
    fs.mkdirSync(path.dirname(run), { recursive: true })
    fs.copyFileSync(srcRun, run)
    done.push(`installed ${run}`)
  }
  return done
}

/** The Windows path of a file in a prefix: C:\… for drive_c, else the drive letter that reaches it (Z: = /). */
export function windowsPath(prefix: string, file: string) {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p)
    } catch {
      return path.resolve(p)
    }
  }
  const target = real(file)
  const dos = path.join(realPrefix(prefix), 'dosdevices')
  let best: { letter: string; root: string } | undefined
  let names: string[] = []
  try {
    names = fs.readdirSync(dos)
  } catch {}
  for (const n of names) {
    if (!/^[a-z]:$/i.test(n)) continue
    const root = real(path.join(dos, n))
    const inside = root === '/' || target === root || target.startsWith(root + '/')
    if (inside && (!best || root.length > best.root.length)) best = { letter: n[0].toUpperCase(), root }
  }
  const { letter, root } = best ?? { letter: 'Z', root: '/' }
  const rel = root === '/' ? target.slice(1) : path.relative(root, target)
  return `${letter}:\\${rel.split('/').join('\\')}`
}
