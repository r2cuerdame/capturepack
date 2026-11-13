// A NAME IS NOT AN IDENTITY, AND THIS LIST FEEDS A DELETE (#111).
//
// Settings > Capture's "delete older than N days" trashes whatever
// listStoredPacks() returned. It used to return any directory holding a file
// called manifest.json and any file named *.zip — so pointing the output folder
// at Downloads or the Desktop put every unrelated archive, and every npm /
// Electron / Rust project folder, one confirmation away from the Recycle Bin.
//
// Run: npm run check:identity
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { directoryHoldsCapturePack, manifestNamesCapturePack } from '../src/shared/packIdentity'
import type { Settings } from '../src/shared/types'
import { createLivePackStore, createPackStore } from '../src/main/mcp/store'
import {
  ARCHIVE_IDENTITY_CACHE_LIMIT,
  archiveIdentityCacheSize,
  archiveIdentityReadCount,
  archiveStem,
  archiveSuffix,
  hasOtherSiblingArchive,
  isShareBundleArchive,
  siblingArchive,
  siblingShareBundle,
} from '../src/main/packArchive'
import { invalidateStorageUsage, storageUsage } from '../src/main/storage'

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

// #515: adm-zip reads a whole archive on every open, on the main process. A
// rescan, a History listing and a storage snapshot must not ask an archive
// that has not changed since the last time.
console.log('REMEMBERED ARCHIVE IDENTITY (#515)')
const cacheRoot = dir('identity-cache', {})
const zipAt = (file: string, entries: Record<string, string>): string => {
  const archive = new AdmZip()
  for (const [entryName, body] of Object.entries(entries)) {
    archive.addFile(entryName, Buffer.from(body, 'utf8'))
  }
  archive.writeZip(file)
  return file
}
const packManifest = (id: string): string => JSON.stringify({ format: 'capturepack', id, created_at: '2026-11-13T10:00:00Z' })
const shareInventory = JSON.stringify({ format: 'capturepack-share', format_version: '0.1.0' })
const ownerDir = dir(path.join('identity-cache', 'Owner'), { 'manifest.json': packManifest('owner') })
const ownerShare = zipAt(path.join(cacheRoot, 'Owner.share.zip'), {
  'share.json': shareInventory,
  'viewer.html': '<p>reviewed derived media</p>',
})
// A whole-second mtime, so the in-place rewrite below can restore it exactly.
const shareTime = new Date(Math.floor(Date.now() / 1000) * 1000 - 120_000)
utimesSync(ownerShare, shareTime, shareTime)
const looseZip = zipAt(path.join(cacheRoot, 'Loose.zip'), { 'manifest.json': packManifest('loose') })
const strayZip = zipAt(path.join(cacheRoot, 'Stray.zip'), { 'IMG_0001.jpg': 'x'.repeat(4096) })
const foreignPack = zipAt(path.join(cacheRoot, 'Foreign.zip'), { 'manifest.json': JSON.stringify({ name: 'left-pad' }) })

const sameMembers = (got: string[], want: string[]): boolean =>
  got.length === want.length && [...got].sort().every((p, i) => p === [...want].sort()[i])
const cacheStore = createPackStore({ outputDir: cacheRoot, watch: false })
const firstScanReads = archiveIdentityReadCount()
const firstEntries = cacheStore.entries().map((e) => e.path)
checkLive(
  sameMembers(firstEntries, [ownerDir, looseZip]),
  `pack, share copy and foreign zips keep their identity — indexed ${firstEntries.map((p) => path.basename(p)).join(', ')}`,
)
checkLive(!isShareBundleArchive(looseZip) && !isShareBundleArchive(strayZip) && !isShareBundleArchive(foreignPack),
  'a pack archive, a photo zip and a foreign manifest are not Share Copies')
checkLive(isShareBundleArchive(ownerShare), 'the managed Share Copy is still a Share Copy')
checkLive(
  archiveIdentityReadCount() === firstScanReads,
  `second scan of an unchanged folder reads no archive (${archiveIdentityReadCount() - firstScanReads} reads)`,
)
const beforeSibling = archiveIdentityReadCount()
const shareA = siblingShareBundle(ownerDir)
const shareB = siblingShareBundle(ownerDir)
checkLive(shareA === ownerShare && shareB === ownerShare, 'siblingShareBundle finds the Share Copy')
checkLive(siblingArchive(ownerDir) === null, 'a Share Copy is not the folder\'s full archive twin')
checkLive(
  archiveIdentityReadCount() === beforeSibling,
  `repeated sibling Share Copy probes read no archive (${archiveIdentityReadCount() - beforeSibling} reads)`,
)
const usageSettings = {
  outputDir: cacheRoot,
  storageRetentionDays: 0,
  storageMaxBytes: 0,
  storageEnforceMaxBytes: false,
} as unknown as Settings
const beforeUsage = archiveIdentityReadCount()
const usageA = storageUsage(usageSettings)
invalidateStorageUsage()
const usageB = storageUsage(usageSettings)
checkLive(usageA.totalPacks === 2 && usageB.totalPacks === 2, `storage counts both packs (${usageB.totalPacks})`)
checkLive(
  usageB.totalBytes === usageA.totalBytes && usageB.totalBytes > statSync(ownerShare).size,
  'storage still adds the Share Copy beside its folder',
)
checkLive(
  archiveIdentityReadCount() === beforeUsage,
  `recomputing storage reads no archive (${archiveIdentityReadCount() - beforeUsage} reads)`,
)

// A touched file is asked again — exactly once.
const strayTime = new Date(Date.now() - 60_000)
utimesSync(strayZip, strayTime, strayTime)
const beforeTouch = archiveIdentityReadCount()
cacheStore.entries()
cacheStore.entries()
checkLive(
  archiveIdentityReadCount() === beforeTouch + 1,
  `a changed mtime is re-read once (${archiveIdentityReadCount() - beforeTouch} reads)`,
)

// Same size, same mtime, different contents: the change time still moves.
const shareStat = statSync(ownerShare)
const patched = readFileSync(ownerShare)
let at = patched.indexOf('share.json')
while (at !== -1) {
  patched.write('share.jsoo', at, 'utf8')
  at = patched.indexOf('share.json', at + 1)
}
writeFileSync(ownerShare, patched)
utimesSync(ownerShare, shareTime, shareTime)
const patchedStat = statSync(ownerShare)
checkLive(
  patchedStat.size === shareStat.size && patchedStat.mtimeMs === shareStat.mtimeMs,
  'probe: in-place rewrite kept size and mtime',
)
checkLive(
  siblingShareBundle(ownerDir) === null,
  'an in-place rewrite with the same size and mtime is asked again (no longer a Share Copy)',
)
zipAt(ownerShare, { 'share.json': shareInventory, 'viewer.html': '<p>again</p>' })
checkLive(siblingShareBundle(ownerDir) === ownerShare, 'a restored Share Copy is recognised again')

// A full pack archive renamed over the Share Copy's name is not a Share Copy.
const replacement = zipAt(path.join(root, 'replacement.zip'), { 'manifest.json': packManifest('owner-full') })
renameSync(replacement, ownerShare)
checkLive(siblingShareBundle(ownerDir) === null, 'a full pack ZIP swapped in under .share.zip is no longer a Share Copy')
checkLive(
  hasOtherSiblingArchive(path.join(cacheRoot, 'Owner.share')) === true,
  'and it now occupies the Owner.share stem as a real archive',
)
checkLive(
  cacheStore.entries().some((e) => e.path === ownerShare && e.kind === 'zip'),
  'and the index now lists it as a pack of its own',
)

// Vanished archives take their remembered answer with them.
const beforeDelete = archiveIdentityCacheSize()
rmSync(strayZip)
cacheStore.entries()
checkLive(
  archiveIdentityCacheSize() === beforeDelete - 1,
  `a deleted archive is forgotten on the next scan (${beforeDelete} -> ${archiveIdentityCacheSize()})`,
)
cacheStore.dispose()

// The memory is bounded however many archives a folder holds.
const boundRoot = dir('identity-cache-bound', {})
for (let i = 0; i < ARCHIVE_IDENTITY_CACHE_LIMIT + 24; i += 1) {
  zipAt(path.join(boundRoot, `Other_${String(i).padStart(4, '0')}.zip`), { 'note.txt': String(i) })
}
const boundStore = createPackStore({ outputDir: boundRoot, watch: false })
checkLive(
  archiveIdentityCacheSize() === ARCHIVE_IDENTITY_CACHE_LIMIT,
  `remembered identities stay at the ${ARCHIVE_IDENTITY_CACHE_LIMIT} limit (${archiveIdentityCacheSize()})`,
)
checkLive(boundStore.entries().length === 0, 'none of the bounded-folder zips is a pack')
boundStore.dispose()

console.log('SUBFOLDER, ARCHIVE EXTENSION COLLISIONS & LIVE PIN (#519)')
const collisionRoot = dir('mcp-collisions', {})
const baseEpochMs = Math.floor(Date.now() / 1000) * 1000 - 300_000
const touchAt = (target: string, offsetMs: number): void => {
  const when = new Date(baseEpochMs + offsetMs)
  utimesSync(target, when, when)
}
const writeDirPack = (relPath: string, manifest: Record<string, unknown>, offsetMs: number): string => {
  const full = dir(path.join('mcp-collisions', relPath), {
    'manifest.json': JSON.stringify({ format: 'capturepack', format_version: '0.8.0', created_at: '2026-11-13T08:00:00Z', ...manifest }),
    'snapshot.png': 'png',
  })
  touchAt(full, offsetMs)
  return full
}
const writeZipPack = (relPath: string, manifest: Record<string, unknown>, offsetMs: number): string => {
  const full = path.join(collisionRoot, relPath)
  mkdirSync(path.dirname(full), { recursive: true })
  zipAt(full, {
    'manifest.json': JSON.stringify({ format: 'capturepack', format_version: '0.8.0', created_at: '2026-11-13T08:00:00Z', ...manifest }),
    'snapshot.png': 'png',
  })
  touchAt(full, offsetMs)
  return full
}

const rootBugDir = writeDirPack(
  'BugReport',
  { id: 'bug-root', capture_kind: 'image', title: 'Root image bug', media: { snapshot: 'snapshot.png', image_scope: 'fullscreen' } },
  10_000,
)
const subBugDir = writeDirPack(
  path.join('2026-11-13', 'BugReport'),
  { id: 'bug-sub', capture_kind: 'video', title: 'Subfolder video bug', media: { snapshot: 'snapshot.png', replay: 'replay.mp4', replay_duration_ms: 1000 } },
  90_000,
)
const subOnlyDir = writeDirPack(
  path.join('2026-11-13', 'SubOnly'),
  { id: 'sub-only', capture_kind: 'image', title: 'Subfolder only', media: { snapshot: 'snapshot.png', image_scope: 'fullscreen' } },
  20_000,
)
const demoZip = writeZipPack(
  'Demo.zip',
  { id: 'demo-zip', capture_kind: 'image', title: 'Demo zip', media: { snapshot: 'snapshot.png', image_scope: 'fullscreen' } },
  30_000,
)
const demoCapturepack = writeZipPack(
  'Demo.capturepack',
  { id: 'demo-cap', capture_kind: 'video', title: 'Demo capturepack', media: { snapshot: 'snapshot.png', replay: 'replay.mp4', replay_duration_ms: 1000 } },
  40_000,
)
const demoZipCapturepack = writeZipPack(
  'Demo.zip.capturepack',
  { id: 'demo-zip-cap', capture_kind: 'image', title: 'Demo zip capturepack', media: { snapshot: 'snapshot.png', image_scope: 'fullscreen' } },
  45_000,
)
const demoZipCapturepackZip = writeZipPack(
  'Demo.zip.capturepack.zip',
  { id: 'demo-zip-cap-zip', capture_kind: 'image', title: 'Demo zip capturepack zip', media: { snapshot: 'snapshot.png', image_scope: 'fullscreen' } },
  47_000,
)
const chainZip = writeZipPack(
  'Chain.zip',
  { id: 'chain-zip', capture_kind: 'image', title: 'Chain zip', media: { snapshot: 'snapshot.png', image_scope: 'fullscreen' } },
  48_000,
)
const chainZipCapturepack = writeZipPack(
  'Chain.zip.capturepack',
  { id: 'chain-zip-cap', capture_kind: 'image', title: 'Chain zip capturepack', media: { snapshot: 'snapshot.png', image_scope: 'fullscreen' } },
  49_000,
)
const rootSoloZip = writeZipPack(
  'Solo.zip',
  { id: 'solo-root', capture_kind: 'image', title: 'Solo root', media: { snapshot: 'snapshot.png', image_scope: 'fullscreen' } },
  50_000,
)
const subSoloZip = writeZipPack(
  path.join('2026-11-13', 'Solo.zip'),
  { id: 'solo-sub', capture_kind: 'image', title: 'Solo sub', media: { snapshot: 'snapshot.png', image_scope: 'fullscreen' } },
  80_000,
)
const legacyOnlyCapturepack = writeZipPack(
  'LegacyOnly.capturepack',
  { id: 'legacy-only', capture_kind: 'image', title: 'Legacy only', media: { snapshot: 'snapshot.png', image_scope: 'fullscreen' } },
  60_000,
)
zipAt(path.join(collisionRoot, 'LegacyOnly.zip'), { 'IMG_0001.jpg': 'not-a-pack' })
const nestedDemoZip = writeZipPack(
  path.join('2026-11-13', 'NestedDemo.zip'),
  { id: 'nested-demo-zip', capture_kind: 'image', title: 'Nested zip', media: { snapshot: 'snapshot.png', image_scope: 'fullscreen' } },
  65_000,
)
const nestedDemoCapturepack = writeZipPack(
  path.join('2026-11-13', 'NestedDemo.capturepack'),
  { id: 'nested-demo-cap', capture_kind: 'video', title: 'Nested cap', media: { snapshot: 'snapshot.png', replay: 'replay.mp4', replay_duration_ms: 1000 } },
  70_000,
)

const collisionStore = createPackStore({ outputDir: collisionRoot, watch: false })
const collisionEntries = collisionStore.entries()
const indexedIds = new Set(collisionEntries.map((e) => e.id))
checkLive(
  indexedIds.size === collisionEntries.length &&
    indexedIds.has('BugReport') &&
    indexedIds.has('2026-11-13/BugReport') &&
    indexedIds.has('Demo.zip') &&
    indexedIds.has('Demo.capturepack') &&
    indexedIds.has('Demo.zip.capturepack') &&
    indexedIds.has('Demo.zip.capturepack.zip') &&
    indexedIds.has('Chain') &&
    indexedIds.has('Chain.zip.capturepack') &&
    indexedIds.has('Solo') &&
    indexedIds.has('2026-11-13/Solo') &&
    indexedIds.has('LegacyOnly') &&
    indexedIds.has('2026-11-13/NestedDemo.zip') &&
    indexedIds.has('2026-11-13/NestedDemo.capturepack'),
  `assigns distinct ids to colliding archives and preserves short ids for unique archives — ${[...indexedIds].join(', ')}`,
)
checkLive(
  collisionStore.open('BugReport').path === rootBugDir &&
    collisionStore.resolve('BugReport').path === rootBugDir &&
    collisionStore.open('BugReport').id === 'BugReport',
  'exact root id BugReport beats newer subfolder pack 2026-11-13/BugReport',
)
checkLive(
  collisionStore.open('2026-11-13/BugReport').path === subBugDir &&
    collisionStore.open('2026-11-13\\BugReport').path === subBugDir,
  'explicit subfolder id opens the subfolder pack with forward or back slashes',
)
checkLive(
  collisionStore.open('SubOnly').path === subOnlyDir && collisionStore.open('SubOnly').id === '2026-11-13/SubOnly',
  'plain basename still resolves to the subfolder pack when no root pack shares the name',
)
checkLive(
  collisionStore.open(subBugDir).id === '2026-11-13/BugReport' &&
    collisionStore.resolve(subBugDir).id === '2026-11-13/BugReport' &&
    collisionStore.open(`${subBugDir}${path.sep}`).id === '2026-11-13/BugReport',
  'opening a listed subfolder pack by absolute path keeps its subfolder id',
)
checkLive(
  collisionStore.open('Demo.zip').path === demoZip &&
    collisionStore.open('Demo.capturepack').path === demoCapturepack &&
    collisionStore.open('Demo.zip.capturepack').path === demoZipCapturepack &&
    collisionStore.open('Demo.zip.capturepack.zip').path === demoZipCapturepackZip &&
    collisionStore.open(demoZip).id === 'Demo.zip' &&
    collisionStore.open(demoZipCapturepack).id === 'Demo.zip.capturepack' &&
    collisionStore.open('Chain').path === chainZip &&
    collisionStore.open('Chain.zip').path === chainZip &&
    collisionStore.open('Chain.zip.capturepack').path === chainZipCapturepack &&
    collisionStore.open('2026-11-13/NestedDemo.zip').path === nestedDemoZip &&
    collisionStore.open('2026-11-13/NestedDemo.capturepack').path === nestedDemoCapturepack,
  'colliding .zip, .capturepack, and extension-qualified stem archives open independently in root and subfolders',
)
let ambiguousDemoThrew = false
try {
  collisionStore.open('Demo')
} catch {
  ambiguousDemoThrew = true
}
checkLive(ambiguousDemoThrew, 'unqualified Demo does not silently pick one of two colliding archives')
checkLive(
  collisionStore.open('Solo').path === rootSoloZip &&
    collisionStore.open('Solo.zip').path === rootSoloZip &&
    collisionStore.open('2026-11-13/Solo').path === subSoloZip &&
    collisionStore.open('2026-11-13/Solo.zip').path === subSoloZip &&
    collisionStore.open('LegacyOnly').path === legacyOnlyCapturepack,
  'single archive short ids and output-relative archive paths resolve accurately',
)
collisionStore.dispose()

const watchStore = createPackStore({ outputDir: collisionRoot, watch: true })
const watchFreshSubDir = writeDirPack(
  path.join('2026-11-13', 'WatchFresh'),
  { id: 'watch-fresh', capture_kind: 'image', title: 'Watch fresh', media: { snapshot: 'snapshot.png', image_scope: 'fullscreen' } },
  95_000,
)
checkLive(
  watchStore.open(watchFreshSubDir).id === '2026-11-13/WatchFresh',
  'opening an unindexed subfolder pack inside watched outputDir rescans and keeps subfolder id',
)
watchStore.dispose()

let liveSubDir = collisionRoot
const subLiveStore = createLivePackStore(() => ({ outputDir: liveSubDir, watch: false }))
const pinnedSub = subLiveStore.current().open(subBugDir)
checkLive(pinnedSub.id === '2026-11-13/BugReport', 'live store pin starts with subfolder id')
liveSubDir = outB
const movedSub = subLiveStore.current().resolve()
checkLive(
  movedSub.path === subBugDir && movedSub.id === '2026-11-13/BugReport',
  `output-folder change preserves subfolder id of pinned pack (got ${movedSub.id})`,
)
subLiveStore.dispose()

let parentMoveDir = path.join(collisionRoot, '2026-11-13')
const parentLiveStore = createLivePackStore(() => ({ outputDir: parentMoveDir, watch: false }))
parentLiveStore.current().open(subBugDir)
parentMoveDir = collisionRoot
const repinnedParent = parentLiveStore.current().resolve()
checkLive(
  repinnedParent.path === subBugDir && repinnedParent.id === '2026-11-13/BugReport',
  `moving output folder up re-indexes pinned pack with subfolder id (got ${repinnedParent.id})`,
)
parentLiveStore.dispose()

rmSync(root, { recursive: true, force: true })
console.log(failed === 0 ? '\npack-identity-check ok' : `\npack-identity-check FAILED (${failed})`)
process.exitCode = failed === 0 ? 0 : 1

function checkLive(ok: boolean, line: string): void {
  if (!ok) failed += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${line}`)
}
