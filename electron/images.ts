import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { mountDevice, mountImage, mountpointOf, udevProps, unmountImage, volumeLabel } from './drive'
import { forgetLoop, loopBackingFile, rememberLoop } from './loops'
import { home } from './paths'
import { run, sleep, which } from './util'

/**
 * Disc images beyond plain ISO: BIN/CUE, MDF/MDS (Alcohol), NRG (Nero), CCD/IMG/SUB (CloneCD).
 *
 * With CDEmu installed the image goes into a virtual CD drive, so everything on it works: CD-audio
 * music tracks (Wine plays them from the d:: device) and copy-protection data. Without CDEmu the
 * data track is mounted on its own: straight from the file when its sectors are plain 2048-byte
 * ones, else after converting it once to a cached ISO. Music tracks are lost that way.
 */

export const IMAGE_EXT = /\.(iso|img|bin|cue|mdf|mds|nrg|ccd)$/i

/** For a set of files with one name, the one to pick: the descriptor over the data file it describes. */
const PREFERRED = ['.cue', '.mds', '.ccd', '.iso', '.nrg', '.img', '.bin', '.mdf']

export interface ImageMount {
  /** Block device: /dev/loopN, or CDEmu's virtual drive /dev/srN */
  device: string
  mountpoint: string
  label?: string
  via: 'loop' | 'cdemu'
  /** CDEmu device number */
  slot?: number
}

export interface MountHooks {
  /** Progress for the UI, e.g. while converting */
  progress?: (message: string) => void
  /** Something the user should know (music tracks that can't play) */
  notice?: (message: string) => void
}

// ---- reading image layouts -------------------------------------------------------------------

/** Where the ISO 9660 / UDF filesystem of the data track sits in a file. */
interface Layout {
  file: string
  /** Byte offset of the track's first sector */
  start: number
  /** Bytes per sector: 2048 (cooked), 2352 (raw), 2336, 2448 (raw + subchannel) */
  sector: number
  /** Offset of the 2048 bytes of user data inside a sector */
  data: number
}

interface ImageInfo {
  /** What CDEmu should load: the descriptor (.cue/.mds/.ccd) when there is one */
  descriptor: string
  layout?: Layout
  /** Number of CD-audio tracks, when the format tells (cue/ccd), or a guess from the size */
  audioTracks: number
  /** A plain ISO: mounting it directly loses nothing */
  plain: boolean
}

const SECTOR_KINDS: [number, number][] = [
  [2048, 0],
  [2352, 16], // Mode 1 raw
  [2352, 24], // Mode 2 XA form 1 raw
  [2336, 8],
  [2448, 16], // raw + 96 bytes of subchannel (some MDF/IMG rips)
  [2448, 24],
]

function readAt(fd: number, pos: number, len: number) {
  const b = Buffer.alloc(len)
  const n = fs.readSync(fd, b, 0, len, pos)
  return b.subarray(0, n)
}

/** A volume descriptor ("CD001" for ISO 9660, "BEA01" for UDF) at sector 16 of the track? */
function hasFilesystem(fd: number, l: Omit<Layout, 'file'>) {
  const id = readAt(fd, l.start + 16 * l.sector + l.data + 1, 5).toString('latin1')
  return id === 'CD001' || id === 'BEA01'
}

function probe(file: string, starts: number[], kinds = SECTOR_KINDS): Layout | undefined {
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return undefined
  }
  try {
    for (const start of starts)
      for (const [sector, data] of kinds) if (hasFilesystem(fd, { start, sector, data })) return { file, start, sector, data }
  } finally {
    fs.closeSync(fd)
  }
}

/** Size of the filesystem in 2048-byte sectors, from the ISO 9660 primary volume descriptor. */
function volumeSectors(l: Layout) {
  const fd = fs.openSync(l.file, 'r')
  try {
    const pvd = readAt(fd, l.start + 16 * l.sector + l.data, 2048)
    if (pvd.subarray(1, 6).toString('latin1') === 'CD001' && pvd.length >= 84) return pvd.readUInt32LE(80)
  } finally {
    fs.closeSync(fd)
  }
  // UDF only: the rest of the file
  return Math.floor((fs.statSync(l.file).size - l.start) / l.sector)
}

function sibling(file: string, ext: string) {
  const base = file.replace(/\.[^.]+$/, '')
  const dir = path.dirname(file)
  const want = path.basename(base + ext).toLowerCase()
  try {
    const hit = fs.readdirSync(dir).find((f) => f.toLowerCase() === want)
    return hit ? path.join(dir, hit) : undefined
  } catch {
    return undefined
  }
}

function msfFrames(msf: string) {
  const [m, s, f] = msf.split(':').map(Number)
  return (m * 60 + s) * 75 + f
}

const CUE_MODES: Record<string, [number, number]> = {
  'MODE1/2048': [2048, 0],
  'MODE1/2352': [2352, 16],
  'MODE2/2352': [2352, 24],
  'MODE2/2336': [2336, 8],
  'MODE2/2048': [2048, 0],
}

function readCue(cue: string): { layout?: Layout; audioTracks: number } {
  const text = fs.readFileSync(cue, 'latin1')
  let file: string | undefined
  let track: { file?: string; mode: string } | undefined
  let audioTracks = 0
  let layout: Layout | undefined
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const f = /^FILE\s+(?:"([^"]+)"|(\S+))/i.exec(line)
    if (f) {
      const name = (f[1] ?? f[2]).replace(/\\/g, '/')
      file = path.isAbsolute(name) ? name : path.join(path.dirname(cue), name)
      // Cue sheets are often written on Windows: match the file name case-insensitively.
      if (!fs.existsSync(file)) file = sibling(path.join(path.dirname(cue), path.basename(name)), path.extname(name)) ?? file
      continue
    }
    const t = /^TRACK\s+\d+\s+(\S+)/i.exec(line)
    if (t) {
      track = { file, mode: t[1].toUpperCase() }
      if (track.mode === 'AUDIO') audioTracks++
      continue
    }
    const idx = /^INDEX\s+01\s+(\d+:\d+:\d+)/i.exec(line)
    if (idx && track && !layout && CUE_MODES[track.mode] && track.file) {
      const [sector, data] = CUE_MODES[track.mode]
      layout = { file: track.file, start: msfFrames(idx[1]) * sector, sector, data }
    }
  }
  return { layout, audioTracks }
}

function readCcd(ccd: string): { layout?: Layout; audioTracks: number } {
  const img = sibling(ccd, '.img')
  const text = fs.readFileSync(ccd, 'latin1')
  let audioTracks = 0
  let layout: Layout | undefined
  // [TRACK n] MODE=0 (audio) / 1 / 2, INDEX 1=<lba>
  for (const sec of text.split(/^\[TRACK\s+\d+\]/im).slice(1)) {
    const mode = Number(/^MODE=(\d)/im.exec(sec)?.[1] ?? -1)
    const lba = Number(/^INDEX 1=(\d+)/im.exec(sec)?.[1] ?? 0)
    if (mode === 0) audioTracks++
    else if (!layout && img && (mode === 1 || mode === 2)) layout = { file: img, start: lba * 2352, sector: 2352, data: mode === 1 ? 16 : 24 }
  }
  return { layout, audioTracks }
}

/** Find the data track of any supported image. */
export function inspectImage(file: string): ImageInfo {
  const ext = path.extname(file).toLowerCase()
  let descriptor = file
  let found: { layout?: Layout; audioTracks: number } = { audioTracks: 0 }
  let dataFile = file
  let starts = [0]

  const cue = ext === '.cue' ? file : ext === '.bin' || ext === '.img' ? sibling(file, '.cue') : undefined
  const ccd = ext === '.ccd' ? file : ext === '.img' && !cue ? sibling(file, '.ccd') : undefined
  if (cue) {
    descriptor = cue
    found = readCue(cue)
    if (found.layout) {
      dataFile = found.layout.file
      starts = [found.layout.start, 0]
    }
  } else if (ccd) {
    descriptor = ccd
    found = readCcd(ccd)
    if (found.layout) {
      dataFile = found.layout.file
      starts = [found.layout.start, 0]
    }
  } else if (ext === '.mds' || ext === '.mdf') {
    descriptor = ext === '.mds' ? file : (sibling(file, '.mds') ?? file)
    dataFile = ext === '.mdf' ? file : (sibling(file, '.mdf') ?? file)
  } else if (ext === '.nrg') {
    // Old Nero images start with a 150-sector pregap.
    starts = [0, 150 * 2048, 150 * 2352]
  }

  // Check the layout the descriptor claims; fall back to looking for the filesystem.
  const claimed = found.layout
  const layout =
    (claimed && probe(claimed.file, [claimed.start], [[claimed.sector, claimed.data]])) ?? probe(dataFile, starts)
  let audioTracks = found.audioTracks
  if (layout && !cue && !ccd) {
    // No track list: much more data after the filesystem than it needs suggests music tracks.
    const used = layout.start + volumeSectors(layout) * layout.sector
    if (fs.statSync(layout.file).size - used > 8 * 1024 * 1024) audioTracks = Math.max(audioTracks, 1)
  }
  const plain = ext === '.iso' || (ext === '.img' && !cue && !ccd)
  return { descriptor, layout, audioTracks, plain: plain && layout?.sector === 2048 && layout.start === 0 && !audioTracks }
}

// ---- converting raw tracks to a cached ISO ----------------------------------------------------

const cacheDir = () => path.join(process.env.XDG_CACHE_HOME || path.join(home, '.cache'), 'discplay', 'images')
/** Converted images are kept up to this size in total, least recently used ones go first. */
const CACHE_LIMIT = 8 * 1024 ** 3

function cacheFile(l: Layout) {
  const st = fs.statSync(l.file)
  const key = crypto.createHash('sha1').update(`${path.resolve(l.file)}:${st.size}:${st.mtimeMs}:${l.start}:${l.sector}:${l.data}`).digest('hex').slice(0, 16)
  return path.join(cacheDir(), `${path.basename(l.file).replace(/\.[^.]+$/, '').slice(0, 60)}-${key}.iso`)
}

/** Files the loop devices hold right now (never evict one of those). */
function attachedFiles() {
  const out = new Set<string>()
  try {
    for (const n of fs.readdirSync('/sys/block').filter((d) => d.startsWith('loop'))) {
      const f = loopBackingFile(`/dev/${n}`)
      if (f) out.add(f)
    }
  } catch {}
  return out
}

function evict(keep: string) {
  const busy = attachedFiles()
  const files = fs
    .readdirSync(cacheDir())
    .filter((f) => f.endsWith('.iso'))
    .map((f) => {
      const p = path.join(cacheDir(), f)
      const st = fs.statSync(p)
      return { p, size: st.size, used: st.mtimeMs }
    })
    .sort((a, b) => a.used - b.used)
  let total = files.reduce((n, f) => n + f.size, 0)
  for (const f of files) {
    if (total <= CACHE_LIMIT) break
    if (f.p === keep || busy.has(f.p)) continue
    fs.rmSync(f.p, { force: true })
    total -= f.size
  }
}

async function toIso(l: Layout, progress?: (m: string) => void) {
  const out = cacheFile(l)
  if (fs.existsSync(out)) {
    const now = new Date()
    fs.utimesSync(out, now, now) // most recently used
    return out
  }
  fs.mkdirSync(cacheDir(), { recursive: true })
  const sectors = Math.min(volumeSectors(l), Math.floor((fs.statSync(l.file).size - l.start) / l.sector))
  const need = sectors * 2048
  const free = fs.statfsSync(cacheDir())
  if (free.bavail * free.bsize < need + 512 * 1024 ** 2)
    throw new Error(`Not enough free space in ${cacheDir()} to prepare this disc image (needs ${Math.ceil(need / 1024 ** 2)} MB).`)
  const tmp = `${out}.part`
  const fin = fs.openSync(l.file, 'r')
  const fout = fs.openSync(tmp, 'w')
  try {
    const chunk = 512
    const inBuf = Buffer.alloc(chunk * l.sector)
    const outBuf = Buffer.alloc(chunk * 2048)
    let lastPct = -1
    for (let s = 0; s < sectors; s += chunk) {
      const n = Math.min(chunk, sectors - s)
      const got = Math.floor(fs.readSync(fin, inBuf, 0, n * l.sector, l.start + s * l.sector) / l.sector)
      for (let i = 0; i < got; i++) inBuf.copy(outBuf, i * 2048, i * l.sector + l.data, i * l.sector + l.data + 2048)
      fs.writeSync(fout, outBuf, 0, got * 2048)
      if (got < n) break
      const pct = Math.floor((s / sectors) * 100)
      if (pct >= lastPct + 5) {
        lastPct = pct
        progress?.(`Preparing the disc image (first time only)… ${pct}%`)
        await new Promise((r) => setImmediate(r)) // keep the UI responsive
      }
    }
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  } finally {
    fs.closeSync(fin)
    fs.closeSync(fout)
  }
  fs.renameSync(tmp, out)
  evict(out)
  return out
}

// ---- CDEmu ----------------------------------------------------------------------------------------

/** CDEmu is usable: its client is installed and the vhba kernel module is loaded. */
export function cdemuAvailable() {
  return !!which('cdemu') && (fs.existsSync('/dev/vhba_ctl') || fs.existsSync('/sys/module/vhba'))
}

async function cdemu(args: string[]) {
  const r = await run('cdemu', args, { timeout: 30000 })
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `cdemu ${args[0]} failed`)
  return r.stdout
}

/** `cdemu status`: one row per virtual drive, "0   True   /path/to/image.cue". */
async function cdemuSlots() {
  const out = await cdemu(['status'])
  const rows: { slot: number; loaded: boolean; file: string }[] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(True|False)\s*(.*)$/i.exec(line)
    if (m) rows.push({ slot: Number(m[1]), loaded: m[2].toLowerCase() === 'true', file: m[3].trim() })
  }
  return rows
}

/** `cdemu device-mapping`: "0   /dev/sr1   /dev/sg2". */
async function cdemuDevice(slot: number) {
  const out = await cdemu(['device-mapping'])
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\/dev\/sr\d+)/.exec(line)
    if (m && Number(m[1]) === slot) return m[2]
  }
}

async function mountWithCdemu(descriptor: string): Promise<ImageMount> {
  let slots = await cdemuSlots()
  let free = slots.find((s) => !s.loaded)
  if (!free) {
    await cdemu(['add-device'])
    slots = await cdemuSlots()
    free = slots.find((s) => !s.loaded)
  }
  if (!free) throw new Error('CDEmu has no free virtual drive.')
  const slot = free.slot
  await cdemu(['load', String(slot), descriptor])
  let device: string | undefined
  for (let i = 0; i < 20 && !device; i++) {
    device = await cdemuDevice(slot).catch(() => undefined)
    if (!device) await sleep(250)
  }
  if (!device) {
    await cdemu(['unload', String(slot)]).catch(() => {})
    throw new Error('CDEmu loaded the image but its virtual drive did not show up.')
  }
  rememberLoop(device, descriptor, slot)
  // Wait for udev to see the disc, then mount it like a real one.
  for (let i = 0; i < 40; i++) {
    if ((await udevProps(device))?.ID_CDROM_MEDIA === '1') break
    await sleep(250)
  }
  const mountpoint = await mountDevice(device)
  if (!mountpoint) {
    await unmountDiscImage({ device, via: 'cdemu', slot })
    throw new Error('The disc in CDEmu could not be mounted.')
  }
  return { device, mountpoint, label: await volumeLabel(device), via: 'cdemu', slot }
}

// ---- public -----------------------------------------------------------------------------------------

/** Mount any supported disc image. See the top of this file for how. */
export async function mountDiscImage(file: string, hooks: MountHooks = {}): Promise<ImageMount> {
  if (!fs.existsSync(file)) throw new Error(`The disc image is missing: ${file}`)
  const info = inspectImage(file)
  const music = info.audioTracks
    ? `${path.basename(file)} has ${info.audioTracks > 1 ? `${info.audioTracks} music tracks` : 'music (CD-audio) tracks'}`
    : undefined

  if (!info.plain && cdemuAvailable()) {
    try {
      hooks.progress?.('Loading the disc image into CDEmu…')
      return await mountWithCdemu(info.descriptor)
    } catch (e) {
      hooks.notice?.(`CDEmu could not load ${path.basename(info.descriptor)} (${(e as Error).message}). Using its data track only${music ? ', so the music is missing' : ''}.`)
    }
  } else if (music) {
    hooks.notice?.(`${music}, which only play when the image is loaded into a virtual drive. Install CDEmu (cdemu-client, cdemu-daemon and vhba-module-dkms) to hear them.`)
  }

  const l = info.layout
  if (!l) {
    // A filesystem this check doesn't know (e.g. HFS on a Mac/PC hybrid): let the kernel try, as before.
    if (/\.(iso|img)$/i.test(file)) {
      const m = await mountImage(file)
      return { device: m.loop, mountpoint: m.mountpoint, label: await volumeLabel(m.loop), via: 'loop' }
    }
    throw new Error(`No CD-ROM data track was found in ${path.basename(file)}. Is it a game disc image?`)
  }
  if (l.sector === 2048) {
    const m = await mountImage(l.file, l.start)
    return { device: m.loop, mountpoint: m.mountpoint, label: await volumeLabel(m.loop), via: 'loop' }
  }
  const iso = await toIso(l, hooks.progress)
  const m = await mountImage(iso)
  return { device: m.loop, mountpoint: m.mountpoint, label: await volumeLabel(m.loop), via: 'loop' }
}

export async function unmountDiscImage(m: Pick<ImageMount, 'device' | 'via' | 'slot'>) {
  if (m.via !== 'cdemu') return unmountImage(m.device)
  if (await mountpointOf(m.device)) {
    await run('udisksctl', ['unmount', '-b', m.device, '--no-user-interaction'], { timeout: 20000 })
    if (await mountpointOf(m.device)) await run('udisksctl', ['unmount', '-b', m.device, '--no-user-interaction', '--force'], { timeout: 20000 })
  }
  if (m.slot !== undefined && which('cdemu')) await cdemu(['unload', String(m.slot)]).catch(() => {})
  forgetLoop(m.device)
}

/** Release what an earlier DiscPlay left in CDEmu, but only if that slot still holds the same image. */
export async function releaseLeftover(l: { loop: string; file: string; cdemu?: number }) {
  if (l.cdemu === undefined) return unmountImage(l.loop)
  const slot = which('cdemu') ? (await cdemuSlots().catch(() => [])).find((s) => s.slot === l.cdemu) : undefined
  if (slot?.loaded && path.resolve(slot.file) === l.file) await unmountDiscImage({ device: l.loop, via: 'cdemu', slot: l.cdemu })
  else forgetLoop(l.loop)
}

/**
 * Find the rest of a multi-disc image set next to one image: "Game (Disc 1).cue" → Disc 2, Disc 3…,
 * also CD1/CD2, Disk_1, DVD 2 and plain trailing numbers ("game1.iso"). Returns disc order, the given
 * file included. Of "x.cue" + "x.bin" only the cue sheet counts.
 */
export function findDiscSet(file: string): string[] {
  const dir = path.dirname(file)
  file = preferredImage(file)
  const name = path.basename(file)
  const patterns = [/(disc|disk|cd|dvd|part)([\s._-]*)(\d{1,2})/i, /()()(\d{1,2})(?=[^\d]*\.[^.]+$)/]
  let files: string[]
  try {
    files = preferredOnly(fs.readdirSync(dir).filter((f) => IMAGE_EXT.test(f)))
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

/** Of each group of files sharing a name ("x.cue", "x.bin"), keep the one to open. */
function preferredOnly(names: string[]) {
  const best = new Map<string, string>()
  const rank = (f: string) => PREFERRED.indexOf(path.extname(f).toLowerCase())
  for (const f of names) {
    const key = f.replace(/\.[^.]+$/, '').toLowerCase()
    const cur = best.get(key)
    if (!cur || rank(f) < rank(cur)) best.set(key, f)
  }
  return [...best.values()]
}

/** "x.bin" → "x.cue" when the cue sheet is there (likewise .mdf → .mds, CloneCD .img → .ccd). */
export function preferredImage(file: string) {
  for (const ext of PREFERRED) {
    if (ext === path.extname(file).toLowerCase()) return file
    const s = sibling(file, ext)
    if (s) return s
  }
  return file
}
