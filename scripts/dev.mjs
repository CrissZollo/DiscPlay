// Dev mode: Vite dev server for the UI + rebuilt main process, then Electron pointed at Vite.
import { spawn } from 'node:child_process'
import { createServer } from 'vite'

await new Promise((res, rej) =>
  spawn('node', ['scripts/build-main.mjs'], { stdio: 'inherit' }).on('exit', (c) => (c ? rej(c) : res())),
)
const server = await createServer({ configFile: 'vite.config.ts' })
await server.listen()
const url = server.resolvedUrls.local[0]
const electron = spawn('npx', ['electron', '.'], {
  stdio: 'inherit',
  env: { ...process.env, DISCPLAY_DEV_URL: url },
})
electron.on('exit', async () => {
  await server.close()
  process.exit(0)
})
