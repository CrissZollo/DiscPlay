import fs from 'node:fs'
import path from 'node:path'

/** Heroic/Proton prefixes may keep the real Wine prefix in a `pfx` subfolder. */
export function realPrefix(prefix: string) {
  const pfx = path.join(prefix, 'pfx')
  if (fs.existsSync(path.join(pfx, 'dosdevices')) || fs.existsSync(path.join(pfx, 'system.reg'))) return pfx
  return prefix
}

export function prefixReady(prefix: string) {
  return fs.existsSync(path.join(realPrefix(prefix), 'system.reg'))
}

/** Point the Wine drive letter at a mounted disc (letter: -> mountpoint, letter:: -> block device). */
export function linkDisc(prefix: string, letter: string, mountpoint: string, device?: string) {
  const dos = path.join(realPrefix(prefix), 'dosdevices')
  fs.mkdirSync(dos, { recursive: true })
  const l = letter.toLowerCase().replace(/:$/, '')
  replaceLink(path.join(dos, `${l}:`), mountpoint)
  if (device) replaceLink(path.join(dos, `${l}::`), device)
  ensureCdromRegistry(prefix, l)
}

/** What a drive letter pointed at before DiscPlay linked a disc there (null: nothing). */
export interface DriveLinks {
  /** letter: → folder */
  dir: string | null
  /** letter:: → block device */
  device: string | null
}

function readLink(at: string) {
  try {
    return fs.readlinkSync(at)
  } catch {
    return null
  }
}

export function readDriveLinks(prefix: string, letter: string): DriveLinks {
  const dos = path.join(realPrefix(prefix), 'dosdevices')
  const l = letter.toLowerCase().replace(/:$/, '')
  return { dir: readLink(path.join(dos, `${l}:`)), device: readLink(path.join(dos, `${l}::`)) }
}

/** Put a drive letter back the way it was before a disc session. */
export function restoreDriveLinks(prefix: string, letter: string, links: DriveLinks) {
  const dos = path.join(realPrefix(prefix), 'dosdevices')
  const l = letter.toLowerCase().replace(/:$/, '')
  for (const [name, target] of [[`${l}:`, links.dir], [`${l}::`, links.device]] as const) {
    const at = path.join(dos, name)
    // Only touch symlinks: a real folder at this name was never ours.
    if (readLink(at) === null && fs.existsSync(at)) continue
    try {
      fs.rmSync(at, { force: true })
      if (target) fs.symlinkSync(target, at)
    } catch {}
  }
}

function replaceLink(at: string, target: string) {
  try {
    fs.rmSync(at, { force: true })
  } catch {}
  fs.symlinkSync(target, at)
}

/** Make sure Wine treats the letter as a CD-ROM drive ([Software\\Wine\\Drives] "d:"="cdrom"). */
export function ensureCdromRegistry(prefix: string, letter: string) {
  const reg = path.join(realPrefix(prefix), 'system.reg')
  if (!fs.existsSync(reg)) return
  const text = fs.readFileSync(reg, 'utf8')
  const entry = `"${letter}:"="cdrom"`
  const header = /^\[Software\\\\Wine\\\\Drives\][^\n]*\n/m
  const m = header.exec(text)
  if (m) {
    // Look inside this section only
    const start = m.index + m[0].length
    const next = text.indexOf('\n[', start)
    const body = text.slice(start, next < 0 ? undefined : next)
    const re = new RegExp(`^"${letter}:"=.*$`, 'mi')
    let newBody: string
    if (re.test(body)) {
      if (body.match(re)![0].toLowerCase() === entry) return
      newBody = body.replace(re, entry)
    } else {
      const lines = body.split('\n')
      const at = lines[0]?.startsWith('#time=') ? 1 : 0
      lines.splice(at, 0, entry)
      newBody = lines.join('\n')
    }
    fs.writeFileSync(reg, text.slice(0, start) + newBody + (next < 0 ? '' : text.slice(next)))
  } else {
    const t = Math.floor(Date.now() / 1000)
    fs.writeFileSync(reg, `${text.replace(/\n*$/, '\n')}\n[Software\\\\Wine\\\\Drives] ${t}\n${entry}\n`)
  }
}

const SKIP = /^(unins|uninst|uninstall|setup|install|isuninst|_isdel|dxsetup|vcredist|dotnet|directx|quicktime|readme|register|regist|autorun|update|patch|crashreport|bugreport|config|settings|launcher-?setup)/i

/** All .exe files under the prefix's Program Files folders. */
export function listExes(prefix: string) {
  const root = path.join(realPrefix(prefix), 'drive_c')
  const out = new Map<string, { size: number; mtime: number }>()
  const dirs = ['Program Files', 'Program Files (x86)', 'GOG Games', 'Games'].map((d) => path.join(root, d))
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (/^(Common Files|Internet Explorer|Windows (Media Player|NT|Mail|Photo Viewer)|Microsoft\.NET|WindowsPowerShell|Uninstall Information)$/i.test(e.name)) continue
        walk(p, depth + 1)
      } else if (/\.exe$/i.test(e.name)) {
        try {
          const st = fs.statSync(p)
          out.set(p, { size: st.size, mtime: st.mtimeMs })
        } catch {}
      }
    }
  }
  dirs.forEach((d) => walk(d, 0))
  return out
}

export function looksLikeGameExe(file: string) {
  return !SKIP.test(path.basename(file))
}
