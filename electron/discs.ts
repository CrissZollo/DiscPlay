import { EventEmitter } from 'node:events'
import path from 'node:path'
import type { DiscSessionInfo, DriveState } from '../shared/types'
import { ejectForSwap, mountDevice, mountImage, unmountImage, volumeLabel, type DriveWatcher } from './drive'
import { linkDisc } from './prefix'

interface Options {
  owner: string
  /** Wine prefix whose drive letter follows the disc; none for native games */
  prefix?: string
  letter: string
  log?: (line: string) => void
  /** Which inserted discs to link (drive sessions). Default: any data disc. */
  accept?: (d: DriveState) => boolean
}

/**
 * The disc(s) a running installer or game uses. Keeps the prefix's drive letter pointed at the
 * right disc as it changes: for a physical drive it follows every disc that goes in (the mount point
 * changes with each label), for images it swaps between the images of a set on request.
 */
export class DiscSession extends EventEmitter {
  readonly kind: 'drive' | 'image'
  private images: string[] = []
  private mounts = new Map<number, { loop: string; mountpoint: string; label?: string }>()
  private current = -1
  private label?: string
  private linked?: string
  private labels: string[] = []
  private busy = false
  private message?: string
  private queue: Promise<unknown> = Promise.resolve()
  private onDrive?: (d: DriveState) => void
  private closed = false

  constructor(
    private drive: DriveWatcher | null,
    private opts: Options,
    images?: string[],
  ) {
    super()
    this.kind = images?.length ? 'image' : 'drive'
    this.images = images ?? []
  }

  /** Mount point of the disc that is in now */
  get root() {
    return this.linked
  }

  /** Every label seen, in order */
  seenLabels() {
    return [...this.labels]
  }

  info(): DiscSessionInfo {
    return {
      owner: this.opts.owner,
      kind: this.kind,
      letter: this.opts.letter,
      images: this.images.map((f) => path.basename(f)),
      current: this.current,
      label: this.label,
      labels: this.seenLabels(),
      busy: this.busy || undefined,
      message: this.message,
    }
  }

  private changed() {
    if (!this.closed) this.emit('change', this.info())
  }

  /** Run swaps one at a time; drive events can arrive while a mount is still in progress. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => {})
    return next
  }

  private see(label?: string) {
    this.label = label
    if (label && !this.labels.includes(label)) this.labels.push(label)
  }

  private link(mountpoint: string, device?: string) {
    this.linked = mountpoint
    if (this.opts.prefix) linkDisc(this.opts.prefix, this.opts.letter, mountpoint, device)
  }

  /** Put image `i` of the set in. Earlier images stay mounted until the session closes, in case something still reads them. */
  useImage(i: number) {
    return this.serial(async () => {
      if (this.kind !== 'image' || i < 0 || i >= this.images.length) throw new Error('No such disc.')
      if (i === this.current) return
      this.busy = true
      this.message = `Inserting disc ${i + 1}…`
      this.changed()
      try {
        let m = this.mounts.get(i)
        if (!m) {
          const mounted = await mountImage(this.images[i])
          m = { ...mounted, label: await volumeLabel(mounted.loop) }
          this.mounts.set(i, m)
        }
        this.link(m.mountpoint, m.loop)
        this.current = i
        this.see(m.label ?? path.basename(this.images[i]).replace(/\.[^.]+$/, ''))
        this.opts.log?.(`Disc ${i + 1} (${path.basename(this.images[i])}) is in ${this.opts.letter.toUpperCase()}:`)
        this.message = undefined
      } catch (e) {
        this.message = (e as Error).message
        throw e
      } finally {
        this.busy = false
        this.changed()
      }
    })
  }

  /** Mount whatever is in the physical drive and link it. Returns the mount point, if any. */
  useDrive() {
    return this.serial(async () => {
      if (!this.drive) return undefined
      const d = this.drive.state
      if (!d.hasDisc) return undefined
      const mp = await mountDevice(this.drive.device)
      if (!mp) return undefined
      if (mp !== this.linked) {
        this.link(mp, this.drive.device)
        this.see(d.label)
        this.opts.log?.(`Disc “${d.label ?? '?'}” is in ${this.opts.letter.toUpperCase()}: (${mp})`)
        this.message = undefined
        this.changed()
      }
      return mp
    })
  }

  /** Keep following the physical drive: every accepted disc that goes in is mounted and linked. */
  follow() {
    if (!this.drive || this.onDrive) return
    this.onDrive = (d: DriveState) => {
      if (!d.hasDisc) {
        if (this.label !== undefined || this.linked) {
          this.label = undefined
          this.linked = undefined
          this.changed()
        }
        return
      }
      if (d.media === 'audio') return
      if (this.opts.accept && !this.opts.accept(d)) return
      // The mount point changes with each disc (it is named after the label), so relink when it does.
      if (d.label === this.label && d.mountpoint && d.mountpoint === this.linked) return
      this.useDrive().catch((e) => this.opts.log?.(`Could not mount the new disc: ${(e as Error).message}`))
    }
    this.drive.on('change', this.onDrive)
  }

  /** Open the drive so the next disc can go in. */
  eject() {
    return this.serial(async () => {
      if (!this.drive) return
      this.busy = true
      this.message = 'Ejecting…'
      this.changed()
      try {
        await ejectForSwap(this.drive.device)
        this.opts.log?.('Disc ejected – insert the next one.')
        this.message = undefined
        this.label = undefined
        this.linked = undefined
      } catch (e) {
        this.message = (e as Error).message
        throw e
      } finally {
        this.busy = false
        this.changed()
        this.drive.soon(800)
      }
    })
  }

  async close() {
    if (this.closed) return
    this.closed = true
    if (this.onDrive) this.drive?.off('change', this.onDrive)
    await this.queue
    for (const m of this.mounts.values()) await unmountImage(m.loop).catch(() => {})
    this.mounts.clear()
  }
}
