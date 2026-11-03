import { useEffect, useRef } from 'react'

/**
 * Drives a disc's rotation with inertia: the speed eases toward `target` (deg/s), so discs
 * spin up and coast down like a real drive. Writes `--angle` on the element directly (no re-renders).
 */
export function useSpin<T extends HTMLElement>(target: number, opts: { response?: number; onSpeed?: (v: number) => void } = {}) {
  const ref = useRef<T>(null)
  const state = useRef({ angle: Math.random() * 360, v: 0, target })
  state.current.target = target
  const response = opts.response ?? 1.6
  const onSpeed = useRef(opts.onSpeed)
  onSpeed.current = opts.onSpeed

  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const s = state.current
      s.v += (s.target - s.v) * (1 - Math.exp(-response * dt))
      if (Math.abs(s.v - s.target) < 0.5) s.v = s.target
      s.angle = (s.angle + s.v * dt) % 360
      const el = ref.current
      if (el) {
        el.style.setProperty('--angle', `${s.angle}deg`)
        el.style.setProperty('--speed', String(Math.min(1, Math.abs(s.v) / 1400)))
      }
      onSpeed.current?.(s.v)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [response])

  return ref
}
