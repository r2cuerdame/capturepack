import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectPack } from './pack-forensics.mjs'
import { terminateProcessTree } from './process-tree.mjs'

const REPORT_SCHEMA_VERSION = 1
// The complete 48-check gate finishes in about 21 seconds on the release
// machine. A 15-minute timeout PER child made one wedged helper look like the
// entire tool had frozen for exactly the delays the owner reported. Two
// minutes leaves ample CI headroom while keeping a single failure bounded;
// unusually large forensic packs can still override this explicitly.
const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000
const OUTPUT_TAIL_BYTES = 128 * 1024
const CORE_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VIDEO_PROFILE_CHECKS = new Set([
  'check:sync',
  'check:delta',
  'check:ring-prune',
  'check:surface-restore',
  'check:provider-host',
  'check:dom',
  'check:controls',
  'check:context-host-dirty',
  'check:identity',
  'check:keyframes',
  'check:pick',
  'check:numbering',
  'check:motion',
  'check:render',
  'check:trim',
  'check:plugins',
  'check:past',
  'check:windows-context',
  'check:repo-hygiene',
  'check:recorder-ring',
  'check:recorder-retention',
  'check:tick-owner',
  'check:settings',
  'check:hotkeys',
  'check:about',
  'check:clipboard',
  'check:source-first-save',
  'check:background-media',
  'check:chrome-lifecycle',
  'check:editor-lifecycle',
  'check:editor-ux',
  'check:qa-process-tree',
  'check:pack-forensics',
  'check:display-clock',
  'check:temporal',
  'check:validator',
  'check:spec',
])

function environmentFlag(name, fallback = false) {
  const value = process.env[name]
  if (value === undefined) return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.toLocaleLowerCase())
}

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function parseCli(argv) {
  const options = {
    artifactDirectory: process.env.CAPTUREPACK_QA_ARTIFACT_DIR
      ? resolve(process.env.CAPTUREPACK_QA_ARTIFACT_DIR)
      : resolve(tmpdir(), 'capturepack-qa'),
    build: !environmentFlag('CAPTUREPACK_QA_SKIP_BUILD'),
    failFast: environmentFlag('CAPTUREPACK_QA_FAIL_FAST'),
    pack: process.env.CAPTUREPACK_QA_PACK ? resolve(process.env.CAPTUREPACK_QA_PACK) : null,
    packStrict: environmentFlag('CAPTUREPACK_QA_PACK_STRICT'),
    profile: process.env.CAPTUREPACK_QA_PROFILE ?? 'all',
    timeoutMs: positiveInteger(process.env.CAPTUREPACK_QA_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--skip-build') options.build = false
    else if (arg === '--fail-fast') options.failFast = true
    else if (arg === '--pack-strict') options.packStrict = true
    else if (arg === '--profile') {
      const value = argv[++index]
      if (!value) throw new Error('--profile requires all or video')
      options.profile = value
    }
    else if (arg === '--pack') {
      const value = argv[++index]
      if (!value) throw new Error('--pack requires a directory')
      options.pack = resolve(value)
    } else if (arg === '--artifacts') {
      const value = argv[++index]
      if (!value) throw new Error('--artifacts requires a directory')
      options.artifactDirectory = resolve(value)
    } else if (arg === '--timeout-ms') {
      const value = argv[++index]
      const parsed = positiveInteger(value, 0)
      if (parsed === 0) throw new Error('--timeout-ms requires a positive integer')
      options.timeoutMs = parsed
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (options.profile !== 'all' && options.profile !== 'video') {
    throw new Error(`Unknown QA profile: ${options.profile}; expected all or video`)
  }
  return options
}

function stripAnsi(value) {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
}

function appendTail(previous, chunk) {
  const combined = previous + chunk
  return combined.length <= OUTPUT_TAIL_BYTES
    ? combined
    : combined.slice(combined.length - OUTPUT_TAIL_BYTES)
}

function npmInvocation(script) {
  const npmExecPath = process.env.npm_execpath
  if (npmExecPath && /\.(?:c?js|mjs)$/iu.test(npmExecPath)) {
    return {
      executable: process.execPath,
      args: [npmExecPath, 'run', script],
      display: `npm run ${script}`,
    }
  }
  return {
    executable: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: ['run', script],
    display: `npm run ${script}`,
  }
}

function runScript(name, timeoutMs) {
  const command = npmInvocation(name)
  const started = process.hrtime.bigint()
  console.log(`\n>>> ${command.display}`)

  return new Promise((resolveResult) => {
    let stdout = ''
    let stderr = ''
    let stdoutTruncated = false
    let stderrTruncated = false
    let timedOut = false
    let settled = false

    const child = spawn(command.executable, command.args, {
      cwd: CORE_DIRECTORY,
      env: {
        ...process.env,
        CI: '1',
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    child.stdout.on('data', (data) => {
      const text = data.toString()
      process.stdout.write(text)
      const next = appendTail(stdout, text)
      if (next.length < stdout.length + text.length) stdoutTruncated = true
      stdout = next
    })
    child.stderr.on('data', (data) => {
      const text = data.toString()
      process.stderr.write(text)
      const next = appendTail(stderr, text)
      if (next.length < stderr.length + text.length) stderrTruncated = true
      stderr = next
    })

    const timer = setTimeout(() => {
      timedOut = true
      terminateProcessTree(child)
    }, timeoutMs)
    timer.unref()

    const finish = (exitCode, signal, spawnError = null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6
      const status = timedOut ? 'timed_out'
        : spawnError !== null || exitCode !== 0 ? 'failed'
          : 'passed'
      const result = {
        name,
        command: command.display,
        status,
        exit_code: exitCode,
        signal: signal ?? null,
        duration_ms: Number(durationMs.toFixed(3)),
        stdout_tail: stripAnsi(stdout),
        stderr_tail: stripAnsi(stderr),
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated,
        ...(spawnError === null
          ? {}
          : { spawn_error: spawnError instanceof Error ? spawnError.message : String(spawnError) }),
      }
      console.log(`<<< ${status.toUpperCase()} ${command.display} (${(durationMs / 1_000).toFixed(2)} s)`)
      resolveResult(result)
    }

    child.on('error', (error) => finish(null, null, error))
    child.on('close', (code, signal) => finish(code, signal))
  })
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function cdata(value) {
  return `<![CDATA[${String(value).replaceAll(']]>', ']]]]><![CDATA[>')}]]>`
}

function junitXml(report) {
  const cases = []
  for (const check of report.checks) {
    const body = []
    if (check.status === 'skipped') {
      body.push(`<skipped message="${xmlEscape(check.skip_reason ?? 'skipped')}"/>`)
    } else if (check.status !== 'passed') {
      body.push(
        `<failure message="${xmlEscape(`${check.command} ${check.status}`)}">`
        + `${cdata(check.stderr_tail || check.stdout_tail || check.spawn_error || '')}</failure>`,
      )
    }
    if (check.stdout_tail) body.push(`<system-out>${cdata(check.stdout_tail)}</system-out>`)
    if (check.stderr_tail) body.push(`<system-err>${cdata(check.stderr_tail)}</system-err>`)
    cases.push(
      `  <testcase classname="capturepack.qa" name="${xmlEscape(check.name)}" `
      + `time="${(check.duration_ms / 1_000).toFixed(3)}">${body.join('')}</testcase>`,
    )
  }

  const forensic = report.forensics
  if (forensic.status === 'skipped') {
    cases.push(
      '  <testcase classname="capturepack.qa" name="pack-forensics" time="0.000">'
      + '<skipped message="CAPTUREPACK_QA_PACK not provided"/></testcase>',
    )
  } else {
    const body = []
    const forensicText = JSON.stringify(forensic, null, 2)
    if (forensic.gate_status === 'failed' || forensic.configuration_error) {
      body.push(`<failure message="CapturePack forensic gate failed">${cdata(forensicText)}</failure>`)
    } else {
      body.push(`<system-out>${cdata(forensicText)}</system-out>`)
    }
    cases.push(
      `  <testcase classname="capturepack.qa" name="pack-forensics" `
      + `time="${((forensic.duration_ms ?? 0) / 1_000).toFixed(3)}">${body.join('')}</testcase>`,
    )
  }

  const failures = report.summary.failed
    + ((forensic.status !== 'skipped'
      && (forensic.gate_status === 'failed' || forensic.configuration_error)) ? 1 : 0)
  const skipped = report.summary.skipped + (forensic.status === 'skipped' ? 1 : 0)
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="CapturePack RC QA" tests="${cases.length}" failures="${failures}" `
      + `skipped="${skipped}" time="${(report.duration_ms / 1_000).toFixed(3)}">`,
    ...cases,
    '</testsuite>',
    '',
  ].join('\n')
}

function writeArtifacts(report, artifactDirectory) {
  mkdirSync(artifactDirectory, { recursive: true })
  const jsonPath = resolve(artifactDirectory, 'qa-report.json')
  const junitPath = resolve(artifactDirectory, 'qa-junit.xml')
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  writeFileSync(junitPath, junitXml(report), 'utf8')
  return { json: jsonPath, junit: junitPath }
}

async function main() {
  let options
  try {
    options = parseCli(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 2
    return
  }

  const packageJson = JSON.parse(readFileSync(resolve(CORE_DIRECTORY, 'package.json'), 'utf8'))
  const discoveredCheckScripts = Object.keys(packageJson.scripts ?? {})
    .filter((name) => name.startsWith('check:') && name !== 'check:qa')
  const checkScripts = options.profile === 'video'
    ? discoveredCheckScripts.filter((name) => VIDEO_PROFILE_CHECKS.has(name))
    : discoveredCheckScripts
  if (options.profile === 'video') {
    const missing = [...VIDEO_PROFILE_CHECKS].filter((name) => !discoveredCheckScripts.includes(name))
    if (missing.length > 0) {
      throw new Error(`Video QA profile references missing package scripts: ${missing.join(', ')}`)
    }
  }
  // `--smoke` intentionally follows build: it launches the just-built main
  // bundle in its CI-only settings path (no window, tray, hotkey, or MCP).
  const requestedScripts = [
    'typecheck',
    ...checkScripts,
    ...(options.build ? ['build', 'smoke'] : []),
  ]
  const startedWallClock = new Date()
  const started = process.hrtime.bigint()

  console.log('CapturePack deterministic RC QA gate')
  console.log(`Core:      ${CORE_DIRECTORY}`)
  console.log(`Artifacts: ${options.artifactDirectory}`)
  console.log(`Checks:    ${requestedScripts.length} (package.json order, sequential)`)
  console.log(`Profile:   ${options.profile}`)
  console.log(`Build:     ${options.build ? 'enabled' : 'skipped by configuration'}`)
  console.log(`Fail-fast: ${options.failFast ? 'enabled' : 'disabled; full summary will be collected'}`)

  let forensics
  if (options.pack === null) {
    forensics = {
      kind: 'capturepack-pack-forensics',
      schema_version: REPORT_SCHEMA_VERSION,
      status: 'skipped',
      gate_status: 'passed',
      strict: options.packStrict,
      reason: 'CAPTUREPACK_QA_PACK was not provided',
    }
    console.log('Pack QA:   SKIPPED — set CAPTUREPACK_QA_PACK or use --pack')
  } else {
    forensics = inspectPack(options.pack, { strict: options.packStrict })
    console.log(
      `Pack QA:   ${forensics.status.toUpperCase()}`
      + ` (${forensics.counts.errors} errors, ${forensics.counts.warnings} warnings; `
      + `${forensics.counts.gating} gating findings; `
      + `${options.packStrict ? 'gating' : 'non-gating legacy audit'})`,
    )
  }

  const checks = []
  let stoppedBy = null
  if (forensics.configuration_error || forensics.gate_status === 'failed') {
    stoppedBy = options.failFast ? 'pack-forensics' : null
  }

  for (const script of requestedScripts) {
    if (stoppedBy !== null) {
      checks.push({
        name: script,
        command: `npm run ${script}`,
        status: 'skipped',
        skip_reason: `fail-fast after ${stoppedBy}`,
        exit_code: null,
        signal: null,
        duration_ms: 0,
        stdout_tail: '',
        stderr_tail: '',
        stdout_truncated: false,
        stderr_truncated: false,
      })
      continue
    }
    const result = await runScript(script, options.timeoutMs)
    checks.push(result)
    if (options.failFast && result.status !== 'passed') stoppedBy = script
  }

  const durationMs = Number(process.hrtime.bigint() - started) / 1e6
  const summary = {
    passed: checks.filter((check) => check.status === 'passed').length,
    failed: checks.filter((check) => check.status === 'failed' || check.status === 'timed_out').length,
    skipped: checks.filter((check) => check.status === 'skipped').length,
    total: checks.length,
  }
  const forensicGateFailed = forensics.status !== 'skipped'
    && (forensics.configuration_error || forensics.gate_status === 'failed')
  const status = summary.failed > 0 || forensicGateFailed ? 'failed' : 'passed'
  const finishedWallClock = new Date()
  const artifactPaths = {
    json: resolve(options.artifactDirectory, 'qa-report.json'),
    junit: resolve(options.artifactDirectory, 'qa-junit.xml'),
  }

  const report = {
    kind: 'capturepack-qa-report',
    schema_version: REPORT_SCHEMA_VERSION,
    status,
    started_at: startedWallClock.toISOString(),
    finished_at: finishedWallClock.toISOString(),
    duration_ms: Number(durationMs.toFixed(3)),
    core_directory: CORE_DIRECTORY,
    configuration: {
      build: options.build,
      fail_fast: options.failFast,
      profile: options.profile,
      timeout_ms: options.timeoutMs,
      pack_strict: options.packStrict,
    },
    summary,
    checks,
    forensics,
    artifacts: artifactPaths,
  }

  let artifacts
  try {
    artifacts = writeArtifacts(report, options.artifactDirectory)
  } catch (error) {
    console.error(`Could not write QA artifacts: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
    return
  }

  console.log('\nCapturePack RC QA summary')
  for (const check of checks) {
    console.log(
      `  ${check.status.toUpperCase().padEnd(9)} ${check.name.padEnd(28)} `
      + `${(check.duration_ms / 1_000).toFixed(2).padStart(8)} s`,
    )
  }
  console.log(
    `  ${forensics.status.toUpperCase().padEnd(9)} ${'pack-forensics'.padEnd(28)} `
    + `${((forensics.duration_ms ?? 0) / 1_000).toFixed(2).padStart(8)} s`
    + `${options.pack !== null && !options.packStrict ? '  (non-gating)' : ''}`,
  )
  console.log(`\nResult: ${status.toUpperCase()} in ${(durationMs / 1_000).toFixed(2)} s`)
  console.log(`JSON:   ${artifacts.json}`)
  console.log(`JUnit:  ${artifacts.junit}`)

  if (status === 'failed') process.exitCode = 1
}

await main()
