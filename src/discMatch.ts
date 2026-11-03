import type { DriveState, Game } from '../shared/types'

export interface DiscSuggestion {
  game: Game
  score: number
  /** Short reason shown to the user */
  why: string
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim()
const compact = (s: string) => norm(s).replace(/ /g, '')

/** "DSLOA2" → "dsloa", "SIMS_DISC_2" → "sims", "MYST CD1" → "myst" */
export function labelStem(label: string) {
  return compact(label)
    .replace(/(disc|disk|cd|dvd|part)?0*\d{1,2}$/, '')
    .replace(/(disc|disk|cd|dvd)$/, '')
}

const SMALL = new Set(['the', 'of', 'and', 'a', 'an', 'in', 'on', 'to', 'for', 'de', 'la', 'le', 'och', 'i'])

/** First letters of the title's words: "Dungeon Siege: Legends of Aranna" → "dsloa" and "dsla" */
function initials(title: string) {
  const words = norm(title).split(' ').filter(Boolean)
  return [words.map((w) => w[0]).join(''), words.filter((w) => !SMALL.has(w)).map((w) => w[0]).join('')]
}

function words(s: string) {
  return new Set(norm(s).split(' ').filter((w) => w.length > 2 && !SMALL.has(w)))
}

/** How likely an unrecognised disc belongs to a game in the library, best first. */
export function suggestGames(drive: DriveState, games: Game[]): DiscSuggestion[] {
  const label = drive.label ?? ''
  const stem = labelStem(label)
  const hint = drive.suggestedTitle ?? ''
  const out: DiscSuggestion[] = []
  for (const game of games) {
    let score = 0
    let why = ''
    const bump = (s: number, w: string) => {
      if (s > score) {
        score = s
        why = w
      }
    }
    // Another disc of the same set: DSLOA1 is linked, DSLOA2 just went in.
    const sibling = game.disc.labels.find((l) => stem.length >= 3 && labelStem(l) === stem)
    if (sibling) bump(100, `same disc set as “${sibling}”`)
    // An add-on's disc of the same set
    const addon = game.addons?.find((a) => a.labels.some((l) => stem.length >= 3 && labelStem(l) === stem))
    if (addon) bump(95, `same disc set as ${addon.title}`)

    const title = compact(game.title)
    if (stem.length >= 4 && (title.startsWith(stem) || title.includes(stem))) bump(80, 'label matches the title')
    if (stem.length >= 3 && initials(game.title).some((i) => i.length >= 3 && (i === stem || (stem.length >= 4 && i.startsWith(stem)))))
      bump(80, 'label matches the title’s initials')
    // autorun.inf title or label words vs the game's title words
    for (const source of [hint, label.replace(/_/g, ' ')]) {
      const a = words(source)
      const b = words(game.title)
      if (!a.size || !b.size) continue
      const common = [...a].filter((w) => b.has(w)).length
      if (common) bump(Math.round((common / Math.min(a.size, b.size)) * 70), source === hint ? 'disc title matches' : 'label matches the title')
    }
    if (score > 0) out.push({ game, score, why })
  }
  return out.sort((x, y) => y.score - x.score || x.game.title.localeCompare(y.game.title))
}

/** The suggestion to offer on the stage, if one is clearly ahead. */
export function bestSuggestion(drive: DriveState, games: Game[]) {
  const [first, second] = suggestGames(drive, games)
  if (!first || first.score < 50) return undefined
  if (second && second.score >= first.score && first.score < 100) return undefined
  return first
}

/** The game's disc spec with this label added (case-insensitive). A game that ran without a disc now uses it if it's in. */
export function withLabel(game: Game, label: string, playFromDisc: boolean): Game['disc'] {
  const has = game.disc.labels.some((l) => l.toLowerCase() === label.toLowerCase())
  const disc = { ...game.disc, labels: has ? game.disc.labels : [...game.disc.labels, label] }
  if (disc.source === 'none' || playFromDisc) disc.source = 'drive'
  return disc
}
