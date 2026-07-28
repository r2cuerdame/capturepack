// Provider Host isolation checks (issue #64).
//
// WHY THIS EXISTS. #64's deliverable is not "a protocol document" — it is
// "protocol version check, lifecycle dispatch, timeouts, failure isolation,
// enable/disable, execution log, declared permissions … A provider must never be
// able to take Core down". Every one of those is a claim about what happens when
// a provider MISBEHAVES, and the only way to check a claim like that is to
// misbehave on purpose. So this file registers deliberately broken providers —
// one that hangs, one that throws, one that lies about its protocol version, one
// that eats memory — and asserts what Core does about each.
//
// It runs the shipping ProviderHost, bundled from TypeScript at run time so it
// can never drift from the code that ships. No Electron, no host process, no
// side effects.
//
//   node scripts/provider-host-check.mjs

import { build } from 'esbuild'

const bundle = await build({
  entryPoints: ['scripts/provider-host-check.entry.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  // The Provider Host logs through main/log.ts, which imports electron. The
  // stub keeps this harness free of Electron without changing a line of the
  // code under test.
  plugins: [
    {
      name: 'log-stub',
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /(^|\/)log$/ }, () => ({ path: 'log-stub', namespace: 'stub' }))
        pluginBuild.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: `
            export const logInfo = (m) => { if (process.env.VERBOSE) console.log('   [log]', m) }
            export const logWarn = (m) => { if (process.env.VERBOSE) console.log('   [warn]', m) }
            export const logError = (m) => { if (process.env.VERBOSE) console.log('   [error]', m) }
          `,
          loader: 'js',
        }))
      },
    },
  ],
})
const { ProviderHost, SessionClock, parseProviderManifest } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
)

const failures = []
function check(label, condition, detail = '') {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

function manifest(overrides = {}) {
  return JSON.stringify({
    id: 'test-provider',
    name: 'Test Provider',
    version: '0.1.0',
    type: 'temporal-context-provider',
    protocol_version: '1',
    entry: 'dist/index.js',
    permissions: ['read-active-window'],
    ...overrides,
  })
}

function baseProvider(id, overrides = {}) {
  return {
    id,
    name: 'Test Provider',
    version: '0.1.0',
    protocolVersion: '1',
    type: 'temporal-context-provider',
    async materialize(c) {
      return {
        providerId: id,
        timeMs: c.timeMs,
        accuracy: {
          requestedTimeMs: c.timeMs,
          materializedTimeMs: c.timeMs,
          errorMs: 0,
          exact: true,
          coverage: 'covered',
        },
        surfaces: [],
      }
    },
    async getSurfaceClaims() {
      return []
    },
    async hitTest() {
      return []
    },
    async track(c) {
      return {
        providerId: id,
        surfaceId: c.surfaceId,
        objectId: c.objectId,
        samples: [],
        gaps: [],
        accuracy: {
          requestedTimeMs: 0,
          materializedTimeMs: 0,
          errorMs: 0,
          exact: true,
          coverage: 'covered',
        },
      }
    },
    async export() {
      return { providerId: id, files: [] }
    },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 1. The manifest is checked strictly, and every refusal names its reason
// ---------------------------------------------------------------------------
console.log('manifest')
check('a well-formed manifest parses', parseProviderManifest(manifest()).ok)
check(
  'protocol_version "2" is refused',
  parseProviderManifest(manifest({ protocol_version: '2' })).refusal?.kind === 'protocol-mismatch',
)
check(
  'an unknown permission is refused, not ignored',
  parseProviderManifest(manifest({ permissions: ['read-everything'] })).refusal?.kind ===
    'unknown-permission',
)
check(
  'a non-provider type is refused',
  parseProviderManifest(manifest({ type: 'after-save-action' })).refusal?.kind === 'unknown-type',
)
check(
  'an id that is not path-safe is refused',
  parseProviderManifest(manifest({ id: '../evil' })).refusal?.kind === 'bad-id',
)
check('garbage is refused', parseProviderManifest('{oops').refusal?.kind === 'not-json')

// ---------------------------------------------------------------------------
// 2. Registration
// ---------------------------------------------------------------------------
console.log('registration')
const clock = new SessionClock(30_000)
const host = new ProviderHost(clock)
const good = parseProviderManifest(manifest())
check('a matching provider registers', host.register(good.manifest, baseProvider('test-provider')).ok)
check(
  'the same id cannot register twice',
  !host.register(good.manifest, baseProvider('test-provider')).ok,
)
check(
  'a provider whose code disagrees with its manifest is refused',
  !host.register(parseProviderManifest(manifest({ id: 'other' })).manifest, baseProvider('mismatch'))
    .ok,
)
check(
  'a provider speaking another protocol version is refused even with a valid manifest',
  !host.register(
    parseProviderManifest(manifest({ id: 'future' })).manifest,
    baseProvider('future', { protocolVersion: '99' }),
  ).ok,
)

// ---------------------------------------------------------------------------
// 3. Permissions are a gate, not a label
// ---------------------------------------------------------------------------
console.log('permissions')
check('a declared permission is granted', host.hasPermission('test-provider', 'read-active-window'))
check('an undeclared permission is denied', !host.hasPermission('test-provider', 'network'))
check('an unknown provider is denied everything', !host.hasPermission('ghost', 'read-pack'))

// ---------------------------------------------------------------------------
// 4. A hanging provider does not hang Core
// ---------------------------------------------------------------------------
console.log('isolation')
const hangHost = new ProviderHost(clock)
hangHost.register(
  parseProviderManifest(manifest({ id: 'hanger' })).manifest,
  baseProvider('hanger', {
    async hitTest() {
      // Never resolves. This is the whole point.
      return new Promise(() => {})
    },
  }),
)
const startedAt = Date.now()
const hung = await hangHost.hitTest(['hanger'], {
  sessionId: clock.sessionId,
  timeMs: 0,
  point: { x: 0, y: 0 },
  surface: {
    surfaceId: 's1',
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    zOrder: 0,
    visible: true,
    minimized: false,
    foreground: true,
  },
})
const hungMs = Date.now() - startedAt
check(
  `a provider that never resolves is abandoned at its budget (${hungMs} ms, returned ${hung.length} candidates)`,
  hung.length === 0 && hungMs < 1_000 && hungMs >= 250,
)
check(
  'the timeout is on the execution log by name',
  hangHost.executionLogEntries().some((e) => e.providerId === 'hanger' && e.outcome === 'timeout'),
)

// A provider that throws SYNCHRONOUSLY is the one that would escape a naive
// wrapper and become an uncaughtException — i.e. take the tray app down.
const throwHost = new ProviderHost(clock)
throwHost.register(
  parseProviderManifest(manifest({ id: 'thrower' })).manifest,
  baseProvider('thrower', {
    hitTest() {
      throw new Error('boom')
    },
  }),
)
let survived = true
try {
  const thrown = await throwHost.hitTest(['thrower'], {
    sessionId: clock.sessionId,
    timeMs: 0,
    point: { x: 0, y: 0 },
    surface: {
      surfaceId: 's1',
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      zOrder: 0,
      visible: true,
      minimized: false,
      foreground: true,
    },
  })
  check('a synchronous throw becomes an empty answer', thrown.length === 0)
} catch {
  survived = false
}
check('a throwing provider cannot take Core down', survived)

// Five consecutive failures disable it BY NAME with a reason.
for (let i = 0; i < 5; i += 1) {
  await throwHost.hitTest(['thrower'], {
    sessionId: clock.sessionId,
    timeMs: 0,
    point: { x: 0, y: 0 },
    surface: {
      surfaceId: 's1',
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      zOrder: 0,
      visible: true,
      minimized: false,
      foreground: true,
    },
  })
}
const thrownStatus = throwHost.statuses()[0]
check(
  'repeated failures disable the provider with a readable reason',
  typeof thrownStatus.disabledReason === 'string' && thrownStatus.disabledReason.length > 0,
  String(thrownStatus.disabledReason),
)
check('a disabled provider is no longer asked', throwHost.activeIds().length === 0)
throwHost.setEnabled('thrower', true)
check('re-enabling clears the reason', throwHost.statuses()[0].disabledReason === null)

// ---------------------------------------------------------------------------
// 5. The tick: clock offset, status, and the memory budget
// ---------------------------------------------------------------------------
console.log('tick and budget')
const tickHost = new ProviderHost(clock)
// A provider whose clock runs 5000 ms ahead of Core's — the drift the protocol
// says nothing measures unless TickAck exists (GAP 3).
const SKEW_MS = 5_000
let ackBytes = 1024
tickHost.register(
  parseProviderManifest(manifest({ id: 'ticker' })).manifest,
  baseProvider('ticker', {
    async onBufferStart() {},
    async onTick(c) {
      const local = clock.nowMs() + SKEW_MS
      return {
        state: 'running',
        receivedAtLocalMs: local,
        providerLocalMs: local,
        bufferedFromMs: c.bufferStartMs,
        bufferedToMs: c.timeMs,
        resolutionMs: 100,
        samples: 10,
        dropped: 0,
        bytes: ackBytes,
      }
    },
  }),
  { memoryBudgetBytes: 4096 },
)
await tickHost.bufferStart()
await tickHost.tick()
const tickStatus = tickHost.statuses()[0]
check('the tick collects state from the provider', tickStatus.state === 'running')
check('the tick reports the provider buffer', tickStatus.resolutionMs === 100)
check(
  `a ${SKEW_MS} ms clock skew is MEASURED, not assumed away ` +
    `(offset ${(tickStatus.clockOffsetMs ?? NaN).toFixed(1)} ms, bound ±${tickStatus.clockErrorMs.toFixed(2)} ms)`,
  tickStatus.clockOffsetMs !== null &&
    Math.abs(tickStatus.clockOffsetMs - SKEW_MS) < 50 &&
    Number.isFinite(tickStatus.clockErrorMs) &&
    tickStatus.clockErrorMs < 50,
)
const materialized = await tickHost.materialize('ticker', { sessionId: clock.sessionId, timeMs: 0 })
check(
  'the measured clock error is folded into every accuracy the provider reports',
  materialized !== null && materialized.accuracy.errorMs >= 0 && materialized.accuracy.errorMs < 50,
  JSON.stringify(materialized?.accuracy),
)

// Over budget: three strikes, then disabled — by name, with the number.
ackBytes = 64 * 1024
await tickHost.tick()
await tickHost.tick()
check('one over-budget tick does not disable', tickHost.statuses()[0].disabledReason === null)
await tickHost.tick()
check(
  'a provider that ignores its memory budget is disabled with the number in the reason',
  (tickHost.statuses()[0].disabledReason ?? '').includes('KB'),
  String(tickHost.statuses()[0].disabledReason),
)

// A provider with no onTick at all is legal, and its clock is UNMEASURED —
// which must read as unbounded error, never as zero.
const quietHost = new ProviderHost(clock)
quietHost.register(parseProviderManifest(manifest({ id: 'quiet' })).manifest, baseProvider('quiet'))
await quietHost.tick()
check(
  'a provider that never acks has an unbounded clock error, not a zero one',
  quietHost.statuses()[0].clockErrorMs === Number.POSITIVE_INFINITY,
)
const quietState = await quietHost.materialize('quiet', { sessionId: clock.sessionId, timeMs: 0 })
check(
  'and its answers are therefore never exact',
  quietState !== null && quietState.accuracy.exact === false,
  JSON.stringify(quietState?.accuracy),
)

// ---------------------------------------------------------------------------
// 6. frame() is optional; declining is not failing
// ---------------------------------------------------------------------------
console.log('optional methods')
const frame = await quietHost.frame('quiet', {
  sessionId: clock.sessionId,
  timeMs: 0,
  region: { x: 0, y: 0, width: 100, height: 100 },
  maxCandidates: 10,
})
check('a provider without frame() declines rather than errors', frame?.declined === true)
check(
  'declining is not a failure',
  quietHost.executionLogEntries().every((e) => e.outcome !== 'error'),
)

console.log('')
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
