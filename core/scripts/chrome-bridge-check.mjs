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

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const electron = process.platform === 'win32'
  ? join('node_modules', 'electron', 'dist', 'electron.exe')
  : join('node_modules', '.bin', 'electron')

const profile = mkdtempSync(join(tmpdir(), 'capturepack-chrome-'))
const dataDir = join(profile, 'data')
const outDir = join(profile, 'out')

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

function logText() {
  const file = join(dataDir, 'logs', 'main.log')
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

console.log('\nStarting the app with a profile of its own')
const app = spawn(
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
  { stdio: 'ignore' },
)

const listening = await waitFor(() => logText().includes('DOM bridge listening'), 45_000)
check('the app listens for a native host', listening, 'no "DOM bridge listening" line appeared')

let host = null
if (listening) {
  console.log('\nSpeaking Chrome\'s side of the wire')
  host = spawn(electron, ['.', '--native-host'], { stdio: ['pipe', 'pipe', 'ignore'] })

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
  let replied = false
  host.stdout.on('data', (chunk) => {
    if (chunk.length > 4) replied = true
  })
  const gotReply = await waitFor(() => replied, 10_000)
  check('the app answers, so the extension knows it is live', gotReply, 'nothing came back on stdout')

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

  // Nothing above is supposed to produce a log line — the DOM is not streamed
  // to the log either — so the proof is that the app is still healthy and
  // still listening after being sent two malformed messages.
  await new Promise((r) => setTimeout(r, 1500))
  check('malformed and future-protocol messages do not take the app down',
    !/DOM bridge could not listen/.test(logText()) && app.exitCode === null)
}

host?.stdin.end()
host?.kill()
app.kill()
await new Promise((r) => setTimeout(r, 1200))

// ---------------------------------------------------------------------------
// And into the pack.
//
// The wire being right proves the app HEARD the browser. What a user gets is a
// folder, so the second half starts a capture with the same messages already
// delivered and then looks for them in plugins/chrome-dom/elements.json. The
// payload is written into the save-first folder before the editor opens, so
// this needs no click — which is the whole reason that folder exists.
// ---------------------------------------------------------------------------
console.log('\nAnd into the pack')
const packProfile = mkdtempSync(join(tmpdir(), 'capturepack-chrome-pack-'))
const packData = join(packProfile, 'data')
const packOut = join(packProfile, 'out')
const app2 = spawn(
  electron,
  [
    '.',
    `--user-data-dir=${packData}`,
    `--output-dir=${packOut}`,
    '--no-global-shortcut',
    '--no-login-item',
    '--capture-now=12',
  ],
  { stdio: 'ignore' },
)

const ready = await waitFor(
  () => existsSync(join(packData, 'logs', 'main.log')) &&
    readFileSync(join(packData, 'logs', 'main.log'), 'utf8').includes('DOM bridge listening'),
  45_000,
)

let host2 = null
if (ready) {
  host2 = spawn(electron, ['.', '--native-host'], { stdio: ['pipe', 'pipe', 'ignore'] })
  host2.stdin.write(frame({ type: 'host.hello', protocol: 1, timestamp: Date.now(), version: '0.1.0' }))
  await new Promise((r) => setTimeout(r, 1500))
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
    }),
  )
}

// The capture fires at 12 s and the payload lands with the rest of the folder.
const wrote = await waitFor(() => {
  if (!existsSync(packOut)) return false
  for (const entry of readdirSync(packOut)) {
    if (existsSync(join(packOut, entry, 'plugins', 'chrome-dom', 'elements.json'))) return true
  }
  return false
}, 90_000)
check('the capture carries the browser context into the pack', wrote,
  'no plugins/chrome-dom/elements.json appeared in the saved folder')

if (wrote) {
  const dir = readdirSync(packOut).find((e) =>
    existsSync(join(packOut, e, 'plugins', 'chrome-dom', 'elements.json')))
  const payload = JSON.parse(
    readFileSync(join(packOut, dir, 'plugins', 'chrome-dom', 'elements.json'), 'utf8'))
  const picked = payload.events.find((e) => e.type === 'dom.element.selected')
  check('it says WHAT was clicked, not where it was drawn',
    picked?.element?.selector === '#save' && picked.element.role === 'button' &&
      picked.tab.url === 'https://example.com/checkout',
    JSON.stringify(picked))
  check('the event is on the pack clock, inside the replay',
    typeof picked?.t_ms === 'number' && picked.t_ms >= 0 && picked.t_ms <= 30_000,
    `t_ms=${String(picked?.t_ms)}`)
  check('the manifest declares the plugin that wrote it',
    JSON.parse(readFileSync(join(packOut, dir, 'manifest.json'), 'utf8'))
      .plugins.some((p) => p.name === 'chrome-dom'))
}

host2?.stdin.end()
host2?.kill()
app2.kill()
await new Promise((r) => setTimeout(r, 800))
try {
  rmSync(profile, { recursive: true, force: true })
  rmSync(packProfile, { recursive: true, force: true })
} catch {
  // A profile the app still holds open is not worth failing over.
}

console.log(`\nresult: ${failed === 0 ? 'OK' : 'BROKEN'} — ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
