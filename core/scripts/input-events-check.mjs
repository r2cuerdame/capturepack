// THE GATE FOR `input.*` TIMELINE EVENTS (issue #12).
//
// Two halves, and the second one is the promise.
//
// The first half is ordinary: the format documents the five event types the
// app emits, the schema and the validator agree with SPEC §10.2, and the ring
// that holds them is bounded.
//
// The second half is why this file exists at all. SPEC §10.2 reserved
// `input.*` in 0.1.0 with "writers MUST NOT emit them yet", and 0.8.0 lifts
// that for the MOUSE and the WINDOW only. `input.key.*` stays reserved and
// unemitted, because a keystroke is the one input the picture does not already
// contain — a password field renders dots, and the DOM walker already refuses
// `type="password"` for exactly that reason. A promise with no check is a
// comment, so the assertions below hunt for a keyboard event, a keyboard hook
// and a keyboard virtual-key code across the whole tree, in the source that
// runs and in the format that is written.
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const core = path.join(here, '..')
const repo = path.join(core, '..')

let passed = 0
let failed = 0

function check(name, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${name}`)
    return
  }
  failed += 1
  console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

function read(rel) {
  return readFileSync(path.join(repo, rel), 'utf8')
}

console.log('input.* timeline events (SPEC §10.2)')

// ---------------------------------------------------------------------------
// The format says what is emitted, and what still is not
// ---------------------------------------------------------------------------
const spec = read('SPEC.md')
const EMITTED = [
  'input.mouse.move',
  'input.mouse.click',
  'input.window.focus',
  'input.window.move',
  'input.window.resize',
]

console.log('SPEC')
for (const type of EMITTED) {
  check(
    `SPEC §10.2 defines \`${type}\` in a table row`,
    new RegExp(`^\\|\\s*\`${type.replaceAll('.', '\\.')}\`\\s*\\|`, 'mu').test(spec),
  )
}
check(
  'SPEC no longer tells writers they may emit nothing in the namespace',
  !/`input\.\*`[^|]*\|[^|]*\*\*Reserved for V2\*\*/u.test(spec),
  'the 0.1.0 blanket reservation is still the only thing §10.2 says about input.*',
)
check(
  'SPEC still refuses `input.key.*` in words a reader cannot miss',
  /`input\.key\.\*`/u.test(spec) && /input\.key[^\n]*MUST NOT/u.test(spec),
)
check(
  'SPEC §13.1 introduces the event types at 0.8.0',
  /0\.8\.0/u.test(spec) && /input\.\*[^\n]*0\.8\.0|0\.8\.0[^\n]*input/u.test(spec),
)

// ---------------------------------------------------------------------------
// The schema
// ---------------------------------------------------------------------------
console.log('docs/schemas/timeline.schema.json')
const schema = JSON.parse(read('docs/schemas/timeline.schema.json'))
const schemaText = JSON.stringify(schema)
check(
  'the schema stops calling the whole namespace unemitted',
  !/input\.\* \(reserved for V2 — not emitted yet\)/u.test(schemaText),
)
check(
  'the schema names the emitted mouse and window types',
  EMITTED.every((type) => schemaText.includes(type)),
)
check(
  'the schema records that input.key.* is still reserved',
  /input\.key\.\*[^"]*reserved/iu.test(schemaText),
)

// ---------------------------------------------------------------------------
// The validator, run for real over a pack
// ---------------------------------------------------------------------------
console.log('tools/validate-capturepack.mjs')
const work = mkdtempSync(path.join(tmpdir(), 'capturepack-input-events-'))
try {
  const validator = path.join(repo, 'tools', 'validate-capturepack.mjs')
  const runOver = (formatVersion, events) => {
    const pack = path.join(work, `pack-${Math.random().toString(36).slice(2)}`)
    cpSync(path.join(repo, 'examples', 'minimal'), pack, { recursive: true })
    const manifestFile = path.join(pack, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    manifest.format_version = formatVersion
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    const timelineFile = path.join(pack, 'timeline.json')
    const timeline = JSON.parse(readFileSync(timelineFile, 'utf8'))
    timeline.events = [...events, ...timeline.events].sort((a, b) => a.t_ms - b.t_ms)
    writeFileSync(timelineFile, `${JSON.stringify(timeline, null, 2)}\n`, 'utf8')
    const result = execFileSync(
      process.execPath,
      [validator, pack],
      { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      // The validator exits non-zero on a failing pack; that is data, not an error.
    ).toString()
    return result
  }
  const runQuiet = (formatVersion, events) => {
    try {
      return runOver(formatVersion, events)
    } catch (error) {
      return `${error.stdout ?? ''}${error.stderr ?? ''}`
    }
  }

  const mouse = { t_ms: 120, type: 'input.mouse.move', source: 'core', data: { x: 40, y: 80 } }
  const focus = {
    t_ms: 130,
    type: 'input.window.focus',
    source: 'core',
    data: { title: 'Fixture', process: 'explorer' },
  }
  const key = { t_ms: 140, type: 'input.key.down', source: 'core', data: {} }

  const accepted = runQuiet('0.8.0', [mouse, focus])
  check(
    'the validator no longer refuses an emitted mouse or window event',
    !/FAIL[^\n]*input\.mouse\.move/u.test(accepted)
      && !/FAIL[^\n]*input\.window\.focus/u.test(accepted),
    accepted.split('\n').filter((line) => /input\./u.test(line)).join(' | '),
  )
  check(
    'the validator says out loud that it read them',
    /PASS[^\n]*input\.mouse[^\n]*event\(s\)/u.test(accepted),
    accepted.split('\n').filter((line) => /input\.(mouse|window)/u.test(line)).join(' | '),
  )

  const refused = runQuiet('0.8.0', [key])
  check(
    'the validator REFUSES input.key.* — the namespace it is still reserved in',
    /FAIL[^\n]*input\.key\.down/u.test(refused),
    refused.split('\n').filter((line) => /input\./u.test(line)).join(' | '),
  )

  const tooOld = runQuiet('0.1.0', [mouse])
  check(
    'a pack carrying input events MUST declare 0.8.0 or later',
    /FAIL[^\n]*0\.8\.0/u.test(tooOld),
    tooOld.split('\n').filter((line) => /input\./u.test(line)).join(' | '),
  )
} finally {
  rmSync(work, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// NOTHING ANYWHERE LISTENS TO THE KEYBOARD
// ---------------------------------------------------------------------------
//
// The reason `input.key.*` is not emitted is not that the code forgot to. It is
// that observing a keystroke needs a global low-level keyboard hook, and in a
// screen-capture tool that is the shape of a keylogger — flagged by antivirus,
// taken on trust by anyone reading the source. These assertions are what keep
// that decision from being reversed by a well-meaning patch.
console.log('No keyboard is observed, anywhere')
// PROSE IS ALLOWED TO NAME WHAT CODE MAY NOT DO, and it has to be: the whole
// reason `input.key.*` is unemitted is written down at these seams, in comments
// that necessarily say "WH_KEYBOARD_LL" and "GetAsyncKeyState". So the
// assertions below run over the file with its comments stripped — what the
// machine executes, not what the file explains.
function code(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*(#|\/\/|\*|\/\*)/u.test(line))
    .join('\n')
}
const hostScript = read('core/scripts/context-host.ps1')
const hostCode = code(hostScript)
const laneSources = [
  'core/src/main/context/inputEvents.ts',
  'core/src/main/context/surfaceLane.ts',
  'core/src/main/context/runtime.ts',
]
check(
  'the context host installs no keyboard hook',
  !/WH_KEYBOARD|SetWindowsHookEx|KBDLLHOOKSTRUCT|GetKeyboardState|MapVirtualKey/u.test(hostCode),
)
check(
  'the context host reads mouse BUTTONS only — no keyboard virtual-key code',
  !/VK_(?!LBUTTON|RBUTTON|MBUTTON)[A-Z0-9_]+/u.test(hostCode),
  (hostCode.match(/VK_[A-Z0-9_]+/gu) ?? []).join(', '),
)
check(
  'the only key state the host asks for is the three mouse buttons',
  (hostCode.match(/GetAsyncKeyState\(([^)]*)\)/gu) ?? []).every((call) =>
    /VK_(LBUTTON|RBUTTON|MBUTTON)|int vKey/u.test(call),
  ),
  (hostCode.match(/GetAsyncKeyState\(([^)]*)\)/gu) ?? []).join(', '),
)
for (const rel of laneSources) {
  let source
  try {
    source = code(read(rel))
  } catch {
    check(`${rel} exists`, false, 'not found')
    continue
  }
  check(
    `${rel} contains no key observation`,
    !/keydown|keyup|KeyboardEvent|WH_KEYBOARD|GetAsyncKeyState/u.test(source),
  )
}
check(
  'no source in the app emits an input.key.* event',
  execFileSync(
    process.execPath,
    [
      '-e',
      `const {readdirSync,readFileSync,statSync}=require('fs');const p=require('path');`
        + `const hits=[];const walk=(d)=>{for(const e of readdirSync(d)){const f=p.join(d,e);`
        + `if(e==='node_modules'||e==='dist'||e==='out')continue;`
        + `if(statSync(f).isDirectory()){walk(f);continue;}`
        + `if(!/[.](ts|mjs|cjs|js|ps1)$/u.test(e))continue;`
        // This file is allowed to name what it forbids; nothing else is.
        + `if(/^input-events-check[.]/u.test(e))continue;`
        + `if(/input[.]key[.](down|up|press)/u.test(readFileSync(f,'utf8')))hits.push(f);}};`
        + `walk(${JSON.stringify(path.join(core, 'src'))});`
        + `walk(${JSON.stringify(path.join(core, 'scripts'))});`
        + `console.log(hits.join('\\n'))`,
    ],
    { encoding: 'utf8' },
  ).trim() === '',
  'a source file mentions an input.key.* event type',
)

// ---------------------------------------------------------------------------
// The wiring: where the events come from, and what declares them
// ---------------------------------------------------------------------------
console.log('Wiring')
const packageJson = JSON.parse(read('core/package.json'))
check(
  'package.json runs this check as check:input-events',
  packageJson.scripts['check:input-events'] === 'node scripts/input-events-check.mjs',
)
const types = read('core/src/shared/types.ts')
check(
  "types.ts declares 0.8.0 as the input events' format version",
  /FORMAT_VERSION_INPUT_EVENTS\s*=\s*'0\.8\.0'/u.test(types),
)
const exporter = read('core/src/main/exporter.ts')
check(
  'the exporter declares 0.8.0 only for a pack that carries an input event',
  exporter.includes('FORMAT_VERSION_INPUT_EVENTS') && /hasInputEvents/u.test(exporter),
)
const sessionSource = read('core/src/main/session.ts')
check(
  'the capture flow puts the observed input events into timeline.json',
  /frozenInputEvents/u.test(sessionSource),
)
check(
  'every path that collapses the clock onto the capture instant drops them first',
  (sessionSource.match(/timeline\.events\.map\(|events\.map\(\(e\) => \(\{ \.\.\.e, t_ms: 0/gu) ?? [])
    .length === 0
    || /withoutInputEvents/u.test(sessionSource),
  'session.ts rebases a timeline without deciding what happens to an input event',
)
check(
  'the host sample carries the cursor it already had the chance to read',
  /GetCursorPos/u.test(hostScript),
)

// ---------------------------------------------------------------------------
// Behaviour: the ring itself
// ---------------------------------------------------------------------------
console.log('The ring (bundled from src)')
const bundleWork = mkdtempSync(path.join(tmpdir(), 'capturepack-input-bundle-'))
try {
  const bundle = path.join(bundleWork, 'check.cjs')
  execFileSync(
    process.execPath,
    [
      path.join(core, 'node_modules', 'esbuild', 'bin', 'esbuild'),
      path.join(here, 'input-events-check.ts'),
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--outfile=${bundle}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  execFileSync(process.execPath, [bundle], { stdio: 'inherit', cwd: core })
} catch (error) {
  failed += 1
  console.log(`  FAIL  the input-event ring could not be built or refused its own contract — ${
    error instanceof Error ? error.message : String(error)
  }`)
} finally {
  rmSync(bundleWork, { recursive: true, force: true })
}

console.log(`\ninput-events check: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
