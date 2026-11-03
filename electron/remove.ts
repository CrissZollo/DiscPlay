import fs from 'node:fs'
import path from 'node:path'
import type { RemovalInfo, RemoveOptions } from '../shared/types'
import { artPath } from './art'
import { home, logDir } from './paths'
import { prefixReady } from './prefix'
import { store } from './store'

const same = (a: string, b: string) => path.resolve(a) === path.resolve(b)

/** Only ever delete a folder that really is a Wine prefix, and never a top-level one. */
function looksLikePrefix(p: string) {
  const abs = path.resolve(p)
  if (!path.isAbsolute(p) || abs === home || abs.split('/').filter(Boolean).length < 3) return false
  return prefixReady(abs) || fs.existsSync(path.join(abs, 'pfx')) || fs.existsSync(path.join(abs, 'drive_c'))
}

/** What removing a game would touch: its add-on games, and whether its prefix may be deleted. */
export function removalInfo(id: string): RemovalInfo {
  const game = store.get(id)
  if (!game) throw new Error('This game is no longer in the library.')
  const lib = store.library()
  const addonGames = lib.filter((g) => g.addonOf === id).map((g) => ({ id: g.id, title: g.title }))
  const prefix = game.runner !== 'native' ? game.prefix : undefined
  if (!prefix) return { addonGames }
  const sharers = lib.filter((g) => g.id !== id && g.runner !== 'native' && g.prefix && same(g.prefix, prefix))
  const others = sharers.filter((g) => g.addonOf !== id)
  let prefixNote: string | undefined
  if (game.source?.kind === 'heroic' || others.some((g) => g.source?.kind === 'heroic'))
    prefixNote = 'Heroic manages this Windows environment. Uninstall the game in Heroic to delete it.'
  else if (!fs.existsSync(prefix)) prefixNote = 'The Windows environment is already gone.'
  else if (!looksLikePrefix(prefix)) prefixNote = "This folder doesn't look like a Wine prefix, so DiscPlay won't delete it."
  else if (others.length) prefixNote = `Shared with ${others.map((g) => g.title).join(', ')}, so it is kept.`
  return { addonGames, prefix, prefixNote, prefixNeedsAddons: sharers.length > 0 && !others.length }
}

/**
 * Remove a game, and with it its cached art and log. Optionally its add-on games and its prefix.
 * Add-on games that stay become ordinary games (they keep working: the prefix is theirs too then).
 */
export function removeGame(id: string, opts: RemoveOptions = {}) {
  const info = removalInfo(id)
  if (opts.prefix) {
    if (!info.prefix) throw new Error('This game has no Windows environment to delete.')
    if (info.prefixNote) throw new Error(info.prefixNote)
    if (info.prefixNeedsAddons && !opts.addons) throw new Error('Its add-ons use the same Windows environment. Remove them too, or keep the environment.')
  }
  const ids = new Set([id, ...(opts.addons ? info.addonGames.map((g) => g.id) : [])])
  const removed = store.library().filter((g) => ids.has(g.id))
  for (const g of store.library()) if (g.addonOf === id && !ids.has(g.id)) store.save({ ...g, addonOf: undefined })
  for (const g of removed) store.remove(g.id)

  // Art is a cached copy; drop it unless a remaining game uses the same file.
  const inUse = new Set(store.library().flatMap((g) => Object.values(g.art).filter(Boolean) as string[]))
  for (const g of removed) {
    for (const name of Object.values(g.art)) {
      const file = name && !inUse.has(name) ? artPath(name) : undefined
      if (file) fs.rmSync(file, { force: true })
    }
    fs.rmSync(path.join(logDir(), `${g.id}.log`), { force: true })
  }
  if (opts.prefix && info.prefix) fs.rmSync(info.prefix, { recursive: true, force: true })
  return removed.map((g) => g.id)
}
