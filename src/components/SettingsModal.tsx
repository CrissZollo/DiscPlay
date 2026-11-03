import { useEffect, useState } from 'react'
import type { RunnerInfo, Settings } from '../../shared/types'
import { api } from '../api'
import { Field, Modal, PathInput, Toggle } from './Modal'

export function SettingsModal({ settings, onClose, onSaved, onImportHeroic }: { settings: Settings; onClose(): void; onSaved(s: Settings): void; onImportHeroic(): void }) {
  const [s, setS] = useState(settings)
  const [runners, setRunners] = useState<RunnerInfo>()
  useEffect(() => {
    api.getRunners().then(setRunners)
  }, [])
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((x) => ({ ...x, [k]: v }))
  return (
    <Modal
      title="Settings"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={async () => onSaved(await api.saveSettings(s))}>Save</button>
        </>
      }
    >
      <h3>Look &amp; feel</h3>
      <div className="seg">
        <button className={s.theme === 'console' ? 'is-on' : ''} onClick={() => set('theme', 'console')}>Console white</button>
        <button className={s.theme === 'midnight' ? 'is-on' : ''} onClick={() => set('theme', 'midnight')}>Midnight</button>
      </div>
      <Toggle checked={s.sound} onChange={(v) => set('sound', v)} label="Menu sounds" />
      <Toggle checked={s.startFullscreen} onChange={(v) => set('startFullscreen', v)} label="Start in fullscreen (F11 toggles)" />

      <h3>Disc drive</h3>
      <Field label="Optical drive device">
        <input value={s.driveDevice} onChange={(e) => set('driveDevice', e.target.value)} spellCheck={false} />
      </Field>
      <Toggle checked={s.autoInsert} onChange={(v) => set('autoInsert', v)} label="Show the game when its disc is inserted" />
      <Toggle checked={s.offerInstall} onChange={(v) => set('offerInstall', v)} label="Offer to install unknown discs" />

      <h3>Running games</h3>
      <Field label="Default Proton">
        <select value={s.defaultProton ?? ''} onChange={(e) => set('defaultProton', e.target.value || undefined)}>
          <option value="">Newest installed</option>
          {runners?.protons.map((p) => <option key={p.path} value={p.path}>{p.name}</option>)}
        </select>
      </Field>
      <Field label="Folder for new Wine prefixes">
        <PathInput value={s.prefixBase} onChange={(v) => set('prefixBase', v)} onBrowse={async () => { const p = await api.pickFile({ title: 'Prefix folder', directory: true }); if (p) set('prefixBase', p) }} />
      </Field>
      <div className="runner-info">
        <span className={runners?.umu ? 'ok' : 'bad'}>umu-launcher: {runners?.umu ?? 'not found'}</span>
        <span className={runners?.protons.length ? 'ok' : 'bad'}>Proton: {runners?.protons.map((p) => p.name).join(', ') || 'none found'}</span>
        <span className={runners?.wine ? 'ok' : 'bad'}>Wine: {runners?.wine ?? 'not found'}</span>
      </div>

      <h3>Artwork</h3>
      <Field label="SteamGridDB API key" hint={<>Free key from steamgriddb.com → Preferences → API.</>}>
        <input type="password" value={s.steamGridDbKey} onChange={(e) => set('steamGridDbKey', e.target.value)} spellCheck={false} />
      </Field>

      <h3>Library</h3>
      <button className="btn" onClick={onImportHeroic}>Import games from Heroic…</button>
    </Modal>
  )
}
