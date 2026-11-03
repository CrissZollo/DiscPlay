import fs from 'node:fs'
import path from 'node:path'
import type { Game, Settings } from '../shared/types'
import { home } from './paths'
import { libraryFile, settingsFile } from './paths'

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file)
}

export const defaultSettings = (): Settings => ({
  theme: 'console',
  sound: true,
  steamGridDbKey: '',
  prefixBase: path.join(home, 'Games/DiscPlay/Prefixes'),
  driveDevice: 'auto',
  autoInsert: true,
  offerInstall: true,
  startFullscreen: false,
})

class Store {
  private games: Game[] | null = null
  private settings: Settings | null = null

  library(): Game[] {
    if (!this.games) this.games = readJson<{ games: Game[] }>(libraryFile(), { games: [] }).games
    return this.games
  }

  get(id: string) {
    return this.library().find((g) => g.id === id)
  }

  save(game: Game) {
    const lib = this.library()
    const i = lib.findIndex((g) => g.id === game.id)
    if (i >= 0) lib[i] = game
    else lib.push(game)
    this.flush()
    return game
  }

  remove(id: string) {
    this.games = this.library().filter((g) => g.id !== id)
    this.flush()
  }

  flush() {
    writeJson(libraryFile(), { version: 1, games: this.library() })
  }

  getSettings(): Settings {
    if (!this.settings) {
      this.settings = { ...defaultSettings(), ...readJson<Partial<Settings>>(settingsFile(), {}) }
      // The old default; automatic covers it and also follows a USB drive that comes back as sr1.
      if (this.settings.driveDevice === '/dev/sr0' || !this.settings.driveDevice) this.settings.driveDevice = 'auto'
    }
    return this.settings
  }

  saveSettings(s: Settings) {
    this.settings = { ...defaultSettings(), ...s }
    writeJson(settingsFile(), this.settings)
    return this.settings
  }
}

export const store = new Store()
