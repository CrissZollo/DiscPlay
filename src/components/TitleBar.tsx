import { useEffect, useState } from 'react'
import type { DriveState } from '../../shared/types'
import { api } from '../api'

interface Props {
  drive: DriveState
  onAdd(): void
  onSettings(): void
}

export function TitleBar({ drive, onAdd, onSettings }: Props) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10000)
    return () => clearInterval(t)
  }, [])
  return (
    <header className="titlebar">
      <div className="brand">
        <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden>
          <defs>
            <linearGradient id="bl" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="var(--accent)" />
              <stop offset="1" stopColor="var(--accent-2)" />
            </linearGradient>
          </defs>
          <circle cx="16" cy="16" r="14" fill="url(#bl)" />
          <circle cx="16" cy="16" r="9" fill="none" stroke="white" strokeOpacity=".5" strokeWidth="1" />
          <circle cx="16" cy="16" r="3.2" fill="var(--bg)" />
        </svg>
        <span>Disc<b>Play</b></span>
      </div>

      <div className={`slot ${drive.hasDisc ? 'has-disc' : ''} ${drive.present ? '' : 'no-drive'}`} title={driveTitle(drive)}>
        <div className="slot-gap" />
        <div className="slot-led" />
      </div>

      <div className="titlebar-right">
        <div className="clock">
          <span className="clock-time">{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          <span className="clock-date">{now.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}</span>
        </div>
        <button className="tb-btn" onClick={onAdd} title="Add a game (Ctrl+N)">
          <svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg>
        </button>
        <button className="tb-btn" onClick={onSettings} title="Settings">
          <svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M12 2.8v2.6M12 18.6v2.6M21.2 12h-2.6M5.4 12H2.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8M18.5 18.5l-1.8-1.8M7.3 7.3 5.5 5.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        </button>
        <span className="tb-sep" />
        <button className="tb-btn tb-win" onClick={() => api.window('minimize')} title="Minimize">
          <svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 12h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        </button>
        <button className="tb-btn tb-win" onClick={() => api.window('maximize')} title="Maximize">
          <svg viewBox="0 0 24 24" width="14" height="14"><rect x="6" y="6" width="12" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="2" /></svg>
        </button>
        <button className="tb-btn tb-win tb-close" onClick={() => api.window('close')} title="Close">
          <svg viewBox="0 0 24 24" width="14" height="14"><path d="m7 7 10 10M17 7 7 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        </button>
      </div>
    </header>
  )
}

function driveTitle(d: DriveState) {
  if (!d.present) return `No optical drive at ${d.device}`
  if (!d.hasDisc) return `${d.device}: no disc`
  return `${d.device}: ${d.label ?? 'disc'}${d.mountpoint ? ` (mounted at ${d.mountpoint})` : ''}`
}
