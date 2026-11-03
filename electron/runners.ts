import fs from 'node:fs'
import path from 'node:path'
import type { ProtonVersion, RunnerInfo } from '../shared/types'
import { heroicConfig, home } from './paths'
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

/** wineserver belonging to a Proton build (used to wait for / kill a prefix). */
export function protonWineserver(protonPath?: string) {
  if (!protonPath) return which('wineserver')
  for (const sub of ['files/bin/wineserver', 'dist/bin/wineserver']) {
    const p = path.join(protonPath, sub)
    if (fs.existsSync(p)) return p
  }
  return which('wineserver')
}
