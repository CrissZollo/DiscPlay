import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Game } from '../shared/types'
import { importArt } from './art'
import { heroicConfig, home } from './paths'
import { store } from './store'
import { quoteArg, splitCommand } from './util'

interface HeroicGame {
  app_name: string
  title: string
  install?: { executable?: string; platform?: string }
  folder_name?: string
  art_cover?: string
  art_square?: string
  art_logo?: string
}

function readJson<T>(f: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')) as T
  } catch {
    return undefined
  }
}

function sideloads(): HeroicGame[] {
  return readJson<{ games: HeroicGame[] }>(path.join(heroicConfig, 'sideload_apps/library.json'))?.games ?? []
}

export function heroicPreview() {
  const have = new Set(store.library().flatMap((g) => (g.source?.kind === 'heroic' ? [g.source.appName] : [])))
  return sideloads().map((g) => ({ appName: g.app_name, title: g.title, already: have.has(g.app_name) }))
}

/** Settings a cd-game-fix wrapper script has baked in. */
function wrapperConfig(file: string) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const get = (k: string) => new RegExp(`^${k}=("([^"]*)"|(\\S*))`, 'm').exec(text)?.slice(2).find((v) => v !== undefined)
    return { label: get('DISC_LABEL'), letter: get('LETTER'), require: get('REQUIRE_DISC') }
  } catch {
    return {}
  }
}

/** disc-autoinstall's map of disc labels to Heroic app names. */
function knownDiscLabels() {
  const data = readJson<{ discs: Record<string, { app_names?: string[] }> }>(path.join(home, '.config/disc-autoinstall/discs.json'))
  const map = new Map<string, string[]>()
  for (const [label, d] of Object.entries(data?.discs ?? {})) {
    for (const app of d.app_names ?? []) map.set(app, [...(map.get(app) ?? []), label])
  }
  return map
}

function colorFor(s: string) {
  const h = parseInt(crypto.createHash('md5').update(s).digest('hex').slice(0, 4), 16) % 360
  return `hsl(${h} 70% 55%)`
}

export async function heroicImport(appNames: string[]) {
  const labels = knownDiscLabels()
  let count = 0
  for (const hg of sideloads().filter((g) => appNames.includes(g.app_name))) {
    const cfgFile = readJson<Record<string, any>>(path.join(heroicConfig, 'GamesConfig', `${hg.app_name}.json`))
    const cfg = cfgFile?.[hg.app_name] ?? {}
    const exe = hg.install?.executable ?? ''
    const native = hg.install?.platform === 'linux' || hg.install?.platform === 'Linux'
    const wine = cfg.wineVersion as { bin?: string; type?: string } | undefined
    const wrappers = ((cfg.wrapperOptions ?? []) as { exe: string; args?: string }[]).filter((w) => w.exe)
    const wrapper = wrappers.map((w) => [quoteArg(w.exe), w.args ?? ''].join(' ').trim()).join(' ')
    const wcfg = wrappers.length ? wrapperConfig(wrappers[0].exe) : {}
    const existing = store.library().find((g) => g.source?.kind === 'heroic' && g.source.appName === hg.app_name)
    // Keep the labels of add-on discs installed through DiscPlay on a refresh.
    const addonLabels = existing?.addons?.flatMap((a) => a.labels) ?? []
    const discLabels = [...new Set([...(labels.get(hg.app_name) ?? []), ...(wcfg.label ? [wcfg.label] : []), ...addonLabels])]
    const env: Record<string, string> = {}
    for (const e of (cfg.enviromentOptions ?? []) as { key: string; value: string }[]) if (e.key) env[e.key] = e.value

    const id = existing?.id ?? crypto.randomUUID()
    const game: Game = {
      id,
      title: hg.title,
      runner: native ? 'native' : wine?.type === 'proton' ? 'umu' : 'wine',
      executable: exe,
      args: cfg.launcherArgs ? splitCommand(cfg.launcherArgs) : [],
      workingDir: exe ? path.dirname(exe) : undefined,
      prefix: cfg.winePrefix,
      protonPath: wine?.type === 'proton' && wine.bin ? path.dirname(wine.bin) : undefined,
      wineBinary: wine?.type === 'wine' ? wine.bin : undefined,
      wrapper: wrapper || undefined,
      env,
      disc: {
        source: discLabels.length ? 'drive' : 'none',
        labels: discLabels,
        letter: wcfg.letter || 'd',
        required: wcfg.require === '1',
      },
      art: existing?.art ?? {},
      color: existing?.color ?? colorFor(hg.title),
      addedAt: existing?.addedAt ?? Date.now(),
      lastPlayed: existing?.lastPlayed,
      playtimeSeconds: existing?.playtimeSeconds ?? 0,
      source: { kind: 'heroic', appName: hg.app_name },
      addons: existing?.addons,
      addonOf: existing?.addonOf,
    }
    // Heroic's art_cover is usually a wide hero image, art_square the portrait grid.
    const wanted: [keyof Game['art'], string | undefined][] = [
      ['cover', hg.art_square || hg.art_cover],
      ['hero', hg.art_cover],
      ['logo', hg.art_logo],
    ]
    for (const [kind, url] of wanted) {
      if (!url || game.art[kind]) continue
      try {
        game.art[kind] = await importArt(id, kind, url)
      } catch (e) {
        console.warn('art', hg.title, kind, e)
      }
    }
    store.save(game)
    count++
  }
  return count
}
