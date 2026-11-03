# DiscPlay

A Linux launcher for your old PC disc games, built around the disc itself. With no disc in, a
ghost disc floats in the empty drive. Put a real game disc in your drive, or pick one from the
shelf, and the disc flies into the drive and spins up. The game's artwork fades in behind it and
you press **Play**.

- **Real discs are first-class.** DiscPlay watches your optical drive(s) through udev (any drive by default, or one you pick; a USB drive is still found after replugging), without spinning the drive up. When a disc goes in, it is matched by volume label to its game, which comes up ready to play. Unknown discs get an *Install game* button.
- **Unknown discs** can be added to a game that is already in the library. DiscPlay suggests the likely game (another disc of a set it knows, such as `DSLOA2` next to `DSLOA1`, or a label that matches a title or its initials) with a one-click *Add to …*, or you pick the game yourself. The label is saved with the game, so the disc brings it up and counts as its disc from then on. When a game is waiting for its disc and a different one is in, *Use this disc* does the same and starts the game.
- **Rolling disc shelf.** Discs stand on a glossy floor and roll as the shelf moves.
- **Runs games with umu + Proton** (or plain Wine, or native Linux). For disc games it mounts the disc with udisks, points the prefix's `D:` at it (`d:` → mount, `d::` → device) and marks it as a CD-ROM in the registry. If the game needs its disc and it isn't in, a "Please insert the disc" prompt waits and starts the game as soon as the disc appears.
- **Disc images**: ISO, BIN/CUE, MDF/MDS, NRG and CloneCD (CCD/IMG/SUB). With [CDEmu](https://cdemu.sourceforge.io/) installed (`cdemu-client`, `cdemu-daemon`, `vhba-module-dkms`), images other than plain ISOs go into a virtual CD drive, so CD-audio music tracks play and copy-protection data is there. Without it, the data track is mounted read-only on its own: directly when it uses plain 2048-byte sectors, otherwise after converting it once to an ISO in `~/.cache/discplay/images` (kept up to 8 GB, least recently used first). DiscPlay says when an image has music that won't play that way. A game can have a set of images (Disc 1, Disc 2…); disc 1 goes in at launch and the others can be swapped in from the play screen.
- **Multi-disc games**: while a game runs, the drive letter follows the disc. Insert the next disc (*Change disc* opens the drive) and it is mounted and `D:` re-pointed at it, since each disc mounts at a path named after its label.
- **Install from disc**: creates a fresh prefix, runs `setup.exe` from `D:\`, then lists the programs it installed so you can pick the game. Multi-disc installs work: from a drive, *Eject* in the installer window and put in the next disc and `D:` follows it. From images, pick disc 1 and the rest of the set in the folder is found automatically (`Disc 1/2`, `CD1/CD2`, `game1/game2`…), then *Insert* the disc the installer asks for. Every disc label seen is saved, so any disc of the set brings the game up.
- **Add-on discs** (expansions, patches): *Add → Install an add-on disc*, *Install add-on…* in a game's editor, or *Install as add-on* on an unknown disc. The setup runs in that game's prefix with its Proton/Wine and environment (but not its wrapper). Afterwards you choose to put the add-on on the shelf as its own game sharing the prefix, have the game start the add-on's program, or keep the game as it is. In the last two cases the add-on's disc labels are added to the game. Add-ons are listed in the editor.
- **SafeDisc 2.x–4.x copy protection** is handled on its own. Wine can't load SafeDisc's `secdrv.sys` driver, so these games just quit a few seconds after starting. At launch DiscPlay looks for SafeDisc in the game's program (and the programs next to it), copies the bundled [SafeDiscShim](https://github.com/RibShark/SafeDiscShim) into the prefix (`drvmgt.dll` in `syswow64`, `C:\DiscPlay\safedisc-run.exe`) and starts the game through it. The original disc is still checked, so a SafeDisc game played from a drive always waits for its disc. The launch log says which version was found. Games already set up to start through `safedisc-run.exe` by hand are left as they are.
- **Drive speed**: some installers and games time a read from the disc and stop if the drive is slower than they want (Disney Interactive's installer, for example, says `CDSPEED=8X` in `setup/INSTALL.INI`). When a disc in the drive says it needs a minimum speed in an INI file, DiscPlay sets the drive to full speed (`eject -x 0`) before the installer or game starts, and again after each disc swap. *Drive speed* in a game's editor overrides this with full speed or a fixed speed. A fixed speed is set back to full speed when the game ends, so a slowed drive doesn't make the next game's disc check time out.
- **Heroic import**: brings over sideloaded games with their prefix, Proton build, wrapper script, launcher arguments and art. Disc labels come from `disc-autoinstall`'s `discs.json` and from `DISC_LABEL=` in cd-game-fix wrapper scripts.
- **Artwork** from local files or SteamGridDB (add a free API key in Settings). Box art is printed on the disc; the hero image becomes the background.
- Keyboard and gamepad: ←/→ choose, Enter/A insert or play, Esc/B eject, E/Y edit, F11 fullscreen.
- Two themes: *Console white* and *Midnight*. Menu sounds are synthesized, so there are no audio files.

## Run

```sh
npm install
npm start               # build + run from the checkout
npm run dev             # Vite dev server with hot reload for the UI
npm run dist            # build release/DiscPlay-<version>.AppImage
npm run install-desktop # add DiscPlay to the app menu (uses the AppImage if built)
```

Requirements: `udisks2` (`udisksctl`), `udevadm`, and umu-launcher with a Proton build for Windows
games. Heroic's bundled umu (`~/.config/heroic/tools/runtimes/umu`) and GE-Proton in
`~/.local/share/Steam/compatibilitytools.d` are picked up automatically.

## Where things live

| What | Path |
|---|---|
| Library + settings | `~/.config/discplay/library.json`, `settings.json` |
| Cached artwork | `~/.config/discplay/art/` |
| Converted disc images | `~/.cache/discplay/images/` |
| Launch logs | `~/.local/state/discplay/logs/<game id>.log` (also under *Edit → Last log*) |
| SafeDisc support files | `resources/safedisc/` (bundled into the AppImage) |
| New prefixes | `~/Games/DiscPlay/Prefixes/<game>` (configurable) |

## Debug switches

- `DISCPLAY_DATA=/tmp/x`: use a separate profile.
- `DISCPLAY_PLAN="sonic"`: print the exact launch command for a game and quit.
- `DISCPLAY_SCREENSHOT=/tmp/shot.png` (+ `DISCPLAY_SCREENSHOT_DELAY`, `DISCPLAY_SCREENSHOT_JS`): capture the window and quit.
- `DISCPLAY_DEBUG=1`: print UI console messages to the terminal.

## Layout

```
electron/   main process: drive watcher, launcher, Wine prefix helpers, Heroic import, art
shared/     types shared by both sides
src/        React UI: Disc (CSS disc), Stage (the drive), Shelf, dialogs, sounds, input
```
