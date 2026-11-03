// Installs a .desktop launcher + icon so DiscPlay shows up in the app menu (runs from this checkout).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const apps = path.join(os.homedir(), '.local/share/applications')
const icons = path.join(os.homedir(), '.local/share/icons/hicolor/scalable/apps')
fs.mkdirSync(apps, { recursive: true })
fs.mkdirSync(icons, { recursive: true })
fs.copyFileSync(path.join(root, 'build/icon.svg'), path.join(icons, 'discplay.svg'))
const electron = path.join(root, 'node_modules/.bin/electron')
const appImage = fs.existsSync(path.join(root, 'release')) && fs.readdirSync(path.join(root, 'release')).find((f) => f.endsWith('.AppImage'))
const exec = appImage ? `"${path.join(root, 'release', appImage)}" %U` : `"${electron}" "${root}" %U`
fs.writeFileSync(
  path.join(apps, 'discplay.desktop'),
  `[Desktop Entry]
Type=Application
Name=DiscPlay
Comment=Play your old PC disc games
Exec=${exec}
Icon=discplay
Terminal=false
Categories=Game;
StartupWMClass=DiscPlay
`,
)
console.log('Installed', path.join(apps, 'discplay.desktop'))
