import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import * as install from '../src/main/updateInstall'
import {
  INSTALL_IDLE_POLL_MS,
  RUN_ONCE_KEY,
  RUN_ONCE_VALUE,
  compareVersions,
  createIdleGate,
  nextPendingUpdate,
  pendingUpdateFile,
  readPendingUpdate,
  runOnceArgs,
  startupInstallArgs,
  startupUpdateDecision,
  writePendingUpdate,
  type IdleGateTimers,
  type PendingUpdate,
  type SessionEndPlan,
  type SessionEndReason,
} from '../src/main/updateInstall'
import * as activity from '../src/main/captureActivity'
import * as updater from '../src/main/updater'
import {
  initUpdater,
  installPendingUpdateBeforeCapture,
  restartAndUpdate,
  setAutoUpdateCheck,
  setUpdateInstallBusyProbe,
} from '../src/main/updater'

let failed = 0
let skipped = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (!condition) failed += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

function skip(name: string, reason: string): void {
  skipped += 1
  console.log(`  SKIP  ${name} — ${reason}`)
}

async function section(title: string, body: () => void | Promise<void>): Promise<void> {
  console.log(`\n${title}`)
  try {
    await body()
  } catch (err) {
    check(`${title.toLowerCase()} runs`, false, err instanceof Error ? err.message : String(err))
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const windowsPowerShell = (): string =>
  path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

const GUARDIAN_HOST = 'guardian-host'

interface GuardianHostInput {
  installerPath: string
  resultFile: string
  appPath: string
  runOncePath: string
}

function processAlive(pid: number): boolean {
  if (pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (processAlive(pid)) {
    if (Date.now() > deadline) return false
    await sleep(200)
  }
  return true
}

function killQuietly(pid: number): void {
  if (pid <= 0) return
  try {
    process.kill(pid)
  } catch {}
}

async function guardianHostGroup(): Promise<void> {
  const input = JSON.parse(process.argv[3] ?? '{}') as GuardianHostInput
  const script = install.sessionEndGuardianScript({
    installerPath: input.installerPath,
    installerArgs: install.sessionEndInstallArgs(),
    waitPid: process.pid,
    version: '0.6.1',
    message: 'CapturePack update check',
    resultFile: input.resultFile,
    appPath: input.appPath,
    appArgs: ['--openAsHidden'],
    runOncePath: input.runOncePath,
  })
  const launch = await install.launchSessionEndGuardian(windowsPowerShell(), script)
  console.log(`${GUARDIAN_HOST} ${JSON.stringify(launch)}`)
  setInterval(() => {}, 1000)
}

function queryEndSession(pid: number, title: string): Promise<{ answer: string; stderr: string }> {
  const script = [
    `Add-Type -TypeDefinition @'`,
    `using System;`,
    `using System.Collections.Generic;`,
    `using System.Runtime.InteropServices;`,
    `using System.Text;`,
    `public static class SessionQueryProbe {`,
    `  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);`,
    `  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr lParam);`,
    `  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);`,
    `  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);`,
    `  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);`,
    `  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);`,
    `  public static string Query(uint pid, string title) {`,
    `    var answers = new List<string>();`,
    `    EnumWindows((hWnd, lParam) => {`,
    `      uint owner;`,
    `      GetWindowThreadProcessId(hWnd, out owner);`,
    `      var text = new StringBuilder(256);`,
    `      GetWindowText(hWnd, text, text.Capacity);`,
    `      if (owner != pid || !IsWindowVisible(hWnd) || text.ToString() != title) return true;`,
    `      IntPtr result;`,
    `      SendMessageTimeout(hWnd, 0x0011, IntPtr.Zero, IntPtr.Zero, 2, 5000, out result);`,
    `      answers.Add(result.ToInt64().ToString());`,
    `      return true;`,
    `    }, IntPtr.Zero);`,
    `    return string.Join(",", answers);`,
    `  }`,
    `}`,
    `'@`,
    `[Console]::Out.Write([SessionQueryProbe]::Query(${String(pid)}, '${title.replace(/'/gu, "''")}'))`,
  ].join('\n')
  return new Promise((resolve) => {
    const probe = spawn(windowsPowerShell(), install.powerShellEncodedArgs(script), {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let answer = ''
    let stderr = ''
    probe.stdout.on('data', (chunk: Buffer) => {
      answer += chunk.toString('utf8')
    })
    probe.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    probe.once('exit', () => resolve({ answer: answer.trim(), stderr: stderr.trim() }))
  })
}
const sha = (bytes: Buffer): string => createHash('sha512').update(bytes).digest('base64')
const pending = (overrides: Partial<PendingUpdate> = {}): PendingUpdate => ({
  version: '0.6.1',
  installerPath: 'C:\\cache\\CapturePack-Setup-0.6.1.exe',
  sha512: 'abc',
  startupAttemptFrom: null,
  ...overrides,
})

function fakeTimers(): { timers: IdleGateTimers; tick: () => void; live: () => number } {
  const queue: Array<{ run: () => void; ms: number; live: boolean }> = []
  return {
    timers: {
      set: (run, ms) => {
        const entry = { run, ms, live: true }
        queue.push(entry)
        return entry
      },
      clear: (handle) => {
        ;(handle as { live: boolean }).live = false
      },
    },
    tick: () => {
      const next = queue.shift()
      if (next?.live === true) next.run()
    },
    live: () => queue.filter((entry) => entry.live).length,
  }
}

async function main(): Promise<void> {
  await section('VERSION ORDER', () => {
    check('newer patch is newer', compareVersions('0.6.1', '0.6.0') === 1)
    check('same version is equal', compareVersions('0.6.0', 'v0.6.0') === 0)
    check('older minor is older', compareVersions('0.5.9', '0.6.0') === -1)
    check('a prerelease precedes its release', compareVersions('0.7.0-rc.1', '0.7.0') === -1)
    check('rc.10 follows rc.2', compareVersions('0.7.0-rc.10', '0.7.0-rc.2') === 1)
    check('an unreadable version has no order', compareVersions('latest', '0.6.0') === null)
  })

  await section('A KILLED RUN: THE NEXT START INSTALLS BEFORE CAPTURE', () => {
    const decide = (p: PendingUpdate | null, hash: string | null = 'abc', autoInstall = true) =>
      startupUpdateDecision({ pending: p, currentVersion: '0.6.0', autoInstall, installerSha512: hash })
    check('nothing waiting starts normally', decide(null).kind === 'none')
    check('a verified newer download installs first', decide(pending()).kind === 'install')
    check('the already installed version is dropped', decide(pending({ version: '0.6.0' })).kind === 'clear')
    check('an older download is dropped', decide(pending({ version: '0.5.0' })).kind === 'clear')
    check('a vanished installer is dropped', decide(pending(), null).kind === 'clear')
    check('an installer whose bytes changed is never executed', decide(pending(), 'tampered').kind === 'clear')
    check('automatic updates turned off keep the download without installing', decide(pending(), 'abc', false).kind === 'keep')
    check(
      'a failed attempt from this version is not retried at every start',
      decide(pending({ startupAttemptFrom: '0.6.0' })).kind === 'keep',
    )
    check(
      'an attempt recorded by an older build does not block this one',
      decide(pending({ startupAttemptFrom: '0.5.9' })).kind === 'install',
    )
    check(
      'the startup install is silent and relaunches the app',
      JSON.stringify(startupInstallArgs()) === JSON.stringify(['--updated', '/S', '--force-run']),
    )
  })

  await section('THE DOWNLOAD RECORD', () => {
    const attempted = pending({ startupAttemptFrom: '0.6.0' })
    check(
      'a re-validated identical download keeps its attempt',
      nextPendingUpdate(attempted, { version: '0.6.1', installerPath: attempted.installerPath, sha512: 'abc' })
        .startupAttemptFrom === '0.6.0',
    )
    check(
      'a newer download gets a fresh attempt',
      nextPendingUpdate(attempted, { version: '0.6.2', installerPath: 'C:\\cache\\b.exe', sha512: 'def' })
        .startupAttemptFrom === null,
    )
  })

  await section('WINDOWS SHUTDOWN: INSTALL WHILE WINDOWS WAITS, RELAUNCH AT NEXT BOOT', () => {
    const plan = (overrides: Partial<Parameters<typeof install.sessionEndPlan>[0]> = {}): SessionEndPlan =>
      install.sessionEndPlan({
        reasons: ['shutdown'],
        pending: pending(),
        currentVersion: '0.6.0',
        autoInstall: true,
        launchAtLogin: false,
        ...overrides,
      })
    const is = (p: SessionEndPlan, installs: boolean, relaunches: boolean): boolean =>
      p.install === installs && p.relaunch === relaunches
    check('shutdown or restart with an update waiting installs during the shutdown', plan().install)
    check('and arms the next-boot relaunch', plan().relaunch)
    check('logoff counts as the session ending', is(plan({ reasons: ['logoff'] }), true, true))
    check(
      'launch at login already relaunches, so no second launcher is added',
      is(plan({ launchAtLogin: true }), true, false),
    )
    check(
      'a critical shutdown cannot be held, so the install is left to the next start',
      is(plan({ reasons: ['shutdown', 'critical'] as SessionEndReason[] }), false, true),
    )
    check('Restart Manager close-app is not a shutdown', is(plan({ reasons: ['close-app'] }), false, false))
    check('nothing waiting does nothing', is(plan({ pending: null }), false, false))
    check('automatic updates off do nothing', is(plan({ autoInstall: false }), false, false))
    check('an installed version does nothing', is(plan({ pending: pending({ version: '0.6.0' }) }), false, false))
    check(
      'an already failed attempt does nothing',
      is(plan({ pending: pending({ startupAttemptFrom: '0.6.0' }) }), false, false),
    )
    check(
      'the shutdown install is silent and never starts the app while Windows is going down',
      JSON.stringify(install.sessionEndInstallArgs()) === JSON.stringify(['--updated', '/S']),
    )
    const runOnce = runOnceArgs('C:\\Apps\\CapturePack\\CapturePack.exe', '--openAsHidden')
    check(
      'the relaunch is a one-shot per-user RunOnce entry started hidden',
      runOnce.includes(RUN_ONCE_KEY) &&
        runOnce.includes(RUN_ONCE_VALUE) &&
        RUN_ONCE_KEY.startsWith('HKCU\\') &&
        runOnce.includes('"C:\\Apps\\CapturePack\\CapturePack.exe" --openAsHidden'),
      runOnce.join(' '),
    )
  })

  await section('CAPTURE/SAVE IN PROGRESS: DEFERRED, NEVER CANCELLED', () => {
    const { timers, tick, live } = fakeTimers()
    let busy = false
    let installs = 0
    let deferrals = 0
    const gate = createIdleGate({
      isBusy: () => busy,
      run: () => {
        installs += 1
      },
      onDeferred: () => {
        deferrals += 1
      },
      timers,
    })
    check('idle installs at once', gate.request() === 'now' && installs === 1)
    busy = true
    check('busy defers', gate.request() === 'deferred' && installs === 1 && deferrals === 1)
    check('a second request while waiting is not a second install', gate.request() === 'already-pending')
    tick()
    tick()
    check('still busy, still waiting', installs === 1 && gate.pending())
    busy = false
    tick()
    check('installs exactly once when the work is done', installs === 2 && !gate.pending())
    check('nothing else is left scheduled', live() === 0)
    const throwing = createIdleGate({
      isBusy: () => {
        throw new Error('probe broke')
      },
      run: () => {
        installs += 1
      },
      timers,
    })
    check('a broken busy probe is read as busy, not idle', throwing.request() === 'deferred' && installs === 2)
    throwing.cancel()
  })

  await section('THE SHUTDOWN HANDOFF WAITS FOR CAPTURE/SAVE AND STARTS ONE INSTALLER', async () => {
    const run = async (options: {
      verify?: boolean
      guardian?: boolean | 'throws'
      relaunch?: boolean
      busyTicks?: number
    }) => {
      const { timers, tick } = fakeTimers()
      const events: string[] = []
      let busyTicks = options.busyTicks ?? 0
      const done = install.runSessionEndHandoff(
        { install: true, relaunch: options.relaunch ?? true },
        {
          verify: () => {
            events.push('verify')
            return Promise.resolve(options.verify ?? true)
          },
          startGuardian: () => {
            events.push('guardian')
            if (options.guardian === 'throws') return Promise.reject(new Error('spawn failed'))
            return Promise.resolve(options.guardian ?? true)
          },
          armRelaunch: () => events.push('relaunch'),
          disarmQuitInstall: () => events.push('disarm'),
          isBusy: () => {
            events.push(busyTicks > 0 ? 'busy' : 'idle')
            return busyTicks > 0
          },
          onDeferred: () => events.push('deferred'),
          quit: (outcome) => events.push(`quit:${outcome}`),
          timers,
        },
      )
      for (let i = 0; i < 10; i += 1) await Promise.resolve()
      const beforeIdle = [...events]
      while (busyTicks > 0) {
        busyTicks -= 1
        tick()
      }
      tick()
      const outcome = await done
      return { outcome, events, beforeIdle }
    }

    const busy = await run({ busyTicks: 3 })
    check('the result is a guarded install', busy.outcome === 'guardian', busy.events.join(' '))
    check(
      'install-on-quit is disarmed before anything else, so quitting starts no second installer',
      busy.events[0] === 'disarm',
      busy.events.join(' '),
    )
    check(
      'the guardian holds Windows before the app waits for its work',
      busy.events.indexOf('guardian') < busy.events.indexOf('busy'),
      busy.events.join(' '),
    )
    check(
      'the app does not quit while a capture/save runs',
      !busy.beforeIdle.some((event) => event.startsWith('quit')) && busy.beforeIdle.includes('deferred'),
      busy.beforeIdle.join(' '),
    )
    check(
      'it quits exactly once, after the work ends',
      busy.events.filter((event) => event.startsWith('quit')).length === 1 &&
        busy.events.at(-1) === 'quit:guardian' &&
        busy.events.lastIndexOf('busy') < busy.events.indexOf('quit:guardian'),
      busy.events.join(' '),
    )
    check('the next boot relaunch is armed', busy.events.includes('relaunch'))

    const idle = await run({})
    check('idle quits at once', idle.outcome === 'guardian' && idle.beforeIdle.includes('quit:guardian'))

    const changed = await run({ verify: false })
    check(
      'a changed installer starts nothing and arms nothing, and Windows goes on',
      changed.outcome === 'dropped' &&
        !changed.events.includes('guardian') &&
        !changed.events.includes('relaunch') &&
        changed.events.at(-1) === 'quit:dropped',
      changed.events.join(' '),
    )
    const noGuardian = await run({ guardian: false })
    check(
      'a guardian that cannot hold Windows leaves the install to the next start, which still relaunches',
      noGuardian.outcome === 'next-start' && noGuardian.events.includes('relaunch'),
      noGuardian.events.join(' '),
    )
    const thrown = await run({ guardian: 'throws' })
    check('a guardian that cannot spawn is the same', thrown.outcome === 'next-start')
    const atLogin = await run({ relaunch: false })
    check('launch at login adds no RunOnce entry', !atLogin.events.includes('relaunch'))
  })

  await section('THE GUARDIAN SCRIPT', () => {
    const script = install.sessionEndGuardianScript({
      installerPath: "C:\\Users\\O'Brien\u2019s\\Setup.exe",
      installerArgs: install.sessionEndInstallArgs(),
      waitPid: 4242,
      version: '0.6.1',
      message: "It's installing",
      resultFile: 'C:\\data\\session-end-install.json',
      appPath: 'C:\\Apps\\CapturePack.exe',
      appArgs: ['--openAsHidden'],
    })
    check(
      'paths are PowerShell literals, quotes doubled',
      script.includes("$installer = 'C:\\Users\\O''Brien\u2019\u2019s\\Setup.exe'") &&
        script.includes("$message = 'It''s installing'"),
    )
    check('it waits for this app process', script.includes('Get-Process -Id 4242'))
    check(
      'setup starts only after the app process has exited',
      script.indexOf('$app.HasExited') !== -1 &&
        script.indexOf('$app.HasExited') < script.indexOf('Start-Process -FilePath $installer'),
    )
    check(
      'it holds Windows shutdown until setup ends',
      script.includes('ShutdownBlockReasonCreate') &&
        script.includes('if (-not $state.done) { $closing.Cancel = $true }') &&
        script.indexOf('$state.done = $true') > script.indexOf('$state.exitCode = $code'),
    )
    check(
      'it relaunches in the same session only when Windows did not end it',
      /if \(-not \(Test-SessionEnding\)\) \{[\s\S]*Remove-ItemProperty[\s\S]*Start-Process -FilePath \$appPath/u.test(script),
    )
    check(
      'whether Windows is ending is read when setup ends, not kept from a cancelable shutdown query',
      script.includes('GetSystemMetrics(8192) -ne 0') &&
        script.indexOf('function Test-SessionEnding') < script.indexOf('function Complete-Install'),
    )
    const args = install.powerShellEncodedArgs(script)
    check(
      'it runs as an encoded command without a profile',
      args.includes('-NoProfile') &&
        args.at(-2) === '-EncodedCommand' &&
        Buffer.from(args.at(-1) ?? '', 'base64').toString('utf16le') === script,
    )
  })

  await section('THE GUARDIAN, END TO END', async () => {
    if (process.platform !== 'win32') {
      skip('the guardian runs setup only after the app exits', 'needs Windows PowerShell')
      return
    }
    const work = mkdtempSync(path.join(tmpdir(), "capturepack-guardian-O'Brien\u2019s "))
    let hostApp: ChildProcess | null = null
    let guardianPid = 0
    try {
      const installerPath = path.join(work, 'Setup.cmd')
      writeFileSync(installerPath, '@echo off\r\n>"%~dp0installer-ran.txt" echo %*\r\nexit /b 7\r\n')
      const appPath = path.join(work, 'App.cmd')
      writeFileSync(appPath, '@echo off\r\n>"%~dp0app-ran.txt" echo %*\r\n')
      const resultFile = install.sessionEndResultFile(work)
      const host: GuardianHostInput = {
        installerPath,
        resultFile,
        appPath,
        runOncePath: `HKCU:\\Software\\CapturePackUpdateCheck-${randomUUID()}`,
      }
      const fakeApp = spawn(process.execPath, [process.argv[1] ?? '', GUARDIAN_HOST, JSON.stringify(host)], {
        stdio: ['ignore', 'pipe', 'inherit'],
        windowsHide: true,
      })
      hostApp = fakeApp
      let appExitedAt = 0
      const appExited = new Promise<void>((resolve) => {
        fakeApp.once('exit', () => {
          appExitedAt = Date.now()
          resolve()
        })
      })
      let hostOutput = ''
      const launch = await new Promise<install.SessionEndGuardianLaunch | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), install.GUARDIAN_READY_TIMEOUT_MS + 10_000)
        fakeApp.stdout.on('data', (chunk: Buffer) => {
          hostOutput += chunk.toString('utf8')
          const line = hostOutput.split(/\r?\n/u).find((entry) => entry.startsWith(`${GUARDIAN_HOST} `))
          if (line === undefined) return
          clearTimeout(timer)
          resolve(JSON.parse(line.slice(GUARDIAN_HOST.length + 1)) as install.SessionEndGuardianLaunch)
        })
        fakeApp.once('exit', () => {
          clearTimeout(timer)
          resolve(null)
        })
      })
      guardianPid = launch?.pid ?? 0
      check(
        'the app starts the guardian the way the shipped app does, and it reports ready while the app still runs',
        launch?.ready === true && guardianPid > 0 && fakeApp.exitCode === null,
        JSON.stringify(launch),
      )
      await sleep(1500)
      check(
        'setup has not started while the app is alive',
        !existsSync(path.join(work, 'installer-ran.txt')),
      )
      const query = await queryEndSession(guardianPid, 'CapturePack')
      check(
        'the guardian refuses a shutdown query while the install is pending',
        query.answer === '0',
        `${query.answer} ${query.stderr}`,
      )
      check('the refused query does not close the guardian', processAlive(guardianPid))
      fakeApp.kill()
      await appExited
      const guardianEnded = await waitForExit(guardianPid, 60_000)
      if (!guardianEnded) killQuietly(guardianPid)
      const marker = path.join(work, 'installer-ran.txt')
      check(
        'setup runs after the app exits, silently and without --force-run',
        existsSync(marker) &&
          statSync(marker).mtimeMs >= appExitedAt - 50 &&
          readFileSync(marker, 'utf8').trim() === '--updated /S',
        existsSync(marker) ? readFileSync(marker, 'utf8').trim() : 'no marker',
      )
      const result = install.takeSessionEndResult(resultFile)
      check('the guardian outlives the app that started it and ends with setup', guardianEnded && result?.exitCode === 7)
      check(
        'it leaves a result for the next start',
        result?.version === '0.6.1' && result.exitCode === 7 && result.relaunched,
        JSON.stringify(result),
      )
      check('the result is read once', !existsSync(resultFile))
      const relaunch = path.join(work, 'app-ran.txt')
      for (let waited = 0; waited < 15_000 && !existsSync(relaunch); waited += 200) await sleep(200)
      await sleep(300)
      check(
        'a shutdown that was queried and then cancelled gets the app back, hidden',
        existsSync(relaunch) && readFileSync(relaunch, 'utf8').trim() === '--openAsHidden',
      )
    } finally {
      if (hostApp !== null && hostApp.exitCode === null) hostApp.kill()
      if (guardianPid > 0) killQuietly(guardianPid)
      rmSync(work, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 })
    }
  })

  const userData = app.getPath('userData')
  mkdirSync(userData, { recursive: true })
  const marker = pendingUpdateFile(userData)
  const installer = process.execPath
  const installerSha = sha(readFileSync(installer))

  await section('THE STARTUP INSTALL, END TO END', async () => {
    check('no record means a normal start', (await installPendingUpdateBeforeCapture(true)) === false)

    writePendingUpdate(marker, pending({ installerPath: installer, sha512: installerSha }))
    check('a verified newer download starts the installer', (await installPendingUpdateBeforeCapture(true)) === true)
    check(
      'the attempt is recorded before the app quits',
      readPendingUpdate(marker)?.startupAttemptFrom === app.getVersion(),
      JSON.stringify(readPendingUpdate(marker)),
    )
    check(
      'a start after a failed install continues on the current version instead of looping',
      (await installPendingUpdateBeforeCapture(true)) === false,
    )

    writePendingUpdate(marker, pending({ installerPath: installer, sha512: 'not-the-bytes' }))
    check('mismatched bytes are not executed', (await installPendingUpdateBeforeCapture(true)) === false)
    check('and their record is dropped', !existsSync(marker))

    writePendingUpdate(marker, pending({ version: app.getVersion(), installerPath: installer, sha512: installerSha }))
    check('the installed version starts normally', (await installPendingUpdateBeforeCapture(true)) === false)
    check('and its record is dropped', !existsSync(marker))

    const notAnExecutable = path.join(userData, 'not-an-installer.txt')
    writeFileSync(notAnExecutable, 'plain text', 'utf8')
    writePendingUpdate(
      marker,
      pending({ installerPath: notAnExecutable, sha512: sha(readFileSync(notAnExecutable)) }),
    )
    check(
      'an installer that cannot start leaves the app running',
      (await installPendingUpdateBeforeCapture(true)) === false,
    )
    check(
      'and is not retried at the next start',
      readPendingUpdate(marker)?.startupAttemptFrom === app.getVersion(),
    )
    rmSync(marker, { force: true })
  })

  const stubApp = app as unknown as { quits: number[]; emit: (event: string) => void }
  const stubUpdater = autoUpdater as unknown as {
    autoInstallOnAppQuit: boolean
    emit: (event: string, ...args: unknown[]) => void
  }

  await section('TRAY QUIT WITH AN UPDATE WAITING DEFERS UNTIL CAPTURE/SAVE ENDS', async () => {
    const quitWhenIdle = updater.quitWhenIdle as ((quit: () => void) => void) | undefined
    check('the tray quit goes through the capture/save gate', typeof quitWhenIdle === 'function')
    if (quitWhenIdle === undefined) return
    initUpdater({ autoCheck: true })
    let appBusy = true
    setUpdateInstallBusyProbe(() => appBusy)
    let quits = 0
    quitWhenIdle(() => {
      quits += 1
    })
    check('with nothing to install, Quit is immediate even while busy', quits === 1)
    stubUpdater.emit('update-downloaded', { version: '0.6.1', downloadedFile: '' })
    check('a downloaded update installs on quit', stubUpdater.autoInstallOnAppQuit)
    quitWhenIdle(() => {
      quits += 1
    })
    quitWhenIdle(() => {
      quits += 1
    })
    check('Quit waits while a capture/save runs, so its install cannot cut it short', quits === 1)
    appBusy = false
    await sleep(INSTALL_IDLE_POLL_MS + 300)
    check('then quits, and installs, exactly once', quits === 2, String(quits))
    setAutoUpdateCheck(false)
    appBusy = true
    quitWhenIdle(() => {
      quits += 1
    })
    check('with automatic updates off nothing installs, so Quit is immediate', quits === 3)
    setAutoUpdateCheck(true)
    appBusy = false
  })

  await section('SESSION END IN THE APP', () => {
    const hold = updater.holdSessionEndForUpdate as
      | ((
          reasons: SessionEndReason[],
          settings: { autoInstall: boolean; launchAtLogin: boolean; message: (version: string) => string },
          hiddenArg: string,
        ) => boolean)
      | undefined
    const prepare = updater.prepareSessionEnd as
      | ((reasons: SessionEndReason[], settings: { autoInstall: boolean; launchAtLogin: boolean }, hiddenArg: string) => void)
      | undefined
    check('the app can hold a session end for an install', typeof hold === 'function' && typeof prepare === 'function')
    if (hold === undefined || prepare === undefined) return
    if (process.platform !== 'win32') {
      skip('session end handling', 'Windows only')
      return
    }
    const settings = { autoInstall: true, launchAtLogin: true, message: (version: string) => `v${version}` }
    check('nothing waiting never holds Windows', !hold(['shutdown'], settings, '--openAsHidden'))
    writePendingUpdate(marker, pending({ installerPath: installer, sha512: installerSha }))
    check('Restart Manager close-app never holds Windows', !hold(['close-app'], settings, '--openAsHidden'))
    stubUpdater.autoInstallOnAppQuit = true
    prepare(['shutdown', 'critical'], settings, '--openAsHidden')
    check(
      'a session that ends without the handoff never runs setup from the quit path',
      !stubUpdater.autoInstallOnAppQuit,
    )
    stubUpdater.autoInstallOnAppQuit = true
    writePendingUpdate(marker, pending({ installerPath: installer, sha512: 'not-the-bytes' }))
    const quitsBefore = stubApp.quits.length
    check('a waiting update holds the shutdown', hold(['shutdown'], settings, '--openAsHidden'))
    check('every later query is held too', hold(['shutdown'], settings, '--openAsHidden'))
    check('install-on-quit is disarmed at once', !stubUpdater.autoInstallOnAppQuit)
    return (async () => {
      await sleep(INSTALL_IDLE_POLL_MS + 300)
      check(
        'a changed installer is dropped and the app lets Windows go',
        !existsSync(marker) && stubApp.quits.length === quitsBefore + 1,
        `${String(stubApp.quits.length - quitsBefore)} quit(s)`,
      )
    })()
  })

  await section('WIRING', () => {
    const indexSource = readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8')
    const updaterSource = readFileSync(path.join(process.cwd(), 'src/main/updater.ts'), 'utf8')
    const at = (needle: string): number => indexSource.indexOf(needle)
    const startup = at('await installPendingUpdateBeforeCapture(settings.autoUpdateCheck)')
    check('index.ts installs a waiting update at startup', startup !== -1)
    check(
      'the startup install runs before MCP, capture, the tray and the updater start, so no capture/save can be in progress',
      startup !== -1 &&
        startup > at('loadSettings()') &&
        startup < at('startMcpAtBoot(settings)') &&
        startup < at('await startCapture(settings)') &&
        startup < at('initUpdater({') &&
        startup < at('setUpdateInstallBusyProbe('),
    )
    check(
      'a started install quits instead of continuing startup',
      /await installPendingUpdateBeforeCapture\(settings\.autoUpdateCheck\)\)\s*\{\s*app\.quit\(\)\s*return\s*\}/u.test(
        indexSource,
      ),
    )
    const sessionSource = readFileSync(path.join(process.cwd(), 'src/main/session.ts'), 'utf8')
    check(
      'every install path waits on a real capture/save and pack operations, not on an open editor',
      /setUpdateInstallBusyProbe\(\s*\(\) => captureOrSaveInProgress\(captureFlowActive\(\)\) \|\| anyPackOperationActive\(\),/u.test(
        indexSource,
      ),
    )
    check(
      'a deferred Quit or Restart and update is shown to the user',
      /setUpdateInstallBusyProbe\([\s\S]*?new Notification\(\{[\s\S]*?'update\.quitWaitsForSave' : 'update\.restartWaitsForSave'[\s\S]*?\.show\(\)/u.test(
        indexSource,
      ),
    )
    check(
      'the editor waiting for the user is the only part of a flow that is not busy',
      /function runEditor\([\s\S]*?\): Promise<EditorOutcome> \{\s*return awaitEditorDecision\(new Promise/u.test(sessionSource),
    )
    check(
      'plugin writes that land while the editor is open count as saving',
      (sessionSource.match(/await trackPackWrite\(\s*writeUiaPlugin\(/gu) ?? []).length === 2 &&
        sessionSource.includes('const domWrite = trackPackWrite(writeCapturedDomPlugin(saveFirstHandle))') &&
        sessionSource.includes('const domWrite: Promise<void> = trackPackWrite((async () => {'),
    )
    check(
      'a shutdown query is held while an update installs',
      /window\.on\('query-session-end'[\s\S]*?holdSessionEndForUpdate\([\s\S]*?if \(held\) event\.preventDefault\(\)/u.test(
        indexSource,
      ),
    )
    check(
      'session end disarms install-on-quit and arms the next-boot relaunch',
      /window\.on\('session-end'[\s\S]*?prepareSessionEnd\(/u.test(indexSource),
    )
    check(
      'a hidden window keeps the shutdown listeners alive with recording off and no window open',
      /app\.on\('browser-window-created'[\s\S]*?\}\)\s*void new BrowserWindow\(\{ show: false,/u.test(indexSource),
    )
    check(
      'tray Quit goes through the capture/save gate',
      /noteExitIntent\('user-quit'\)\s*quitWhenIdle\(\(\) => app\.quit\(\)\)/u.test(indexSource),
    )
    check(
      'the guardian waits for this process and runs setup without --force-run',
      /installerArgs: sessionEndInstallArgs\(\)[\s\S]*?waitPid: process\.pid/u.test(updaterSource),
    )
    check(
      'the shipped app starts the guardian through the launcher the end-to-end test runs',
      /return launchSessionEndGuardian\(windowsSystemPath\('WindowsPowerShell', 'v1\.0', 'powershell\.exe'\), script\)/u.test(
        updaterSource,
      ) && !updaterSource.includes("'powershell.exe'),\n      powerShellEncodedArgs("),
    )
    check(
      'every download is remembered for a killed run',
      /'update-downloaded'[\s\S]*?rememberDownloadedUpdate\(info\.version, info\.downloadedFile\)/u.test(updaterSource),
    )
    check(
      'a graceful quit still installs through autoInstallOnAppQuit',
      updaterSource.includes('autoUpdater.autoInstallOnAppQuit = opts.autoCheck'),
    )
  })

  stubApp.emit('will-quit')
}

function appFixture() {
  const userData = app.getPath('userData')
  mkdirSync(userData, { recursive: true })
  const calls = (autoUpdater as unknown as { calls: unknown[][] }).calls
  const stubApp = app as unknown as { quits: number[]; emit: (event: string) => void }
  const stubUpdater = autoUpdater as unknown as {
    autoInstallOnAppQuit: boolean
    emit: (event: string, ...args: unknown[]) => void
  }
  const hold = (reasons: SessionEndReason[]): boolean =>
    updater.holdSessionEndForUpdate(
      reasons,
      { autoInstall: true, launchAtLogin: true, message: (version) => `v${version}` },
      '--openAsHidden',
    )
  const stagedChangedInstaller = (): void =>
    writePendingUpdate(
      pendingUpdateFile(userData),
      pending({ installerPath: process.execPath, sha512: 'not-the-bytes' }),
    )
  return { calls, stubApp, stubUpdater, hold, stagedChangedInstaller }
}

async function restartGroup(): Promise<void> {
  await section('THE APP DEFERS RESTART AND UPDATE', async () => {
    const calls = (autoUpdater as unknown as { calls: unknown[][] }).calls
    let appBusy = true
    const notices: string[] = []
    setUpdateInstallBusyProbe(
      () => appBusy,
      (kind) => {
        notices.push(kind)
      },
    )
    restartAndUpdate()
    restartAndUpdate()
    check('no installer is started while a capture/save runs', calls.length === 0, JSON.stringify(calls))
    check('the wait is shown to the user once', JSON.stringify(notices) === '["restart"]', JSON.stringify(notices))
    appBusy = false
    await sleep(INSTALL_IDLE_POLL_MS + 300)
    check(
      'the install follows exactly once after the work ends',
      calls.length === 1 && calls[0]?.[0] === false && calls[0]?.[1] === true,
      JSON.stringify(calls),
    )
  })

  const { calls, stubApp, stubUpdater, hold, stagedChangedInstaller } = appFixture()

  await section('A RESTART THAT STARTED SETUP NEVER ALSO HOLDS WINDOWS FOR A SECOND ONE', async () => {
    if (process.platform !== 'win32') {
      skip('session end after restart and update', 'Windows only')
      return
    }
    stagedChangedInstaller()
    const quitsBefore = stubApp.quits.length
    check('a shutdown query after Restart and update started setup is not held', !hold(['shutdown']))
    await sleep(INSTALL_IDLE_POLL_MS + 300)
    check(
      'and no session-end handoff quits the app a second time',
      stubApp.quits.length === quitsBefore,
      `${String(stubApp.quits.length - quitsBefore)} quit(s)`,
    )
    rmSync(pendingUpdateFile(app.getPath('userData')), { force: true })
  })

  await section('QUIT AND RESTART AND UPDATE SHARE ONE EXIT', async () => {
    initUpdater({ autoCheck: true })
    stubUpdater.emit('update-downloaded', { version: '0.6.1', downloadedFile: '' })
    let appBusy = true
    setUpdateInstallBusyProbe(() => appBusy)
    let quits = 0
    const installsBefore = calls.length
    restartAndUpdate()
    updater.quitWhenIdle(() => {
      quits += 1
    })
    appBusy = false
    await sleep(INSTALL_IDLE_POLL_MS + 300)
    check(
      'Quit while Restart and update waits replaces it: one quit, no second installer',
      quits === 1 && calls.length === installsBefore,
      `${String(quits)} quit(s), ${String(calls.length - installsBefore)} restart install(s)`,
    )
    appBusy = true
    updater.quitWhenIdle(() => {
      quits += 1
    })
    restartAndUpdate()
    appBusy = false
    await sleep(INSTALL_IDLE_POLL_MS + 300)
    check(
      'Restart and update while Quit waits replaces it: one restart install, no extra quit',
      quits === 1 && calls.length === installsBefore + 1,
      `${String(quits - 1)} quit(s), ${String(calls.length - installsBefore)} restart install(s)`,
    )
  })

  stubApp.emit('will-quit')
}

async function handoffGroup(): Promise<void> {
  const { calls, stubApp, stubUpdater, hold, stagedChangedInstaller } = appFixture()

  await section('A SHUTDOWN HANDOFF OWNS THE EXIT: QUIT AND RESTART JOIN IT', async () => {
    if (process.platform !== 'win32') {
      skip('session end handoff ownership', 'Windows only')
      return
    }
    initUpdater({ autoCheck: true })
    stubUpdater.emit('update-downloaded', { version: '0.6.1', downloadedFile: '' })
    let appBusy = true
    setUpdateInstallBusyProbe(() => appBusy)
    let trayQuits = 0
    const quitsBefore = stubApp.quits.length
    restartAndUpdate()
    stagedChangedInstaller()
    check('a waiting update holds the shutdown', hold(['shutdown']))
    updater.quitWhenIdle(() => {
      trayQuits += 1
    })
    restartAndUpdate()
    await sleep(INSTALL_IDLE_POLL_MS + 300)
    check(
      'tray Quit during the handoff waits for the capture/save in progress',
      trayQuits === 0 && stubApp.quits.length === quitsBefore,
      `${String(trayQuits)} tray quit(s), ${String(stubApp.quits.length - quitsBefore)} app quit(s)`,
    )
    check('a queued Restart and update never runs beside the handoff', calls.length === 0, JSON.stringify(calls))
    appBusy = false
    await sleep(INSTALL_IDLE_POLL_MS + 300)
    check(
      'after the work ends the handoff alone quits, exactly once',
      trayQuits === 0 && stubApp.quits.length === quitsBefore + 1,
      `${String(trayQuits)} tray quit(s), ${String(stubApp.quits.length - quitsBefore)} app quit(s)`,
    )
    check('and no restart install follows', calls.length === 0, JSON.stringify(calls))
  })

  stubApp.emit('will-quit')
}

async function editorGroup(): Promise<void> {
  const { stubApp, stubUpdater } = appFixture()

  await section('AN OPEN EDITOR IS NOT A CAPTURE/SAVE IN PROGRESS', async () => {
    const decide = activity.awaitEditorDecision as (<T>(decision: Promise<T>) => Promise<T>) | undefined
    const write = activity.trackPackWrite as (<T>(work: Promise<T>) => Promise<T>) | undefined
    const inProgress = activity.captureOrSaveInProgress as ((flowActive: boolean) => boolean) | undefined
    check(
      'capture/save activity is tracked apart from the editor waiting for the user',
      typeof decide === 'function' && typeof write === 'function' && typeof inProgress === 'function',
    )
    if (decide === undefined || write === undefined || inProgress === undefined) return
    check('no flow is not busy', !inProgress(false))
    check('capturing before the editor opens is busy', inProgress(true))
    let closeEditor: (outcome: string) => void = () => {}
    const editor = decide(new Promise<string>((resolve) => (closeEditor = resolve)))
    check('an editor waiting for the user is not busy', !inProgress(true))
    let finishWrite: () => void = () => {}
    const pluginWrite = write(new Promise<void>((resolve) => (finishWrite = resolve)))
    check('a pack write while the editor is open is busy', inProgress(true))
    finishWrite()
    await pluginWrite
    check('the open editor is idle again once that write lands', !inProgress(true))
    closeEditor('export')
    check('the save after the editor closes is busy', (await editor) === 'export' && inProgress(true))
    const failing = write(Promise.reject(new Error('disk full')))
    await failing.catch(() => {})
    check('a failed pack write stops counting', !inProgress(false))

    initUpdater({ autoCheck: true })
    stubUpdater.emit('update-downloaded', { version: '0.6.1', downloadedFile: '' })
    let flowActive = true
    const notices: string[] = []
    setUpdateInstallBusyProbe(
      () => inProgress(flowActive),
      (kind) => {
        notices.push(kind)
      },
    )
    let quits = 0
    let closeOpenEditor: (outcome: string) => void = () => {}
    const openEditor = decide(new Promise<string>((resolve) => (closeOpenEditor = resolve)))
    updater.quitWhenIdle(() => {
      quits += 1
    })
    check(
      'tray Quit with only an editor open quits at once and installs on quit',
      quits === 1 && stubUpdater.autoInstallOnAppQuit && notices.length === 0,
      `${String(quits)} quit(s), ${String(notices.length)} notice(s)`,
    )
    closeOpenEditor('cancel')
    await openEditor
    let finishSave: () => void = () => {}
    const save = write(new Promise<void>((resolve) => (finishSave = resolve)))
    flowActive = false
    updater.quitWhenIdle(() => {
      quits += 1
    })
    updater.quitWhenIdle(() => {
      quits += 1
    })
    check(
      'tray Quit during a real save waits and tells the user once',
      quits === 1 && notices.length === 1 && notices[0] === 'quit',
      `${String(quits)} quit(s), notices ${JSON.stringify(notices)}`,
    )
    finishSave()
    await save
    await sleep(INSTALL_IDLE_POLL_MS + 300)
    check('the save is not cut short, then Quit installs exactly once', quits === 2, String(quits))
  })

  stubApp.emit('will-quit')
}

const groups: Record<string, () => Promise<void>> = {
  main,
  restart: restartGroup,
  handoff: handoffGroup,
  editor: editorGroup,
  [GUARDIAN_HOST]: guardianHostGroup,
}
const group = groups[process.argv[2] ?? 'main']

;(group ?? (() => Promise.reject(new Error(`unknown group ${String(process.argv[2])}`))))()
  .catch((err: unknown) => {
    failed += 1
    console.error(err)
  })
  .finally(() => {
    if (skipped > 0) console.log(`\nupdate-install-check skipped: ${skipped}`)
    if (failed > 0) {
      console.error(`\nupdate-install-check failed: ${failed}`)
      process.exitCode = 1
    } else {
      console.log('\nupdate-install-check ok')
    }
  })
