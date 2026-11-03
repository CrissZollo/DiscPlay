import type { DiscPlayApi, Game } from '../shared/types'

declare global {
  interface Window {
    discplay: DiscPlayApi
  }
}

export const api = window.discplay

export function artUrl(name?: string) {
  return name ? `dpart://art/${encodeURIComponent(name)}` : undefined
}

export function newGame(partial: Partial<Game> = {}): Game {
  const title = partial.title ?? ''
  return {
    id: crypto.randomUUID(),
    title,
    runner: 'umu',
    executable: '',
    args: [],
    env: {},
    disc: { source: 'none', labels: [], letter: 'd', required: false },
    art: {},
    color: colorFor(title || String(Math.random())),
    addedAt: Date.now(),
    playtimeSeconds: 0,
    ...partial,
  }
}

export function colorFor(s: string) {
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return `hsl(${h % 360} 70% 55%)`
}

export function formatPlaytime(sec: number) {
  if (!sec) return 'Never played'
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec % 3600) / 60)
  return h ? `${h} h ${m} min played` : `${m} min played`
}

export function formatAgo(ts?: number) {
  if (!ts) return ''
  const d = (Date.now() - ts) / 1000
  if (d < 90) return 'just now'
  if (d < 3600) return `${Math.round(d / 60)} min ago`
  if (d < 86400) return `${Math.round(d / 3600)} h ago`
  if (d < 86400 * 30) return `${Math.round(d / 86400)} days ago`
  return new Date(ts).toLocaleDateString()
}
