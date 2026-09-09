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
import {
  assertProcessesPreserved,
  findProcess,
  processIdentity,
  selectOwnedProcessTrees,
  traceProcessAncestry,
  verifyChromeRoot,
} from './windows-process-provenance.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const core = resolve(here, '..')
const repo = resolve(core, '..')
const hostRegistrySubkey = 'Software\\Google\\Chrome\\NativeMessagingHosts\\com.capturepack.host'
const hostKey = `HKCU\\${hostRegistrySubkey}`
const fixtureTitlePrefix = 'CapturePack Acceptance Fixture'
const scenarios = {
  long: { documentHeight: 7216, markerTop: 2475, windowSize: '1024,720', viewportWidth: [800, 1024], viewportHeight: [450, 720], deviceScaleFactor: null },
  responsive: { documentHeight: 5080, markerTop: 1777, windowSize: '390,844', viewportWidth: [300, 600], viewportHeight: [550, 844], deviceScaleFactor: null },
  'very-tall': { documentHeight: 30016, markerTop: 24000, windowSize: '1024,720', viewportWidth: [800, 1024], viewportHeight: [450, 720], deviceScaleFactor: null },
  dpr2: { documentHeight: 8016, markerTop: 6000, windowSize: '800,600', viewportWidth: [600, 800], viewportHeight: [350, 600], deviceScaleFactor: 2 },
  short: { documentHeight: 400, markerTop: 100, windowSize: '1280,720', viewportWidth: [1000, 1280], viewportHeight: [450, 720], deviceScaleFactor: null },
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

function windowsProcessSnapshot() {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    '  $rows = @(Get-CimInstance Win32_Process | ForEach-Object {',
    '    if ($null -ne $_.CreationDate) {',
    '      [ordered]@{',
    '        pid = [int]$_.ProcessId',
    '        parentPid = [int]$_.ParentProcessId',
    '        name = [string]$_.Name',
    '        executablePath = [string]$_.ExecutablePath',
    '        commandLine = [string]$_.CommandLine',
    "        creationTimeUtc = $_.CreationDate.ToUniversalTime().ToString('o')",
    '      }',
    '    }',
    '  })',
    '  $json = ConvertTo-Json -InputObject @($rows) -Compress -Depth 3',
    '  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))',
    '} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 2 }',
  ].join('\n')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true,
  })
  if (result.status !== 0) {
    throw new Error(`BLOCKED: unable to snapshot Windows process identities safely: ${String(result.stderr || result.error)}`)
  }
  try {
    const parsed = JSON.parse(Buffer.from(String(result.stdout).trim(), 'base64').toString('utf8'))
    if (!Array.isArray(parsed)) throw new Error('process snapshot is not an array')
    return parsed
  } catch (error) {
    throw new Error(`BLOCKED: Windows process snapshot was invalid: ${String(error)}`)
  }
}

function chromeProcesses(processes = windowsProcessSnapshot()) {
  return processes.filter((process) => String(process.name).toLowerCase() === 'chrome.exe')
}

function registrySnapshot(registrySubkey = hostRegistrySubkey) {
  const escapedSubkey = registrySubkey.replace(/'/g, "''")
  const script = [
    "$key = $null",
    "try {",
    `  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${escapedSubkey}', $false)`,
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
  ].join('\n')
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

function restoreRegistry(snapshot, registrySubkey = hostRegistrySubkey) {
  const registryKey = `HKCU\\${registrySubkey}`
  const current = registrySnapshot(registrySubkey)
  if (JSON.stringify(current) === JSON.stringify(snapshot)) return
  if (snapshot.exists) {
    command('reg.exe', ['add', registryKey, '/ve', '/t', snapshot.type, '/d', snapshot.value, '/f'])
  } else if (snapshot.keyExists) {
    if (!current.keyExists) command('reg.exe', ['add', registryKey, '/f'])
    if (registrySnapshot(registrySubkey).exists) command('reg.exe', ['delete', registryKey, '/ve', '/f'])
  } else if (current.keyExists) {
    command('reg.exe', ['delete', registryKey, '/f'])
  }
  const after = registrySnapshot(registrySubkey)
  if (JSON.stringify(after) !== JSON.stringify(snapshot)) {
    throw new Error(`native-host registry restoration mismatch: ${JSON.stringify(after)}`)
  }
}

function probeAbsentRegistryRestore() {
  const registrySubkey = `Software\\CapturePack\\AcceptanceTests\\absent-${String(process.pid)}-${String(Date.now())}`
  const registryKey = `HKCU\\${registrySubkey}`
  const absent = registrySnapshot(registrySubkey)
  if (absent.keyExists) throw new Error('unique absent-key registry probe unexpectedly exists')
  try {
    restoreRegistry(absent, registrySubkey)
    const noOp = registrySnapshot(registrySubkey)
    command('reg.exe', ['add', registryKey, '/ve', '/t', 'REG_SZ', '/d', 'temporary', '/f'])
    restoreRegistry(absent, registrySubkey)
    const restored = registrySnapshot(registrySubkey)
    if (noOp.keyExists || restored.keyExists) throw new Error('absent-key registry restoration left residue')
    return { noOp, restored }
  } finally {
    if (registrySnapshot(registrySubkey).keyExists) command('reg.exe', ['delete', registryKey, '/f'])
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

async function recordSpawnedRoot(child, expectedExecutable, commandFragment) {
  if (!Number.isInteger(child?.pid) || child.pid <= 0) throw new Error('spawned process has no valid PID')
  return waitFor(() => {
    const process = windowsProcessSnapshot().find((candidate) => candidate.pid === child.pid)
    if (process === undefined) return null
    if (normalize(resolve(process.executablePath)).toLowerCase() !== normalize(resolve(expectedExecutable)).toLowerCase()) {
      throw new Error(`spawned PID ${String(child.pid)} executable does not match the owned binary`)
    }
    if (!String(process.commandLine).toLowerCase().includes(normalize(resolve(commandFragment)).toLowerCase())) {
      throw new Error(`spawned PID ${String(child.pid)} command line lacks its owned path`)
    }
    return process
  }, 5_000, `spawned PID ${String(child.pid)} identity`)
}

async function stopOwnedRoot(rootIdentity, protectedChrome) {
  if (rootIdentity === null || rootIdentity === undefined) return { root: null, targets: [] }
  const before = windowsProcessSnapshot()
  const root = findProcess(before, rootIdentity)
  if (root === null) {
    assertProcessesPreserved(protectedChrome, chromeProcesses(before))
    return { root: processIdentity(rootIdentity), targets: [], alreadyExited: true }
  }
  const targets = selectOwnedProcessTrees(before, [root], protectedChrome)
  const killed = spawnSync('taskkill.exe', ['/PID', String(root.pid), '/T', '/F'], {
    encoding: 'utf8', windowsHide: true,
  })
  await waitFor(() => findProcess(windowsProcessSnapshot(), root) === null, 10_000, `owned PID ${String(root.pid)} exit`)
  const after = windowsProcessSnapshot()
  const preserved = assertProcessesPreserved(protectedChrome, chromeProcesses(after))
  return {
    root: processIdentity(root),
    targets: targets.map(processIdentity),
    taskkillStatus: killed.status,
    preExistingChromePreserved: preserved,
  }
}

function discoverExtension(profile, extensionDir) {
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
      if (
        /^[a-p]{32}$/u.test(id) && found === wanted &&
        entry?.location === 4 && entry?.state === 1
      ) {
        return {
          id,
          preferenceFile: name,
          storedPath: entry.path,
          resolvedPath: resolve(entry.path),
          location: entry.location,
          state: entry.state,
          manifestName: entry.manifest?.name ?? null,
          manifestVersion: entry.manifest?.version ?? null,
        }
      }
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

function sameNumber(actual, expected, tolerance = 0.001) {
  return Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= tolerance
}

function packEvidence(packDir, expected) {
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
  const screen = manifest.environment?.screens?.[0]
  const geometry = expected.geometry
  const widthScale = snapshot.width / trigger?.data?.document_width_css
  const heightScale = snapshot.height / trigger?.data?.document_height_css
  if (manifest.capture_kind !== 'image' || manifest.media?.image_scope !== 'fullscreen') throw new Error('pack is not a fullscreen image')
  if (trigger?.data?.source !== 'chrome-full-page' || trigger?.data?.hotkey !== 'chrome.action') throw new Error('timeline does not identify the Chrome action')
  if (
    trigger.data.url !== expected.url || trigger.data.document_width_css !== geometry.documentWidth ||
    trigger.data.document_height_css !== geometry.documentHeight ||
    trigger.data.viewport_width_css !== geometry.viewportWidth ||
    trigger.data.viewport_height_css !== geometry.viewportHeight ||
    !sameNumber(trigger.data.device_scale_factor, geometry.deviceScaleFactor)
  ) throw new Error(`persisted capture geometry differs from the independent fixture report: ${JSON.stringify(trigger.data)}`)
  if (
    !Number.isFinite(widthScale) || !Number.isFinite(heightScale) ||
    Math.abs(widthScale - heightScale) > 0.001 ||
    Math.abs(widthScale - trigger.data.device_scale_factor) > 0.001
  ) throw new Error(`persisted raster/viewport scale mismatch: ${String(widthScale)}x${String(heightScale)} vs DPR ${String(trigger.data.device_scale_factor)}`)
  if (
    snapshot.width !== Math.round(geometry.documentWidth * geometry.deviceScaleFactor) ||
    snapshot.height !== Math.round(geometry.documentHeight * geometry.deviceScaleFactor)
  ) throw new Error('snapshot dimensions do not match the independently reported fixture geometry')
  if (
    screen?.width !== snapshot.width || screen?.height !== snapshot.height ||
    !sameNumber(screen?.scale, geometry.deviceScaleFactor)
  ) throw new Error('manifest screen metadata does not match the persisted full-page raster')
  if (
    documentEvent?.tab?.url !== expected.url || documentEvent?.tab?.title !== expected.title ||
    documentEvent?.document?.url !== expected.url || documentEvent?.document?.title !== expected.title ||
    documentEvent?.document?.truncated !== false || marker === undefined
  ) throw new Error('captured DOM URL/title/completeness/marker does not match the fixture')
  if (
    documentEvent.document.viewport?.width !== geometry.documentWidth ||
    documentEvent.document.viewport?.height !== geometry.documentHeight ||
    !sameNumber(documentEvent.document.viewport?.devicePixelRatio, geometry.deviceScaleFactor) ||
    documentEvent.document.viewport?.scrollX !== 0 || documentEvent.document.viewport?.scrollY !== 0 ||
    !sameNumber(documentEvent.viewport?.width, geometry.documentWidth) ||
    !sameNumber(documentEvent.viewport?.height, geometry.documentHeight) ||
    !sameNumber(documentEvent.viewport?.dpr, geometry.deviceScaleFactor)
  ) throw new Error('persisted DOM document/raster viewport mapping differs from the fixture')
  if (
    marker.bounds?.x !== geometry.marker.x || marker.bounds?.y !== geometry.marker.y ||
    marker.bounds?.width !== geometry.marker.width || marker.bounds?.height !== geometry.marker.height
  ) throw new Error('persisted DOM marker bounds differ from the fixture')
  if (!plugins.includes('chrome-dom') || !plugins.includes('windows-context')) throw new Error('required context plugins are not declared')
  if (!surfaceText.includes('capturepack-browser-page')) throw new Error('reserved browser-page surface is absent')
  return {
    packId: manifest.id,
    directory: packDir,
    captureKind: manifest.capture_kind,
    imageScope: manifest.media.image_scope,
    snapshot,
    rasterScale: { x: widthScale, y: heightScale, reportedDpr: trigger.data.device_scale_factor },
    expectedFixtureGeometry: geometry,
    manifestScreen: screen,
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

async function fixtureServer(scenarioName, scenario, fixtureTitle) {
  let geometry = null
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${fixtureTitle}</title><style>html,body{margin:0;min-width:0}body{position:relative;height:${String(scenario.documentHeight)}px}header{position:sticky;top:0;z-index:2;background:#18222f;color:white;padding:20px}main{position:absolute;left:0;top:0;width:100%;height:${String(scenario.documentHeight)}px;background:linear-gradient(#fff,#7ad)}#acceptance-marker{position:absolute;left:123px;top:${String(scenario.markerTop)}px;width:240px;height:80px;background:#f85}</style></head><body><header>Toolbar gesture acceptance: ${scenarioName}</header><main><button id="acceptance-marker">Deterministic marker</button></main><script>(()=>{const report=()=>{const marker=document.getElementById('acceptance-marker').getBoundingClientRect();const root=document.documentElement;const body=document.body;fetch('/geometry',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scenario:${JSON.stringify(scenarioName)},title:document.title,url:location.href,viewportWidth:innerWidth,viewportHeight:innerHeight,deviceScaleFactor:devicePixelRatio||1,documentWidth:Math.max(root.scrollWidth,body.scrollWidth,innerWidth),documentHeight:Math.max(root.scrollHeight,body.scrollHeight,innerHeight),marker:{x:Math.round(marker.left+scrollX),y:Math.round(marker.top+scrollY),width:Math.round(marker.width),height:Math.round(marker.height)}})}).catch(()=>{})};addEventListener('load',report);addEventListener('resize',report);setTimeout(report,250)})()</script></body></html>`
  const server = http.createServer((request, response) => {
    if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return }
    if (request.url === '/geometry' && request.method === 'POST') {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk) => { if (body.length < 65_536) body += chunk })
      request.on('end', () => {
        try { geometry = JSON.parse(body) } catch { geometry = null }
        response.writeHead(204)
        response.end()
      })
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(html)
  })
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const address = server.address()
  return {
    server,
    url: `http://127.0.0.1:${String(address.port)}/acceptance`,
    geometry: () => geometry,
    resetGeometry: () => { geometry = null },
  }
}

function validateFixtureGeometry(geometry, scenarioName, scenario, fixtureTitle, fixtureUrl) {
  if (
    geometry?.scenario !== scenarioName || geometry?.title !== fixtureTitle || geometry?.url !== fixtureUrl
  ) throw new Error(`fixture identity report mismatch: ${JSON.stringify(geometry)}`)
  if (
    !Number.isInteger(geometry.viewportWidth) ||
    geometry.viewportWidth < scenario.viewportWidth[0] || geometry.viewportWidth > scenario.viewportWidth[1] ||
    !Number.isInteger(geometry.viewportHeight) ||
    geometry.viewportHeight < scenario.viewportHeight[0] || geometry.viewportHeight > scenario.viewportHeight[1]
  ) throw new Error(`fixture viewport is outside the ${scenarioName} acceptance range: ${JSON.stringify(geometry)}`)
  if (
    geometry.documentWidth !== geometry.viewportWidth ||
    geometry.documentHeight !== Math.max(scenario.documentHeight, geometry.viewportHeight)
  ) throw new Error(`fixture document dimensions are not the ${scenarioName} contract: ${JSON.stringify(geometry)}`)
  if (
    !Number.isFinite(geometry.deviceScaleFactor) || geometry.deviceScaleFactor <= 0 ||
    (scenario.deviceScaleFactor !== null && !sameNumber(geometry.deviceScaleFactor, scenario.deviceScaleFactor))
  ) throw new Error(`fixture DPR is not the ${scenarioName} contract: ${JSON.stringify(geometry)}`)
  if (
    geometry.marker?.x !== 123 || geometry.marker?.y !== scenario.markerTop ||
    geometry.marker?.width !== 240 || geometry.marker?.height !== 80
  ) throw new Error(`fixture marker is not the ${scenarioName} contract: ${JSON.stringify(geometry)}`)
  return geometry
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
  const stopped = []
  const protectedChrome = state.preExistingChrome ?? []
  const provenanceStateValid = state.provenanceSchema === 1 &&
    Array.isArray(state.preExistingChrome) && Array.isArray(state.chromeRoots) &&
    Array.isArray(state.appRoots) && Array.isArray(state.hostProcesses)
  if (!provenanceStateValid) {
    errors.push('refusing unsafe cleanup: run-state lacks PID/creation-time provenance')
  } else {
    for (const root of [...state.chromeRoots, ...state.appRoots, ...state.hostProcesses].reverse()) {
      try { stopped.push(await stopOwnedRoot(root, protectedChrome)) } catch (error) { errors.push(String(error)) }
    }
  }
  try { restoreRegistry(registryBefore) } catch (error) { errors.push(String(error)) }
  if (errors.length === 0) {
    for (const candidate of [state.chromeProfile, state.appData, state.transient]) {
      if (!candidate || !existsSync(candidate)) continue
      try { removeOwned(candidate, artifacts) } catch (error) { errors.push(String(error)) }
    }
  }
  let preExistingChromePreserved = []
  try { preExistingChromePreserved = assertProcessesPreserved(protectedChrome, chromeProcesses()) } catch (error) { errors.push(String(error)) }
  const preExistingChromeBefore = protectedChrome.map(processIdentity)
  const preExistingChromeExact = JSON.stringify(preExistingChromePreserved) === JSON.stringify(preExistingChromeBefore)
  if (!preExistingChromeExact) errors.push('pre-existing Chrome preservation evidence differs from the initial identity set')
  const result = {
    registryRestored: JSON.stringify(registrySnapshot()) === JSON.stringify(registryBefore),
    pathsRemoved: [state.chromeProfile, state.appData, state.transient].filter(Boolean).every((path) => !existsSync(path)),
    stopped,
    preExistingChromeBefore,
    preExistingChromePreserved,
    preExistingChromeExact,
    errors,
  }
  if (!result.registryRestored || !result.pathsRemoved || !result.preExistingChromeExact || errors.length > 0) throw new Error(`cleanup failed: ${JSON.stringify(result)}`)
  return result
}

async function run(artifacts) {
  if (process.platform !== 'win32') throw new Error('headed Chrome acceptance requires Windows')
  if (processExists('LogonUI.exe')) throw new Error('BLOCKED: LogonUI is active; unlock the interactive Windows session')
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
  const preExistingChrome = chromeProcesses()
  if (preExistingChrome.length === 0) {
    throw new Error('BLOCKED: headed acceptance requires an ordinary pre-existing Chrome process to prove preservation')
  }
  const preExistingChromeSnapshotAt = new Date().toISOString()
  const fixtureTitle = `${fixtureTitlePrefix} ${runId}`
  const state = {
    provenanceSchema: 1,
    runId,
    scenario: scenarioName,
    fixtureTitle,
    transient,
    chromeProfile,
    appData,
    output,
    preExistingChromeSnapshotAt,
    preExistingChrome: preExistingChrome.map(processIdentity),
    chromeRoots: [],
    appRoots: [],
    hostProcesses: [],
  }
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
    fixture = await fixtureServer(scenarioName, scenario, fixtureTitle)
    chrome = launchChrome(prepared.chrome, chromeProfile, prepared.extensionDir, fixture.url, env, scenario)
    const installChromeRoot = await waitFor(() => {
      const processes = windowsProcessSnapshot()
      if (!processes.some((process) => process.pid === chrome.pid)) return null
      return verifyChromeRoot(processes, chrome.pid, preExistingChrome, prepared.chrome, chromeProfile)
    }, 5_000, 'install Chrome root identity')
    state.chromeRoots.push(processIdentity(installChromeRoot))
    writeJson(stateFile, state)
    let extension = await waitFor(
      () => discoverExtension(chromeProfile, prepared.extensionDir),
      8_000,
      'command-line unpacked extension discovery',
    ).catch(() => null)
    if (extension === null) {
      const installOutput = command('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', join(here, 'windows-chrome-toolbar.ps1'),
        '-Mode', 'InstallExtension', '-WindowTitle', fixtureTitle,
        '-ExpectedRootPid', String(installChromeRoot.pid),
        '-ExpectedRootCreationTimeUtc', installChromeRoot.creationTimeUtc,
        '-ExtensionPath', prepared.extensionDir, '-TargetUrl', fixture.url,
        '-TimeoutSeconds', '45',
      ], { windowsHide: false })
      extensionInstall = {
        method: 'chrome-developer-mode-ui',
        ui: JSON.parse(installOutput.split(/\r?\n/u).at(-1)),
      }
      extension = await waitFor(
        () => discoverExtension(chromeProfile, prepared.extensionDir),
        15_000,
        'UI-loaded unpacked extension evidence discovery',
      )
    }
    const extensionId = extension.id
    await stopOwnedRoot(installChromeRoot, preExistingChrome)
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
    const appRoot = await recordSpawnedRoot(app, prepared.appExe.path, appData)
    state.appRoots.push(processIdentity(appRoot))
    writeJson(stateFile, state)
    await waitFor(() => existsSync(logFile) && readFileSync(logFile, 'utf8').includes('DOM bridge listening'), 45_000, 'CapturePack DOM bridge')

    fixture.resetGeometry()
    chrome = launchChrome(prepared.chrome, chromeProfile, prepared.extensionDir, fixture.url, env, scenario)
    const captureChromeRoot = await waitFor(() => {
      const processes = windowsProcessSnapshot()
      if (!processes.some((process) => process.pid === chrome.pid)) return null
      return verifyChromeRoot(processes, chrome.pid, preExistingChrome, prepared.chrome, chromeProfile)
    }, 5_000, 'capture Chrome root identity')
    state.chromeRoots.push(processIdentity(captureChromeRoot))
    writeJson(stateFile, state)
    const fixtureGeometry = validateFixtureGeometry(
      await waitFor(() => fixture.geometry(), 10_000, 'independent fixture geometry report'),
      scenarioName,
      scenario,
      fixtureTitle,
      fixture.url,
    )
    await waitFor(() => readFileSync(logFile, 'utf8').includes(`[chrome] extension ${prepared.extensionVersion} connected, protocol v1`), 30_000, 'native-host handshake')
    const hostLaunches = await waitFor(() => {
      if (!existsSync(hostEvidence)) return null
      const launches = readFileSync(hostEvidence, 'utf8').trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line))
      if (launches.length === 0) return null
      const processes = windowsProcessSnapshot()
      return launches.map((launch) => {
        const host = processes.find((process) => process.pid === launch.pid)
        if (host === undefined) throw new Error(`native-host PID ${String(launch.pid)} exited before provenance inspection`)
        if (host.parentPid !== launch.ppid) throw new Error(`native-host PID ${String(launch.pid)} parent identity changed`)
        const ancestry = traceProcessAncestry(processes, host, captureChromeRoot, { strict: true })
        if (!launch.argv.some((arg) => arg === `chrome-extension://${extensionId}/`) || !launch.argv.some((arg) => arg.startsWith('--parent-window='))) {
          throw new Error('native host launch lacks Chrome origin/parent-window arguments')
        }
        return { ...launch, process: processIdentity(host), ancestry: ancestry.map(processIdentity) }
      })
    }, 10_000, 'native-host process ancestry')
    state.hostProcesses = hostLaunches.map((launch) => launch.process)
    writeJson(stateFile, state)
    const clickOutput = command('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', join(here, 'windows-chrome-toolbar.ps1'),
      '-Mode', 'ClickAction', '-WindowTitle', fixtureTitle, '-TimeoutSeconds', '30',
      '-ExpectedRootPid', String(captureChromeRoot.pid),
      '-ExpectedRootCreationTimeUtc', captureChromeRoot.creationTimeUtc,
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
      '-ExpectedRootPid', String(appRoot.pid),
      '-ExpectedRootCreationTimeUtc', appRoot.creationTimeUtc,
    ], { windowsHide: false })
    const editor = JSON.parse(editorOutput.split(/\r?\n/u).at(-1))
    if (
      editor.offscreen !== false || !Number.isInteger(editor.width) || editor.width <= 0 ||
      !Number.isInteger(editor.height) || editor.height <= 0
    ) throw new Error(`normal editor is not visibly rendered on screen: ${JSON.stringify(editor)}`)
    const packDir = join(output, persisted.basename)
    const pack = packEvidence(packDir, { url: fixture.url, title: fixtureTitle, geometry: fixtureGeometry })
    if (pack.packId !== persisted.packId) throw new Error(`pack identity mismatch: ${pack.packId} != ${persisted.packId}`)
    const hostLaunch = hostLaunches.at(-1)
    if (!hostLaunch.argv.some((arg) => arg === `chrome-extension://${extensionId}/`) || !hostLaunch.argv.some((arg) => arg.startsWith('--parent-window='))) {
      throw new Error('native host launch lacks Chrome origin/parent-window arguments')
    }
    verdict = {
      schema: 1,
      status: 'PASS',
      completedAt: new Date().toISOString(),
      runId,
      scenario: scenarioName,
      head: prepared.head,
      chrome: prepared.chrome,
      extensionId,
      extension,
      extensionVersion: prepared.extensionVersion,
      extensionInstall,
      pipeSuffix: suffix,
      fixtureTitle,
      fixtureUrl: fixture.url,
      fixtureGeometry,
      preExistingChromeSnapshotAt,
      preExistingChrome: preExistingChrome.map(processIdentity),
      chromeRoot: processIdentity(captureChromeRoot),
      chromeLaunches: state.chromeRoots.map(processIdentity),
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
    let cleanupResult
    try { cleanupResult = await cleanup(artifacts, state, registryBefore) }
    catch (error) { cleanupResult = { registryRestored: false, pathsRemoved: false, errors: [String(error)] }; if (verdict?.status === 'PASS') verdict.status = 'FAIL' }
    verdict = { ...(verdict ?? { schema: 1, status: 'FAIL', runId }), cleanup: cleanupResult }
    writeJson(join(artifacts, `acceptance-${runId}.json`), verdict)
    if (cleanupResult.errors.length > 0) process.exitCode = 1
  }
}

async function main() {
  const mode = process.argv.includes('--prepare') ? 'prepare' : process.argv.includes('--run') ? 'run' : process.argv.includes('--cleanup') ? 'cleanup' : process.argv.includes('--probe-registry') ? 'probe-registry' : process.argv.includes('--probe-registry-restore-absent') ? 'probe-registry-restore-absent' : process.argv.includes('--probe-processes') ? 'probe-processes' : null
  if (mode === null) throw new Error('choose exactly one of --prepare, --run, --cleanup, --probe-registry, --probe-registry-restore-absent, or --probe-processes')
  if (mode === 'probe-registry') {
    console.log(JSON.stringify(registrySnapshot()))
    return
  }
  if (mode === 'probe-registry-restore-absent') {
    console.log(JSON.stringify(probeAbsentRegistryRestore()))
    return
  }
  if (mode === 'probe-processes') {
    const processes = windowsProcessSnapshot()
    console.log(JSON.stringify({ processCount: processes.length, chrome: chromeProcesses(processes).map(processIdentity) }))
    return
  }
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
