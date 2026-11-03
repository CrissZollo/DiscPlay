import { useEffect, useState } from 'react'
import { api } from '../api'
import { Modal } from './Modal'

export function HeroicImport({ onClose, onDone }: { onClose(): void; onDone(n: number): void }) {
  const [items, setItems] = useState<{ appName: string; title: string; already: boolean }[]>()
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    api.heroicPreview().then((r) => {
      setItems(r)
      setSel(new Set(r.filter((x) => !x.already).map((x) => x.appName)))
    })
  }, [])
  const toggle = (a: string) => setSel((s) => { const n = new Set(s); n.has(a) ? n.delete(a) : n.add(a); return n })
  return (
    <Modal
      title="Import from Heroic"
      onClose={onClose}
      footer={
        <>
          <span className="muted">Imports Heroic's sideloaded games with their prefix, Proton, wrapper and art. Disc labels come from disc-autoinstall and wrapper scripts.</span>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" disabled={busy || !sel.size} onClick={async () => { setBusy(true); onDone(await api.heroicImport([...sel])) }}>
            {busy ? 'Importing…' : `Import ${sel.size}`}
          </button>
        </>
      }
    >
      {!items ? <p className="muted">Reading Heroic library…</p> : !items.length ? <p className="muted">No sideloaded games found in ~/.config/heroic.</p> : (
        <ul className="check-list">
          {items.map((it) => (
            <li key={it.appName}>
              <label>
                <input type="checkbox" checked={sel.has(it.appName)} onChange={() => toggle(it.appName)} />
                <span>{it.title}</span>
                {it.already && <em>already imported – will refresh</em>}
              </label>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
