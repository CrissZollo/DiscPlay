import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ArtResult, GameArt, GridResult } from '../shared/types'
import { artDir } from './paths'
import { store } from './store'

const UA = 'DiscPlay/0.1 (+https://github.com/discplay)'

function extFrom(src: string, contentType?: string | null) {
  const m = /\.(png|jpe?g|webp|gif|ico|svg)(?:$|\?)/i.exec(src)
  if (m) return m[1].toLowerCase().replace('jpeg', 'jpg')
  if (contentType?.includes('png')) return 'png'
  if (contentType?.includes('webp')) return 'webp'
  if (contentType?.includes('svg')) return 'svg'
  return 'jpg'
}

/** Copy or download an image into the art cache. Returns the cached file name. */
export async function importArt(gameId: string, kind: keyof GameArt, source: string): Promise<string> {
  const tag = crypto.createHash('sha1').update(source).digest('hex').slice(0, 10)
  let data: Buffer
  let ext: string
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source, { headers: { 'User-Agent': UA } })
    if (!res.ok) throw new Error(`Download failed (${res.status}) for ${source}`)
    data = Buffer.from(await res.arrayBuffer())
    ext = extFrom(source, res.headers.get('content-type'))
  } else {
    data = fs.readFileSync(source.replace(/^file:\/\//, ''))
    ext = extFrom(source)
  }
  const name = `${gameId}-${kind}-${tag}.${ext}`
  fs.writeFileSync(path.join(artDir(), name), data)
  return name
}

export function artPath(name: string) {
  const p = path.join(artDir(), path.basename(name))
  return fs.existsSync(p) ? p : undefined
}

async function sgdb<T>(endpoint: string): Promise<T> {
  const key = store.getSettings().steamGridDbKey.trim()
  if (!key) throw new Error('Add a SteamGridDB API key in Settings to search for artwork.')
  const res = await fetch(`https://www.steamgriddb.com/api/v2${endpoint}`, {
    headers: { Authorization: `Bearer ${key}`, 'User-Agent': UA },
  })
  if (res.status === 401) throw new Error('SteamGridDB rejected the API key.')
  if (!res.ok) throw new Error(`SteamGridDB error ${res.status}`)
  const body = (await res.json()) as { success: boolean; data: T }
  return body.data
}

export async function gridSearch(term: string): Promise<GridResult[]> {
  const data = await sgdb<{ id: number; name: string; release_date?: number }[]>(
    `/search/autocomplete/${encodeURIComponent(term)}`,
  )
  return data.slice(0, 12).map((d) => ({
    id: d.id,
    name: d.name,
    year: d.release_date ? String(new Date(d.release_date * 1000).getFullYear()) : undefined,
  }))
}

export async function gridArt(gridId: number, kind: keyof GameArt): Promise<ArtResult[]> {
  const endpoint =
    kind === 'hero'
      ? `/heroes/game/${gridId}`
      : kind === 'logo'
        ? `/logos/game/${gridId}`
        : kind === 'disc'
          ? `/grids/game/${gridId}?dimensions=512x512,1024x1024`
          : `/grids/game/${gridId}?dimensions=600x900,342x482,660x930`
  const data = await sgdb<{ url: string; thumb: string; width: number; height: number }[]>(endpoint)
  return data.slice(0, 30).map((d) => ({ url: d.url, thumb: d.thumb, width: d.width, height: d.height }))
}
