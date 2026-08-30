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
  readCanonicalShareStill,
  ShareBundleError,
} from '../src/main/shareBundle'
import { moveNoReplace } from '../src/main/moveNoReplace'
import {
  isShareBundleArchive,
  shareBundlePath,
  siblingArchive,
  siblingShareBundle,
} from '../src/main/packArchive'
import { PackRenderBatchTracker } from '../src/main/renderBatch'
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
  const renderEvents: Array<{ state: string; locked: boolean; ratio?: number }> = []
  let renderLock = false
  const renderBatches = new PackRenderBatchTracker(
    () => {
      if (renderLock) return null
      renderLock = true
      return () => {
        renderLock = false
      }
    },
    (_dirPath, state, ratio) => {
      renderEvents.push({ state, locked: renderLock, ...(ratio === undefined ? {} : { ratio }) })
    },
  )
  const finishFocused = renderBatches.begin('C:\\fixture\\pack')
  const finishDisplayVideo = renderBatches.begin('c:\\FIXTURE\\pack')
  const finishDisplayStill = renderBatches.begin('C:\\fixture\\pack')
  check('focused/display/still renders form one locked pack batch',
    finishFocused !== null &&
      finishDisplayVideo !== null &&
      finishDisplayStill !== null &&
      renderLock &&
      renderBatches.isInFlight('c:\\fixture\\PACK') &&
      renderEvents.length === 1 &&
      renderEvents[0]?.state === 'rendering')
  finishFocused?.('done')
  finishDisplayVideo?.('failed')
  check('intermediate completion keeps the batch locked with no terminal state',
    renderLock &&
      renderBatches.isInFlight('C:\\fixture\\pack') &&
      renderEvents.slice(1).every((event) => event.state === 'rendering'))
  const eventsBeforeFinal = renderEvents.length
  finishDisplayStill?.('done')
  finishDisplayStill?.('failed')
  check('the final job releases before one sticky aggregate failure event',
    !renderLock &&
      !renderBatches.isInFlight('C:\\fixture\\pack') &&
      renderEvents.length === eventsBeforeFinal + 1 &&
      renderEvents.at(-1)?.state === 'failed' &&
      renderEvents.at(-1)?.locked === false)
  const finishFreshBatch = renderBatches.begin('C:\\fixture\\pack')
  finishFreshBatch?.('done')
  check('a later batch resets failure state and can finish done',
    renderEvents.at(-1)?.state === 'done' && renderEvents.at(-1)?.locked === false)
  renderLock = true
  const refusedRender = renderBatches.begin('C:\\fixture\\busy-pack')
  check('a foreground pack operation rejects a new render without waiting',
    refusedRender === null &&
      !renderBatches.isInFlight('C:\\fixture\\busy-pack') &&
      renderEvents.at(-1)?.state === 'failed')
  renderLock = false

  if (process.platform === 'win32') {
    const moveRoot = path.join(root, 'move-no-replace')
    mkdirSync(moveRoot)
    const fileSource = path.join(moveRoot, 'file-source.txt')
    const fileDestination = path.join(moveRoot, 'file-destination.txt')
    writeFileSync(fileSource, 'source-file')
    writeFileSync(fileDestination, 'destination-file')
    let fileCollision = false
    try {
      await moveNoReplace(fileSource, fileDestination)
    } catch (error) {
      fileCollision =
        typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
    }
    check('no-replace file move preserves both sides of an existing-file collision',
      fileCollision &&
        readFileSync(fileSource, 'utf8') === 'source-file' &&
        readFileSync(fileDestination, 'utf8') === 'destination-file')

    const directorySource = path.join(moveRoot, 'directory-source')
    const directoryDestination = path.join(moveRoot, 'directory-destination.txt')
    mkdirSync(directorySource)
    writeFileSync(path.join(directorySource, 'source.txt'), 'source-directory')
    writeFileSync(directoryDestination, 'destination-file')
    let directoryCollision = false
    try {
      await moveNoReplace(directorySource, directoryDestination)
    } catch {
      directoryCollision = true
    }
    check('no-replace directory move preserves both sides of an existing-file collision',
      directoryCollision &&
        readFileSync(path.join(directorySource, 'source.txt'), 'utf8') === 'source-directory' &&
        readFileSync(directoryDestination, 'utf8') === 'destination-file')

    const successSource = path.join(moveRoot, 'success-source.txt')
    const successDestination = path.join(moveRoot, 'success-destination.txt')
    writeFileSync(successSource, 'success-source')
    await moveNoReplace(successSource, successDestination)
    check('no-replace move publishes when the destination is absent',
      !existsSync(successSource) && readFileSync(successDestination, 'utf8') === 'success-source')
  }

  const success = makeFixture('success')
  const before = hashTree(success.dir)
  const plan = await planShareBundle(success.dir)
  check('plan names a distinct .share.zip sibling', plan.outputPath.endsWith('.share.zip'))
  check('the 0.1 writer plans only two reviewed annotated stills',
    plan.entries.length === 2 && plan.entries.every((entry) => entry.kind === 'annotated-still'))
  check('plan reports visible derived labels for local review',
    plan.visibleLabels.includes('SECRET_VISIBLE_LABEL_51c4'))
  check('an empty blur label does not block sharing', plan.blockers.length === 0)
  const reviewedCanonical = await readCanonicalShareStill(plan.entries[0]!)
  check('the review binding records canonical dimensions, sizes and hash',
    plan.entries[0]?.pixelWidth === reviewedCanonical.width &&
      plan.entries[0]?.pixelHeight === reviewedCanonical.height &&
      plan.entries[0]?.canonicalSha256 === sha(reviewedCanonical.bytes) &&
      plan.entries[0]?.canonicalSize === reviewedCanonical.bytes.length &&
      plan.entries[0]?.decodedRasterBytes ===
        reviewedCanonical.width * reviewedCanonical.height * 4)
  await expectError('pack-changed', () => readCanonicalShareStill({
    ...plan.entries[0]!,
    canonicalSize: plan.entries[0]!.canonicalSize + 1,
  }))
  await expectError('pack-changed', () => readCanonicalShareStill({
    ...plan.entries[0]!,
    decodedRasterBytes: plan.entries[0]!.decodedRasterBytes + 4,
  }))

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
  check('the reviewed canonical still is byte-identical to the published ZIP entry',
    archive.getEntry(plan.entries[0]!.archivePath)!.getData().equals(reviewedCanonical.bytes))
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

  const decodedBoundaryPng = declaredGreyPng(4_096, 4_096)
  check('decoded-raster boundary fixture stays tiny while declaring exactly 64 MiB RGBA',
    decodedBoundaryPng.length < 128 &&
      decodedBoundaryPng.readUInt32BE(16) * decodedBoundaryPng.readUInt32BE(20) * 4 ===
        64 * 1024 * 1024)
  const decodedBoundary = makeFixture('png-decoded-raster-boundary', false, decodedBoundaryPng)
  await expectError('derived-media-missing', () => planShareBundle(decodedBoundary.dir))
  check('the compact boundary fixture fails closed on its intentionally truncated raster',
    !existsSync(decodedBoundary.share))

  const oversizedDecodedPng = declaredGreyPng(4_096, 4_097)
  check('decoded-raster overflow fixture stays tiny while declaring more than 64 MiB RGBA',
    oversizedDecodedPng.length < 128 &&
      oversizedDecodedPng.readUInt32BE(16) * oversizedDecodedPng.readUInt32BE(20) * 4 >
        64 * 1024 * 1024)
  const oversizedDecoded = makeFixture('png-decoded-raster-overflow', false, oversizedDecodedPng)
  await expectError('derived-media-missing', () => planShareBundle(oversizedDecoded.dir))
  check('an oversized decoded footprint creates no Share Copy', !existsSync(oversizedDecoded.share))

  for (const transparent of [transparentGreyPng(), transparentRgbPng()]) {
    const transparentFixture = makeFixture(
      `png-trns-${transparent.name}`,
      false,
      transparent.png,
    )
    const transparentPlan = await planShareBundle(transparentFixture.dir)
    await createShareBundle(transparentFixture.dir, transparentPlan.revision)
    const transparentOutput = new AdmZip(transparentFixture.share)
      .getEntry('media/display-1/annotated-still-01.png')!
      .getData()
    check(`${transparent.name} tRNS is preserved as canonical RGBA pixels`,
      pngColorType(transparentOutput) === 6 &&
        pngChunkNames(transparentOutput).join(',') === 'IHDR,IDAT,IEND' &&
        canonicalRgbaPixels(transparentOutput).equals(transparent.pixels))
  }

  const transparentGrey = transparentGreyPng().png
  for (const [name, invalidPng] of [
    ['duplicate tRNS', insertPngChunk(transparentGrey, 'IDAT', 'tRNS', Buffer.from([0, 0x20]))],
    ['tRNS after IDAT', insertPngChunk(greyPng(2, 1), 'IEND', 'tRNS', Buffer.from([0, 0x20]))],
    ['wrong-length tRNS', insertPngChunk(greyPng(2, 1), 'IDAT', 'tRNS', Buffer.from([0x20]))],
    ['tRNS on RGBA', insertPngChunk(filteredRgbaPng().png, 'IDAT', 'tRNS', Buffer.from([0, 0]))],
  ] as const) {
    const invalidTransparency = makeFixture(`png-${name.replaceAll(' ', '-')}`, false, invalidPng)
    await expectError('derived-media-missing', () => planShareBundle(invalidTransparency.dir))
    check(`${name} creates no Share Copy`, !existsSync(invalidTransparency.share))
  }

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
  await expectError('pack-changed', () => readCanonicalShareStill(byteRacePlan.entries[0]!))
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

  const backupCollision = makeFixture('backup-collision')
  const backupPlan = await planShareBundle(backupCollision.dir)
  await createShareBundle(backupCollision.dir, backupPlan.revision)
  const completedHash = sha(readFileSync(backupCollision.share))
  const foreignBackup = `${backupCollision.share}.previous`
  writeFileSync(foreignBackup, 'foreign-backup-bytes')
  await expectError('output-conflict', () =>
    createShareBundle(backupCollision.dir, backupPlan.revision))
  check('a backup-name collision preserves the completed Share Copy and foreign backup',
    sha(readFileSync(backupCollision.share)) === completedHash &&
      readFileSync(foreignBackup, 'utf8') === 'foreign-backup-bytes')

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

  for (const [name, mutate] of [
    ['non-array display table', (manifest: any) => { manifest.media.displays = {} }],
    ['malformed display entry', (manifest: any) => { manifest.media.displays[1] = null }],
    ['duplicate display index', (manifest: any) => { manifest.media.displays[1].index = 1 }],
    ['missing focused display', (manifest: any) => {
      for (const display of manifest.media.displays) display.focused = false
    }],
    ['multiple focused displays', (manifest: any) => { manifest.media.displays[1].focused = true }],
  ] as const) {
    const malformed = makeFixture(`manifest-${name.replaceAll(' ', '-')}`)
    const manifestFile = path.join(malformed.dir, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    mutate(manifest)
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
    await expectError('invalid-pack', () => planShareBundle(malformed.dir))
    check(`${name} cannot create a partial Share Copy`, !existsSync(malformed.share))
  }

  for (const [name, mutate] of [
    ['missing keyframe time', (manifest: any) => { delete manifest.media.keyframes[0].t_ms }],
    ['negative keyframe time', (manifest: any) => { manifest.media.keyframes[0].t_ms = -1 }],
    ['fractional keyframe time', (manifest: any) => { manifest.media.keyframes[0].t_ms = 0.5 }],
    ['out-of-order keyframe time', (manifest: any) => {
      manifest.media.keyframes = [
        { file: 'frames/frame-01_00-01.000.png', t_ms: 1_000 },
        { file: 'frames/frame-02_00-00.500.png', t_ms: 500 },
      ]
    }],
    ['wrong keyframe array ordinal', (manifest: any) => {
      manifest.media.keyframes[0].file = 'frames/frame-02_00-01.000.png'
    }],
    ['empty present keyframe array', (manifest: any) => { manifest.media.keyframes = [] }],
    ['declared keyframe width mismatch', (manifest: any) => {
      manifest.media.keyframes[0].width = 2
    }],
    ['declared keyframe height mismatch', (manifest: any) => {
      manifest.media.keyframes[0].height = 2
    }],
  ] as const) {
    const malformed = makeFixture(`manifest-${name.replaceAll(' ', '-')}`)
    const manifestFile = path.join(malformed.dir, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    mutate(manifest)
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
    await expectError('invalid-pack', () => planShareBundle(malformed.dir))
    check(`${name} cannot create a partial Share Copy`, !existsSync(malformed.share))
  }

  for (const [name, mutate] of [
    ['focused snapshot alias', (manifest: any) => {
      manifest.media.displays[0].snapshot = 'snapshot-d1.png'
    }],
    ['secondary snapshot alias', (manifest: any) => {
      manifest.media.displays[1].snapshot = 'snapshot.png'
    }],
    ['focused replay alias', (manifest: any) => {
      manifest.media.displays[0].replay = 'replay-d1.webm'
    }],
    ['secondary replay alias', (manifest: any) => {
      manifest.media.displays[1].replay = 'replay.webm'
    }],
    ['missing snapshot width', (manifest: any) => {
      delete manifest.media.displays[0].snapshot_width
    }],
    ['missing snapshot height', (manifest: any) => {
      delete manifest.media.displays[0].snapshot_height
    }],
    ['invalid snapshot width', (manifest: any) => {
      manifest.media.displays[1].snapshot_width = 0
    }],
    ['invalid snapshot height', (manifest: any) => {
      manifest.media.displays[1].snapshot_height = 0
    }],
    ['missing display bounds', (manifest: any) => { delete manifest.media.displays[1].bounds }],
    ['invalid display bounds', (manifest: any) => {
      manifest.media.displays[1].bounds.width = 0
    }],
    ['missing display scale', (manifest: any) => { delete manifest.media.displays[1].scale }],
    ['invalid display scale', (manifest: any) => { manifest.media.displays[1].scale = 0 }],
    ['display without matching screen', (manifest: any) => { manifest.environment.screens.pop() }],
  ] as const) {
    const malformed = makeFixture(`display-${name.replaceAll(' ', '-')}`)
    const manifestFile = path.join(malformed.dir, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    mutate(manifest)
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
    await expectError('invalid-pack', () => planShareBundle(malformed.dir))
    check(`${name} cannot create a partial Share Copy`, !existsSync(malformed.share))
  }

  for (const [name, lane] of [['focused', 'top'], ['non-blur secondary', 'display']] as const) {
    const incomplete = makeFixture(`missing-${name.replaceAll(' ', '-')}-lane`)
    const manifestFile = path.join(incomplete.dir, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    if (lane === 'top') delete manifest.media.keyframes
    else delete manifest.media.displays[1].keyframes
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
    await expectError('derived-media-not-ready', () => planShareBundle(incomplete.dir))
    check(`${name} annotated lane cannot disappear from sharing`, !existsSync(incomplete.share))
  }

  const undeclaredAnnotation = makeFixture('undeclared-annotation-display')
  const undeclaredAnnotationsFile = path.join(undeclaredAnnotation.dir, 'annotations.json')
  const undeclaredAnnotations = JSON.parse(readFileSync(undeclaredAnnotationsFile, 'utf8'))
  undeclaredAnnotations.annotations[1].display = 3
  writeFileSync(undeclaredAnnotationsFile, `${JSON.stringify(undeclaredAnnotations, null, 2)}\n`)
  await expectError('invalid-annotations', () => planShareBundle(undeclaredAnnotation.dir))
  check('an annotation cannot name an undeclared display', !existsSync(undeclaredAnnotation.share))

  const optionalDefaults = makeFixture('annotation-optional-defaults')
  const optionalDefaultsFile = path.join(optionalDefaults.dir, 'annotations.json')
  const optionalAnnotations = JSON.parse(readFileSync(optionalDefaultsFile, 'utf8'))
  for (const annotation of optionalAnnotations.annotations) {
    delete annotation.text
    delete annotation.numbered
    delete annotation.blur
    delete annotation.tracking
  }
  writeFileSync(optionalDefaultsFile, `${JSON.stringify(optionalAnnotations, null, 2)}\n`)
  writeFileSync(path.join(optionalDefaults.dir, 'frames', 'frame-01_00-01.000.png'), PNG)
  writeFileSync(path.join(optionalDefaults.dir, 'frames-d2', 'frame-01_00-01.000.png'), PNG)
  const optionalDefaultsPlan = await planShareBundle(optionalDefaults.dir)
  check('omitted optional annotation fields receive safe defaults',
    optionalDefaultsPlan.entries.length === 2 &&
      optionalDefaultsPlan.visibleLabels.length === 0 &&
      !optionalDefaultsPlan.hasBlur &&
      optionalDefaultsPlan.blockers.length === 0)

  for (const [name, mutate] of [
    ['annotation text type', (annotation: any) => { annotation.text = 1 }],
    ['annotation numbered type', (annotation: any) => { annotation.numbered = 'true' }],
    ['annotation blur type', (annotation: any) => { annotation.blur = 1 }],
    ['annotation tracking type', (annotation: any) => { annotation.tracking = null }],
  ] as const) {
    const malformed = makeFixture(name.replaceAll(' ', '-'))
    const annotationsFile = path.join(malformed.dir, 'annotations.json')
    const annotations = JSON.parse(readFileSync(annotationsFile, 'utf8'))
    mutate(annotations.annotations[0])
    writeFileSync(annotationsFile, `${JSON.stringify(annotations, null, 2)}\n`)
    await expectError('invalid-annotations', () => planShareBundle(malformed.dir))
    check(`${name} cannot create a partial Share Copy`, !existsSync(malformed.share))
  }

  for (const [name, samples] of [
    ['enabled tracking without samples', undefined],
    ['enabled tracking with empty samples', []],
  ] as const) {
    const malformed = makeFixture(name.replaceAll(' ', '-'))
    const annotationsFile = path.join(malformed.dir, 'annotations.json')
    const annotations = JSON.parse(readFileSync(annotationsFile, 'utf8'))
    annotations.annotations[0].tracking = {
      enabled: true,
      ...(samples === undefined ? {} : { samples }),
    }
    writeFileSync(annotationsFile, `${JSON.stringify(annotations, null, 2)}\n`)
    await expectError('invalid-annotations', () => planShareBundle(malformed.dir))
    check(`${name} cannot create a partial Share Copy`, !existsSync(malformed.share))
  }

  for (const [name, samples] of [
    ['tracking sample negative time', [
      { t_ms: -1, x: 0, y: 0, width: 1, height: 1 },
    ]],
    ['tracking sample out-of-order time', [
      { t_ms: 2, x: 0, y: 0, width: 1, height: 1 },
      { t_ms: 1, x: 0, y: 0, width: 1, height: 1 },
    ]],
    ['tracking sample malformed rectangle', [
      { t_ms: 0, x: 0, y: 0, width: 0, height: 1 },
    ]],
  ] as const) {
    const malformed = makeFixture(name.replaceAll(' ', '-'))
    const annotationsFile = path.join(malformed.dir, 'annotations.json')
    const annotations = JSON.parse(readFileSync(annotationsFile, 'utf8'))
    annotations.annotations[0].tracking = { enabled: true, samples }
    writeFileSync(annotationsFile, `${JSON.stringify(annotations, null, 2)}\n`)
    await expectError('invalid-annotations', () => planShareBundle(malformed.dir))
    check(`${name} cannot create a partial Share Copy`, !existsSync(malformed.share))
  }

  for (const [name, keyframes] of [
    ['authored keyframe negative time', [
      { t_ms: -1, x: 0, y: 0, width: 1, height: 1 },
      { t_ms: 1, x: 0, y: 0, width: 1, height: 1 },
    ]],
    ['authored keyframe out-of-order time', [
      { t_ms: 2, x: 0, y: 0, width: 1, height: 1 },
      { t_ms: 1, x: 0, y: 0, width: 1, height: 1 },
    ]],
    ['authored keyframe malformed rectangle', [
      { t_ms: 0, x: 0, y: 0, width: 1, height: 1 },
      { t_ms: 1, x: 0, y: 0, width: 0, height: 1 },
    ]],
  ] as const) {
    const malformed = makeFixture(name.replaceAll(' ', '-'))
    const annotationsFile = path.join(malformed.dir, 'annotations.json')
    const annotations = JSON.parse(readFileSync(annotationsFile, 'utf8'))
    annotations.annotations[0].keyframes = keyframes
    writeFileSync(annotationsFile, `${JSON.stringify(annotations, null, 2)}\n`)
    await expectError('invalid-annotations', () => planShareBundle(malformed.dir))
    check(`${name} cannot create a partial Share Copy`, !existsSync(malformed.share))
  }

  const staleSecondary = makeFixture('stale-secondary-keyframes')
  const staleAnnotationsFile = path.join(staleSecondary.dir, 'annotations.json')
  const staleAnnotations = JSON.parse(readFileSync(staleAnnotationsFile, 'utf8'))
  staleAnnotations.annotations = [staleAnnotations.annotations[0]]
  writeFileSync(staleAnnotationsFile, `${JSON.stringify(staleAnnotations, null, 2)}\n`)
  await expectError('invalid-pack', () => planShareBundle(staleSecondary.dir))
  check('secondary keyframes without an affected annotation lane are rejected',
    !existsSync(staleSecondary.share))

  const crossing = makeFixture('cross-display-tracking')
  const crossingManifestFile = path.join(crossing.dir, 'manifest.json')
  const crossingManifest = JSON.parse(readFileSync(crossingManifestFile, 'utf8'))
  delete crossingManifest.media.displays[1].keyframes
  writeFileSync(crossingManifestFile, `${JSON.stringify(crossingManifest, null, 2)}\n`)
  const crossingAnnotationsFile = path.join(crossing.dir, 'annotations.json')
  const crossingAnnotations = JSON.parse(readFileSync(crossingAnnotationsFile, 'utf8'))
  crossingAnnotations.annotations = [crossingAnnotations.annotations[0]]
  crossingAnnotations.annotations[0].tracking = {
    enabled: true,
    samples: [{ t_ms: 500, display: 2, x: 0, y: 0, width: 1, height: 1 }],
  }
  writeFileSync(crossingAnnotationsFile, `${JSON.stringify(crossingAnnotations, null, 2)}\n`)
  await expectError('derived-media-not-ready', () => planShareBundle(crossing.dir))
  check('a tracked blur that crosses displays requires a still on every affected lane',
    !existsSync(crossing.share))

  const legacy = makeFixture('legacy-single-display')
  const legacyManifestFile = path.join(legacy.dir, 'manifest.json')
  const legacyManifest = JSON.parse(readFileSync(legacyManifestFile, 'utf8'))
  legacyManifest.format_version = '0.6.0'
  delete legacyManifest.media.displays
  writeFileSync(legacyManifestFile, `${JSON.stringify(legacyManifest, null, 2)}\n`)
  const legacyAnnotationsFile = path.join(legacy.dir, 'annotations.json')
  const legacyAnnotations = JSON.parse(readFileSync(legacyAnnotationsFile, 'utf8'))
  legacyAnnotations.annotations = [legacyAnnotations.annotations[0]]
  writeFileSync(legacyAnnotationsFile, `${JSON.stringify(legacyAnnotations, null, 2)}\n`)
  writeFileSync(path.join(legacy.dir, 'frames', 'frame-01_00-01.000.png'), PNG)
  const legacyPlan = await planShareBundle(legacy.dir)
  check('a pre-0.7 single-display video pack keeps its focused-lane fallback',
    legacyPlan.entries.length === 1 && legacyPlan.entries[0]?.display === 1)

  const legacyFractional = makeFixture('legacy-fractional-secondary')
  const legacyFractionalManifestFile = path.join(legacyFractional.dir, 'manifest.json')
  const legacyFractionalManifest = JSON.parse(
    readFileSync(legacyFractionalManifestFile, 'utf8'),
  )
  legacyFractionalManifest.format_version = '0.6.0'
  const legacySecondary = legacyFractionalManifest.media.displays[1]
  delete legacySecondary.snapshot_width
  delete legacySecondary.snapshot_height
  legacySecondary.bounds = { x: 1, y: 0, width: 2, height: 2 }
  legacySecondary.scale = 1.5
  legacyFractionalManifest.environment.screens[1] = { width: 3, height: 3, scale: 1.5 }
  writeFileSync(
    legacyFractionalManifestFile,
    `${JSON.stringify(legacyFractionalManifest, null, 2)}\n`,
  )
  // bounds × scale estimates 3×3, while the real legacy raster is -1px wide
  // and +1px tall. Only this inferred legacy geometry receives that tolerance.
  writeFileSync(
    path.join(legacyFractional.dir, 'frames-d2', 'frame-01_00-01.000.png'),
    greyPng(2, 4),
  )
  const legacyFractionalPlan = await planShareBundle(legacyFractional.dir)
  const legacyFractionalEntry = legacyFractionalPlan.entries.find((entry) => entry.display === 2)
  check('a pre-0.7 fractional-scale secondary lane accepts a ±1px inferred raster delta',
    legacyFractionalEntry?.pixelWidth === 2 && legacyFractionalEntry.pixelHeight === 4)

  const legacyDeclaredExact = makeFixture('legacy-declared-frame-exact')
  const legacyDeclaredManifestFile = path.join(legacyDeclaredExact.dir, 'manifest.json')
  const legacyDeclaredManifest = JSON.parse(readFileSync(legacyDeclaredManifestFile, 'utf8'))
  legacyDeclaredManifest.format_version = '0.6.0'
  legacyDeclaredManifest.media.displays[1].snapshot_width = 3
  legacyDeclaredManifest.media.displays[1].snapshot_height = 3
  legacyDeclaredManifest.media.displays[1].bounds = { x: 1, y: 0, width: 2, height: 2 }
  legacyDeclaredManifest.media.displays[1].scale = 1.5
  legacyDeclaredManifest.environment.screens[1] = { width: 3, height: 3, scale: 1.5 }
  writeFileSync(
    legacyDeclaredManifestFile,
    `${JSON.stringify(legacyDeclaredManifest, null, 2)}\n`,
  )
  writeFileSync(
    path.join(legacyDeclaredExact.dir, 'frames-d2', 'frame-01_00-01.000.png'),
    greyPng(2, 3),
  )
  await expectError('derived-media-not-ready', () => planShareBundle(legacyDeclaredExact.dir))
  check('a declared legacy snapshot width keeps zero raster tolerance',
    !existsSync(legacyDeclaredExact.share))

  const legacyAnnotationExact = makeFixture('legacy-annotation-frame-exact')
  const legacyAnnotationManifestFile = path.join(legacyAnnotationExact.dir, 'manifest.json')
  const legacyAnnotationManifest = JSON.parse(readFileSync(legacyAnnotationManifestFile, 'utf8'))
  legacyAnnotationManifest.format_version = '0.6.0'
  delete legacyAnnotationManifest.media.displays[0].snapshot_width
  delete legacyAnnotationManifest.media.displays[0].snapshot_height
  writeFileSync(
    legacyAnnotationManifestFile,
    `${JSON.stringify(legacyAnnotationManifest, null, 2)}\n`,
  )
  writeFileSync(
    path.join(legacyAnnotationExact.dir, 'frames', 'frame-01_00-01.000.png'),
    greyPng(2, 1),
  )
  await expectError('derived-media-not-ready', () => planShareBundle(legacyAnnotationExact.dir))
  check('a focused annotation reference keeps zero raster tolerance',
    !existsSync(legacyAnnotationExact.share))

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
  const shareBundle = readFileSync(path.join(process.cwd(), 'src', 'main', 'shareBundle.ts'), 'utf8')
  const annotatedRender = readFileSync(path.join(process.cwd(), 'src', 'main', 'annotatedRender.ts'), 'utf8')
  const preload = readFileSync(path.join(process.cwd(), 'src', 'preload', 'history.ts'), 'utf8')
  const renderer = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'history', 'history.ts'), 'utf8')
  const historyHtml = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'history', 'history.html'), 'utf8')
  const toastMain = readFileSync(path.join(process.cwd(), 'src', 'main', 'saveToast.ts'), 'utf8')
  const toastPreload = readFileSync(path.join(process.cwd(), 'src', 'preload', 'toast.ts'), 'utf8')
  const exporter = readFileSync(path.join(process.cwd(), 'src', 'main', 'exporter.ts'), 'utf8')
  const storage = readFileSync(path.join(process.cwd(), 'src', 'main', 'storage.ts'), 'utf8')
  const sharedIpc = readFileSync(path.join(process.cwd(), 'src', 'shared', 'ipc.ts'), 'utf8')
  const mainPlanHandler = history.slice(
    history.indexOf('IPC.historyPlanShare'),
    history.indexOf('IPC.historyShareStill'),
  )
  const mainPlanBuiltAt = mainPlanHandler.indexOf(
    'const historyPlan = await sharePlanForHistory(plan)',
  )
  const mainLateSenderGuardAt = mainPlanHandler.indexOf(
    'if (!fromHistory(event))',
    mainPlanBuiltAt,
  )
  const mainPlanCacheWriteAt = mainPlanHandler.indexOf(
    'sharePlanCache.set(entry.path, plan)',
  )
  const rendererPlanHandler = renderer.slice(
    renderer.indexOf('function beginShareReview'),
    renderer.indexOf('function buildShareReview'),
  )
  const rendererPlanResultAt = rendererPlanHandler.indexOf(
    'const result = await bridge.planShare(p.path)',
  )
  const rendererLateGuardAt = rendererPlanHandler.indexOf(
    'if (request !== sharePlanRequest || sharingFor !== p.path) return',
    rendererPlanResultAt,
  )
  const rendererPlanCommitAt = rendererPlanHandler.indexOf('sharePlan = result.plan')
  const canonicalPngSource = shareBundle.slice(
    shareBundle.indexOf('function canonicalPng(bytes: Buffer): Buffer'),
    shareBundle.indexOf('function paeth'),
  )
  const decodedBudgetAt = canonicalPngSource.indexOf(
    'const decodedRasterBytes = width * height * 4',
  )
  const inflateAt = canonicalPngSource.indexOf('inflateSync(')
  check('History sender/ref guards own every Share Copy IPC route',
    history.includes('IPC.historyPlanShare') &&
      history.includes('IPC.historyShareStill') &&
      history.includes('IPC.historyCreateShare') &&
      history.includes('fromHistory(event)') &&
      history.includes('entryFor(ref)'))
  check('History review passes an opaque revision into creation',
    preload.includes('createShare(packPath: string, revision: string)') &&
      renderer.includes('bridge.createShare(p.path, plan.revision)'))
  check('Share publication, backup, restore and recovery use no-replace moves',
    shareBundle.includes("from './moveNoReplace'") &&
      !shareBundle.includes('await rename(') &&
      shareBundle.includes('await moveShareNoReplace(destination, backup)') &&
      shareBundle.includes('await moveShareNoReplace(backup, destination)') &&
      shareBundle.includes("error.code === 'EEXIST'") &&
      shareBundle.includes("new ShareBundleError('output-conflict')"))
  check('History forward, rollback and case-only renames use no-replace moves',
    history.includes("from './moveNoReplace'") &&
      !history.includes('await rename(') &&
      history.includes('await moveHistoryNoReplace(move.from, move.to)') &&
      history.includes('await moveHistoryNoReplace(entry.path, target)') &&
      history.includes('await moveHistoryNoReplace(move.to, move.from)') &&
      history.includes('`.capturepack-case-rename-${randomUUID()}.tmp`') &&
      history.includes('await moveNoReplace(temporary, destination)') &&
      history.includes('await moveNoReplace(temporary, source)') &&
      history.includes("liveT()('history.errNameExists')"))
  check('rendering and pack mutations cannot race Share Copy publication',
    history.includes('isRenderInFlight(entry.path)') &&
      history.includes('beginPackOperation(entry.path)') &&
      storage.includes('beginPackOperation(pack.path)') &&
      [...annotatedRender.matchAll(/const finishTracking = beginTrackedRender\(handle\.dirPath\)/gu)].length === 3 &&
      annotatedRender.includes('new PackRenderBatchTracker(beginPackOperation, emitRenderState)'))
  check('every rendered label reaches the local review without truncation',
    history.includes('visibleLabels: plan.visibleLabels') && !history.includes('MAX_REVIEW_LABELS'))
  check('every planned still reaches confirmation without preview sampling',
    history.includes('for (const entry of stills)') &&
      history.includes('nativeImage.createFromBuffer(canonical.bytes)') &&
      !history.includes('nativeImage.createFromPath(entry.sourcePath)') &&
      history.includes("throw new ShareBundleError('derived-media-missing', entry.sourceRel)") &&
      !history.includes('MAX_SHARE_PREVIEWS') &&
      !history.includes('selectSharePreviews'))
  check('History exposes and renders the writer\'s exact media inventory',
    shareBundle.includes('const publicEntries = plan.entries.map') &&
      shareBundle.includes('media: publicEntries') &&
      sharedIpc.includes('media: Array<{') &&
      history.includes('const stills = plan.entries.filter') &&
      history.includes('media: stills.map') &&
      history.includes('previewCount: previews.length') &&
      history.includes('stillCount: stills.length') &&
      renderer.includes('for (const media of plan.media)'))
  check('decoded RGBA dimensions are capped before inflate while the 64 MiB boundary remains valid',
    decodedBudgetAt >= 0 &&
      inflateAt > decodedBudgetAt &&
      canonicalPngSource.includes('decodedRasterBytes > MAX_SHARE_STILL_BYTES') &&
      !canonicalPngSource.includes('decodedRasterBytes >= MAX_SHARE_STILL_BYTES'))
  check('renderer and main serialize every Share operation globally',
    history.includes('let historyShareOperationInFlight = false') &&
      history.includes('if (historyShareOperationInFlight) return null') &&
      history.includes('historyShareOperationInFlight = true') &&
      history.includes('historyShareOperationInFlight = false') &&
      [...history.matchAll(/const release = beginHistoryShareOperation\(entry\.path\)/gu)]
        .length === 3 &&
      renderer.includes(
        'return sharePlanning.size > 0 || shareStillPending.size > 0 || shareCreating.size > 0',
      ) &&
      [...renderer.matchAll(/if \(shareOperationPending\(\)\) return/gu)].length === 3)
  check('late main and renderer plan results cannot repopulate a stale review cache',
    mainPlanBuiltAt >= 0 &&
      mainLateSenderGuardAt > mainPlanBuiltAt &&
      mainPlanCacheWriteAt > mainLateSenderGuardAt &&
      rendererPlanResultAt >= 0 &&
      rendererLateGuardAt > rendererPlanResultAt &&
      rendererPlanCommitAt > rendererLateGuardAt)
  check('full-resolution inspection is lazy, revision-bound and releases each Blob URL',
    preload.includes('shareStill(packPath: string, revision: string, index: number)') &&
      renderer.includes('.shareStill(p.path, plan.revision, index)') &&
      renderer.includes('request !== shareStillRequest') &&
      renderer.includes('URL.revokeObjectURL(shareInspectorUrl)') &&
      historyHtml.includes("img-src 'self' data: blob:"))
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
  const stillWidth = stillPng.readUInt32BE(16)
  const stillHeight = stillPng.readUInt32BE(20)
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
        { width: stillWidth, height: stillHeight, scale: 1 },
        { width: stillWidth, height: stillHeight, scale: 1 },
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
          snapshot_width: stillWidth,
          snapshot_height: stillHeight,
          replay: 'replay.webm',
          replay_duration_ms: 1_000,
          bounds: { x: 0, y: 0, width: stillWidth, height: stillHeight },
          scale: 1,
          focused: true,
        },
        {
          index: 2,
          snapshot: 'snapshot-d2.png',
          snapshot_width: stillWidth,
          snapshot_height: stillHeight,
          replay: 'replay-d2.webm',
          replay_duration_ms: 1_000,
          replay_annotated: 'replay_annotated-d2.webm',
          keyframes: [{ file: 'frames-d2/frame-01_00-01.000.png', t_ms: 1_000 }],
          bounds: { x: stillWidth, y: 0, width: stillWidth, height: stillHeight },
          scale: 1,
          focused: false,
        },
      ],
    },
    plugins: [{ name: 'chrome-dom', version: '1', path: 'plugins/chrome-dom/' }],
  }
  const annotations = {
    reference_width: stillWidth,
    reference_height: stillHeight,
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
  manifest.media.replay = null
  manifest.media.image_scope = 'fullscreen'
  delete manifest.media.replay_duration_ms
  delete manifest.media.replay_annotated
  delete manifest.media.displays
  manifest.media.keyframes = [
    { file: 'frames/frame-01_00-00.000.png', t_ms: 0 },
  ]
  manifest.environment.screens = [manifest.environment.screens[0]]
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
  const annotationsFile = path.join(fixture.dir, 'annotations.json')
  const annotations = JSON.parse(readFileSync(annotationsFile, 'utf8'))
  annotations.annotations = annotations.annotations.slice(0, 1)
  writeFileSync(annotationsFile, `${JSON.stringify(annotations, null, 2)}\n`)
  // The image still is rendered from this exact annotations revision.
  writeFileSync(path.join(fixture.dir, 'frames', 'frame-01_00-00.000.png'), PNG)
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

function declaredGreyPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    testPngChunk('IHDR', ihdr),
    // Structurally valid but deliberately far too short for the declared
    // raster. The overflow case must reject from IHDR before this is inflated.
    testPngChunk('IDAT', deflateSync(Buffer.alloc(0))),
    testPngChunk('IEND', Buffer.alloc(0)),
  ])
}

function transparentGreyPng(): { name: string; png: Buffer; pixels: Buffer } {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(2, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 0
  return {
    name: 'grayscale',
    png: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      testPngChunk('IHDR', ihdr),
      // For bit depths below 16, decoders compare only the low sample bits.
      testPngChunk('tRNS', Buffer.from([0xab, 0x20])),
      testPngChunk('IDAT', deflateSync(Buffer.from([0, 0x20, 0x7f]))),
      testPngChunk('IEND', Buffer.alloc(0)),
    ]),
    pixels: Buffer.from([
      0x20, 0x20, 0x20, 0,
      0x7f, 0x7f, 0x7f, 0xff,
    ]),
  }
}

function transparentRgbPng(): { name: string; png: Buffer; pixels: Buffer } {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(2, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return {
    name: 'RGB',
    png: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      testPngChunk('IHDR', ihdr),
      testPngChunk('tRNS', Buffer.from([0x91, 0x12, 0x82, 0x34, 0x73, 0x56])),
      testPngChunk(
        'IDAT',
        deflateSync(Buffer.from([0, 0x12, 0x34, 0x56, 0x12, 0x34, 0x57])),
      ),
      testPngChunk('IEND', Buffer.alloc(0)),
    ]),
    pixels: Buffer.from([
      0x12, 0x34, 0x56, 0,
      0x12, 0x34, 0x57, 0xff,
    ]),
  }
}

function pngColorType(bytes: Buffer): number | undefined {
  return bytes.toString('ascii', 12, 16) === 'IHDR' ? bytes[25] : undefined
}

function insertPngChunk(
  bytes: Buffer,
  beforeType: string,
  type: string,
  data: Buffer,
): Buffer {
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const currentType = bytes.toString('ascii', offset + 4, offset + 8)
    if (currentType === beforeType) {
      return Buffer.concat([bytes.subarray(0, offset), testPngChunk(type, data), bytes.subarray(offset)])
    }
    offset += length + 12
  }
  throw new Error(`fixture PNG has no ${beforeType} chunk`)
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
