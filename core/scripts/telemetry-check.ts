import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dailyTelemetryLaunchPolicy, sendDailyTelemetry, telemetryOs, type TelemetryPayload } from '../src/main/telemetry'

function requiredCheckDirectory(): string {
  const directory = process.env.CAPTUREPACK_TELEMETRY_CHECK_DIR
  if (directory === undefined) throw new Error('CAPTUREPACK_TELEMETRY_CHECK_DIR is required')
  return directory
}

const checkDirectory = requiredCheckDirectory()
const statePath = join(checkDirectory, 'purplepulse.json')
const INSTALL_ID = '123e4567-e89b-42d3-a456-426614174000'
const SECOND_ID = '123e4567-e89b-42d3-a456-426614174001'
let passed = 0
let failed = 0

function check(name: string, condition: boolean): void {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`)
  if (condition) passed += 1
  else failed += 1
}

const sent: TelemetryPayload[] = []
const post = async (payload: TelemetryPayload): Promise<void> => {
  sent.push(payload)
}

async function main(): Promise<void> {
const production = dailyTelemetryLaunchPolicy(true, {})
const qa = dailyTelemetryLaunchPolicy(true, { CAPTUREPACK_FIELD_QA: '1', CAPTUREPACK_TELEMETRY_ENVIRONMENT: 'prod' })
const test = dailyTelemetryLaunchPolicy(true, { CAPTUREPACK_TELEMETRY_ENVIRONMENT: 'test' })
const dev = dailyTelemetryLaunchPolicy(true, { CAPTUREPACK_TELEMETRY_ENVIRONMENT: 'dev' })
check('packaged production keeps the existing identity file and omitted environment', production.enabled && production.stateFile === 'purplepulse.json' && production.environment === undefined)
check('source development never emits production telemetry', !dailyTelemetryLaunchPolicy(false, {}).enabled)
check('explicit test mode does not enable unpackaged collection', !dailyTelemetryLaunchPolicy(false, { CAPTUREPACK_TELEMETRY_ENVIRONMENT: 'test' }).enabled)
check('field QA always overrides a production environment request', qa.enabled && qa.environment === 'test')
check('test mode uses a separate persistent identity and daily gate', test.enabled && test.stateFile === 'purplepulse.test.json' && test.environment === 'test')
check('dev mode is isolated from test and production', dev.enabled && dev.stateFile === 'purplepulse.dev.json' && dev.environment === 'dev')
check('invalid environment fails closed instead of polluting production', !dailyTelemetryLaunchPolicy(true, { CAPTUREPACK_TELEMETRY_ENVIRONMENT: 'qa-typo' }).enabled)
let qaPayload: TelemetryPayload | undefined
await sendDailyTelemetry({
  statePath: join(checkDirectory, qa.stateFile), version: 'qa', os: 'windows',
  environment: qa.environment, now: new Date(2026, 8, 14, 12),
  createInstallId: () => SECOND_ID, post: async payload => { qaPayload = payload },
})
check('packaged QA policy reaches the sender as test', qaPayload?.environment === 'test')
await sendDailyTelemetry({
  statePath,
  version: '0.5.0',
  os: 'windows',
  now: new Date(2026, 8, 14, 23, 59),
  createInstallId: () => INSTALL_ID,
  post,
})
const firstState = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>
check('first run persists the generated UUID', firstState.install_id === INSTALL_ID)
check('the daily gate uses the local calendar day', firstState.last_attempt_day === '2026-09-14')
check('first run sends once', sent.length === 1)
check(
  'production payload contains only the anonymous allowlist',
  JSON.stringify(Object.keys(sent[0] ?? {}).sort()) ===
    JSON.stringify(['install_id', 'os', 'platform', 'project_id', 'version']),
)
check(
  'production payload carries the project, app version, actual OS and Electron platform',
  sent[0]?.project_id === 'pp_capturepack_6bede657' &&
    sent[0]?.install_id === INSTALL_ID &&
    sent[0]?.version === '0.5.0' &&
    sent[0]?.os === 'windows' &&
    sent[0]?.platform === 'electron' &&
    sent[0]?.environment === undefined,
)
check('Electron OS maps Windows without leaking win32', telemetryOs('win32') === 'windows')
check('Electron OS maps macOS from darwin', telemetryOs('darwin') === 'macos')
check('Electron OS preserves linux', telemetryOs('linux') === 'linux')
check('Electron OS maps unsupported platforms to other', telemetryOs('freebsd') === 'other')

await sendDailyTelemetry({
  statePath,
  version: '0.5.0',
  os: 'windows',
  now: new Date(2026, 8, 14, 0, 1),
  createInstallId: () => SECOND_ID,
  post,
})
check('a second launch on the same local day sends nothing', sent.length === 1)

await sendDailyTelemetry({
  statePath,
  version: '0.5.1',
  os: 'windows',
  now: new Date(2026, 8, 15, 0, 1),
  createInstallId: () => SECOND_ID,
  post,
})
check('the next local day sends once with the persisted UUID', sent.length === 2 && sent[1]?.install_id === INSTALL_ID)

const failurePath = join(checkDirectory, 'failure.json')
let failedPosts = 0
await sendDailyTelemetry({
  statePath: failurePath,
  version: 'test',
  os: 'test-os',
  environment: 'test',
  now: new Date(2026, 8, 14, 12),
  createInstallId: () => SECOND_ID,
  post: async (payload) => {
    failedPosts += 1
    check('test environment is opt-in and retained in the allowlist', payload.environment === 'test')
    throw new Error('offline')
  },
})
await sendDailyTelemetry({
  statePath: failurePath,
  version: 'test',
  os: 'test-os',
  now: new Date(2026, 8, 14, 13),
  createInstallId: () => INSTALL_ID,
  post: async () => {
    failedPosts += 1
  },
})
check('network failure stays silent and does not retry again that day', failedPosts === 1)

const invalidPath = join(checkDirectory, 'invalid.json')
await writeFile(invalidPath, '{not json', 'utf8')
let repaired: TelemetryPayload | undefined
await sendDailyTelemetry({
  statePath: invalidPath,
  version: 'test',
  os: 'test-os',
  now: new Date(2026, 8, 16, 12),
  createInstallId: () => INSTALL_ID,
  post: async (payload) => {
    repaired = payload
  },
})
check('corrupt state is replaced with a persistent valid UUID', repaired?.install_id === INSTALL_ID)

if (failed !== 0) {
  console.error(`\n${failed}/${passed + failed} telemetry checks failed.`)
  process.exitCode = 1
} else {
  console.log(`\n${passed}/${passed} telemetry checks passed.`)
}
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})

for (const flag of ['true', '0', '', 'false', 'typo']) {
  check('invalid field QA mode fails closed: ' + JSON.stringify(flag),
    !dailyTelemetryLaunchPolicy(true, { CAPTUREPACK_FIELD_QA: flag, CAPTUREPACK_TELEMETRY_ENVIRONMENT: 'prod' }).enabled)
}
