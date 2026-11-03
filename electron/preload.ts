import { contextBridge, ipcRenderer } from 'electron'
import type { DiscPlayApi } from '../shared/types'

const on = (channel: string) => (cb: (v: any) => void) => {
  const h = (_e: unknown, v: unknown) => cb(v)
  ipcRenderer.on(channel, h)
  return () => {
    ipcRenderer.off(channel, h)
  }
}
const call = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(channel, ...args)

const api: DiscPlayApi = {
  getLibrary: call('library:get'),
  saveGame: call('library:save'),
  removalInfo: call('library:removalInfo'),
  deleteGame: call('library:delete'),
  getSettings: call('settings:get'),
  saveSettings: call('settings:save'),
  getRunners: call('runners:get'),
  getDrive: call('drive:get'),
  listDrives: call('drive:list'),
  ejectDrive: call('drive:eject'),
  launch: call('game:launch'),
  stop: call('game:stop'),
  cancelWait: call('game:cancelWait'),
  getStatus: call('game:status'),
  heroicPreview: call('heroic:preview'),
  heroicImport: call('heroic:import'),
  pickFile: call('dialog:pick'),
  importArt: call('art:import'),
  gridSearch: call('art:search'),
  gridArt: call('art:list'),
  installFromDisc: call('install:run') as DiscPlayApi['installFromDisc'],
  discardInstall: call('install:discard'),
  findDiscSet: call('disc:set'),
  getDiscSession: call('disc:session'),
  swapDisc: call('disc:swap'),
  ejectSessionDisc: call('disc:eject'),
  readLog: call('game:log'),
  openPath: call('shell:open'),
  window: call('window'),
  onDrive: on('drive'),
  onStatus: on('status'),
  onLibrary: on('library'),
  onInstallLog: on('install-log'),
  onDiscSession: on('disc-session'),
  onNotice: on('notice'),
}

contextBridge.exposeInMainWorld('discplay', api)
