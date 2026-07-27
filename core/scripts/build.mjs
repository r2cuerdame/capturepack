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
  build({ ...browser, entryPoints: ['src/renderer/capture/capture.ts'], outfile: 'dist/renderer/capture/capture.js' }),
  build({ ...browser, entryPoints: ['src/renderer/editor/editor.ts'], outfile: 'dist/renderer/editor/editor.js' }),
  build({ ...browser, entryPoints: ['src/renderer/settings/settings.ts'], outfile: 'dist/renderer/settings/settings.js' }),
])

await Promise.all([
  cp('src/renderer/capture/capture.html', 'dist/renderer/capture/capture.html'),
  cp('src/renderer/editor/editor.html', 'dist/renderer/editor/editor.html'),
  cp('src/renderer/editor/editor.css', 'dist/renderer/editor/editor.css'),
  cp('src/renderer/settings/settings.html', 'dist/renderer/settings/settings.html'),
  cp('src/renderer/settings/settings.css', 'dist/renderer/settings/settings.css'),
  cp('assets', 'dist/assets', { recursive: true }),
])

console.log('build ok' + (watch ? ' (watch not implemented — rerun on change)' : ''))
