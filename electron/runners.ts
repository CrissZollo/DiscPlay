import fs from 'node:fs'
import path from 'node:path'
import type { ProtonVersion, RunnerInfo } from '../shared/types'
import { heroicConfig, home } from './paths'
import { store } from './store'
import { isExecutable, which } from './util'

const protonDirs = [
  path.join(home, '.local/share/Steam/compatibilitytools.d'),
  path.join(home, '.steam/root/compatibilitytools.d'),
  path.join(home, '.steam/steam/compatibilitytools.d'),
  path.join(heroicConfig, 'tools/proton'),
  '/usr/share/steam/compatibilitytools.d',
  path.join(home, '.local/share/Steam/steamapps/common'),
]

export function findProtons(): ProtonVersion[] {
  const seen = new Map<string, ProtonVersion>()
  for (const dir of protonDirs) {
    let entries: string[] = []
    try {
      entries = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      const p = path.join(dir, name)
      if (!fs.existsSync(path.join(p, 'proton'))) continue
      let real = p
      try {
        real = fs.realpathSync(p)
      } catch {}
      if (![...seen.values()].some((v) => v.path === real)) seen.set(name, { name, path: real })
    }
  }
  // Newest first: GE-Proton11-9 > GE-Proton10-25 > Proton 9.0
  return [...seen.values()].sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
}

export function findUmu(): string | undefined {
  const fromPath = which('umu-run')
  if (fromPath) return fromPath
  for (const p of [
    path.join(heroicConfig, 'tools/runtimes/umu/umu_run.py'),
    path.join(heroicConfig, 'tools/runtimes/umu/umu-run'),
    path.join(home, '.local/bin/umu-run'),
  ]) {
    if (fs.existsSync(p)) return p
  }
}

/** umu_run.py may lack the executable bit; run it through python then. */
export function umuCommand(umu: string): string[] {
  if (umu.endsWith('.py') && !isExecutable(umu)) return ['python3', umu]
  return [umu]
}

export function runnerInfo(): RunnerInfo {
  return { umu: findUmu(), wine: which('wine'), protons: findProtons() }
}

const isProton = (p?: string): p is string => !!p && fs.existsSync(path.join(p, 'proton'))

/**
 * The Proton build to run with. A game's saved build may have been removed since (old GE-Proton
 * versions get cleaned out); then the default, or the newest installed, is used and `note` says so.
 */
export function resolveProton(wanted?: string): { path?: string; note?: string } {
  if (isProton(wanted)) return { path: wanted }
  const def = store.getSettings().defaultProton
  const fallback = isProton(def) ? def : findProtons()[0]?.path
  if (!wanted || !fallback) return { path: fallback }
  return {
    path: fallback,
    note: `${path.basename(wanted)} is no longer installed – using ${path.basename(fallback)} instead. Pick a Proton version in the game's editor to make this stick.`,
  }
}

/** wineserver belonging to a Proton build (used to wait for / kill a prefix). */
export function protonWineserver(protonPath?: string) {
  const proton = resolveProton(protonPath).path
  if (!proton) return which('wineserver')
  for (const sub of ['files/bin/wineserver', 'dist/bin/wineserver']) {
    const p = path.join(proton, sub)
    if (fs.existsSync(p)) return p
  }
  return which('wineserver')
}
