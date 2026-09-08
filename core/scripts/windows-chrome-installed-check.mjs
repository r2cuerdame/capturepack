import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
}

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
  'locked or shared Chrome sessions block before any registry mutation',
  harness.indexOf("processExists('LogonUI.exe')") < harness.indexOf('const registryBefore = registrySnapshot()') &&
    harness.indexOf("processExists('chrome.exe')") < harness.indexOf('const registryBefore = registrySnapshot()') &&
    harness.includes('close every pre-existing Chrome process or use a disposable Windows user') &&
    harness.includes('BLOCKED: unable to inspect ${imageName} processes safely') &&
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
  'cleanup kills recorded PIDs and removes only paths owned below the artifact root',
  harness.includes("spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F']") &&
    harness.includes('if (!ownedPath(candidate, parent))') &&
    harness.includes('owned path survived cleanup'),
)
check(
  'Chrome-spawned native host provenance is opt-in and never touches stdout',
  harness.includes('CAPTUREPACK_NATIVE_HOST_EVIDENCE') &&
    nativeEntry.includes("process.env['CAPTUREPACK_NATIVE_HOST_EVIDENCE']") &&
    nativeEntry.includes('fs.appendFileSync') && !nativeEntry.includes('process.stdout.write'),
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
