import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertProcessesPreserved,
  identityKey,
  selectOwnedProcessTrees,
  traceProcessAncestry,
  verifyChromeRoot,
} from './windows-process-provenance.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const harnessFile = join(here, 'windows-chrome-installed-acceptance.mjs')
const toolbarFile = join(here, 'windows-chrome-toolbar.ps1')
const installerFile = join(here, 'windows-installer-lifecycle.ps1')
const harness = readFileSync(harnessFile, 'utf8')
const toolbar = readFileSync(toolbarFile, 'utf8')
const installer = readFileSync(installerFile, 'utf8')
const nativeEntry = readFileSync(join(here, '..', 'src', 'main', 'chrome', 'nativeHostEntry.ts'), 'utf8')
const domBridge = readFileSync(join(here, '..', 'src', 'main', 'chrome', 'domBridge.ts'), 'utf8')
const pageCapture = readFileSync(join(here, '..', 'src', 'main', 'chrome', 'pageCapture.ts'), 'utf8')
const browserPage = readFileSync(join(here, '..', 'src', 'shared', 'context', 'browserPage.ts'), 'utf8')
const browserPageSurfaceId = browserPage.match(/BROWSER_PAGE_SURFACE_ID\s*=\s*'([^']+)'/u)?.[1]
let passed = 0
let failed = 0

function check(name, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}`)
  if (condition) passed += 1
  else failed += 1
}

function throws(fn, pattern) {
  try { fn(); return false } catch (error) { return pattern.test(String(error)) }
}

const root = { pid: 100, parentPid: 4, name: 'chrome.exe', executablePath: resolve('fixtures/chrome.exe'), commandLine: `chrome.exe --user-data-dir=${resolve('fixtures/profile')}`, creationTimeUtc: '2026-09-08T01:00:00.0000000Z' }
const broker = { pid: 101, parentPid: 100, name: 'chrome.exe', creationTimeUtc: '2026-09-08T01:00:01.0000000Z' }
const host = { pid: 102, parentPid: 101, name: 'CapturePack.exe', creationTimeUtc: '2026-09-08T01:00:02.0000000Z' }
const prior = { pid: 90, parentPid: 4, name: 'chrome.exe', creationTimeUtc: '2026-09-08T00:00:00.0000000Z' }
const fixtureProcesses = [root, broker, host, prior]

const syntax = spawnSync(process.execPath, ['--check', harnessFile], { encoding: 'utf8' })
check('headed acceptance harness parses as JavaScript', syntax.status === 0)

if (process.platform === 'win32') {
  for (const file of [toolbarFile, installerFile]) {
    const escaped = file.replace(/'/g, "''")
    const parsed = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$parseTokens=$null; $parseErrors=$null; ` +
      `[void][System.Management.Automation.Language.Parser]::ParseFile('${escaped}',[ref]$parseTokens,[ref]$parseErrors); ` +
      `if(@($parseErrors).Count){$parseErrors | ForEach-Object { [Console]::Error.WriteLine($_.ToString()) }; exit 1}`,
    ], { encoding: 'utf8', windowsHide: true })
    if (parsed.status !== 0) process.stderr.write(String(parsed.stderr || parsed.stdout || parsed.error))
    check(`${file.split(/[\\/]/u).at(-1)} parses as PowerShell`, parsed.status === 0)
  }
  const registryProbe = spawnSync(process.execPath, [harnessFile, '--probe-registry'], {
    encoding: 'utf8', windowsHide: true,
  })
  if (registryProbe.status !== 0) process.stderr.write(String(registryProbe.stderr || registryProbe.error))
  let registryProbeResult = null
  try { registryProbeResult = JSON.parse(String(registryProbe.stdout).trim()) } catch {}
  check(
    'the native-host registry snapshot executes read-only and fails closed',
    registryProbe.status === 0 && typeof registryProbeResult?.keyExists === 'boolean' &&
      typeof registryProbeResult?.exists === 'boolean',
  )
  const processProbe = spawnSync(process.execPath, [harnessFile, '--probe-processes'], {
    encoding: 'utf8', windowsHide: true,
  })
  let processProbeResult = null
  try { processProbeResult = JSON.parse(String(processProbe.stdout).trim()) } catch {}
  check(
    'the Windows process identity snapshot executes read-only or blocks fail-closed',
    (processProbe.status === 0 && Number.isInteger(processProbeResult?.processCount) &&
      Array.isArray(processProbeResult?.chrome) && processProbeResult.chrome.every((entry) =>
        Number.isInteger(entry.pid) && typeof entry.creationTimeUtc === 'string')) ||
      (processProbe.status !== 0 && String(processProbe.stderr).includes('BLOCKED: unable to snapshot Windows process identities safely')),
  )
}

check(
  'native-host ancestry reaches the owned Chrome root through an identity-checked chain',
  traceProcessAncestry(fixtureProcesses, host, root, { strict: true }).map((entry) => entry.pid).join(',') === '102,101,100',
)
check(
  'ancestry fails closed for an unrelated host, missing parent, cycle, and reused root PID',
  throws(() => traceProcessAncestry(fixtureProcesses, prior, root, { strict: true }), /ended before owned root|missing parent/u) &&
    throws(() => traceProcessAncestry([root, { ...host, parentPid: 999 }], host, root, { strict: true }), /missing parent PID 999/u) &&
    throws(() => traceProcessAncestry([root, { ...broker, parentPid: 102, creationTimeUtc: host.creationTimeUtc }, { ...host, parentPid: 101 }], host, root, { strict: true }), /cycle/u) &&
    throws(() => traceProcessAncestry([{ ...root, creationTimeUtc: '2026-09-08T02:00:00.0000000Z' }, host], host, root), /owned root identity is no longer live/u),
)
check(
  'unique-profile launch accepts only a fresh Chrome root with the expected executable and profile',
  identityKey(verifyChromeRoot(fixtureProcesses, root.pid, [prior], root.executablePath, resolve('fixtures/profile'))) === identityKey(root) &&
    throws(() => verifyChromeRoot(fixtureProcesses, prior.pid, [prior], root.executablePath, resolve('fixtures/profile')), /reused pre-existing\/protected/u) &&
    throws(() => verifyChromeRoot(fixtureProcesses, root.pid, [], root.executablePath, resolve('fixtures/other-profile')), /unique user-data-dir/u),
)
check(
  'cleanup selection contains only identity-proven owned descendants and excludes pre-existing Chrome',
  selectOwnedProcessTrees(fixtureProcesses, [root], [prior]).map((entry) => entry.pid).sort().join(',') === '100,101,102',
)
check(
  'pre-existing Chrome preservation detects missing and PID-replaced browsers',
  assertProcessesPreserved([prior], fixtureProcesses).length === 1 &&
    throws(() => assertProcessesPreserved([prior], fixtureProcesses.filter((entry) => entry.pid !== prior.pid)), /killed or replaced/u) &&
    throws(() => assertProcessesPreserved([prior], fixtureProcesses.map((entry) => entry.pid === prior.pid ? { ...entry, creationTimeUtc: '2026-09-08T03:00:00.0000000Z' } : entry)), /killed or replaced/u),
)

check(
  'the final trigger is a physical click on a UIA-discovered Chrome action',
  toolbar.includes('UIAutomationClient') && toolbar.includes('Click-Physical $action') &&
    toolbar.includes('mouse_event') && !harness.includes('fullPageCapture(') &&
    !harness.includes('chrome.debugger'),
)
check(
  'official Chrome can load the unpacked extension through its developer-mode UI',
  toolbar.includes("ValidateSet('InstallExtension', 'ClickAction', 'FindEditor')") &&
    toolbar.includes("Send-Literal 'chrome://extensions/'") && toolbar.includes('Click-Physical $load') &&
    toolbar.includes('Click-Physical $select') && harness.includes("method: 'chrome-developer-mode-ui'") &&
    harness.includes("'-Mode', 'InstallExtension'") && harness.includes("'--force-renderer-accessibility'"),
)
check(
  'locked sessions still block while pre-existing Chrome is snapshotted instead of rejected',
  harness.indexOf("processExists('LogonUI.exe')") < harness.indexOf('const registryBefore = registrySnapshot()') &&
    !harness.includes("processExists('chrome.exe')") &&
    harness.includes('const preExistingChrome = chromeProcesses()') &&
    harness.includes('preExistingChromePreserved') &&
    harness.includes('an earlier acceptance run still owns state; run --cleanup first'),
)
check(
  'the exact Chrome registry value is journaled, restored and verified in cleanup',
    harness.includes("const hostKey = 'HKCU\\\\Software\\\\Google\\\\Chrome") &&
    harness.includes('[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey') &&
    harness.includes("@($key.GetValueNames()) -contains ''") &&
    harness.includes('[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))') &&
    harness.includes("else if (snapshot.keyExists)") &&
    harness.includes("['delete', hostKey, '/ve', '/f']") &&
    harness.includes("writeJson(registryFile, registryBefore)") &&
    harness.includes('restoreRegistry(registryBefore)') &&
    harness.includes('native-host registry restoration mismatch'),
)
check(
  'cleanup identity-checks owned roots, protects prior Chrome and removes only owned paths',
  harness.includes("spawnSync('taskkill.exe', ['/PID', String(root.pid), '/T', '/F']") &&
    harness.includes('selectOwnedProcessTrees(before, [root], protectedChrome)') &&
    harness.includes('assertProcessesPreserved(protectedChrome, chromeProcesses(after))') &&
    harness.includes('refusing unsafe cleanup: run-state lacks PID/creation-time provenance') &&
    harness.includes('if (!ownedPath(candidate, parent))') && harness.includes('owned path survived cleanup'),
)
check(
  'Chrome-spawned native host evidence is ancestry-checked and never touches stdout',
  harness.includes('CAPTUREPACK_NATIVE_HOST_EVIDENCE') &&
    harness.includes('traceProcessAncestry(processes, host, captureChromeRoot, { strict: true })') &&
    harness.includes('native-host PID ${String(launch.pid)} exited before provenance inspection') &&
    nativeEntry.includes("process.env['CAPTUREPACK_NATIVE_HOST_EVIDENCE']") &&
    nativeEntry.includes('fs.appendFileSync') && !nativeEntry.includes('process.stdout.write'),
)
check(
  'toolbar and editor UIA are constrained by unique title and owned PID/start-time ancestry',
  harness.includes('const fixtureTitle = `${fixtureTitlePrefix} ${runId}`') &&
    harness.includes("'-ExpectedRootPid', String(captureChromeRoot.pid)") &&
    harness.includes("'-ExpectedRootCreationTimeUtc', captureChromeRoot.creationTimeUtc") &&
    toolbar.includes('function Test-OwnedProcess') && toolbar.includes('$titleMatches') &&
    toolbar.includes('(Test-OwnedProcess $item.Current.ProcessId)') &&
    toolbar.includes('(Test-OwnedProcess $candidate.Current.ProcessId)'),
)
check(
  'capture ID, finish, pack identity and visible normal editor are correlated',
  domBridge.includes('[chrome] page.capture.start ${captureId} accepted') &&
    domBridge.includes('[chrome] page.capture.finish ${captureId} received') &&
    pageCapture.includes('persisted as pack ${handle.id}') &&
    harness.includes('persisted.captureId') && harness.includes('persisted.packId') &&
    harness.includes('[capture] re-edit editor shown: ${persisted.basename}') &&
    harness.includes("'-Mode', 'FindEditor'"),
)
check(
  'persisted evidence asserts the Chrome action, DOM metadata and reserved page surface',
  harness.includes("trigger?.data?.source !== 'chrome-full-page'") &&
    harness.includes("trigger?.data?.hotkey !== 'chrome.action'") &&
    harness.includes("element.id === 'acceptance-marker'") &&
    browserPageSurfaceId !== undefined &&
    harness.includes(`surfaceText.includes('${browserPageSurfaceId}')`),
)
check(
  'headed scenarios retain strict long, responsive, very-tall, DPR-2 and short raster checks',
  harness.includes("responsive: { documentHeight: 5080") &&
    harness.includes("'very-tall': { documentHeight: 30016") &&
    harness.includes("dpr2: { documentHeight: 8016") && harness.includes("short: { documentHeight: 400") &&
    harness.includes('persisted raster/viewport scale mismatch') && harness.includes('reportedDpr'),
)
check(
  'preparation requires a clean git head and hashes the package and exact extension inventory',
  harness.includes("['status', '--porcelain=v1']") && harness.includes('refusing to package a dirty tree') &&
    harness.includes('extensionInventorySha256') && harness.includes("sha256: sha256(installer)"),
)
check(
  'installer install/update/remove is hard-gated to a disposable Windows user',
  installer.includes("CAPTUREPACK_DISPOSABLE_WINDOWS_ACCEPTANCE -ne '1'") &&
    installer.includes("Run-Setup 'install'") && installer.includes("Run-Setup 'same-candidate update'") &&
    installer.includes("Set-Item -Path $hostKeys[0] -Value $hostManifest") &&
    installer.includes('same-candidate update did not restore the exact enabled Chrome native-host state') &&
    installer.includes("Start-Process -FilePath $uninstaller") && installer.includes('uninstall residue'),
)

console.log(`\nresult: ${failed === 0 ? 'OK' : 'BROKEN'} — ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
