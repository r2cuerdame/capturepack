// The browser half, without a browser (GOAL "Chrome Extension", Phase 1).
//
// WHY THIS EXISTS. The chain from an extension to a saved pack crosses three
// processes — Chrome starts a host, the host dials a pipe, the app writes the
// events into plugins/chrome-dom — and every one of those hops fails silently
// by design, because a browser that cannot be reached must never be allowed to
// cost a capture. Silence is exactly what a compiling, well-typed, completely
// broken integration also produces.
//
// So this speaks Chrome's side of the wire: it starts the REAL app, starts the
// REAL host mode as a child, writes properly framed protocol v1 messages into
// its stdin, and then reads the app's log to see whether they arrived. No
// browser, no extension ID, no registry — those decide whether Chrome will
// LAUNCH the host, and this checks what happens once it has.
//
//   node scripts/chrome-bridge-check.mjs

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { terminateProcessTree } from './process-tree.mjs'

let passed = 0
let failed = 0
function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** Chrome's framing: 32-bit little-endian length, then the UTF-8 body. */
function frame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length, 0)
  return Buffer.concat([head, body])
}

const require = createRequire(import.meta.url)
const electron = require('electron')
const nativeHostScript = resolve('dist', 'scripts', 'native-host.js')

// THIS CHECK STARTS THE REAL APP, SO IT NEEDS THE REAL BUNDLE.
//
// `qa-gate.mjs` runs every `check:*` BEFORE `build`, and `dist/` is gitignored,
// so on a fresh clone this would spawn an Electron that has no main script and
// then spend 45 seconds waiting for a log line that can never appear. Building
// once here is the difference between a check that is honest everywhere and one
// that only passes on a machine that happened to build already.
const mainBundle = resolve('dist', 'main', 'index.js')
if (!existsSync(mainBundle) || !existsSync(nativeHostScript)) {
  console.log('\nNo build to test — building it first')
  const built = spawnSync(process.execPath, [resolve('scripts', 'build.mjs')], {
    stdio: 'inherit',
  })
  if (built.status !== 0 || !existsSync(mainBundle) || !existsSync(nativeHostScript)) {
    console.log('\nresult: BROKEN — the app bundle could not be built\n')
    process.exit(1)
  }
}
const bridgeEnv = {
  ...process.env,
  CAPTUREPACK_DOM_PIPE_SUFFIX: `qa-${process.pid}`,
}

async function main() {
const trackedChildren = new Set()

function waitFor(predicate, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = () => {
      if (predicate()) return resolve(true)
      if (Date.now() - started > timeoutMs) return resolve(false)
      setTimeout(tick, 200)
    }
    tick()
  })
}

function track(child) {
  trackedChildren.add(child)
  child.once('close', () => trackedChildren.delete(child))
  return child
}

async function stopTracked(child) {
  if (child === null || child === undefined) return
  if (child.exitCode !== null || child.signalCode !== null) {
    trackedChildren.delete(child)
    return
  }
  const killer = terminateProcessTree(child)
  if (killer !== null) {
    await Promise.race([
      new Promise((resolve) => {
        killer.once('close', resolve)
        killer.once('error', resolve)
      }),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ])
  }
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 5_000)
  trackedChildren.delete(child)
}

async function stopAllTracked() {
  for (const child of [...trackedChildren].reverse()) await stopTracked(child)
}

let profile = null
let packProfile = null
try {
profile = mkdtempSync(join(tmpdir(), 'capturepack-chrome-'))
const dataDir = join(profile, 'data')
const outDir = join(profile, 'out')

function logText() {
  const file = join(dataDir, 'logs', 'main.log')
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

console.log('\nStarting the app with a profile of its own')
const app = track(spawn(
  electron,
  [
    '.',
    // `=` form: Electron's own switches are parsed that way, and the
    // space-separated form silently leaves the app on the DEFAULT profile —
    // where the installed CapturePack already holds the single-instance lock,
    // so the process exits before it ever listens.
    `--user-data-dir=${dataDir}`,
    `--output-dir=${outDir}`,
    '--no-global-shortcut',
    '--no-login-item',
  ],
  { stdio: 'ignore', env: bridgeEnv },
))

const listening = await waitFor(() => logText().includes('DOM bridge listening'), 45_000)
check('the app listens for a native host', listening, 'no "DOM bridge listening" line appeared')

let host = null
if (listening) {
  console.log('\nSpeaking Chrome\'s side of the wire')
  // Chrome never runs the Electron app as its stdio host. Electron writes a
  // leading CRLF on Windows before app JS runs, which corrupts byte zero of
  // Chrome's length-prefixed protocol. Production's launcher re-enters the
  // same executable as plain Node and runs the standalone host bundle.
  host = track(spawn(
    electron,
    [nativeHostScript],
    {
      env: { ...bridgeEnv, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'ignore'],
    },
  ))
  let stdoutBytes = Buffer.alloc(0)
  let replyFrames = 0
  let framingClean = true
  let framingError = ''
  host.stdout.on('data', (chunk) => {
    stdoutBytes = Buffer.concat([stdoutBytes, chunk])
    let offset = 0
    let complete = 0
    while (offset + 4 <= stdoutBytes.length) {
      const length = stdoutBytes.readUInt32LE(offset)
      if (length <= 0 || length > 1024 * 1024) {
        framingClean = false
        framingError =
          `invalid length ${length} at byte ${offset}; ` +
          `next=${stdoutBytes.subarray(offset, offset + 32).toString('hex')}`
        break
      }
      if (offset + 4 + length > stdoutBytes.length) break
      try {
        JSON.parse(stdoutBytes.subarray(offset + 4, offset + 4 + length).toString('utf8'))
      } catch {
        framingClean = false
        framingError =
          `invalid JSON at byte ${offset}; ` +
          `body=${stdoutBytes.subarray(offset + 4, offset + 4 + length).toString('hex')}`
        break
      }
      complete += 1
      offset += 4 + length
    }
    replyFrames = complete
  })

  // A hello, exactly as background.js sends it on connect.
  host.stdin.write(
    frame({
      type: 'host.hello',
      protocol: 1,
      timestamp: Date.now(),
      app: 'capturepack-extension',
      version: '0.1.0',
    }),
  )

  const shookHands = await waitFor(
    () => /\[chrome\] extension 0\.1\.0 connected, protocol v1/.test(logText()),
    30_000,
  )
  check('the handshake reaches the app through the host', shookHands,
    'the app never logged the extension connecting')

  // The app answers a hello, so the extension can tell a live app from a
  // registered-but-dead one. The reply comes back framed the same way.
  const gotReply = await waitFor(() => replyFrames > 0 || !framingClean, 10_000)
  check('the app answers, so the extension knows it is live', gotReply, 'nothing came back on stdout')
  check('every stdout byte parses as protocol framing (no \r\n poison)', framingClean,
    framingError === '' ? 'stray bytes before or between frames — Chrome would kill this port' : framingError)

  console.log('\nA picked element')
  host.stdin.write(
    frame({
      type: 'dom.element.selected',
      protocol: 1,
      timestamp: Date.now(),
      tab: { url: 'https://example.com/checkout', title: 'Checkout' },
      element: {
        tag: 'button',
        id: 'save',
        role: 'button',
        text: 'Save',
        selector: '#save',
        bounds: { x: 100, y: 200, width: 120, height: 40 },
      },
    }),
  )

  // A message the schema forbids: no element on an element-selected event.
  // It must be dropped rather than stored half-formed.
  host.stdin.write(
    frame({
      type: 'dom.element.selected',
      protocol: 1,
      timestamp: Date.now(),
      tab: { url: 'https://example.com', title: 'x' },
    }),
  )

  // A protocol we do not speak.
  host.stdin.write(frame({ type: 'dom.element.selected', protocol: 99, timestamp: Date.now() }))

  // THE PICKER'S OWN LIFECYCLE (#104). The extension has reported these three
  // since 0.1.5 and the app discarded all of them, so the only question a
  // missing pick asks — did the picker ever arm? — had no answer anywhere on
  // the machine. They are diagnostics, never pack content.
  console.log('\nThe picker reporting itself')
  host.stdin.write(frame({
    type: 'picker.armed',
    protocol: 1,
    timestamp: Date.now(),
    tab: { url: 'https://example.com/armed', title: 'Armed' },
  }))
  host.stdin.write(frame({
    type: 'picker.failed',
    protocol: 1,
    timestamp: Date.now(),
    reason: 'Cannot access a chrome:// URL',
    tab: { url: 'chrome://extensions/', title: 'Extensions' },
  }))

  await new Promise((r) => setTimeout(r, 1500))
  const log = logText()
  check('an accepted pick is written down as it arrives',
    /\[chrome\] element pick at \d+ms: #save 120x40/.test(log),
    'no element-pick line in main.log')
  check('a refused pick says which rule it broke',
    /\[chrome\] refused a browser message: element-absent/.test(log),
    'a pick without an element was dropped silently')
  check('a future protocol is refused out loud',
    /\[chrome\] refused a browser message: protocol-mismatch:99/.test(log),
    'an unspeakable protocol was dropped silently')
  check('an armed picker is visible to the app',
    /\[chrome\] element picker armed on https:\/\/example\.com\/armed/.test(log),
    'picker.armed never reached main.log')
  check('a picker that could not arm says why',
    /\[chrome\] element picker could not arm: Cannot access a chrome:\/\/ URL/.test(log),
    'picker.failed never reached main.log')

  // Nothing above is supposed to take the app down — the DOM is not streamed
  // to the log either — so the proof is that the app is still healthy and
  // still listening after being sent two malformed messages.
  check('malformed and future-protocol messages do not take the app down',
    !/DOM bridge could not listen/.test(log) && app.exitCode === null)
}

host?.stdin.end()
await stopTracked(host)
await stopTracked(app)

// ---------------------------------------------------------------------------
// And into the pack.
//
// The wire being right proves the app HEARD the browser. What a user gets is a
// folder, so the second half starts a capture with the same messages already
// delivered and then looks for them in plugins/chrome-dom/elements.json. The
// payload is written into the save-first folder before the editor opens, so
// this needs no click — which is the whole reason that folder exists.
//
// THIS HALF NEEDS A REAL SCREEN, AND THE OTHER HALF DOES NOT.
//
// Everything above speaks the wire and reads the log: no capture, no display,
// no encoder. Below this line the app records the desktop for twelve seconds,
// which is a hardware fact a build agent may simply not have — the same reason
// `qa:native-replay-field` and `qa:dxgi-timing-reference` are not `check:`
// scripts. So `--wire-only` runs the part a gate can honestly hold, and the
// full run stays available as `npm run qa:chrome-bridge`.
//
// The skip is LOUD. A silently shortened check is how the whole harness came to
// be failing without anyone knowing.
// ---------------------------------------------------------------------------
if (process.argv.includes('--wire-only')) {
  console.log(
    '\nSKIPPED the pack half (--wire-only): it records the desktop for 12 s.'
    + '\n        Run `npm run qa:chrome-bridge` on a machine with a display.',
  )
  console.log(`\nresult: ${failed === 0 ? 'OK' : 'BROKEN'} — ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exitCode = 1
  return
}
console.log('\nAnd into the pack')
packProfile = mkdtempSync(join(tmpdir(), 'capturepack-chrome-pack-'))
const packData = join(packProfile, 'data')
const packOut = join(packProfile, 'out')
const app2 = track(spawn(
  electron,
  [
    '.',
    `--user-data-dir=${packData}`,
    `--output-dir=${packOut}`,
    '--no-global-shortcut',
    '--no-login-item',
    '--capture-now=12',
  ],
  { stdio: 'ignore', env: bridgeEnv },
))

const ready = await waitFor(
  () => existsSync(join(packData, 'logs', 'main.log')) &&
    readFileSync(join(packData, 'logs', 'main.log'), 'utf8').includes('DOM bridge listening'),
  45_000,
)

let host2 = null
let manifestHostConnected = false
if (ready) {
  // LAUNCHED THE WAY CHROME LAUNCHES IT, not the way we would: through the
  // silent .cmd named by the native-host manifest, with Chromium's own origin
  // and --parent-window arguments. The launcher is generated here inside the
  // disposable profile from the same three-line contract production writes.
  //
  // A direct Electron host is intentionally not tested as valid: its measured
  // leading CRLF is the bug this launcher exists to prevent.
  const launcher = join(packProfile, 'capturepack-host.cmd')
  writeFileSync(
    launcher,
    `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n` +
      `"${electron}" "${nativeHostScript}" %*\r\n`,
    'utf8',
  )
  host2 = track(spawn(
    process.env.ComSpec ?? 'cmd.exe',
    [
      '/d',
      '/s',
      '/c',
      launcher,
      'chrome-extension://hkkjpjijojljlboonbkfjcmmlljbgkik/',
      '--parent-window=0',
    ],
    { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env: bridgeEnv },
  ))
  host2.stdin.write(frame({ type: 'host.hello', protocol: 1, timestamp: Date.now(), version: '0.1.0' }))
  manifestHostConnected = await waitFor(
    () =>
      readFileSync(join(packData, 'logs', 'main.log'), 'utf8').includes(
        '[chrome] extension 0.1.0 connected, protocol v1',
      ),
    10_000,
  )
  check(
    'the manifest-style launcher reaches the isolated app',
    manifestHostConnected,
    'capturepack-host.cmd exited before its hello reached the app',
  )
  if (manifestHostConnected) {
    // A real extension sends selection events after its hello/hello-reply
    // handshake, not in the same scheduler turn as the connection itself.
    // Preserve that ordering so this remains a browser-shaped integration
    // check instead of a race against app-side connection registration.
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    // AND AFTER THE RECORDER IS ACTUALLY RECORDING.
    //
    // A pack carries the DOM events inside its frozen replay window, and
    // nothing else — a pick from before the first frame was retained points at
    // a moment the pack does not contain. This check used to fire its pick
    // about two seconds after launch, while the recorder needed three, so the
    // event landed BEFORE the replay began and was correctly excluded. The
    // check then reported the product as broken. Measured on the failing run:
    // pick at 1991 ms, replay starting at 3067 ms.
    const recording = await waitFor(
      () => readFileSync(join(packData, 'logs', 'main.log'), 'utf8')
        .includes('[capture] recorder state: recording'),
      45_000,
    )
    check('the recorder is running before the browser speaks', recording,
      'no "recorder state: recording" line, so any pick would fall outside the replay')
    host2.stdin.write(
      frame({
        type: 'dom.element.selected',
        protocol: 1,
        timestamp: Date.now(),
        tab: { url: 'https://example.com/checkout', title: 'Checkout' },
        element: {
          tag: 'button', id: 'save', role: 'button', text: 'Save',
          selector: '#save', bounds: { x: 100, y: 200, width: 120, height: 40 },
        },
        // Extension 0.1.4 and newer always send this, and without it a pick is
        // recorded but can never become a candidate. A fixture that omits it
        // is not a fixture of anything a browser sends.
        viewport: {
          width: 1280, height: 720, dpr: 1,
          screenX: 0, screenY: 0, outerWidth: 1280, outerHeight: 820,
        },
      }),
    )
  }
}

// The capture fires at 12 s and the payload lands with the rest of the folder.
const wrote =
  manifestHostConnected &&
  (await waitFor(() => {
    if (!existsSync(packOut)) return false
    for (const entry of readdirSync(packOut)) {
      if (existsSync(join(packOut, entry, 'plugins', 'chrome-dom', 'elements.json'))) return true
    }
    return false
  }, 90_000))
check('the capture carries the browser context into the pack', wrote,
  'no plugins/chrome-dom/elements.json appeared in the saved folder')

if (wrote) {
  const dir = readdirSync(packOut).find((e) =>
    existsSync(join(packOut, e, 'plugins', 'chrome-dom', 'elements.json')))
  const packDir = join(packOut, dir)
  const payload = JSON.parse(
    readFileSync(join(packDir, 'plugins', 'chrome-dom', 'elements.json'), 'utf8'))
  const picked = payload.events.find((e) => e.type === 'dom.element.selected')
  check('it says WHAT was clicked, not where it was drawn',
    picked?.element?.selector === '#save' && picked.element.role === 'button' &&
      picked.tab.url === 'https://example.com/checkout',
    JSON.stringify(picked))
  check('the event is on the pack clock, inside the replay',
    typeof picked?.t_ms === 'number' && picked.t_ms >= 0 && picked.t_ms <= 30_000,
    `t_ms=${String(picked?.t_ms)}`)
  // DECLARED AFTER IT IS WRITTEN, SO IT IS WAITED FOR.
  //
  // `writeCapturedDomPlugin` writes `elements.json` and only then calls
  // `addManifestPlugin`, and the loop above stops at the first of those two.
  // Reading the manifest in the same turn therefore raced the second, and this
  // check went red once in a gate run and green standalone — the exact shape of
  // a flake that teaches people to re-run instead of to look.
  const declared = await waitFor(() => {
    try {
      return JSON.parse(readFileSync(join(packDir, 'manifest.json'), 'utf8'))
        .plugins.some((p) => p.name === 'chrome-dom')
    } catch {
      // A manifest being rewritten atomically can be briefly unreadable.
      return false
    }
  }, 30_000)
  check('the manifest declares the plugin that wrote it', declared,
    'plugins[] never listed chrome-dom')

  // REAL MEDIA, NOT ONLY BOX SHAPES. This is the release-desk E2E the
  // deterministic ring unit cannot provide: Chromium encoded these files
  // through the production MediaRecorder/ring path above. Probe every display
  // replay, then make ffmpeg decode every video frame with -xerror before the
  // disposable pack is removed.
  const replayFiles = readdirSync(packDir)
    .filter((name) => /^replay(?:-d\d+)?\.mp4$/u.test(name))
    .sort()
  const decodeFailures = []
  for (const replayFile of replayFiles) {
    const replayPath = join(packDir, replayFile)
    const probe = spawnSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_name:format=duration',
        '-of',
        'json',
        replayPath,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 60_000 },
    )
    let probeValid = false
    try {
      const parsed = JSON.parse(probe.stdout || '{}')
      probeValid =
        probe.status === 0 &&
        Array.isArray(parsed.streams) &&
        parsed.streams.some((stream) => typeof stream.codec_name === 'string') &&
        Number(parsed.format?.duration) > 0
    } catch {
      probeValid = false
    }
    const decode = spawnSync(
      'ffmpeg',
      ['-nostdin', '-v', 'error', '-xerror', '-i', replayPath, '-map', '0:v:0', '-f', 'null', '-'],
      { encoding: 'utf8', windowsHide: true, timeout: 120_000 },
    )
    if (!probeValid || decode.status !== 0) {
      decodeFailures.push(
        `${replayFile}: probe=${String(probe.status)}, decode=${String(decode.status)}, ` +
          `${String(probe.stderr || decode.stderr || probe.error || decode.error).slice(0, 240)}`,
      )
    }
  }
  check(
    'every newly recorded display MP4 probes and fully decodes',
    replayFiles.length > 0 && decodeFailures.length === 0,
    decodeFailures.length > 0
      ? decodeFailures.join(' | ')
      : `no replay MP4 found in ${packDir}`,
  )
}

host2?.stdin.end()
await stopTracked(host2)
await stopTracked(app2)

console.log(`\nresult: ${failed === 0 ? 'OK' : 'BROKEN'} — ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
} finally {
  await stopAllTracked()
  for (const temporaryProfile of [profile, packProfile]) {
    if (temporaryProfile === null) continue
    try {
      rmSync(temporaryProfile, { recursive: true, force: true })
    } catch {
      // Process-tree shutdown was attempted first. A transient Windows file
      // lock is diagnostic litter, never permission to leave a live app.
    }
  }
}
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
