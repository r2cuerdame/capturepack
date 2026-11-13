// A NAME IS NOT AN IDENTITY, AND THIS LIST FEEDS A DELETE (#111).
//
// Settings > Capture's "delete older than N days" trashes whatever
// listStoredPacks() returned. It used to return any directory holding a file
// called manifest.json and any file named *.zip — so pointing the output folder
// at Downloads or the Desktop put every unrelated archive, and every npm /
// Electron / Rust project folder, one confirmation away from the Recycle Bin.
//
// Run: npm run check:identity
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { directoryHoldsCapturePack, manifestNamesCapturePack } from '../src/shared/packIdentity'
import { createLivePackStore } from '../src/main/mcp/store'
import { archiveStem, archiveSuffix, hasOtherSiblingArchive } from '../src/main/packArchive'

const root = mkdtempSync(path.join(tmpdir(), 'capturepack-identity-'))
const cases: { name: string; build: () => string; pack: boolean }[] = []

const dir = (name: string, files: Record<string, string>): string => {
  const full = path.join(root, name)
  mkdirSync(full, { recursive: true })
  for (const [f, body] of Object.entries(files)) writeFileSync(path.join(full, f), body)
  return full
}

cases.push({
  name: 'a real pack folder',
  build: () => dir('pack', { 'manifest.json': JSON.stringify({ format: 'capturepack', format_version: '0.2.0' }) }),
  pack: true,
})
cases.push({
  name: 'a pack folder whose manifest has a BOM',
  build: () => dir('bom', { 'manifest.json': '\uFEFF' + JSON.stringify({ format: 'capturepack' }) }),
  pack: true,
})
cases.push({
  name: 'an npm project (manifest.json, not ours)',
  build: () => dir('npm-proj', { 'manifest.json': JSON.stringify({ name: 'my-app', version: '1.0.0' }) }),
  pack: false,
})
cases.push({
  name: 'a web app manifest',
  build: () => dir('webapp', { 'manifest.json': JSON.stringify({ short_name: 'App', icons: [] }) }),
  pack: false,
})
cases.push({
  name: 'manifest.json that is a DIRECTORY',
  build: () => {
    const full = path.join(root, 'weird')
    mkdirSync(path.join(full, 'manifest.json'), { recursive: true })
    return full
  },
  pack: false,
})
cases.push({
  name: 'manifest.json that is not JSON at all',
  build: () => dir('garbage', { 'manifest.json': 'not json {{{' }),
  pack: false,
})
cases.push({ name: 'a folder with no manifest', build: () => dir('empty', { 'readme.txt': 'hi' }), pack: false })

let failed = 0
console.log('FOLDERS')
for (const c of cases) {
  const got = directoryHoldsCapturePack(c.build())
  const ok = got === c.pack
  if (!ok) failed += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.name} — counted as a pack: ${got} (want ${c.pack})`)
}

// The same question of an archive, through the manifest text the zip holds.
const zipCase = (name: string, entries: Record<string, string> | null, want: boolean): void => {
  const p = path.join(root, `${name}.zip`)
  const zip = new AdmZip()
  if (entries !== null) for (const [n, body] of Object.entries(entries)) zip.addFile(n, Buffer.from(body, 'utf8'))
  zip.writeZip(p)
  const entry = new AdmZip(p).getEntry('manifest.json')
  const got = entry !== null && !entry.isDirectory && manifestNamesCapturePack(entry.getData().toString('utf8'))
  const ok = got === want
  if (!ok) failed += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — counted as a pack: ${got} (want ${want})`)
}
console.log('ARCHIVES')
zipCase('real-pack', { 'manifest.json': JSON.stringify({ format: 'capturepack' }) }, true)
zipCase('holiday-photos', { 'IMG_0001.jpg': 'x' }, false)
zipCase('some-node-module', { 'manifest.json': JSON.stringify({ name: 'left-pad' }) }, false)
zipCase('capturepack-share', {
  'share.json': JSON.stringify({ format: 'capturepack-share', format_version: '0.1.0' }),
  'viewer.html': '<p>reviewed derived media</p>',
}, false)

console.log('LIVE MCP OUTPUT FOLDER')
const outA = dir('output-a', {})
const outB = dir('output-b', {})
dir(path.join('output-a', 'CapturePack_A'), {
  'manifest.json': JSON.stringify({
    format: 'capturepack',
    format_version: '0.2.1',
    id: 'a',
    created_at: '2026-07-29T10:00:00Z',
  }),
  'snapshot.png': 'a',
})
dir(path.join('output-b', 'CapturePack_B'), {
  'manifest.json': JSON.stringify({
    format: 'capturepack',
    format_version: '0.2.1',
    id: 'b',
    created_at: '2026-07-29T11:00:00Z',
  }),
  'snapshot.png': 'b',
})
let liveOutputDir = outA
let liveWatch = false
const liveStore = createLivePackStore(() => ({ outputDir: liveOutputDir, watch: liveWatch }))
const first = liveStore.current().latest()
checkLive(first.path.startsWith(outA), `latest starts in the configured folder — ${first.path}`)
const beforeWatchToggle = liveStore.current()
liveWatch = true
const afterWatchToggle = liveStore.current()
checkLive(
  beforeWatchToggle === afterWatchToggle,
  'watch toggle keeps the same store/index instance',
)
checkLive(
  afterWatchToggle.resolve().path === first.path,
  'watch toggle preserves the explicitly pinned pack',
)
liveOutputDir = outB
const movedStore = liveStore.current()
checkLive(
  movedStore.resolve().path === first.path,
  'output-folder change preserves an explicit current-pack pin',
)
const second = movedStore.latest()
checkLive(second.path.startsWith(outB), `next request follows a changed folder — ${second.path}`)
liveStore.dispose()

console.log('ARCHIVE SUFFIX, STEM & SIBLING COLLISIONS')
const suffixCases: Array<{ file: string; suffix: string | null; stem: string }> = [
  { file: 'Demo.zip', suffix: '.zip', stem: 'Demo' },
  { file: 'Demo.ZIP', suffix: '.ZIP', stem: 'Demo' },
  { file: 'Demo.ZiP', suffix: '.ZiP', stem: 'Demo' },
  { file: 'Demo.capturepack', suffix: '.capturepack', stem: 'Demo' },
  { file: 'Demo.CapturePack', suffix: '.CapturePack', stem: 'Demo' },
  { file: 'Demo.CAPTUREPACK', suffix: '.CAPTUREPACK', stem: 'Demo' },
  { file: 'Dotted.Name.CapturePack', suffix: '.CapturePack', stem: 'Dotted.Name' },
  { file: '.ZIP', suffix: null, stem: '.ZIP' },
  { file: '.CapturePack', suffix: null, stem: '.CapturePack' },
  { file: 'PlainFolder', suffix: null, stem: 'PlainFolder' },
]
for (const sc of suffixCases) {
  const full = path.join(root, 'suffix-probe', sc.file)
  const gotSuffix = archiveSuffix(full)
  const gotStem = archiveStem(full)
  checkLive(
    gotSuffix === sc.suffix && gotStem === sc.stem,
    `${sc.file} -> suffix=${String(gotSuffix)} (want ${String(sc.suffix)}), stem=${gotStem} (want ${sc.stem})`,
  )
}

const siblingRoot = dir('sibling-collisions', {})
const writeArchive = (fileName: string, entries: Record<string, string>): string => {
  const target = path.join(siblingRoot, fileName)
  const archive = new AdmZip()
  for (const [entryName, body] of Object.entries(entries)) {
    archive.addFile(entryName, Buffer.from(body, 'utf8'))
  }
  archive.writeZip(target)
  return target
}
const alphaZip = writeArchive('Alpha.zip', {
  'manifest.json': JSON.stringify({ format: 'capturepack', id: 'alpha' }),
})
writeArchive('Beta.CapturePack', {
  'manifest.json': JSON.stringify({ format: 'capturepack', id: 'beta' }),
})
writeArchive('Gamma.ZIP', {
  'manifest.json': JSON.stringify({ format: 'capturepack', id: 'gamma' }),
})
writeArchive('Owner.share.zip', {
  'share.json': JSON.stringify({ format: 'capturepack-share', format_version: '0.1.0' }),
})

checkLive(
  hasOtherSiblingArchive(path.join(siblingRoot, 'Beta'), alphaZip) === true,
  'detects mixed-case .CapturePack sibling archive collision',
)
checkLive(
  hasOtherSiblingArchive(path.join(siblingRoot, 'Gamma'), alphaZip) === true,
  'detects uppercase .ZIP sibling archive collision',
)
checkLive(
  hasOtherSiblingArchive(path.join(siblingRoot, 'Alpha'), alphaZip) === false,
  'ignores the archive itself on same-stem check',
)
checkLive(
  hasOtherSiblingArchive(path.join(siblingRoot, 'ALPHA'), alphaZip) === false,
  'ignores the archive itself on case-only stem check',
)
checkLive(
  hasOtherSiblingArchive(path.join(siblingRoot, 'Owner.share'), alphaZip) === false,
  'ignores validated .share.zip Share Copy when probing Owner.share stem',
)

rmSync(root, { recursive: true, force: true })
console.log(failed === 0 ? '\npack-identity-check ok' : `\npack-identity-check FAILED (${failed})`)
process.exitCode = failed === 0 ? 0 : 1

function checkLive(ok: boolean, line: string): void {
  if (!ok) failed += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${line}`)
}
