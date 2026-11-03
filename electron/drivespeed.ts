import fs from 'node:fs'
import path from 'node:path'
import { run } from './util'

/**
 * Optical drive read speed.
 *
 * Some old installers and games time a read from the disc and refuse to go on when the drive is
 * slower than they want ("needs an 8× CD-ROM"). A drive can be left slowed down (`eject -x 4`, or
 * a drive that picks a low speed itself), so DiscPlay sets the speed when a disc asks for one.
 *
 * Disney Interactive's installer (2000–2003) says so in setup/INSTALL.INI: `CDSPEED=8X`, with
 * `SKIP_CDROM_TEST=0`. Other installers that write the minimum into an INI file use similar keys.
 */

/** A minimum speed a disc declares, and the file that says so. */
export interface SpeedNeed {
  speed: number
  file: string
}

/** INI keys that hold a minimum CD-ROM speed, e.g. CDSPEED=8X, MinCDSpeed=4, CDROM_SPEED=8x. */
const SPEED_KEY = /^\s*(?:min(?:imum)?_?)?cd_?(?:rom_?)?speed(?:_?min(?:imum)?)?\s*=\s*(\d{1,2})\s*x?\s*(?:;.*)?$/im
/** The installer was told not to run its CD-ROM test. */
const SKIP_TEST = /^\s*skip_?cd_?(?:rom_?)?(?:speed_?)?test\s*=\s*(?:1|y|yes|true)\s*$/im

/** Folders on a disc where installers keep their INI files. */
const INI_DIRS = ['', 'setup', 'install', 'data', 'disk1']
const MAX_INI_SIZE = 256 * 1024

const cache = new Map<string, SpeedNeed | null>()

function caseless(dir: string, name: string) {
  try {
    const hit = fs.readdirSync(dir).find((f) => f.toLowerCase() === name.toLowerCase())
    return hit ? path.join(dir, hit) : undefined
  } catch {
    return undefined
  }
}

/**
 * The minimum read speed a mounted disc asks for, if it says. Reads only small INI files in the disc
 * root and a few usual setup folders. Cached per mount point and label, since discs don't change.
 */
export function discSpeedNeed(root: string, label = ''): SpeedNeed | null {
  const key = `${root}\0${label}`
  if (cache.has(key)) return cache.get(key)!
  let found: SpeedNeed | null = null
  for (const d of INI_DIRS) {
    const dir = d ? caseless(root, d) : root
    if (!dir) continue
    let files: string[] = []
    try {
      files = fs.readdirSync(dir).filter((f) => /\.ini$/i.test(f) && !/^autorun\.inf$/i.test(f))
    } catch {}
    for (const f of files) {
      const file = path.join(dir, f)
      try {
        if (fs.statSync(file).size > MAX_INI_SIZE) continue
        const text = fs.readFileSync(file, 'latin1')
        const m = SPEED_KEY.exec(text)
        if (!m || SKIP_TEST.test(text)) continue
        const speed = Number(m[1])
        if (speed >= 1 && (!found || speed > found.speed)) found = { speed, file: path.relative(root, file) }
      } catch {}
    }
  }
  cache.set(key, found)
  return found
}

/** "full speed" or "8×" */
export function speedName(speed: number) {
  return speed === 0 ? 'full speed' : `${speed}×`
}

/**
 * Set the drive's read speed (0 = the fastest it can do). No root needed: `eject -x` is the
 * CDROM_SELECT_SPEED ioctl, which works on a drive the user may open. Throws with eject's message.
 */
export async function setDriveSpeed(device: string, speed: number) {
  const r = await run('eject', ['-x', String(speed), device], { timeout: 15000 })
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `eject exited with ${r.code}`)
}

/**
 * The speed to set for a disc: the game's own setting, or with `auto` full speed when the disc says
 * it needs a minimum (the drive's actual speed can't be read without raw SCSI, so it isn't trusted).
 * undefined = leave the drive alone.
 */
export function speedFor(setting: number | undefined, root: string, label?: string): { speed: number; why: string } | undefined {
  if (setting !== undefined) return { speed: setting, why: 'set for this game' }
  const need = discSpeedNeed(root, label)
  if (!need) return undefined
  return { speed: 0, why: `the disc needs at least ${need.speed}× (${need.file})` }
}
