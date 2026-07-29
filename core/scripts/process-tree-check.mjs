import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { terminateProcessTree } from './process-tree.mjs'

let passed = 0
let failed = 0

function check(name, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}`)
  if (condition) passed += 1
  else failed += 1
}

console.log('\nQA timeout process-tree termination')

{
  const events = new Map()
  const spawnCalls = []
  const wrapperSignals = []
  const child = {
    pid: 4242,
    kill(signal) {
      wrapperSignals.push(signal)
    },
  }
  const killer = {
    once(name, listener) {
      events.set(name, listener)
    },
  }
  terminateProcessTree(child, {
    platform: 'win32',
    spawnProcess(executable, args, options) {
      spawnCalls.push({ executable, args, options })
      return killer
    },
  })
  check('Windows invokes the native process-tree killer once', spawnCalls.length === 1)
  check(
    'Windows timeout targets the exact PID with /T and /F',
    JSON.stringify(spawnCalls[0]?.args) === JSON.stringify(['/PID', '4242', '/T', '/F']),
  )
  check('taskkill is hidden and inherits no QA pipes',
    spawnCalls[0]?.executable === 'taskkill.exe'
      && spawnCalls[0]?.options?.windowsHide === true
      && spawnCalls[0]?.options?.stdio === 'ignore')
  check('a successful tree kill does not redundantly kill only the wrapper', wrapperSignals.length === 0)
  events.get('close')?.(0)
  check('taskkill exit zero keeps the wrapper-only fallback unused', wrapperSignals.length === 0)
  events.get('error')?.(new Error('synthetic taskkill failure'))
  check('taskkill failure force-kills the wrapper as a bounded fallback',
    wrapperSignals.at(-1) === 'SIGKILL')
}

{
  const groupSignals = []
  const wrapperSignals = []
  terminateProcessTree(
    {
      pid: 7331,
      kill(signal) {
        wrapperSignals.push(signal)
      },
    },
    {
      platform: 'linux',
      killProcess(pid, signal) {
        groupSignals.push({ pid, signal })
      },
    },
  )
  check('POSIX targets the detached process group', groupSignals[0]?.pid === -7331)
  check('POSIX uses a decisive timeout signal', groupSignals[0]?.signal === 'SIGKILL')
  check('a successful group kill does not fall back to the wrapper', wrapperSignals.length === 0)
}

{
  const harness = readFileSync(new URL('./chrome-bridge-check.mjs', import.meta.url), 'utf8')
  const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const supervision = readFileSync(
    new URL('../src/shared/supervision.ts', import.meta.url),
    'utf8',
  )
  const smoke = readFileSync(new URL('./smoke-check.mjs', import.meta.url), 'utf8')
  const qaGate = readFileSync(new URL('./qa-gate.mjs', import.meta.url), 'utf8')
  const qaDocs = readFileSync(new URL('../../docs/QA.md', import.meta.url), 'utf8')
  check(
    'one wedged QA child is bounded to two minutes, not the former 15-minute stall',
    qaGate.includes('const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000') &&
      qaDocs.includes('default 2 minutes'),
  )
  check(
    'headed Chrome harness disables watchdog relaunch for both temporary profiles',
    (harness.match(/'--no-supervision'/gu) ?? []).length === 2 &&
      main.includes("!process.argv.includes('--no-supervision')") &&
      supervision.includes("'--no-supervision'"),
  )
  check(
    'headed Chrome harness exercises the CRLF-safe plain-Node native host',
    harness.includes("const nativeHostScript = resolve('dist', 'scripts', 'native-host.js')") &&
      harness.includes('CAPTUREPACK_DOM_PIPE_SUFFIX: `qa-${process.pid}`') &&
      harness.includes("ELECTRON_RUN_AS_NODE: '1'") &&
      harness.includes("set ELECTRON_RUN_AS_NODE=1\\r\\n") &&
      !harness.includes("['.', '--native-host']") &&
      !harness.includes('shell: true'),
  )
  check(
    'headed Chrome harness owns every spawned process tree through finally',
    harness.includes("import { terminateProcessTree } from './process-tree.mjs'") &&
      harness.includes('async function stopAllTracked()') &&
      harness.includes('finally {') &&
      harness.includes('await stopAllTracked()') &&
      !harness.includes('app.kill()') &&
      !harness.includes('app2.kill()'),
  )
  check(
    'headed Chrome cleanup can reach its bounded exit waiter',
    harness.indexOf('function waitFor(') >= 0 &&
      harness.indexOf('function waitFor(') < harness.indexOf('async function stopTracked('),
  )
  check(
    'RC smoke is isolated from the owner profile and cleans its process tree',
    smoke.includes("mkdtempSync(join(tmpdir(), 'capturepack-smoke-'))") &&
      smoke.includes('`--user-data-dir=${profile}`') &&
      smoke.includes("'--no-supervision'") &&
      smoke.includes('const killer = terminateProcessTree(target)') &&
      smoke.includes('await stopChildTree(child)') &&
      smoke.includes('rmSync(profile, { recursive: true, force: true })'),
  )
}

if (process.platform === 'win32') {
  const root = spawn(
    process.execPath,
    [
      '-e',
      "const {spawn}=require('node:child_process');"
        + "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],"
        + "{stdio:'ignore',windowsHide:true});"
        + "process.stdout.write(String(child.pid)+'\\n');setInterval(()=>{},1000)",
    ],
    { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
  )
  let descendantPid = 0
  let output = ''
  const descendantReady = new Promise((resolve, reject) => {
    root.stdout.on('data', (chunk) => {
      output += chunk.toString()
      const line = output.split(/\r?\n/u)[0]
      const parsed = Number(line)
      if (Number.isInteger(parsed) && parsed > 0) {
        descendantPid = parsed
        resolve()
      }
    })
    root.once('error', reject)
    root.once('close', (code) => {
      if (descendantPid === 0) reject(new Error(`test process exited before reporting (${code})`))
    })
  })
  const deadline = (label) => new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), 5_000)
    timer.unref()
  })
  const alive = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  try {
    await Promise.race([descendantReady, deadline('descendant startup')])
    const rootClosed = new Promise((resolve) => root.once('close', resolve))
    terminateProcessTree(root)
    await Promise.race([rootClosed, deadline('tree termination')])
    for (let attempt = 0; attempt < 20 && alive(descendantPid); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    check('a real Windows timeout closes the npm-like wrapper process', !alive(root.pid))
    check('a real Windows timeout also closes its descendant process', !alive(descendantPid))
  } catch (error) {
    check(`real Windows process-tree probe (${error.message})`, false)
  } finally {
    if (alive(root.pid)) terminateProcessTree(root)
    if (descendantPid > 0 && alive(descendantPid)) {
      terminateProcessTree({
        pid: descendantPid,
        kill(signal) {
          process.kill(descendantPid, signal)
        },
      })
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
