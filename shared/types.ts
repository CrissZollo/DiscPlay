// Types shared between the Electron main process and the UI.

export type RunnerKind = 'umu' | 'wine' | 'native'

export interface DiscSpec {
  /** none = the game runs without a disc; drive = a physical disc in an optical drive; image = an ISO file */
  source: 'none' | 'drive' | 'image'
  /** Volume label(s) that belong to this game (e.g. ["DSLOA1","DSLOA2"]). Used to recognise an inserted disc. */
  labels: string[]
  /** ISO/IMG path when source = image (disc 1; kept for older libraries, mirrors images[0]) */
  imagePath?: string
  /** All disc images of a multi-disc game, in disc order. Disc 1 is mounted at launch; the others can be swapped in. */
  images?: string[]
  /** Drive letter the game expects inside Wine (without colon), usually "d" */
  letter: string
  /** true = refuse to start until the right disc is in */
  required: boolean
}

export interface GameArt {
  /** Box / grid art (portrait). Also used as the printed disc label. */
  cover?: string
  /** Wide background art */
  hero?: string
  /** Transparent title logo */
  logo?: string
  /** Optional dedicated disc label image (square) */
  disc?: string
}

/** An expansion, patch or other add-on installed into a game's prefix from its own disc. */
export interface AddonInfo {
  id: string
  title: string
  /** Volume labels of the add-on's disc(s) */
  labels: string[]
  installedAt: number
  /** Program the add-on installed, if one was picked */
  executable?: string
}

export interface Game {
  id: string
  title: string
  runner: RunnerKind
  executable: string
  args: string[]
  workingDir?: string
  prefix?: string
  /** Absolute path of the Proton directory (contains the `proton` script). runner = umu */
  protonPath?: string
  /** Wine binary when runner = wine (default: `wine` from PATH) */
  wineBinary?: string
  /** Wrapper command put in front of the launch command, e.g. a disc wrapper script or gamescope. */
  wrapper?: string
  env: Record<string, string>
  disc: DiscSpec
  art: GameArt
  /** Accent colour for the disc when there is no art */
  color: string
  year?: string
  notes?: string
  addedAt: number
  lastPlayed?: number
  playtimeSeconds: number
  source?: { kind: 'heroic'; appName: string }
  /** Add-ons installed into this game's prefix */
  addons?: AddonInfo[]
  /** Set on a game that is an add-on (e.g. an expansion with its own program) sharing another game's prefix */
  addonOf?: string
}

export interface Settings {
  theme: 'console' | 'midnight'
  sound: boolean
  steamGridDbKey: string
  defaultProton?: string
  prefixBase: string
  driveDevice: string
  /** Show the game automatically when a known disc is inserted */
  autoInsert: boolean
  /** Ask to add a game when an unknown disc with a setup program is inserted */
  offerInstall: boolean
  startFullscreen: boolean
}

export interface DriveState {
  device: string
  /** A drive exists at all */
  present: boolean
  /** Media is in the drive */
  hasDisc: boolean
  label?: string
  mountpoint?: string
  /** media kind from udev: cd, cd_r, dvd, dvd_r... */
  media?: string
  /** True for a pressed (non-recordable) disc */
  pressed?: boolean
  /** Disc contains autorun.inf / setup.exe, filled in after mounting */
  hasSetup?: boolean
  /** Name suggested by autorun.inf */
  suggestedTitle?: string
}

/** What removing a game would touch (see removeGame). */
export interface RemovalInfo {
  /** Add-on games that share this game's prefix */
  addonGames: { id: string; title: string }[]
  prefix?: string
  /** Why the prefix can't be deleted, if it can't */
  prefixNote?: string
  /** The prefix can only be deleted together with the add-on games that share it */
  prefixNeedsAddons?: boolean
}

export interface RemoveOptions {
  /** Also remove the add-on games */
  addons?: boolean
  /** Also delete the Wine prefix (everything installed in it, saves included) */
  prefix?: boolean
}

export interface ProtonVersion {
  name: string
  path: string
}

export interface RunnerInfo {
  umu?: string
  wine?: string
  protons: ProtonVersion[]
}

export type RunStatus =
  | { state: 'idle' }
  | { state: 'preparing'; gameId: string; message: string }
  | { state: 'waiting-disc'; gameId: string; label?: string; found?: string }
  | { state: 'running'; gameId: string; pid?: number; startedAt: number }
  | { state: 'error'; gameId: string; message: string }

export interface InstallRequest {
  title: string
  /** Where the installer comes from */
  from: 'drive' | 'image' | 'file'
  /** Disc images in disc order (from = image). Disc 1 holds the installer; the others can be swapped in while it runs. */
  images?: string[]
  /** setup program; relative to the disc root for drive/image, absolute for file */
  setupPath?: string
  protonPath?: string
  prefix?: string
  /** Install an add-on (expansion, patch…) into this existing game's prefix instead of a new one */
  targetId?: string
}

export interface InstallResult {
  candidates: ExeCandidate[]
  game: Partial<Game>
  /** Volume labels of every disc used during the install, in the order they went in */
  labels: string[]
  /** Program of the target game before the add-on was installed */
  targetExecutable?: string
  /** The new prefix this install made (new games only); can be thrown away with discardInstall */
  createdPrefix?: string
}

/** The disc(s) currently linked into a running game's or installer's prefix. */
export interface DiscSessionInfo {
  /** Who the session belongs to: a game id, or "install" */
  owner: string
  kind: 'drive' | 'image'
  letter: string
  /** Image file names (kind = image) */
  images: string[]
  /** Index into images of the disc that is in, or -1 */
  current: number
  /** Label of the disc currently linked */
  label?: string
  /** Every disc label seen in this session */
  labels: string[]
  /** A swap or eject is in progress */
  busy?: boolean
  message?: string
}

export interface ExeCandidate {
  path: string
  size: number
  mtime: number
}

export interface GridResult {
  id: number
  name: string
  year?: string
}

export interface ArtResult {
  url: string
  thumb: string
  width: number
  height: number
}

export interface DiscPlayApi {
  getLibrary(): Promise<Game[]>
  saveGame(game: Game): Promise<Game>
  removalInfo(id: string): Promise<RemovalInfo>
  /** Remove a game (and optionally its add-ons and prefix). Returns the ids removed. */
  deleteGame(id: string, opts?: RemoveOptions): Promise<string[]>
  getSettings(): Promise<Settings>
  saveSettings(s: Settings): Promise<Settings>
  getRunners(): Promise<RunnerInfo>
  getDrive(): Promise<DriveState>
  ejectDrive(): Promise<void>
  launch(id: string): Promise<void>
  stop(): Promise<void>
  cancelWait(): Promise<void>
  getStatus(): Promise<RunStatus>
  heroicPreview(): Promise<{ appName: string; title: string; already: boolean }[]>
  heroicImport(appNames: string[]): Promise<number>
  pickFile(opts: { title: string; filters?: { name: string; extensions: string[] }[]; directory?: boolean; defaultPath?: string }): Promise<string | undefined>
  importArt(gameId: string, kind: keyof GameArt, source: string): Promise<string>
  gridSearch(term: string): Promise<GridResult[]>
  gridArt(gridId: number, kind: keyof GameArt): Promise<ArtResult[]>
  installFromDisc(req: InstallRequest): Promise<InstallResult>
  /** Delete the prefix a new-game install made, when the game is not added after all */
  discardInstall(prefix: string): Promise<void>
  /** Other images of the same disc set next to an image (Disc 1 → Disc 2, Disc 3…), disc 1 first */
  findDiscSet(imagePath: string): Promise<string[]>
  getDiscSession(): Promise<DiscSessionInfo | null>
  /** Put another image of the running session "in the drive" */
  swapDisc(index: number): Promise<void>
  /** Eject the physical disc during an install or game, so the next one can go in */
  ejectSessionDisc(): Promise<void>
  readLog(id: string): Promise<string>
  openPath(p: string): Promise<void>
  window(action: 'minimize' | 'maximize' | 'close' | 'fullscreen'): Promise<void>
  onDrive(cb: (d: DriveState) => void): () => void
  onStatus(cb: (s: RunStatus) => void): () => void
  onLibrary(cb: (g: Game[]) => void): () => void
  onInstallLog(cb: (line: string) => void): () => void
  onDiscSession(cb: (s: DiscSessionInfo | null) => void): () => void
  /** Things worth telling the user that don't stop the game, e.g. a Proton fallback */
  onNotice(cb: (text: string) => void): () => void
}
