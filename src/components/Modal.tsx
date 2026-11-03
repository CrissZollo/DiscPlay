import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

// Only the top-most modal reacts to Escape.
const stack: object[] = []
export const modalOpen = () => stack.length > 0

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose(): void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const me = useRef({})
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const token = me.current
    stack.push(token)
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && stack[stack.length - 1] === token) {
        e.stopPropagation()
        close.current()
      }
    }
    window.addEventListener('keydown', k, true)
    return () => {
      window.removeEventListener('keydown', k, true)
      stack.splice(stack.indexOf(token), 1)
    }
  }, [])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal--wide' : ''}`} role="dialog" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="tb-btn" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" width="16" height="16"><path d="m7 7 10 10M17 7 7 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

export function PathInput({ value, onChange, onBrowse, placeholder }: { value: string; onChange(v: string): void; onBrowse(): void; placeholder?: string }) {
  return (
    <div className="path-input">
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} spellCheck={false} />
      <button type="button" className="btn btn--small" onClick={onBrowse}>Browse…</button>
    </div>
  )
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange(v: boolean): void; label: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track"><span className="toggle-thumb" /></span>
      <span>{label}</span>
    </label>
  )
}
