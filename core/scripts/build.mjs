// Builds main, preload, and renderer bundles into dist/ and copies static assets.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { compileDxgiTimingHelper } from './build-dxgi-timing-helper.mjs'

const watch = process.argv.includes('--watch')

await rm('dist', { recursive: true, force: true })
await mkdir('dist', { recursive: true })
await mkdir('dist/scripts', { recursive: true })

function compileNativeReplayHelper() {
  if (process.platform !== 'win32') {
    console.warn('native replay helper skipped: Windows build host required')
    return
  }
  const windows = process.env.WINDIR ?? 'C:\\Windows'
  const candidates = [
    join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(windows, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ]
  const compiler = candidates.find((candidate) => existsSync(candidate))
  if (compiler === undefined) {
    throw new Error('native replay helper compiler not found (Windows .NET Framework csc.exe)')
  }
  const result = spawnSync(
    compiler,
    [
      '/nologo',
      '/optimize+',
      '/target:exe',
      '/reference:System.Drawing.dll',
      `/out:${join(process.cwd(), 'dist', 'scripts', 'native-replay-capture.exe')}`,
      join(process.cwd(), 'scripts', 'native-replay-capture.cs'),
    ],
    { encoding: 'utf8', windowsHide: true },
  )
  if (result.status !== 0) {
    throw new Error(
      `native replay helper compile failed (${String(result.status)}): ` +
        `${String(result.stderr || result.stdout || result.error)}`,
    )
  }
}

compileNativeReplayHelper()
compileDxgiTimingHelper({
  required: process.argv.includes('--require-dxgi-helper'),
})

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
  // The watchdog (issue #61) runs as PLAIN NODE — the app's own binary
  // re-entered with ELECTRON_RUN_AS_NODE — so it must not link electron and
  // must land outside the asar (asarUnpack in electron-builder.yml): a fresh
  // Node process knows nothing about Electron's archive format.
  build({
    ...node,
    external: [],
    entryPoints: ['src/watchdog/watchdog.ts'],
    outfile: 'dist/scripts/watchdog.js',
  }),
  // The native messaging host also runs as PLAIN NODE (ELECTRON_RUN_AS_NODE):
  // electron.exe writes CRLF to stdout before the main script runs, and two
  // stray bytes are enough to poison Chrome's length-prefixed framing for the
  // whole session — Chrome kills the port, the extension redials every ~2 s,
  // and the log fills with hellos from hosts that die young. Plain Node writes
  // nothing it is not told to. Same rules as the watchdog: no electron import,
  // outside the asar.
  build({
    ...node,
    external: [],
    entryPoints: ['src/main/chrome/nativeHostEntry.ts'],
    outfile: 'dist/scripts/native-host.js',
  }),
  build({ ...node, entryPoints: ['src/preload/capture.ts'], outfile: 'dist/preload/capture.js' }),
  build({ ...node, entryPoints: ['src/preload/editor.ts'], outfile: 'dist/preload/editor.js' }),
  build({ ...node, entryPoints: ['src/preload/settings.ts'], outfile: 'dist/preload/settings.js' }),
  build({ ...node, entryPoints: ['src/preload/render.ts'], outfile: 'dist/preload/render.js' }),
  build({ ...node, entryPoints: ['src/preload/toast.ts'], outfile: 'dist/preload/toast.js' }),
  build({ ...node, entryPoints: ['src/preload/history.ts'], outfile: 'dist/preload/history.js' }),
  build({ ...node, entryPoints: ['src/preload/about.ts'], outfile: 'dist/preload/about.js' }),
  build({ ...node, entryPoints: ['src/preload/welcome.ts'], outfile: 'dist/preload/welcome.js' }),
  build({ ...node, entryPoints: ['src/preload/imageRegion.ts'], outfile: 'dist/preload/image-region.js' }),
  build({ ...browser, entryPoints: ['src/renderer/capture/capture.ts'], outfile: 'dist/renderer/capture/capture.js' }),
  build({ ...browser, entryPoints: ['src/renderer/editor/editor.ts'], outfile: 'dist/renderer/editor/editor.js' }),
  build({ ...browser, entryPoints: ['src/renderer/settings/settings.ts'], outfile: 'dist/renderer/settings/settings.js' }),
  build({ ...browser, entryPoints: ['src/renderer/render/render.ts'], outfile: 'dist/renderer/render/render.js' }),
  build({ ...browser, entryPoints: ['src/renderer/toast/toast.ts'], outfile: 'dist/renderer/toast/toast.js' }),
  build({ ...browser, entryPoints: ['src/renderer/history/history.ts'], outfile: 'dist/renderer/history/history.js' }),
  build({ ...browser, entryPoints: ['src/renderer/about/about.ts'], outfile: 'dist/renderer/about/about.js' }),
  build({ ...browser, entryPoints: ['src/renderer/welcome/welcome.ts'], outfile: 'dist/renderer/welcome/welcome.js' }),
  build({
    ...browser,
    entryPoints: ['src/renderer/image-region/image-region.ts'],
    outfile: 'dist/renderer/image-region/image-region.js',
  }),
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
  cp('src/renderer/about/about.html', 'dist/renderer/about/about.html'),
  cp('src/renderer/about/about.css', 'dist/renderer/about/about.css'),
  cp('src/renderer/welcome/welcome.html', 'dist/renderer/welcome/welcome.html'),
  cp('src/renderer/welcome/welcome.css', 'dist/renderer/welcome/welcome.css'),
  cp('src/renderer/image-region/image-region.html', 'dist/renderer/image-region/image-region.html'),
  cp('src/renderer/image-region/image-region.css', 'dist/renderer/image-region/image-region.css'),
  // Windows UI Automation helper (GOAL "Static object picking"): spawned by
  // src/main/uia.ts as a real file, so it must ship next to the bundles AND be
  // kept out of the asar — see asarUnpack in electron-builder.yml.
  cp('scripts/uia-dump.ps1', 'dist/scripts/uia-dump.ps1'),
  // The resident Context Host (issues #64/#65): spawned by src/main/context/host.ts
  // as a real file for the same reason, and kept standalone-runnable
  // (`powershell -File dist/scripts/context-host.ps1 -SelfTest 100`) because
  // that self-test is how its CPU cost stays a measured number rather than a
  // claim.
  cp('scripts/context-host.ps1', 'dist/scripts/context-host.ps1'),
  // Lane A's resident control tracker (#111). Same reasons as the two above:
  // powershell.exe cannot read inside an asar, and keeping it a real file keeps
  // `powershell -File dist/scripts/uia-track.ps1 -SelfTest 20` runnable by hand
  // — which is how its cost numbers are checked.
  cp('scripts/uia-track.ps1', 'dist/scripts/uia-track.ps1'),
  cp('assets', 'dist/assets', { recursive: true }),
])

console.log('build ok' + (watch ? ' (watch not implemented — rerun on change)' : ''))
