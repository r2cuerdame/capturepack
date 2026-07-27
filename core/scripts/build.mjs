// Builds main, preload, and renderer bundles into dist/ and copies static assets.
import { build } from 'esbuild'
import { cp, mkdir, rm } from 'node:fs/promises'

const watch = process.argv.includes('--watch')

await rm('dist', { recursive: true, force: true })
await mkdir('dist', { recursive: true })

const node = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  sourcemap: true,
}

const browser = {
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome120',
  sourcemap: true,
}

await Promise.all([
  build({ ...node, entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.js' }),
  build({ ...node, entryPoints: ['src/preload/capture.ts'], outfile: 'dist/preload/capture.js' }),
  build({ ...node, entryPoints: ['src/preload/editor.ts'], outfile: 'dist/preload/editor.js' }),
  build({ ...node, entryPoints: ['src/preload/settings.ts'], outfile: 'dist/preload/settings.js' }),
  build({ ...node, entryPoints: ['src/preload/render.ts'], outfile: 'dist/preload/render.js' }),
  build({ ...node, entryPoints: ['src/preload/toast.ts'], outfile: 'dist/preload/toast.js' }),
  build({ ...node, entryPoints: ['src/preload/history.ts'], outfile: 'dist/preload/history.js' }),
  build({ ...browser, entryPoints: ['src/renderer/capture/capture.ts'], outfile: 'dist/renderer/capture/capture.js' }),
  build({ ...browser, entryPoints: ['src/renderer/editor/editor.ts'], outfile: 'dist/renderer/editor/editor.js' }),
  build({ ...browser, entryPoints: ['src/renderer/settings/settings.ts'], outfile: 'dist/renderer/settings/settings.js' }),
  build({ ...browser, entryPoints: ['src/renderer/render/render.ts'], outfile: 'dist/renderer/render/render.js' }),
  build({ ...browser, entryPoints: ['src/renderer/toast/toast.ts'], outfile: 'dist/renderer/toast/toast.js' }),
  build({ ...browser, entryPoints: ['src/renderer/history/history.ts'], outfile: 'dist/renderer/history/history.js' }),
])

await Promise.all([
  cp('src/renderer/capture/capture.html', 'dist/renderer/capture/capture.html'),
  cp('src/renderer/editor/editor.html', 'dist/renderer/editor/editor.html'),
  cp('src/renderer/editor/editor.css', 'dist/renderer/editor/editor.css'),
  cp('src/renderer/settings/settings.html', 'dist/renderer/settings/settings.html'),
  cp('src/renderer/settings/settings.css', 'dist/renderer/settings/settings.css'),
  cp('src/renderer/render/render.html', 'dist/renderer/render/render.html'),
  cp('src/renderer/toast/toast.html', 'dist/renderer/toast/toast.html'),
  cp('src/renderer/toast/toast.css', 'dist/renderer/toast/toast.css'),
  cp('src/renderer/history/history.html', 'dist/renderer/history/history.html'),
  cp('src/renderer/history/history.css', 'dist/renderer/history/history.css'),
  cp('assets', 'dist/assets', { recursive: true }),
])

console.log('build ok' + (watch ? ' (watch not implemented — rerun on change)' : ''))
