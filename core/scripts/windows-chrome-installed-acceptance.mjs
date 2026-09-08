// Hardware-only Windows acceptance for Issue #157 / PR #158.
//
// This deliberately does not use CDP or call the extension helper. The final
// trigger is a physical mouse click on the Chrome action found through UIA, so
// Chromium's activeTab user-gesture grant is part of the path under test.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { terminateProcessTree } from './process-tree.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const core = resolve(here, '..')
const repo = resolve(core, '..')
const hostKey = 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.capturepack.host'
const fixtureTitle = 'CapturePack Acceptance Fixture'
const scenarios = {
  long: { documentHeight: 7216, windowSize: '1024,720', deviceScaleFactor: null },
  responsive: { documentHeight: 5080, windowSize: '390,844', deviceScaleFactor: null },
  'very-tall': { documentHeight: 30016, windowSize: '1024,720', deviceScaleFactor: null },
  dpr2: { documentHeight: 8016, windowSize: '800,600', deviceScaleFactor: 2 },
  short: { documentHeight: 400, windowSize: '1280,720', deviceScaleFactor: null },
}

function option(name, fallback = null) {
  const prefix = `--${name}=`
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? fallback
}

function command(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: core,
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  })
  if (result.status !== 0) {
    throw new Error(
      `${file} ${args.join(' ')} failed (${String(result.status)}): ` +
      `${String(result.stderr || result.stdout || result.error).slice(0, 2000)}`,
    )
  }
  return String(result.stdout ?? '').trim()
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function fileInventory(root) {
  const rows = []
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile()) {
        rows.push({ path: relative(root, absolute).replace(/\\/g, '/'), bytes: statSync(absolute).size, sha256: sha256(absolute) })
      }
    }
  }
  visit(root)
  return rows
}

function inventoryDigest(rows) {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function findChrome() {
  const requested = option('chrome')
  const candidates = [
    requested,
    join(process.env['PROGRAMFILES'] ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env['LOCALAPPDATA'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean)
  const chrome = candidates.find((candidate) => existsSync(candidate))
  if (chrome === undefined) throw new Error('Google Chrome was not found; pass --chrome=<absolute path>')
  return resolve(chrome)
}

function fileVersion(file) {
  const escaped = file.replace(/'/g, "''")
  return command('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `(Get-Item -LiteralPath '${escaped}').VersionInfo.ProductVersion`,
  ])
}

function processExists(imageName) {
  const processName = imageName.replace(/\.exe$/iu, '').replace(/'/g, "''")
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `$found = Get-Process -Name '${processName}' -ErrorAction SilentlyContinue; if ($null -ne $found) { exit 0 }; exit 1`,
  ], { encoding: 'utf8', windowsHide: true })
  if (result.status === 0) return true
  if (result.status === 1) return false
  throw new Error(`BLOCKED: unable to inspect ${imageName} processes safely`)
}

function registrySnapshot() {
  const script = [
    "$key = $null",
    "try {",
    "  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Google\\Chrome\\NativeMessagingHosts\\com.capturepack.host', $false)",
    "  if ($null -eq $key) { $snapshot = @{ keyExists = $false; exists = $false } }",
    "  elseif (-not (@($key.GetValueNames()) -contains '')) { $snapshot = @{ keyExists = $true; exists = $false } }",
    "  else {",
    "    $kind = $key.GetValueKind('').ToString()",
    "    $type = switch ($kind) { 'String' { 'REG_SZ' } 'ExpandString' { 'REG_EXPAND_SZ' } default { throw \"unsupported native-host registry value kind: $kind\" } }",
    "    $value = [string]$key.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
    "    $snapshot = @{ keyExists = $true; exists = $true; type = $type; value = $value }",
    "  }",
    "  $json = $snapshot | ConvertTo-Json -Compress",
    "  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))",
    "} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 2 } finally { if ($null -ne $key) { $key.Dispose() } }",
  ].join('; ')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true,
  })
  if (result.status !== 0) {
    throw new Error(`BLOCKED: unable to snapshot Chrome native-host registry safely: ${String(result.stderr || result.error)}`)
  }
  try {
    return JSON.parse(Buffer.from(String(result.stdout).trim(), 'base64').toString('utf8'))
  } catch (error) {
    throw new Error(`BLOCKED: Chrome native-host registry snapshot was invalid: ${String(error)}`)
  }
}

function restoreRegistry(snapshot) {
  if (snapshot.exists) {
    command('reg.exe', ['add', hostKey, '/ve', '/t', snapshot.type, '/d', snapshot.value, '/f'])
  } else if (snapshot.keyExists) {
    command('reg.exe', ['delete', hostKey, '/ve', '/f'])
  } else {
    command('reg.exe', ['delete', hostKey, '/f'])
  }
  const after = registrySnapshot()
  if (JSON.stringify(after) !== JSON.stringify(snapshot)) {
    throw new Error(`native-host registry restoration mismatch: ${JSON.stringify(after)}`)
  }
}

function ownedPath(candidate, parent) {
  const rel = relative(resolve(parent), resolve(candidate))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function removeOwned(candidate, parent) {
  if (!ownedPath(candidate, parent)) throw new Error(`refusing to remove non-owned path: ${candidate}`)
  rmSync(candidate, { recursive: true, force: true })
  if (existsSync(candidate)) throw new Error(`owned path survived cleanup: ${candidate}`)
}

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now()
  while (Date.now() - started <= timeoutMs) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error(`${label} timed out after ${String(timeoutMs)} ms`)
}

async function stopChild(child) {
  if (child === null || child === undefined || child.exitCode !== null || child.signalCode !== null) return
  const killer = terminateProcessTree(child)
  if (killer !== null) {
    await Promise.race([
      new Promise((done) => { killer.once('close', done); killer.once('error', done) }),
      new Promise((done) => setTimeout(done, 10_000)),
    ])
  }
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 5_000, `PID ${String(child.pid)} exit`).catch(() => {})
}

function discoverExtensionId(profile, extensionDir) {
  const wanted = normalize(resolve(extensionDir)).toLowerCase()
  for (const name of ['Secure Preferences', 'Preferences']) {
    const file = join(profile, 'Default', name)
    if (!existsSync(file)) continue
    let settings
    try {
      settings = JSON.parse(readFileSync(file, 'utf8'))?.extensions?.settings
    } catch {
      continue
    }
    for (const [id, entry] of Object.entries(settings ?? {})) {
      const found = typeof entry?.path === 'string' ? normalize(resolve(entry.path)).toLowerCase() : ''
      if (/^[a-p]{32}$/u.test(id) && found === wanted) return id
    }
  }
  return null
}

function launchChrome(chrome, profile, extensionDir, url, env, scenario) {
  const geometryArgs = [`--window-size=${scenario.windowSize}`]
  if (scenario.deviceScaleFactor !== null) geometryArgs.push(`--force-device-scale-factor=${String(scenario.deviceScaleFactor)}`)
  return spawn(chrome, [
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-background-networking',
    '--force-renderer-accessibility',
    ...geometryArgs,
    '--new-window',
    url,
  ], { stdio: 'ignore', env })
}

function pngSize(file) {
  const bytes = readFileSync(file)
  if (bytes.length < 24 || bytes.subarray(1, 4).toString('ascii') !== 'PNG') throw new Error('snapshot.png is not PNG')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes: bytes.length, sha256: sha256(file) }
}

function packEvidence(packDir, expectedUrl) {
  const manifest = JSON.parse(readFileSync(join(packDir, 'manifest.json'), 'utf8'))
  const timeline = JSON.parse(readFileSync(join(packDir, 'timeline.json'), 'utf8'))
  const domFile = join(packDir, 'plugins', 'chrome-dom', 'elements.json')
  const windowsFile = join(packDir, 'plugins', 'windows-context', 'timeline.json')
  const dom = JSON.parse(readFileSync(domFile, 'utf8'))
  const windows = JSON.parse(readFileSync(windowsFile, 'utf8'))
  const trigger = timeline.events?.find((event) => event.type === 'core.image.capture.triggered')
  const documentEvent = dom.events?.find((event) => event.type === 'dom.document.captured')
  const surfaceText = JSON.stringify(windows)
  const marker = documentEvent?.document?.elements?.find((element) => element.id === 'acceptance-marker')
  const plugins = manifest.plugins?.map((plugin) => plugin.name) ?? []
  const snapshot = pngSize(join(packDir, 'snapshot.png'))
  const widthScale = snapshot.width / trigger?.data?.document_width_css
  const heightScale = snapshot.height / trigger?.data?.document_height_css
  if (manifest.capture_kind !== 'image' || manifest.media?.image_scope !== 'fullscreen') throw new Error('pack is not a fullscreen image')
  if (trigger?.data?.source !== 'chrome-full-page' || trigger?.data?.hotkey !== 'chrome.action') throw new Error('timeline does not identify the Chrome action')
  if (
    !Number.isFinite(widthScale) || !Number.isFinite(heightScale) ||
    Math.abs(widthScale - heightScale) > 0.001 ||
    Math.abs(widthScale - trigger.data.device_scale_factor) > 0.001
  ) throw new Error(`persisted raster/viewport scale mismatch: ${String(widthScale)}x${String(heightScale)} vs DPR ${String(trigger.data.device_scale_factor)}`)
  if (documentEvent?.tab?.url !== expectedUrl || marker === undefined) throw new Error('captured DOM URL/marker does not match the fixture')
  if (!plugins.includes('chrome-dom') || !plugins.includes('windows-context')) throw new Error('required context plugins are not declared')
  if (!surfaceText.includes('capturepack-browser-page')) throw new Error('reserved browser-page surface is absent')
  return {
    packId: manifest.id,
    directory: packDir,
    captureKind: manifest.capture_kind,
    imageScope: manifest.media.image_scope,
    snapshot,
    rasterScale: { x: widthScale, y: heightScale, reportedDpr: trigger.data.device_scale_factor },
    timelineTrigger: trigger,
    dom: {
      bytes: statSync(domFile).size,
      extensionVersion: dom.extension_version,
      url: documentEvent.tab.url,
      title: documentEvent.tab.title,
      viewport: documentEvent.viewport,
      documentViewport: documentEvent.document.viewport,
      elementCount: documentEvent.document.elements.length,
      markerBounds: marker.bounds,
      truncated: documentEvent.document.truncated,
    },
    windowsContextBytes: statSync(windowsFile).size,
    plugins,
  }
}

async function fixtureServer(scenarioName, scenario) {
  const markerTop = Math.min(2475, Math.max(100, scenario.documentHeight - 180))
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${fixtureTitle}</title><style>html,body{margin:0}header{position:sticky;top:0;background:#18222f;color:white;padding:20px}main{height:${String(scenario.documentHeight)}px;background:linear-gradient(#fff,#7ad)}#acceptance-marker{position:absolute;left:123px;top:${String(markerTop)}px;width:240px;height:80px;background:#f85}</style></head><body><header>Toolbar gesture acceptance: ${scenarioName}</header><main><button id="acceptance-marker">Deterministic marker</button></main></body></html>`
  const server = http.createServer((request, response) => {
    if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(html)
  })
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const address = server.address()
  return { server, url: `http://127.0.0.1:${String(address.port)}/acceptance` }
}

async function prepare(artifacts) {
  if (process.platform !== 'win32') throw new Error('Windows packaging acceptance requires Windows')
  if (existsSync(join(artifacts, 'prepare.json'))) throw new Error(`prepared evidence already exists: ${artifacts}`)
  if (!existsSync(join(core, 'node_modules'))) throw new Error('core/node_modules is absent; run npm ci first')
  const head = command('git.exe', ['rev-parse', 'HEAD'], { cwd: repo })
  const dirty = command('git.exe', ['status', '--porcelain=v1'], { cwd: repo })
  if (dirty !== '') throw new Error('refusing to package a dirty tree; commit the acceptance work first')
  const branch = command('git.exe', ['branch', '--show-current'], { cwd: repo })
  const packageDir = join(artifacts, 'package')
  const extensionDir = join(artifacts, 'unpacked-extension')
  const tscCli = join(core, 'node_modules', 'typescript', 'bin', 'tsc')
  const builderCli = join(core, 'node_modules', 'electron-builder', 'cli.js')
  mkdirSync(artifacts, { recursive: true })
  command(process.execPath, [tscCli, '--noEmit'])
  command(process.execPath, [join(core, 'scripts', 'build.mjs'), '--require-dxgi-helper'])
  command(process.execPath, [builderCli, '--win', '--publish', 'never', `--config.directories.output=${packageDir}`])
  cpSync(join(repo, 'extensions', 'chrome'), extensionDir, { recursive: true })
  const appExe = join(packageDir, 'win-unpacked', 'CapturePack.exe')
  const nativeHostScript = join(packageDir, 'win-unpacked', 'resources', 'app.asar.unpacked', 'dist', 'scripts', 'native-host.js')
  const packagedExtensionDir = join(packageDir, 'win-unpacked', 'resources', 'extensions', 'chrome')
  const installer = readdirSync(packageDir).map((name) => join(packageDir, name)).find((file) => /CapturePack-Setup-.*\.exe$/u.test(file))
  for (const required of [appExe, nativeHostScript, packagedExtensionDir, installer]) {
    if (required === undefined || !existsSync(required)) throw new Error(`packaged artifact is missing: ${String(required)}`)
  }
  const sourceInventory = fileInventory(join(repo, 'extensions', 'chrome'))
  const stagedInventory = fileInventory(extensionDir)
  if (JSON.stringify(sourceInventory) !== JSON.stringify(stagedInventory)) throw new Error('staged extension differs from the PR tree')
  const packagedInventory = fileInventory(packagedExtensionDir)
  if (JSON.stringify(sourceInventory) !== JSON.stringify(packagedInventory)) throw new Error('packaged extension differs from the PR tree')
  const chrome = findChrome()
  const evidence = {
    schema: 1,
    preparedAt: new Date().toISOString(),
    head,
    branch,
    dirty: false,
    node: process.version,
    appVersion: JSON.parse(readFileSync(join(core, 'package.json'), 'utf8')).version,
    extensionVersion: JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8')).version,
    chrome,
    chromeVersion: fileVersion(chrome),
    packageDir,
    appExe: { path: appExe, bytes: statSync(appExe).size, sha256: sha256(appExe) },
    nativeHostScript: { path: nativeHostScript, bytes: statSync(nativeHostScript).size, sha256: sha256(nativeHostScript) },
    installer: { path: installer, bytes: statSync(installer).size, sha256: sha256(installer) },
    extensionDir,
    extensionInventorySha256: inventoryDigest(stagedInventory),
    packagedExtensionDir,
    packagedExtensionInventorySha256: inventoryDigest(packagedInventory),
    extensionFiles: stagedInventory,
    installerLifecycleCommand: `powershell -File scripts/windows-installer-lifecycle.ps1 -Installer "${installer}" -EvidenceDir "<disposable-user-evidence-dir>"`,
    headedCommands: Object.keys(scenarios).map((scenario) =>
      `npm run qa:windows-chrome-installed -- --run --scenario=${scenario} --artifacts="${artifacts}"`),
  }
  writeJson(join(artifacts, 'prepare.json'), evidence)
  console.log(JSON.stringify(evidence, null, 2))
}

async function cleanup(artifacts, state, registryBefore) {
  const errors = []
  for (const pid of [...(state.hostPids ?? []), ...(state.pids ?? [])]) {
    if (!Number.isInteger(pid) || pid <= 0) continue
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true })
  }
  try { restoreRegistry(registryBefore) } catch (error) { errors.push(String(error)) }
  for (const candidate of [state.chromeProfile, state.appData, state.transient]) {
    if (!candidate || !existsSync(candidate)) continue
    try { removeOwned(candidate, artifacts) } catch (error) { errors.push(String(error)) }
  }
  const result = {
    registryRestored: JSON.stringify(registrySnapshot()) === JSON.stringify(registryBefore),
    pathsRemoved: [state.chromeProfile, state.appData, state.transient].filter(Boolean).every((path) => !existsSync(path)),
    errors,
  }
  if (!result.registryRestored || !result.pathsRemoved || errors.length > 0) throw new Error(`cleanup failed: ${JSON.stringify(result)}`)
  return result
}

async function run(artifacts) {
  if (process.platform !== 'win32') throw new Error('headed Chrome acceptance requires Windows')
  if (processExists('LogonUI.exe')) throw new Error('BLOCKED: LogonUI is active; unlock the interactive Windows session')
  if (processExists('chrome.exe')) throw new Error('BLOCKED: close every pre-existing Chrome process or use a disposable Windows user')
  const priorStateFile = join(artifacts, 'run-state.json')
  if (existsSync(priorStateFile)) {
    const priorState = JSON.parse(readFileSync(priorStateFile, 'utf8'))
    if (typeof priorState.transient === 'string' && existsSync(priorState.transient)) {
      throw new Error('BLOCKED: an earlier acceptance run still owns state; run --cleanup first')
    }
  }
  const prepared = JSON.parse(readFileSync(join(artifacts, 'prepare.json'), 'utf8'))
  const scenarioName = option('scenario', 'long')
  const scenario = scenarios[scenarioName]
  if (scenario === undefined) throw new Error(`unknown headed scenario: ${scenarioName}`)
  const head = command('git.exe', ['rev-parse', 'HEAD'], { cwd: repo })
  if (head !== prepared.head) throw new Error(`prepared head ${prepared.head} differs from current ${head}`)
  const inventory = fileInventory(prepared.extensionDir)
  if (inventoryDigest(inventory) !== prepared.extensionInventorySha256) throw new Error('unpacked extension changed after preparation')
  if (sha256(prepared.appExe.path) !== prepared.appExe.sha256 || sha256(prepared.nativeHostScript.path) !== prepared.nativeHostScript.sha256) {
    throw new Error('packaged app/native host changed after preparation')
  }

  const runId = `${prepared.head.slice(0, 12)}-${Date.now()}`
  const transient = join(artifacts, `transient-${runId}`)
  const chromeProfile = join(transient, 'chrome-profile')
  const appData = join(transient, 'appdata')
  const output = join(artifacts, `pack-${runId}`)
  const hostEvidence = join(artifacts, `native-host-${runId}.jsonl`)
  const logFile = join(appData, 'logs', 'main.log')
  const stateFile = join(artifacts, 'run-state.json')
  const registryFile = join(artifacts, 'registry-before.json')
  const registryBefore = registrySnapshot()
  const state = { runId, scenario: scenarioName, transient, chromeProfile, appData, output, pids: [], hostPids: [] }
  writeJson(registryFile, registryBefore)
  writeJson(stateFile, state)
  mkdirSync(chromeProfile, { recursive: true })
  mkdirSync(appData, { recursive: true })
  mkdirSync(output, { recursive: true })
  const suffix = `windows-157-${process.pid}-${Date.now()}`
  const env = {
    ...process.env,
    APPDATA: appData,
    CAPTUREPACK_DOM_PIPE_SUFFIX: suffix,
    CAPTUREPACK_NATIVE_HOST_EVIDENCE: hostEvidence,
  }
  let chrome = null
  let app = null
  let fixture = null
  let verdict = null
  let extensionInstall = { method: 'command-line' }
  try {
    fixture = await fixtureServer(scenarioName, scenario)
    chrome = launchChrome(prepared.chrome, chromeProfile, prepared.extensionDir, fixture.url, env, scenario)
    state.pids.push(chrome.pid)
    writeJson(stateFile, state)
    let extensionId = await waitFor(
      () => discoverExtensionId(chromeProfile, prepared.extensionDir),
      8_000,
      'command-line unpacked extension discovery',
    ).catch(() => null)
    if (extensionId === null) {
      const installOutput = command('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', join(here, 'windows-chrome-toolbar.ps1'),
        '-Mode', 'InstallExtension', '-WindowTitle', fixtureTitle,
        '-ExtensionPath', prepared.extensionDir, '-TargetUrl', fixture.url,
        '-TimeoutSeconds', '45',
      ], { windowsHide: false })
      extensionInstall = {
        method: 'chrome-developer-mode-ui',
        ui: JSON.parse(installOutput.split(/\r?\n/u).at(-1)),
      }
      extensionId = await waitFor(
        () => discoverExtensionId(chromeProfile, prepared.extensionDir),
        15_000,
        'UI-loaded unpacked extension ID discovery',
      )
    }
    await stopChild(chrome)
    chrome = null

    const launcher = join(appData, 'capturepack-host.cmd')
    const manifestPath = join(appData, 'com.capturepack.host.json')
    writeFileSync(launcher, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${prepared.appExe.path}" "${prepared.nativeHostScript.path}" %*\r\n`, 'utf8')
    writeJson(manifestPath, {
      name: 'com.capturepack.host',
      description: 'CapturePack PR #158 Windows acceptance host',
      path: launcher,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${extensionId}/`],
    })
    command('reg.exe', ['add', hostKey, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'])
    const registered = registrySnapshot()
    if (!registered.exists || normalize(registered.value).toLowerCase() !== normalize(manifestPath).toLowerCase()) throw new Error('Chrome host registration readback failed')

    app = spawn(prepared.appExe.path, [
      `--user-data-dir=${appData}`,
      `--output-dir=${output}`,
      '--openAsHidden',
      '--no-global-shortcut',
      '--no-login-item',
    ], { stdio: 'ignore', env })
    state.pids.push(app.pid)
    writeJson(stateFile, state)
    await waitFor(() => existsSync(logFile) && readFileSync(logFile, 'utf8').includes('DOM bridge listening'), 45_000, 'CapturePack DOM bridge')

    chrome = launchChrome(prepared.chrome, chromeProfile, prepared.extensionDir, fixture.url, env, scenario)
    state.pids.push(chrome.pid)
    writeJson(stateFile, state)
    await waitFor(() => readFileSync(logFile, 'utf8').includes(`[chrome] extension ${prepared.extensionVersion} connected, protocol v1`), 30_000, 'native-host handshake')
    const clickOutput = command('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', join(here, 'windows-chrome-toolbar.ps1'),
      '-Mode', 'ClickAction', '-WindowTitle', fixtureTitle, '-TimeoutSeconds', '30',
    ], { windowsHide: false })
    const click = JSON.parse(clickOutput.split(/\r?\n/u).at(-1))

    const persisted = await waitFor(() => {
      const log = readFileSync(logFile, 'utf8')
      const match = /\[chrome\] full-page capture ([a-zA-Z0-9_-]+) persisted as pack ([^\s]+) \(([^)]+)\):/u.exec(log)
      return match === null ? null : { captureId: match[1], packId: match[2], basename: match[3], log }
    }, 120_000, 'page capture persistence')
    if (!persisted.log.includes(`[chrome] page.capture.start ${persisted.captureId} accepted`)) throw new Error('capture start is not correlated in main.log')
    if (!persisted.log.includes(`[chrome] page.capture.finish ${persisted.captureId} received`)) throw new Error('capture finish is not correlated in main.log')
    await waitFor(() => readFileSync(logFile, 'utf8').includes(`[capture] re-edit editor shown: ${persisted.basename}`), 45_000, 'normal editor visibility log')
    const editorOutput = command('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', join(here, 'windows-chrome-toolbar.ps1'),
      '-Mode', 'FindEditor', '-WindowTitle', 'CapturePack', '-TimeoutSeconds', '30',
    ], { windowsHide: false })
    const editor = JSON.parse(editorOutput.split(/\r?\n/u).at(-1))
    const packDir = join(output, persisted.basename)
    const pack = packEvidence(packDir, fixture.url)
    if (pack.packId !== persisted.packId) throw new Error(`pack identity mismatch: ${pack.packId} != ${persisted.packId}`)
    const hostLaunch = JSON.parse(readFileSync(hostEvidence, 'utf8').trim().split(/\r?\n/u).at(-1))
    if (!hostLaunch.argv.some((arg) => arg === `chrome-extension://${extensionId}/`) || !hostLaunch.argv.some((arg) => arg.startsWith('--parent-window='))) {
      throw new Error('native host launch lacks Chrome origin/parent-window arguments')
    }
    state.hostPids.push(hostLaunch.pid)
    writeJson(stateFile, state)
    verdict = {
      schema: 1,
      status: 'PASS',
      completedAt: new Date().toISOString(),
      runId,
      scenario: scenarioName,
      head: prepared.head,
      chrome: prepared.chrome,
      extensionId,
      extensionVersion: prepared.extensionVersion,
      extensionInstall,
      pipeSuffix: suffix,
      fixtureUrl: fixture.url,
      action: click,
      captureId: persisted.captureId,
      pack,
      hostLaunch,
      editor,
      logLines: persisted.log.split(/\r?\n/u).filter((line) =>
        line.includes('extension ') || line.includes(persisted.captureId) || line.includes(persisted.basename)),
    }
  } catch (error) {
    verdict = { schema: 1, status: 'FAIL', completedAt: new Date().toISOString(), runId, head: prepared.head, error: String(error) }
    throw error
  } finally {
    if (fixture !== null) await new Promise((done) => fixture.server.close(done))
    await stopChild(chrome)
    await stopChild(app)
    let cleanupResult
    try { cleanupResult = await cleanup(artifacts, state, registryBefore) }
    catch (error) { cleanupResult = { registryRestored: false, pathsRemoved: false, errors: [String(error)] }; if (verdict?.status === 'PASS') verdict.status = 'FAIL' }
    verdict = { ...(verdict ?? { schema: 1, status: 'FAIL', runId }), cleanup: cleanupResult }
    writeJson(join(artifacts, `acceptance-${runId}.json`), verdict)
    if (cleanupResult.errors.length > 0) process.exitCode = 1
  }
}

async function main() {
  const mode = process.argv.includes('--prepare') ? 'prepare' : process.argv.includes('--run') ? 'run' : process.argv.includes('--cleanup') ? 'cleanup' : null
  if (mode === null) throw new Error('choose exactly one of --prepare, --run, or --cleanup')
  const artifacts = resolve(option('artifacts', join(core, 'release', `windows-chrome-${Date.now()}`)))
  if (!ownedPath(artifacts, core) && !ownedPath(artifacts, process.env['TEMP'] ?? core)) {
    throw new Error('artifacts must be inside core or the current TEMP directory')
  }
  if (mode === 'prepare') await prepare(artifacts)
  else if (mode === 'run') await run(artifacts)
  else {
    const state = JSON.parse(readFileSync(join(artifacts, 'run-state.json'), 'utf8'))
    const registryBefore = JSON.parse(readFileSync(join(artifacts, 'registry-before.json'), 'utf8'))
    console.log(JSON.stringify(await cleanup(artifacts, state, registryBefore), null, 2))
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
