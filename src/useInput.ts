import { useEffect, useRef } from 'react'

export type InputAction = 'left' | 'right' | 'confirm' | 'back' | 'play' | 'edit' | 'add'

const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)

/** Keyboard + gamepad navigation (d-pad/stick to move, A insert/play, B eject, Y edit, Start play). */
export function useInput(handler: (a: InputAction) => void) {
  const h = useRef(handler)
  h.current = handler

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F11') {
        e.preventDefault()
        window.discplay.window('fullscreen')
        return
      }
      if (typing(e.target)) return
      const map: Record<string, InputAction> = {
        ArrowLeft: 'left',
        ArrowRight: 'right',
        Enter: 'confirm',
        ' ': 'confirm',
        Escape: 'back',
        Backspace: 'back',
        e: 'edit',
        p: 'play',
      }
      let a = map[e.key]
      if (e.ctrlKey && e.key === 'n') a = 'add'
      if (!a) return
      // Let focused buttons handle Enter/Space themselves
      if ((a === 'confirm') && e.target instanceof HTMLButtonElement && !e.target.closest('.shelf')) return
      e.preventDefault()
      h.current(a)
    }
    window.addEventListener('keydown', onKey)

    // Gamepad polling
    let raf = 0
    const prev: Record<string, boolean> = {}
    let repeatAt = 0
    const poll = (now: number) => {
      // Only while DiscPlay has focus: the pad also drives the game, and a press meant for the game
      // must not move the shelf or open the editor behind it.
      const focused = document.hasFocus()
      const pads = navigator.getGamepads?.() ?? []
      for (const pad of pads) {
        if (!pad) continue
        const b = (i: number) => !!pad.buttons[i]?.pressed
        const x = pad.axes[0] ?? 0
        const state: Record<string, boolean> = {
          left: b(14) || x < -0.6,
          right: b(15) || x > 0.6,
          confirm: b(0),
          back: b(1),
          edit: b(3),
          play: b(9),
        }
        for (const [k, down] of Object.entries(state)) {
          const key = `${pad.index}:${k}`
          const isDir = k === 'left' || k === 'right'
          // Buttons held while focus comes back (e.g. the one that quit the game) count once released.
          if (focused && down && (!prev[key] || (isDir && now > repeatAt))) {
            h.current(k as InputAction)
            if (isDir) repeatAt = now + (prev[key] ? 130 : 380)
          }
          prev[key] = down
        }
        break
      }
      raf = requestAnimationFrame(poll)
    }
    raf = requestAnimationFrame(poll)
    return () => {
      window.removeEventListener('keydown', onKey)
      cancelAnimationFrame(raf)
    }
  }, [])
}
