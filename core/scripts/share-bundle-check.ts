import AdmZip from 'adm-zip'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { deflateSync, inflateSync } from 'node:zlib'
import {
  createShareBundle,
  planShareBundle,
  ShareBundleError,
} from '../src/main/shareBundle'
import {
  isShareBundleArchive,
  shareBundlePath,
  siblingArchive,
  siblingShareBundle,
} from '../src/main/packArchive'
import { greyPng } from './fixtures/greyPng'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`PASS  ${label}`)
  else {
    failures += 1
    console.error(`FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

const DERIVED_METADATA = 'SECRET_DERIVED_METADATA_9f3a'
const DERIVED_TRAILER = 'SECRET_DERIVED_TRAILER_12c7'
const WEBM = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
  Buffer.from('SECRET_DERIVED_VIDEO_METADATA_76ae'),
])
const CANARIES = [
  'SECRET_RAW_PIXELS_7bc1',
  'SECRET_MANIFEST_ID_42f1',
  'SECRET_MANIFEST_NOTE_3f0a',
  'SECRET_MANIFEST_TITLE_6a2d',
  'SECRET_OS_VERSION_e80d',
  'SECRET_APP_91ee',
  'SECRET_VISIBLE_LABEL_51c4',
  'SECRET_TARGET_URL_29b7',
  'SECRET_TIMELINE_WINDOW_0de3',
  'SECRET_PLUGIN_DOM_84af',
  'SECRET_GENERATED_DOC_1ca0',
  'SECRET_UNDECLARED_ROOT_d511',
  DERIVED_METADATA,
  DERIVED_TRAILER,
  'SECRET_DERIVED_VIDEO_METADATA_76ae',
]

interface Fixture {
  dir: string
  share: string
  files: Map<string, string>
}

async function run(): Promise<void> {
const PNG = withHiddenPngPayload(greyPng(1, 1), DERIVED_METADATA, DERIVED_TRAILER)
const root = mkdtempSync(path.join(tmpdir(), 'capturepack-share-check-'))
try {
  const success = makeFixture('success')
  const before = hashTree(success.dir)
  const plan = await planShareBundle(success.dir)
  check('plan names a distinct .share.zip sibling', plan.outputPath.endsWith('.share.zip'))
  check('the 0.1 writer plans only two reviewed annotated stills',
    plan.entries.length === 2 && plan.entries.every((entry) => entry.kind === 'annotated-still'))
  check('plan reports visible derived labels for local review',
    plan.visibleLabels.includes('SECRET_VISIBLE_LABEL_51c4'))
  check('an empty blur label does not block sharing', plan.blockers.length === 0)

  const created = await createShareBundle(success.dir, plan.revision)
  check('Share Copy is written at the reviewed path', created.zipPath === plan.outputPath && existsSync(plan.outputPath))
  const archive = new AdmZip(plan.outputPath)
  const entries = archive.getEntries()
  const names = entries.map((entry) => entry.entryName).sort()
  const expected = [
    'README.md',
    'media/display-1/annotated-still-01.png',
    'media/display-2/annotated-still-01.png',
    'share.json',
    'viewer.html',
  ].sort()
  check('archive central directory is the exact closed allowlist',
    JSON.stringify(names) === JSON.stringify(expected), names.join(', '))
  check('Share Copy is not a CapturePack and carries no original filenames',
    !names.includes('manifest.json') &&
      !names.some((name) => /(^|\/)(snapshot|replay)(-d[0-9]+)?\.(png|webm|mp4)$/u.test(name)))

  const inflated = entries.map((entry) => entry.getData())
  for (const canary of CANARIES) {
    check(`source canary is absent after inflating every ZIP entry: ${canary}`,
      inflated.every((bytes) => !bytes.includes(Buffer.from(canary, 'utf8'))))
  }
  const shareJson = JSON.parse(archive.getEntry('share.json')!.getData().toString('utf8')) as Record<string, unknown>
  check('share.json declares capturepack-share rather than capturepack',
    shareJson['format'] === 'capturepack-share' && shareJson['profile'] === 'reviewed-stills-only')
  check('every output PNG was reduced to canonical pixel chunks',
    entries
      .filter((entry) => entry.entryName.endsWith('.png'))
      .every((entry) => pngChunkNames(entry.getData()).join(',') === 'IHDR,IDAT,IEND'))
  const viewer = archive.getEntry('viewer.html')!.getData().toString('utf8')
  check('share viewer blocks network and has no script surface',
    viewer.includes("default-src 'none'") &&
      viewer.includes("connect-src 'none'") &&
      !viewer.includes('<script') &&
      !/https?:\/\//u.test(viewer))
  check('creating a Share Copy never mutates the source pack', mapsEqual(before, hashTree(success.dir)))
  check('managed Share Copy identity is content-based',
    isShareBundleArchive(success.share) && siblingShareBundle(success.dir) === success.share)
  check('the same .share.zip is not stolen as another pack folder\'s Full ZIP',
    siblingArchive(`${success.dir}.share`) === null)

  const image = makeImageFixture('image')
  const imagePlan = await planShareBundle(image.dir)
  check('an explicit image capture uses the null/capture lane',
    imagePlan.entries.length === 1 &&
      imagePlan.entries[0]?.display === null &&
      imagePlan.entries[0]?.archivePath === 'media/capture/annotated-still-01.png')
  await createShareBundle(image.dir, imagePlan.revision)
  check('image Share Copy is a valid managed sibling', siblingShareBundle(image.dir) === image.share)

  // Replacement is supported, but is completed through a verified temporary
  // archive rather than by recursively touching the source folder.
  await createShareBundle(success.dir, plan.revision)
  check('a reviewed Share Copy can be replaced', existsSync(success.share))

  const filteredFixturePng = filteredRgbaPng()
  const filtered = makeFixture(
    'png-filters',
    false,
    withHiddenPngPayload(filteredFixturePng.png, DERIVED_METADATA, DERIVED_TRAILER),
  )
  const filteredPlan = await planShareBundle(filtered.dir)
  await createShareBundle(filtered.dir, filteredPlan.revision)
  const filteredOutput = new AdmZip(filtered.share)
    .getEntry('media/display-1/annotated-still-01.png')!
    .getData()
  check('PNG filters 0–4 decode to the same reviewed pixels before canonical re-encoding',
    canonicalRgbaPixels(filteredOutput).equals(filteredFixturePng.pixels))

  const recovery = makeFixture('replacement-recovery')
  const recoveryPlan = await planShareBundle(recovery.dir)
  await createShareBundle(recovery.dir, recoveryPlan.revision)
  renameSync(recovery.share, `${recovery.share}.previous`)
  const staleTemporary =
    `${recovery.share}.tmp-999-00000000-0000-4000-8000-000000000000.zip`
  writeFileSync(staleTemporary, readFileSync(`${recovery.share}.previous`))
  await createShareBundle(recovery.dir, recoveryPlan.revision)
  check('next creation restores an interrupted replacement and scavenges its exact temp name',
    existsSync(recovery.share) &&
      !existsSync(`${recovery.share}.previous`) &&
      !existsSync(staleTemporary))

  const byteRace = makeFixture('same-size-mtime-race')
  const byteRacePlan = await planShareBundle(byteRace.dir)
  const byteRaceFile = path.join(byteRace.dir, 'frames', 'frame-01_00-01.000.png')
  const byteRaceStat = statSync(byteRaceFile)
  const replacementPng = withHiddenPngPayload(
    greyPng(1, 1),
    'SECRET_DERIVED_METADATA_4b8e',
    DERIVED_TRAILER,
  )
  check('same-size race fixture really keeps the source size', replacementPng.length === byteRaceStat.size)
  writeFileSync(byteRaceFile, replacementPng)
  utimesSync(byteRaceFile, byteRaceStat.atime, byteRaceStat.mtime)
  await expectError('pack-changed', () => createShareBundle(byteRace.dir, byteRacePlan.revision))
  check('content hash catches a same-size, restored-mtime media change', !existsSync(byteRace.share))

  const collision = makeFixture('output-collision')
  const collisionPlan = await planShareBundle(collision.dir)
  const foreign = new AdmZip()
  foreign.addFile(
    'manifest.json',
    Buffer.from('{"format":"capturepack","id":"FOREIGN_FULL_ZIP_901d"}\n', 'utf8'),
  )
  foreign.writeZip(collision.share)
  const foreignHash = sha(readFileSync(collision.share))
  await expectError('output-conflict', () => createShareBundle(collision.dir, collisionPlan.revision))
  check('a foreign/full ZIP at the Share Copy name is never overwritten',
    sha(readFileSync(collision.share)) === foreignHash && siblingShareBundle(collision.dir) === null)

  const directoryCollision = makeFixture('directory-collision')
  const directoryPlan = await planShareBundle(directoryCollision.dir)
  mkdirSync(directoryCollision.share)
  await expectError('output-conflict', () =>
    createShareBundle(directoryCollision.dir, directoryPlan.revision))
  check('a directory at the output name is preserved', statSync(directoryCollision.share).isDirectory())

  const trailing = makeFixture('trailing-separator')
  const trailingPlan = await planShareBundle(`${trailing.dir}${path.sep}`)
  check('a trailing separator still resolves to an external sibling',
    trailingPlan.outputPath === shareBundlePath(trailing.dir) &&
      !trailingPlan.outputPath.startsWith(`${trailing.dir}${path.sep}`))

  const aliasSource = makeFixture('pack-alias-source')
  const aliasPath = path.join(root, 'pack-alias')
  let packAliasMade = false
  try {
    symlinkSync(aliasSource.dir, aliasPath, process.platform === 'win32' ? 'junction' : 'dir')
    packAliasMade = true
  } catch {
    // Some hosts disallow user-created links. The rejection remains exercised
    // wherever the host permits creating the fixture.
  }
  if (packAliasMade) {
    await expectError('invalid-pack', () => planShareBundle(aliasPath))
  }
  check('a pack reached through a symlink or junction alias is rejected',
    !packAliasMade || !existsSync(`${aliasPath}.share.zip`))

  const reviewedAgain = await planShareBundle(success.dir)
  const oldShareHash = sha(readFileSync(success.share))
  appendFileSync(path.join(success.dir, 'annotations.json'), '\n')
  await expectError('pack-changed', () => createShareBundle(success.dir, reviewedAgain.revision))
  check('a revision race preserves the previous completed Share Copy',
    sha(readFileSync(success.share)) === oldShareHash)

  const missing = makeFixture('missing')
  rmSync(path.join(missing.dir, 'frames', 'frame-01_00-01.000.png'))
  await expectError('derived-media-missing', () => planShareBundle(missing.dir))
  check('missing derived media creates no partial final ZIP', !existsSync(missing.share))

  const corrupt = makeFixture('corrupt')
  writeFileSync(path.join(corrupt.dir, 'frames', 'frame-01_00-01.000.png'), 'not a png')
  await expectError('derived-media-missing', () => planShareBundle(corrupt.dir))
  check('corrupt derived media creates no partial final ZIP', !existsSync(corrupt.share))

  const blocked = makeFixture('blur-label', true)
  const blockedPlan = await planShareBundle(blocked.dir)
  check('text on a blur box is a visible-label blocker', blockedPlan.blockers.includes('blur-label'))
  await expectError('blocked', () => createShareBundle(blocked.dir, blockedPlan.revision))
  check('blocked blur-label export creates no ZIP', !existsSync(blocked.share))

  const traversal = makeFixture('traversal')
  const traversalManifest = JSON.parse(readFileSync(path.join(traversal.dir, 'manifest.json'), 'utf8'))
  traversalManifest.media.keyframes[0].file = '../frame-01_00-01.000.png'
  writeFileSync(path.join(traversal.dir, 'manifest.json'), `${JSON.stringify(traversalManifest)}\n`)
  await expectError('unsafe-media-path', () => planShareBundle(traversal.dir))
  check('a traversal declaration creates no ZIP', !existsSync(traversal.share))

  const linked = makeFixture('linked')
  const linkedFile = path.join(linked.dir, 'frames', 'frame-01_00-01.000.png')
  const outside = path.join(root, 'outside.png')
  writeFileSync(outside, PNG)
  rmSync(linkedFile)
  let symlinkMade = false
  try {
    symlinkSync(outside, linkedFile, 'file')
    symlinkMade = true
  } catch {
    // Some Windows policies deny user-created symlinks. The runtime rejection
    // remains covered wherever the host permits making the fixture.
  }
  if (symlinkMade) {
    await expectError('unsafe-media-path', () => planShareBundle(linked.dir))
  }
  check('derived symlink is rejected when the host permits the fixture', !symlinkMade || !existsSync(linked.share))

  const history = readFileSync(path.join(process.cwd(), 'src', 'main', 'historyWindow.ts'), 'utf8')
  const preload = readFileSync(path.join(process.cwd(), 'src', 'preload', 'history.ts'), 'utf8')
  const renderer = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'history', 'history.ts'), 'utf8')
  const toastMain = readFileSync(path.join(process.cwd(), 'src', 'main', 'saveToast.ts'), 'utf8')
  const toastPreload = readFileSync(path.join(process.cwd(), 'src', 'preload', 'toast.ts'), 'utf8')
  const exporter = readFileSync(path.join(process.cwd(), 'src', 'main', 'exporter.ts'), 'utf8')
  const storage = readFileSync(path.join(process.cwd(), 'src', 'main', 'storage.ts'), 'utf8')
  check('History sender/ref guards own both Share Copy IPC routes',
    history.includes('IPC.historyPlanShare') &&
      history.includes('IPC.historyCreateShare') &&
      history.includes('fromHistory(event)') &&
      history.includes('entryFor(ref)'))
  check('History review passes an opaque revision into creation',
    preload.includes('createShare(packPath: string, revision: string)') &&
      renderer.includes('bridge.createShare(p.path, plan.revision)'))
  check('rendering and pack mutations cannot race Share Copy publication',
    history.includes('isRenderInFlight(entry.path)') &&
      history.includes('beginPackOperation(entry.path)') &&
      storage.includes('beginPackOperation(pack.path)'))
  check('every rendered label reaches the local review without truncation',
    history.includes('visibleLabels: plan.visibleLabels') && !history.includes('MAX_REVIEW_LABELS'))
  check('create UI cannot dismiss a running write and refreshes storage immediately',
    renderer.includes('cancelBtn.disabled = shareCreating.has(p.path)') &&
      renderer.includes('p.shareTwin = true') &&
      renderer.includes('refreshUsage()'))
  check('Full ZIP refuses to overwrite the neighbouring Share Copy identity',
    exporter.includes('isShareBundleArchive(zipPath)'))
  check('raw full ZIP is demoted to the More menu with an originals warning',
    renderer.includes("t('history.menuFullZip')") && renderer.includes("t('history.fullZipTooltip')"))
  check('save toast no longer exposes the stale raw-ZIP IPC',
    !toastMain.includes('toastCreateZip') && !toastPreload.includes('toastCreateZip'))

  console.log(`\n${failures === 0 ? 'share bundle checks passed' : `${String(failures)} share bundle check(s) failed`}`)
  if (failures > 0) process.exitCode = 1
} finally {
  rmSync(root, { recursive: true, force: true })
}

function makeFixture(name: string, blurLabel = false, stillPng = PNG): Fixture {
  const dir = path.join(root, `CapturePack_${name}`)
  mkdirSync(path.join(dir, 'frames'), { recursive: true })
  mkdirSync(path.join(dir, 'frames-d2'), { recursive: true })
  mkdirSync(path.join(dir, 'plugins', 'chrome-dom'), { recursive: true })
  const manifest = {
    format: 'capturepack',
    format_version: '0.8.0',
    capture_kind: 'video',
    id: 'SECRET_MANIFEST_ID_42f1',
    created_at: '2026-08-21T00:00:00+09:00',
    generator: { name: 'capturepack', version: 'test' },
    title: 'SECRET_MANIFEST_TITLE_6a2d',
    note: 'SECRET_MANIFEST_NOTE_3f0a',
    environment: {
      os: 'windows',
      os_version: 'SECRET_OS_VERSION_e80d',
      app: 'SECRET_APP_91ee',
      screens: [
        { width: 1, height: 1, scale: 1 },
        { width: 1, height: 1, scale: 1 },
      ],
    },
    media: {
      snapshot: 'snapshot.png',
      replay: 'replay.webm',
      replay_duration_ms: 1_000,
      replay_annotated: 'replay_annotated.webm',
      keyframes: [{ file: 'frames/frame-01_00-01.000.png', t_ms: 1_000 }],
      displays: [
        {
          index: 1,
          snapshot: 'snapshot.png',
          snapshot_width: 1,
          snapshot_height: 1,
          replay: 'replay.webm',
          replay_duration_ms: 1_000,
          bounds: { x: 0, y: 0, width: 1, height: 1 },
          scale: 1,
          focused: true,
        },
        {
          index: 2,
          snapshot: 'snapshot-d2.png',
          snapshot_width: 1,
          snapshot_height: 1,
          replay: 'replay-d2.webm',
          replay_duration_ms: 1_000,
          replay_annotated: 'replay_annotated-d2.webm',
          keyframes: [{ file: 'frames-d2/frame-01_00-01.000.png', t_ms: 1_000 }],
          bounds: { x: 1, y: 0, width: 1, height: 1 },
          scale: 1,
          focused: false,
        },
      ],
    },
    plugins: [{ name: 'chrome-dom', version: '1', path: 'plugins/chrome-dom/' }],
  }
  const annotations = {
    reference_width: 1,
    reference_height: 1,
    annotations: [
      {
        annotation_id: 'ann_000001',
        type: 'box',
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        text: blurLabel ? 'SECRET_BLUR_LABEL_251a' : '',
        numbered: false,
        blur: true,
        tracking: { enabled: false },
        created_at: '2026-08-21T00:00:00+09:00',
        z: 1,
        target: { url: 'SECRET_TARGET_URL_29b7' },
      },
      {
        annotation_id: 'ann_000002',
        type: 'box',
        display: 2,
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        text: 'SECRET_VISIBLE_LABEL_51c4',
        numbered: true,
        blur: false,
        tracking: { enabled: false },
        created_at: '2026-08-21T00:00:00+09:00',
        z: 2,
      },
    ],
  }
  const files = new Map<string, string>([
    ['manifest.json', `${JSON.stringify(manifest, null, 2)}\n`],
    ['annotations.json', `${JSON.stringify(annotations, null, 2)}\n`],
    ['timeline.json', '{"events":[{"data":{"title":"SECRET_TIMELINE_WINDOW_0de3"}}]}\n'],
    ['report.md', 'SECRET_GENERATED_DOC_1ca0\n'],
    ['README.md', 'SECRET_GENERATED_DOC_1ca0\n'],
    ['viewer.html', '<p>SECRET_GENERATED_DOC_1ca0</p>\n'],
    ['plugins/chrome-dom/elements.json', '{"text":"SECRET_PLUGIN_DOM_84af"}\n'],
    ['SECRET_UNDECLARED_ROOT_d511.txt', 'SECRET_UNDECLARED_ROOT_d511\n'],
  ])
  for (const [rel, text] of files) {
    const file = path.join(dir, ...rel.split('/'))
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  for (const rel of ['snapshot.png', 'snapshot-d2.png']) {
    writeFileSync(path.join(dir, rel), `SECRET_RAW_PIXELS_7bc1:${rel}`)
  }
  for (const rel of ['replay.webm', 'replay-d2.webm']) {
    writeFileSync(path.join(dir, rel), `SECRET_RAW_PIXELS_7bc1:${rel}`)
  }
  writeFileSync(path.join(dir, 'replay_annotated.webm'), WEBM)
  writeFileSync(path.join(dir, 'replay_annotated-d2.webm'), WEBM)
  writeFileSync(path.join(dir, 'frames', 'frame-01_00-01.000.png'), stillPng)
  writeFileSync(path.join(dir, 'frames-d2', 'frame-01_00-01.000.png'), stillPng)
  return { dir, share: `${dir}.share.zip`, files }
}

function makeImageFixture(name: string): Fixture {
  const fixture = makeFixture(name)
  const manifestFile = path.join(fixture.dir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  manifest.capture_kind = 'image'
  delete manifest.media.replay
  delete manifest.media.replay_duration_ms
  delete manifest.media.replay_annotated
  delete manifest.media.displays
  manifest.environment.screens = [manifest.environment.screens[0]]
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
  const annotationsFile = path.join(fixture.dir, 'annotations.json')
  const annotations = JSON.parse(readFileSync(annotationsFile, 'utf8'))
  annotations.annotations = annotations.annotations.slice(0, 1)
  writeFileSync(annotationsFile, `${JSON.stringify(annotations, null, 2)}\n`)
  // The image still is rendered from this exact annotations revision.
  writeFileSync(path.join(fixture.dir, 'frames', 'frame-01_00-01.000.png'), PNG)
  return fixture
}

async function expectError(code: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run()
    check(`fails closed with ${code}`, false, 'operation unexpectedly succeeded')
  } catch (error) {
    check(`fails closed with ${code}`, error instanceof ShareBundleError && error.code === code,
      error instanceof Error ? error.message : String(error))
  }
}

function hashTree(dir: string): Map<string, string> {
  const result = new Map<string, string>()
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(full, rel)
      else result.set(rel, sha(readFileSync(full)))
    }
  }
  walk(dir, '')
  return result
}

function sha(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function withHiddenPngPayload(base: Buffer, metadata: string, trailer: string): Buffer {
  let offset = 8
  while (offset + 12 <= base.length) {
    const length = base.readUInt32BE(offset)
    const type = base.toString('ascii', offset + 4, offset + 8)
    if (type === 'IEND') {
      return Buffer.concat([
        base.subarray(0, offset),
        testPngChunk('tEXt', Buffer.from(`Comment\0${metadata}`, 'utf8')),
        base.subarray(offset),
        Buffer.from(trailer, 'utf8'),
      ])
    }
    offset += length + 12
  }
  throw new Error('fixture PNG has no IEND')
}

function pngChunkNames(bytes: Buffer): string[] {
  const names: string[] = []
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    names.push(type)
    offset += length + 12
    if (type === 'IEND') break
  }
  return names
}

function filteredRgbaPng(): { png: Buffer; pixels: Buffer } {
  const width = 3
  const height = 5
  const channels = 4
  const rowBytes = width * channels
  const pixels = Buffer.allocUnsafe(rowBytes * height)
  for (let index = 0; index < pixels.length; index += 1) {
    pixels[index] = (index * 37 + 19) & 0xff
  }
  const filtered = Buffer.allocUnsafe((rowBytes + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const filter = y
    const row = y * (rowBytes + 1)
    filtered[row] = filter
    for (let x = 0; x < rowBytes; x += 1) {
      const value = pixels[y * rowBytes + x]!
      const left = x >= channels ? pixels[y * rowBytes + x - channels]! : 0
      const up = y > 0 ? pixels[(y - 1) * rowBytes + x]! : 0
      const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * rowBytes + x - channels]! : 0
      const prediction =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? Math.floor((left + up) / 2)
                : testPaeth(left, up, upLeft)
      filtered[row + 1 + x] = (value - prediction + 256) & 0xff
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return {
    png: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      testPngChunk('IHDR', ihdr),
      testPngChunk('IDAT', deflateSync(filtered)),
      testPngChunk('IEND', Buffer.alloc(0)),
    ]),
    pixels,
  }
}

function canonicalRgbaPixels(bytes: Buffer): Buffer {
  let offset = 8
  let width = 0
  let height = 0
  const idat: Buffer[] = []
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
    } else if (type === 'IDAT') idat.push(data)
    offset += length + 12
    if (type === 'IEND') break
  }
  const rowBytes = width * 4
  const raw = inflateSync(Buffer.concat(idat))
  const pixels = Buffer.allocUnsafe(rowBytes * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * (rowBytes + 1)
    if (raw[row] !== 0) throw new Error('output PNG is not canonical filter 0')
    raw.copy(pixels, y * rowBytes, row + 1, row + 1 + rowBytes)
  }
  return pixels
}

function testPaeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft
  const leftDistance = Math.abs(estimate - left)
  const upDistance = Math.abs(estimate - up)
  const diagonalDistance = Math.abs(estimate - upLeft)
  if (leftDistance <= upDistance && leftDistance <= diagonalDistance) return left
  return upDistance <= diagonalDistance ? up : upLeft
}

function testPngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const result = Buffer.allocUnsafe(data.length + 12)
  result.writeUInt32BE(data.length, 0)
  body.copy(result, 4)
  result.writeUInt32BE(testPngCrc(body), data.length + 8)
  return result
}

function testPngCrc(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function mapsEqual(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
  return left.size === right.size && [...left].every(([key, value]) => right.get(key) === value)
}
}

void run().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
