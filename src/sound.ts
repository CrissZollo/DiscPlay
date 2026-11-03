// Tiny synthesized UI sounds (no audio files): ticks, whooshes, a drive spin-up and a start chime.
let ctx: AudioContext | null = null
let enabled = true
let master: GainNode | null = null

export function setSoundEnabled(on: boolean) {
  enabled = on
}

function ac() {
  if (!ctx) {
    ctx = new AudioContext()
    master = ctx.createGain()
    master.gain.value = 0.5
    master.connect(ctx.destination)
  }
  if (ctx.state === 'suspended') ctx.resume()
  return ctx
}

function tone(freq: number, dur: number, opts: { type?: OscillatorType; gain?: number; delay?: number; to?: number } = {}) {
  const c = ac()
  const t = c.currentTime + (opts.delay ?? 0)
  const o = c.createOscillator()
  const g = c.createGain()
  o.type = opts.type ?? 'sine'
  o.frequency.setValueAtTime(freq, t)
  if (opts.to) o.frequency.exponentialRampToValueAtTime(opts.to, t + dur)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(opts.gain ?? 0.2, t + 0.008)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  o.connect(g).connect(master!)
  o.start(t)
  o.stop(t + dur + 0.05)
}

function noise(dur: number, opts: { from: number; to: number; gain?: number; q?: number; delay?: number }) {
  const c = ac()
  const t = c.currentTime + (opts.delay ?? 0)
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  const src = c.createBufferSource()
  src.buffer = buf
  const f = c.createBiquadFilter()
  f.type = 'bandpass'
  f.Q.value = opts.q ?? 1.2
  f.frequency.setValueAtTime(opts.from, t)
  f.frequency.exponentialRampToValueAtTime(opts.to, t + dur)
  const g = c.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(opts.gain ?? 0.15, t + dur * 0.3)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  src.connect(f).connect(g).connect(master!)
  src.start(t)
}

export const sfx = {
  tick() {
    if (enabled) tone(1900, 0.045, { gain: 0.05 })
  },
  hover() {
    if (enabled) tone(2600, 0.03, { gain: 0.025 })
  },
  open() {
    if (!enabled) return
    tone(880, 0.09, { gain: 0.08 })
    tone(1320, 0.12, { gain: 0.06, delay: 0.05 })
  },
  close() {
    if (!enabled) return
    tone(1320, 0.08, { gain: 0.06 })
    tone(880, 0.1, { gain: 0.05, delay: 0.05 })
  },
  insert() {
    if (!enabled) return
    noise(0.5, { from: 400, to: 3200, gain: 0.12 })
    tone(140, 0.08, { gain: 0.25, delay: 0.42, type: 'triangle' })
  },
  spinUp() {
    if (!enabled) return
    const c = ac()
    const t = c.currentTime
    const o = c.createOscillator()
    const f = c.createBiquadFilter()
    const g = c.createGain()
    o.type = 'sawtooth'
    o.frequency.setValueAtTime(40, t)
    o.frequency.exponentialRampToValueAtTime(190, t + 1.3)
    o.frequency.exponentialRampToValueAtTime(150, t + 2.4)
    f.type = 'lowpass'
    f.frequency.value = 700
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.5)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.6)
    o.connect(f).connect(g).connect(master!)
    o.start(t)
    o.stop(t + 2.7)
    noise(2.2, { from: 1500, to: 5000, gain: 0.025, q: 0.6 })
  },
  eject() {
    if (!enabled) return
    noise(0.45, { from: 3000, to: 500, gain: 0.1 })
    tone(220, 0.08, { gain: 0.12, type: 'triangle' })
  },
  start() {
    if (!enabled) return
    // bright two-note chime
    tone(659.25, 0.5, { gain: 0.14 })
    tone(987.77, 0.7, { gain: 0.12, delay: 0.12 })
    tone(1318.5, 0.9, { gain: 0.06, delay: 0.24 })
  },
  error() {
    if (!enabled) return
    tone(196, 0.18, { gain: 0.12, type: 'square' })
    tone(147, 0.25, { gain: 0.1, type: 'square', delay: 0.16 })
  },
}
