import fs from 'node:fs'
import path from 'node:path'
import { configDir } from './paths'

/**
 * Loop devices DiscPlay has attached and not yet released. Kept on disk so that loop devices left
 * behind by a crash (or a kill) can be released the next time DiscPlay starts.
 */
interface OwnedLoop {
  loop: string
  file: string
  boot: string
}

const registry = () => path.join(configDir(), 'loops.json')

export function bootId() {
  try {
    return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  } catch {
    return ''
  }
}

function read(): OwnedLoop[] {
  try {
    return JSON.parse(fs.readFileSync(registry(), 'utf8')) as OwnedLoop[]
  } catch {
    return []
  }
}

function write(list: OwnedLoop[]) {
  try {
    if (!list.length) return fs.rmSync(registry(), { force: true })
    fs.mkdirSync(path.dirname(registry()), { recursive: true })
    fs.writeFileSync(registry(), JSON.stringify(list, null, 2))
  } catch {}
}

export function rememberLoop(loop: string, file: string) {
  write([...read().filter((l) => l.loop !== loop), { loop, file: path.resolve(file), boot: bootId() }])
}

export function forgetLoop(loop: string) {
  write(read().filter((l) => l.loop !== loop))
}

/** The image file a loop device is attached to right now, if any. */
export function loopBackingFile(loop: string) {
  try {
    return fs
      .readFileSync(`/sys/block/${path.basename(loop)}/loop/backing_file`, 'utf8')
      .trim()
      .replace(/ \(deleted\)$/, '')
  } catch {
    return undefined
  }
}

/**
 * Loop devices from an earlier run that still hold the same image. Entries from another boot, or
 * whose loop device now holds something else, are dropped (never touch a loop device we don't own).
 */
export function leftoverLoops(): OwnedLoop[] {
  const boot = bootId()
  const list = read()
  const still = list.filter((l) => l.boot === boot && loopBackingFile(l.loop) === l.file)
  if (still.length !== list.length) write(still)
  return still
}
