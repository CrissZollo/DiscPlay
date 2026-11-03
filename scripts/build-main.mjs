import { build } from 'esbuild'

const watch = process.argv.includes('--watch')
const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
}
const configs = [
  { ...common, entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.js', format: 'cjs' },
  { ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.js', format: 'cjs' },
]
if (watch) {
  const { context } = await import('esbuild')
  for (const c of configs) (await context(c)).watch()
} else {
  await Promise.all(configs.map((c) => build(c)))
}
