import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { DriveState } from '../shared/types'
import { forgetLoop, loopBackingFile, rememberLoop } from './loops'
import { run, sleep } from './util'

/** Decode udev's \x20-style escapes (ID_FS_LABEL_ENC). */
function decodeUdev(s: string) {
  return s.replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

async function udevProps(device: string) {
  const r = await run('udevadm', ['info', '-q', 'property', '-n', device], { timeout: 4000 })
  const props: Record<string, string> = {}
  if (r.code !== 0) return null
  for (const line of r.stdout.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) props[line.slice(0, i)] = line.slice(i + 1)
  }
  return props
}

async function mountpointOf(device: string) {
  const r = await run('findmnt', ['-n', '-o', 'TARGET', '--source', device], { timeout: 4000 })
  const line = r.stdout.split('\n')[0]?.trim()
  return line ? decodeUdev(line) : undefined
}

export async function readDrive(device: string): Promise<DriveState> {
  const props = await udevProps(device)
  if (!props) return { device, present: false, hasDisc: false }
  const hasDisc = props.ID_CDROM_MEDIA === '1'
  if (!hasDisc) return { device, present: true, hasDisc: false }
  const label = props.ID_FS_LABEL_ENC ? decodeUdev(props.ID_FS_LABEL_ENC) : props.ID_FS_LABEL
  const mediaKey = Object.keys(props).find((k) => k.startsWith('ID_CDROM_MEDIA_') && props[k] === '1' && !/TRACK|SESSION|STATE/.test(k))
  const media = mediaKey?.replace('ID_CDROM_MEDIA_', '').toLowerCase()
  const audioOnly = Number(props.ID_CDROM_MEDIA_TRACK_COUNT_AUDIO || 0) > 0 && !Number(props.ID_CDROM_MEDIA_TRACK_COUNT_DATA || 0)
  return {
    device,
    present: true,
    hasDisc: true,
    label: audioOnly ? 'Audio CD' : label,
    media: audioOnly ? 'audio' : media,
    pressed: media ? !/_r$|_rw$|_plus|_ram$|_minus/.test(media) : undefined,
    mountpoint: await mountpointOf(device),
  }
}

/** Mount a block device through udisks (no root needed). Returns the mount point. */
export async function mountDevice(device: string, tries = 10): Promise<string | undefined> {
  let mp = await mountpointOf(device)
  for (let i = 0; !mp && i < tries; i++) {
    await run('udisksctl', ['mount', '-b', device, '--no-user-interaction', '-o', 'ro'], { timeout: 20000 })
    mp = await mountpointOf(device)
    if (!mp) await sleep(1000) // drive may still be spinning up
  }
  return mp
}

/** Volume label of a block device as udev sees it (works for loop devices too). */
export async function volumeLabel(device: string) {
  const props = await udevProps(device)
  if (!props) return undefined
  const l = props.ID_FS_LABEL_ENC ? decodeUdev(props.ID_FS_LABEL_ENC) : props.ID_FS_LABEL
  return l?.trim() || undefined
}

/**
 * Open the tray mid-session (disc swap). Never powers the drive off, so a USB drive stays attached.
 * Falls back to a lazy unmount when something still has the old disc open.
 */
export async function ejectForSwap(device: string) {
  if (await mountpointOf(device)) {
    await run('udisksctl', ['unmount', '-b', device, '--no-user-interaction'], { timeout: 20000 })
    if (await mountpointOf(device)) await run('udisksctl', ['unmount', '-b', device, '--no-user-interaction', '--force'], { timeout: 20000 })
    if (await mountpointOf(device)) throw new Error('The disc is still in use and could not be released.')
  }
  const r = await run('eject', [device], { timeout: 20000 })
  if (r.code !== 0)
    throw new Error(
      /busy/i.test(r.stderr)
        ? 'The drive is busy: the installer may still be running from this disc. Wait until it asks for the next disc, then eject again.'
        : `The drive would not open. ${r.stderr.trim()}`.trim(),
    )
}

const IMAGE_EXT = /\.(iso|img)$/i

/**
 * Find the rest of a multi-disc image set next to one image: "Game (Disc 1).iso" → Disc 2, Disc 3…,
 * also CD1/CD2, Disk_1, DVD 2 and plain trailing numbers ("game1.iso"). Returns disc order, the given file included.
 */
export function findDiscSet(file: string): string[] {
  const dir = path.dirname(file)
  const name = path.basename(file)
  // [keyword+separator, number]; the keyword may differ between files (CD1 vs Disc 2 is unlikely, but cheap to allow)
  const patterns = [/(disc|disk|cd|dvd|part)([\s._-]*)(\d{1,2})/i, /()()(\d{1,2})(?=[^\d]*\.[^.]+$)/]
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter((f) => IMAGE_EXT.test(f))
  } catch {
    return [file]
  }
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const re of patterns) {
    const m = re.exec(name)
    if (!m) continue
    const keyword = m[1] ? `(?:disc|disk|cd|dvd|part)${esc(m[2])}` : ''
    const before = esc(name.slice(0, m.index)) + keyword
    const after = esc(name.slice(m.index + m[0].length))
    const same = new RegExp(`^${before}0*(\\d{1,2})${after}$`, 'i')
    const set = files
      .map((f) => ({ f, n: Number(same.exec(f)?.[1]) }))
      .filter((x) => x.n > 0)
      .sort((a, b) => a.n - b.n)
      .map((x) => path.join(dir, x.f))
    if (set.length > 1) return set
  }
  return [file]
}

export async function ejectDevice(device: string) {
  if (await mountpointOf(device)) await run('udisksctl', ['unmount', '-b', device, '--no-user-interaction'], { timeout: 20000 })
  const r = await run('eject', [device], { timeout: 20000 })
  if (r.code !== 0) await run('udisksctl', ['power-off', '-b', device, '--no-user-interaction'], { timeout: 20000 })
}

/** Loop-mount an ISO/IMG read-only. */
export async function mountImage(file: string): Promise<{ loop: string; mountpoint: string }> {
  const setup = await run('udisksctl', ['loop-setup', '-r', '-f', file, '--no-user-interaction'], { timeout: 20000 })
  const loop = /as (\/dev\/loop\d+)/.exec(setup.stdout)?.[1]
  if (!loop) throw new Error(`Could not attach the disc image: ${setup.stderr || setup.stdout}`.trim())
  rememberLoop(loop, file)
  const mp = await mountDevice(loop, 5)
  if (!mp) {
    await run('udisksctl', ['loop-delete', '-b', loop, '--no-user-interaction'])
    forgetLoop(loop)
    throw new Error('The disc image could not be mounted (only ISO 9660 / UDF images are supported).')
  }
  return { loop, mountpoint: mp }
}

export async function unmountImage(loop: string) {
  await run('udisksctl', ['unmount', '-b', loop, '--no-user-interaction'], { timeout: 20000 })
  await run('udisksctl', ['loop-delete', '-b', loop, '--no-user-interaction'], { timeout: 20000 })
  // Still attached (something kept the image busy): keep it listed so the next start can retry.
  if (!loopBackingFile(loop)) forgetLoop(loop)
}

/** Find a file case-insensitively in a directory (discs are often all upper case). */
export function findCaseless(dir: string, name: string) {
  try {
    const hit = fs.readdirSync(dir).find((f) => f.toLowerCase() === name.toLowerCase())
    return hit ? path.join(dir, hit) : undefined
  } catch {
    return undefined
  }
}

/** Look for an installer on a mounted disc. Returns the setup path relative to the disc root. */
export function inspectDisc(mountpoint: string): { setup?: string; title?: string } {
  let setup: string | undefined
  let title: string | undefined
  const inf = findCaseless(mountpoint, 'autorun.inf')
  if (inf) {
    try {
      const text = fs.readFileSync(inf, 'latin1')
      const get = (k: string) => new RegExp(`^\\s*${k}\\s*=\\s*(.+?)\\s*$`, 'mi').exec(text)?.[1]
      const open = get('open')
      title = get('label')
      if (open) {
        const exe = open.replace(/^"([^"]+)".*$/, '$1').split(/\s+/)[0].replace(/\\/g, '/')
        const found = resolveCaseless(mountpoint, exe)
        if (found) setup = path.relative(mountpoint, found)
      }
    } catch {}
  }
  if (!setup) {
    for (const n of ['setup.exe', 'install.exe', 'autorun.exe', 'autoplay.exe']) {
      const f = findCaseless(mountpoint, n)
      if (f) {
        setup = path.relative(mountpoint, f)
        break
      }
    }
  }
  return { setup, title }
}

function resolveCaseless(root: string, rel: string) {
  let cur = root
  for (const part of rel.split('/').filter(Boolean)) {
    const next = findCaseless(cur, part)
    if (!next) return undefined
    cur = next
  }
  return cur
}

/**
 * Watches an optical drive. Uses `udevadm monitor` for instant notice of disc changes,
 * plus a slow poll as a fallback. Reads only udev's database, so it never spins the drive up.
 */
export class DriveWatcher extends EventEmitter {
  state: DriveState
  private monitor?: ChildProcess
  private timer?: NodeJS.Timeout
  private pending?: NodeJS.Timeout

  constructor(public device: string) {
    super()
    this.state = { device, present: false, hasDisc: false }
  }

  start() {
    this.refresh()
    this.timer = setInterval(() => this.refresh(), 4000)
    try {
      this.monitor = spawn('udevadm', ['monitor', '--udev', '--subsystem-match=block'], { stdio: ['ignore', 'pipe', 'ignore'] })
      const name = path.basename(this.device)
      this.monitor.stdout?.on('data', (buf: Buffer) => {
        if (buf.toString().includes(name)) this.soon()
      })
      this.monitor.on('error', () => {})
    } catch {}
  }

  setDevice(device: string) {
    if (device === this.device) return
    this.device = device
    this.refresh()
  }

  stop() {
    clearInterval(this.timer)
    this.monitor?.kill()
  }

  soon(ms = 400) {
    clearTimeout(this.pending)
    this.pending = setTimeout(() => this.refresh(), ms)
  }

  async refresh() {
    const next = await readDrive(this.device)
    const prev = this.state
    if (next.hasDisc && prev.hasDisc && next.label === prev.label) {
      next.hasSetup = prev.hasSetup
      next.suggestedTitle = prev.suggestedTitle
    }
    if (next.mountpoint && next.hasSetup === undefined) {
      const info = inspectDisc(next.mountpoint)
      next.hasSetup = !!info.setup
      next.suggestedTitle = info.title
    }
    if (JSON.stringify(next) !== JSON.stringify(prev)) {
      this.state = next
      this.emit('change', next, prev)
    }
  }
}
