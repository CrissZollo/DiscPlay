import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'

export function run(cmd: string, args: string[], opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout ?? 15000, env: opts.env, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

/** Split a command line the way a POSIX shell would (quotes and backslashes, no expansion). */
export function splitCommand(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let has = false
  let q: '"' | "'" | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q === "'") {
      if (c === "'") q = null
      else cur += c
    } else if (q === '"') {
      if (c === '"') q = null
      else if (c === '\\' && i + 1 < line.length && '"\\$`'.includes(line[i + 1])) cur += line[++i]
      else cur += c
    } else if (c === "'" || c === '"') {
      q = c
      has = true
    } else if (c === '\\' && i + 1 < line.length) {
      cur += line[++i]
      has = true
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur)
      cur = ''
      has = false
    } else {
      cur += c
    }
  }
  if (has || cur) out.push(cur)
  return out
}

export function quoteArg(a: string) {
  return /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`
}

export function slug(s: string) {
  return (
    s
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, ' ') || 'game'
  )
}

export function exists(p?: string) {
  return !!p && fs.existsSync(p)
}

export function isExecutable(p: string) {
  try {
    fs.accessSync(p, fs.constants.X_OK)
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

export function which(bin: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir && isExecutable(`${dir}/${bin}`)) return `${dir}/${bin}`
  }
}

/** Clean environment for child processes: drop Electron's own variables. */
export function childEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('ELECTRON_') || k === 'CHROME_DESKTOP' || k === 'GDK_BACKEND' || k === 'ORIGINAL_XDG_CURRENT_DESKTOP') continue
    env[k] = v
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  return env
}

export { spawn }

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
