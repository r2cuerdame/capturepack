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
  symlinkSync,
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
  archivePackPrefix,
  capturePackKindAt,
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

// #521: the twin is renamed, trashed and counted with its folder, so a name
// alone must never make a user's file into one.
console.log('ARCHIVE TWIN IS A PACK, NOT A NAME (#521)')
const twinRoot = dir('twin-identity', {})
const twinFolder = (name: string): string =>
  dir(path.join('twin-identity', name), { 'manifest.json': packManifest(name.toLowerCase()) })
const photoDir = twinFolder('Photos')
const photoZip = zipAt(path.join(twinRoot, 'Photos.zip'), { 'IMG_0001.jpg': 'p'.repeat(2048) })
const foreignDir = twinFolder('Foreign')
const foreignZip = zipAt(path.join(twinRoot, 'Foreign.zip'), {
  'manifest.json': JSON.stringify({ name: 'left-pad', version: '1.0.0' }),
})
const textDir = twinFolder('Notes')
const textZip = path.join(twinRoot, 'Notes.capturepack')
writeFileSync(textZip, 'plain text, not an archive at all')
const folderDir = twinFolder('Shelf')
const folderTwin = path.join(twinRoot, 'Shelf.zip')
mkdirSync(folderTwin)
writeFileSync(path.join(folderTwin, 'keep.txt'), 'a folder that only looks like an archive')
const legacyDir = twinFolder('Legacy')
const legacyPhotoZip = zipAt(path.join(twinRoot, 'Legacy.zip'), { 'IMG_0002.jpg': 'q'.repeat(1024) })
const legacyTwin = zipAt(path.join(twinRoot, 'Legacy.CapturePack'), { 'manifest.json': packManifest('legacy') })
const realDir = twinFolder('Real')
const realTwin = zipAt(path.join(twinRoot, 'Real.ZIP'), { 'manifest.json': packManifest('real') })
const shareStemDir = twinFolder('Owner.share')
zipAt(path.join(twinRoot, 'Owner.share.zip'), { 'share.json': shareInventory })

checkLive(siblingArchive(photoDir) === null, 'a photo zip with the folder\'s name is not its twin')
checkLive(siblingArchive(foreignDir) === null, 'a zip whose manifest.json names another format is not a twin')
checkLive(siblingArchive(textDir) === null, 'a plain file ending .capturepack is not a twin')
checkLive(siblingArchive(folderDir) === null, 'a FOLDER named {pack}.zip is not a twin')
checkLive(siblingArchive(shareStemDir) === null, 'a Share Copy under {pack}.zip is not the twin of a folder named {pack}')
checkLive(
  siblingArchive(legacyDir) === legacyTwin,
  `a stray Legacy.zip does not hide the real Legacy.CapturePack — got ${String(siblingArchive(legacyDir))}`,
)
checkLive(
  siblingArchive(`${legacyDir}${path.sep}`) === legacyTwin && siblingArchive(`${legacyDir}/`) === legacyTwin,
  'a trailing separator on the folder path finds the same twin',
)
checkLive(
  archiveSuffix(siblingArchive(legacyDir) ?? '') === '.CapturePack' &&
    archiveSuffix(siblingArchive(realDir) ?? '') === '.ZIP',
  'the twin path carries its on-disk suffix case, so a rename keeps .CapturePack / .ZIP',
)
checkLive(siblingArchive(realDir) === realTwin, 'a real upper-case .ZIP pack archive is still the twin')

const twinBytesBefore = new Map(
  [photoZip, foreignZip, textZip, legacyPhotoZip].map((f) => [f, readFileSync(f)] as const),
)
const twinSettings = { ...usageSettings, outputDir: twinRoot } as unknown as Settings
invalidateStorageUsage()
const twinUsage = storageUsage(twinSettings)
invalidateStorageUsage()
const beforeTwinRepeat = archiveIdentityReadCount()
const twinUsageAgain = storageUsage(twinSettings)
const sizeOf = (f: string): number => statSync(f).size
const userFileBytes = sizeOf(photoZip) + sizeOf(foreignZip) + sizeOf(textZip) + sizeOf(legacyPhotoZip)
checkLive(
  twinUsage.totalPacks === 7,
  `storage counts the seven pack folders and no user archive as a pack (${twinUsage.totalPacks})`,
)
// The only companions storage may add are the two real twins.
const folderBytes = [photoDir, foreignDir, textDir, folderDir, legacyDir, realDir, shareStemDir]
  .map((d) => sizeOf(path.join(d, 'manifest.json')))
  .reduce((a, b) => a + b, 0)
checkLive(
  twinUsage.totalBytes === folderBytes + sizeOf(legacyTwin) + sizeOf(realTwin),
  `storage adds only the real twins, never the ${userFileBytes} bytes of user files ` +
    `(${twinUsage.totalBytes} vs ${folderBytes + sizeOf(legacyTwin) + sizeOf(realTwin)})`,
)
checkLive(
  twinUsageAgain.totalBytes === twinUsage.totalBytes && archiveIdentityReadCount() === beforeTwinRepeat,
  `recomputing storage beside unchanged user archives reads no archive (${archiveIdentityReadCount() - beforeTwinRepeat} reads)`,
)
const beforeTwinProbe = archiveIdentityReadCount()
for (const d of [photoDir, foreignDir, textDir, folderDir, legacyDir, realDir]) siblingArchive(d)
checkLive(
  archiveIdentityReadCount() === beforeTwinProbe,
  `repeated twin probes read no unchanged archive (${archiveIdentityReadCount() - beforeTwinProbe} reads)`,
)
checkLive(
  [...twinBytesBefore].every(([f, bytes]) => readFileSync(f).equals(bytes)) &&
    statSync(folderTwin).isDirectory(),
  'every user file and folder beside a pack is still in place with its contents',
)

// #525: an absolute path handed to MCP skips the scan, so it has to prove it
// is a pack before anything is read from it — and a refusal, or a pinned pack
// replaced by something else, must never leave a stranger's path pinned.
console.log('ABSOLUTE PATHS OPEN ONLY CAPTUREPACKS (#525)')
const prefixCases: Array<{ names: string[]; want: string | null; why: string }> = [
  { names: ['manifest.json', 'snapshot.png'], want: '', why: 'root manifest' },
  { names: ['Top/', 'Top/manifest.json', 'Top/snapshot.png'], want: 'Top/', why: 'single wrapping folder' },
  { names: ['Top\\manifest.json', 'Top\\snapshot.png'], want: 'Top/', why: 'backslash entry names' },
  { names: ['README.md', 'examples/pack/manifest.json'], want: null, why: 'nested example beside a root file' },
  { names: ['A/manifest.json', 'B/notes.txt'], want: null, why: 'two top-level folders' },
  { names: ['outer/inner/manifest.json'], want: null, why: 'manifest two folders deep' },
  { names: ['IMG_0001.jpg'], want: null, why: 'no manifest' },
  { names: [], want: null, why: 'empty archive' },
]
for (const pc of prefixCases) {
  const got = archivePackPrefix(pc.names)
  checkLive(got === pc.want, `archivePackPrefix: ${pc.why} -> ${String(got)} (want ${String(pc.want)})`)
}

const absOut = dir('abs-output', {})
const absAway = dir('abs-elsewhere', {})
const absNow = Math.floor(Date.now() / 1000) * 1000
const ageTo = (target: string, agoMs: number): void => {
  const when = new Date(absNow - agoMs)
  utimesSync(target, when, when)
}
const SECRET = 'user-content-525-must-not-be-read'
const realPack = (rel: string, id: string): string =>
  dir(rel, { 'manifest.json': packManifest(id), 'snapshot.png': `png-${id}` })
const newestPack = realPack(path.join('abs-output', 'Newest'), 'newest')
ageTo(newestPack, 10_000)
const olderPack = realPack(path.join('abs-output', 'Older'), 'older')
ageTo(olderPack, 60_000)
const insideWrapped = zipAt(path.join(absOut, 'InsideWrapped.zip'), {
  'InsideWrapped/manifest.json': packManifest('inside-wrapped'),
  'InsideWrapped/snapshot.png': 'png-inside-wrapped',
})
ageTo(insideWrapped, 120_000)
const writeText = (file: string, body: string): string => {
  writeFileSync(file, body)
  return file
}

const rejected: Array<{ name: string; p: string }> = [
  { name: 'an ordinary folder', p: dir(path.join('abs-elsewhere', 'Plain'), { 'readme.txt': SECRET }) },
  {
    name: 'an ordinary folder inside the output folder',
    p: dir(path.join('abs-output', 'Notes'), { 'readme.txt': SECRET }),
  },
  {
    name: "a folder holding another program's manifest.json and plugins/",
    p: (() => {
      const other = dir(path.join('abs-elsewhere', 'OtherApp'), {
        'manifest.json': JSON.stringify({ name: 'other-app', version: '2.0.0', note: SECRET }),
      })
      dir(path.join('abs-elsewhere', 'OtherApp', 'plugins', 'sync'), { 'config.json': SECRET })
      return other
    })(),
  },
  {
    name: 'a Share Copy (.share.zip)',
    p: zipAt(path.join(absAway, 'Owner.share.zip'), { 'share.json': shareInventory, 'viewer.html': SECRET }),
  },
  { name: 'a photo zip', p: zipAt(path.join(absAway, 'Holiday.zip'), { 'IMG_0001.jpg': SECRET }) },
  { name: 'a photo zip inside the output folder', p: zipAt(path.join(absOut, 'Album.zip'), { 'IMG_0002.jpg': SECRET }) },
  {
    name: "another program's archive with manifest.json and plugins/",
    p: zipAt(path.join(absAway, 'OtherApp.capturepack'), {
      'manifest.json': JSON.stringify({ name: 'other-app', note: SECRET }),
      'plugins/sync/config.json': SECRET,
    }),
  },
  {
    name: 'a zip whose capture manifest is only in a nested example folder',
    p: zipAt(path.join(absAway, 'Project.zip'), {
      'README.md': SECRET,
      'examples/pack/manifest.json': packManifest('example'),
    }),
  },
  {
    name: 'a zip whose capture manifest is two folders deep',
    p: zipAt(path.join(absAway, 'Deep.zip'), {
      'outer/inner/manifest.json': packManifest('deep'),
      'outer/inner/snapshot.png': SECRET,
    }),
  },
  { name: 'a plain text document', p: writeText(path.join(absAway, 'notes.txt'), SECRET) },
  { name: 'a text file named .capturepack', p: writeText(path.join(absAway, 'Fake.capturepack'), SECRET) },
  {
    name: 'a capture archive carrying a document suffix',
    p: zipAt(path.join(absAway, 'Disguised.txt'), { 'manifest.json': packManifest('disguised'), 'snapshot.png': SECRET }),
  },
  {
    name: 'a link to a real pack folder',
    p: (() => {
      const link = path.join(absAway, 'LinkedPack')
      symlinkSync(olderPack, link, 'junction')
      return link
    })(),
  },
]
const rejectedBytes = new Map(
  rejected.filter((r) => statSync(r.p).isFile()).map((r) => [r.p, readFileSync(r.p)] as const),
)

const absStore = createPackStore({ outputDir: absOut, watch: false })
const messageOf = (fn: () => unknown): string => {
  try {
    fn()
    return ''
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}
const pinnedOlder = absStore.open(olderPack)
checkLive(
  pinnedOlder.manifest()?.id === 'older' && absStore.pinnedPath() === olderPack,
  'a real capture opened by absolute path is pinned',
)
for (const r of rejected) {
  const openErr = messageOf(() => absStore.open(r.p))
  const resolveErr = messageOf(() => absStore.resolve(r.p))
  checkLive(capturePackKindAt(r.p) === null, `${r.name} is not a CapturePack`)
  checkLive(
    openErr.includes('not a CapturePack') && resolveErr.includes('not a CapturePack') && !openErr.includes(SECRET),
    `open and resolve refuse ${r.name} without echoing its contents`,
  )
  checkLive(
    absStore.pinnedPath() === olderPack && absStore.resolve().manifest()?.id === 'older',
    `refusing ${r.name} keeps the previously pinned capture`,
  )
}
checkLive(
  messageOf(() => absStore.open(path.join(absAway, 'missing-pack'))).startsWith('No pack matches') &&
    absStore.pinnedPath() === olderPack,
  'a path that does not exist is refused and keeps the pin',
)
checkLive(
  [...rejectedBytes].every(([f, bytes]) => readFileSync(f).equals(bytes)) &&
    rejected.every((r) => statSync(r.p) !== undefined),
  'every refused file and folder is still in place, unchanged',
)

const outsideDir = realPack(path.join('abs-elsewhere', 'OutsidePack'), 'outside-dir')
const outsideZip = zipAt(path.join(absAway, 'OutsideRoot.zip'), {
  'manifest.json': packManifest('outside-zip'),
  'snapshot.png': 'png-outside-zip',
})
const outsideLegacy = zipAt(path.join(absAway, 'OutsideLegacy.CapturePack'), {
  'manifest.json': packManifest('outside-legacy'),
  'snapshot.png': 'png-outside-legacy',
})
const outsideWrapped = zipAt(path.join(absAway, 'OutsideWrapped.zip'), {
  'OutsideWrapped/manifest.json': packManifest('outside-wrapped'),
  'OutsideWrapped/snapshot.png': 'png-outside-wrapped',
  'OutsideWrapped/plugins/demo/data.json': '{}',
})
const accepted: Array<{ name: string; p: string; id: string; kind: 'dir' | 'zip' }> = [
  { name: 'pack folder in the output folder', p: newestPack, id: 'newest', kind: 'dir' },
  { name: 'wrapped pack archive in the output folder', p: insideWrapped, id: 'inside-wrapped', kind: 'zip' },
  { name: 'pack folder elsewhere', p: outsideDir, id: 'outside-dir', kind: 'dir' },
  { name: 'pack .zip elsewhere', p: outsideZip, id: 'outside-zip', kind: 'zip' },
  { name: 'legacy .CapturePack elsewhere', p: outsideLegacy, id: 'outside-legacy', kind: 'zip' },
  { name: 'wrapped pack .zip elsewhere', p: outsideWrapped, id: 'outside-wrapped', kind: 'zip' },
]
for (const a of accepted) {
  const opened = absStore.open(a.p)
  checkLive(
    capturePackKindAt(a.p) === a.kind &&
      opened.kind === a.kind &&
      opened.manifest()?.id === a.id &&
      opened.readText('snapshot.png') === `png-${a.id}` &&
      absStore.pinnedPath() === opened.path &&
      absStore.resolve().manifest()?.id === a.id,
    `${a.name} still opens by absolute path and pins`,
  )
}
const wrappedHandle = absStore.open(outsideWrapped)
checkLive(
  sameMembers(wrappedHandle.listFiles(), ['manifest.json', 'snapshot.png', 'plugins/demo/data.json']) &&
    wrappedHandle.plugins().some((p) => p.name === 'demo'),
  'a wrapped archive reads from inside its single top-level folder',
)
const projectHandle = absStore.readEntry?.({ id: 'Project', path: path.join(absAway, 'Project.zip'), kind: 'zip' })
checkLive(
  projectHandle !== undefined && projectHandle.manifest() === null,
  'the archive reader no longer roots a pack at a nested example manifest',
)

// A pin whose path stops being a pack is released to the newest capture.
const swapPath = path.join(absAway, 'Swap')
const swapCases: Array<{ name: string; make: () => string; replace: () => void }> = [
  {
    name: 'pack folder replaced by an ordinary folder',
    make: () => realPack(path.join('abs-elsewhere', 'Swap'), 'swap'),
    replace: () => {
      rmSync(swapPath, { recursive: true })
      dir(path.join('abs-elsewhere', 'Swap'), { 'readme.txt': SECRET })
    },
  },
  {
    name: "pack folder replaced by another program's manifest folder",
    make: () => realPack(path.join('abs-elsewhere', 'Swap'), 'swap'),
    replace: () => {
      rmSync(swapPath, { recursive: true })
      dir(path.join('abs-elsewhere', 'Swap'), { 'manifest.json': JSON.stringify({ name: 'other', note: SECRET }) })
    },
  },
  {
    name: 'pack folder replaced by a plain file of the same name',
    make: () => realPack(path.join('abs-elsewhere', 'Swap'), 'swap'),
    replace: () => {
      rmSync(swapPath, { recursive: true })
      writeFileSync(swapPath, SECRET)
    },
  },
  {
    name: 'pack archive replaced by a photo zip',
    make: () => zipAt(path.join(absAway, 'Swap.zip'), { 'manifest.json': packManifest('swap'), 'snapshot.png': 'p' }),
    replace: () => {
      rmSync(path.join(absAway, 'Swap.zip'))
      zipAt(path.join(absAway, 'Swap.zip'), { 'IMG_0001.jpg': SECRET })
    },
  },
  {
    name: 'pack archive replaced by a folder of the same name',
    make: () => zipAt(path.join(absAway, 'Swap.zip'), { 'manifest.json': packManifest('swap'), 'snapshot.png': 'p' }),
    replace: () => {
      rmSync(path.join(absAway, 'Swap.zip'), { recursive: true })
      dir(path.join('abs-elsewhere', 'Swap.zip'), { 'manifest.json': JSON.stringify({ name: 'other' }) })
    },
  },
]
for (const sc of swapCases) {
  rmSync(swapPath, { recursive: true, force: true })
  rmSync(path.join(absAway, 'Swap.zip'), { recursive: true, force: true })
  const pinned = absStore.open(sc.make())
  const pinnedOk = pinned.manifest()?.id === 'swap' && absStore.resolve().manifest()?.id === 'swap'
  sc.replace()
  const after = absStore.resolve()
  checkLive(
    pinnedOk && after.manifest()?.id === 'newest' && absStore.pinnedPath() === null,
    `${sc.name}: the pin is released and the newest capture answers`,
  )
}

// The same inside the output folder, while a watched index still lists it.
const doomed = realPack(path.join('abs-output', 'Doomed'), 'doomed')
ageTo(doomed, 30_000)
const watchedAbs = createPackStore({ outputDir: absOut, watch: true })
const doomedEntries = watchedAbs.entries()
const doomedPinnedId = watchedAbs.open(doomed).manifest()?.id
rmSync(doomed, { recursive: true })
dir(path.join('abs-output', 'Doomed'), { 'readme.txt': SECRET })
const afterDoomed = watchedAbs.resolve()
checkLive(
  doomedEntries.some((e) => e.path === doomed) &&
    doomedPinnedId === 'doomed' &&
    afterDoomed.manifest()?.id === 'newest' &&
    watchedAbs.pinnedPath() === null,
  'an indexed pin replaced by an ordinary folder is released even before the watcher rescans',
)
watchedAbs.dispose()
absStore.dispose()

// And across an output-folder change, the pin is restored only if still a pack.
const absOther = dir('abs-other-output', {})
realPack(path.join('abs-other-output', 'OtherNewest'), 'other-newest')
let liveAbsDir = absOut
const liveAbs = createLivePackStore(() => ({ outputDir: liveAbsDir, watch: false }))
const livePin = realPack(path.join('abs-elsewhere', 'LivePin'), 'live-pin')
liveAbs.current().open(livePin)
rmSync(livePin, { recursive: true })
dir(path.join('abs-elsewhere', 'LivePin'), { 'readme.txt': SECRET })
liveAbsDir = absOther
const afterLiveMove = liveAbs.current().resolve()
checkLive(
  afterLiveMove.manifest()?.id === 'other-newest' && liveAbs.current().pinnedPath() === null,
  'a pin replaced by an ordinary folder is not restored after the output folder changes',
)
liveAbs.current().open(outsideWrapped)
liveAbsDir = absOut
checkLive(
  liveAbs.current().resolve().manifest()?.id === 'outside-wrapped',
  'a wrapped pack archive pin is restored after the output folder changes',
)
liveAbs.dispose()

rmSync(root, { recursive: true, force: true })
console.log(failed === 0 ? '\npack-identity-check ok' : `\npack-identity-check FAILED (${failed})`)
process.exitCode = failed === 0 ? 0 : 1

function checkLive(ok: boolean, line: string): void {
  if (!ok) failed += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${line}`)
}
