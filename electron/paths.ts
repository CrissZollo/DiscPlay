import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const home = os.homedir()
export const configDir = () => app.getPath('userData')
export const artDir = () => ensure(path.join(configDir(), 'art'))
export const logDir = () =>
  ensure(path.join(process.env.XDG_STATE_HOME || path.join(home, '.local/state'), 'discplay', 'logs'))
export const libraryFile = () => path.join(configDir(), 'library.json')
export const settingsFile = () => path.join(configDir(), 'settings.json')

export const heroicConfig = path.join(home, '.config/heroic')

function ensure(p: string) {
  fs.mkdirSync(p, { recursive: true })
  return p
}
