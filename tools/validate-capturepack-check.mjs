import assert from 'node:assert/strict'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const validator = join(repositoryRoot, 'tools', 'validate-capturepack.mjs')
const temporaryRoot = mkdtempSync(join(tmpdir(), 'capturepack-validator-'))
const pack = join(temporaryRoot, 'chrome-dom.capturepack')
const motionPack = join(temporaryRoot, 'mixed-display-motion.capturepack')
const imagePack = join(temporaryRoot, 'region-image.capturepack')
const viewerPack = join(temporaryRoot, 'offline-viewer.capturepack')
const uiaDisplayPack = join(temporaryRoot, 'uia-display.capturepack')
let checks = 0

function check(message, condition) {
  checks += 1
  assert.ok(condition, message)
  console.log(`  PASS ${message}`)
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function runValidator(target = pack) {
  return spawnSync(process.execPath, [validator, target], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
}

function pngHeader(width, height) {
  const bytes = Buffer.alloc(33)
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes, 0)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

try {
  console.log('CapturePack validator regressions')
  cpSync(join(repositoryRoot, 'examples', 'minimal'), pack, { recursive: true })
  mkdirSync(join(pack, 'plugins', 'chrome-dom'), { recursive: true })

  const manifestFile = join(pack, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  manifest.plugins = [{
    name: 'chrome-dom',
    version: '0.1.0',
    path: 'plugins/chrome-dom/',
  }]
  writeJson(manifestFile, manifest)
  writeJson(join(pack, 'plugins', 'chrome-dom', 'meta.json'), {
    name: 'chrome-dom',
    version: '0.1.0',
  })
  const annotationsFile = join(pack, 'annotations.json')
  const annotations = JSON.parse(readFileSync(annotationsFile, 'utf8'))
  annotations.annotations[0].target = {
    source: 'chrome-dom',
    level: 'control',
    object_id: '#save @0 #0',
    selector: '#save',
    tag: 'button',
    role: 'button',
    url: 'https://example.test/',
    title: 'Fixture',
    name: 'Save',
  }
  writeJson(annotationsFile, annotations)

  const elementsFile = join(pack, 'plugins', 'chrome-dom', 'elements.json')
  writeJson(elementsFile, {
    protocol: 1,
    extension_version: '0.1.8',
    events: [{
      t_ms: 0,
      type: 'dom.element.selected',
      tab: { url: 'https://example.test/', title: 'Fixture' },
      element: {
        tag: 'button',
        selector: '#save',
        bounds: { x: 10, y: 20, width: 80, height: 24 },
      },
    }],
  })

  const valid = runValidator()
  check('a declared Chrome DOM payload returns a normal VALID outcome',
    valid.status === 0 && valid.stdout.includes('result: VALID'))
  check('the valid payload reaches Chrome DOM validation',
    valid.stdout.includes('1 event(s), 1 picked element(s), all on the replay clock'))
  check('a persisted Chrome DOM annotation target is recognized',
    valid.stdout.includes('1 Chrome DOM target(s) preserve provider identity across save/reopen'))
  check('the validator never emits an uncaught ReferenceError',
    !`${valid.stdout}\n${valid.stderr}`.includes('ReferenceError'))

  writeJson(elementsFile, {
    protocol: 1,
    extension_version: '0.1.8',
    events: [],
  })
  const invalid = runValidator()
  check('a malformed Chrome DOM payload returns a normal INVALID outcome',
    invalid.status === 1 && invalid.stdout.includes('result: INVALID'))
  check('the invalid payload reports the validation failure instead of crashing',
    invalid.stdout.includes('.events is empty')
      && !`${invalid.stdout}\n${invalid.stderr}`.includes('ReferenceError'))

  writeFileSync(elementsFile, '{\n', 'utf8')
  const invalidJson = runValidator()
  check('invalid Chrome DOM JSON is a normal validation failure',
    invalidJson.status === 1
      && invalidJson.stdout.includes('not valid JSON')
      && invalidJson.stdout.includes('result: INVALID'))
  check('invalid Chrome DOM JSON never escapes as an exception',
    !`${invalidJson.stdout}\n${invalidJson.stderr}`.includes('ReferenceError')
      && !invalidJson.stderr.includes('SyntaxError'))

  const validDoc = {
    viewport: {
      width: 1280,
      height: 720,
      device_pixel_ratio: 1,
      scroll_x: 0,
      scroll_y: 0,
    },
    url: 'https://example.test/doc',
    title: 'Doc Title',
    truncated: false,
    visited_count: 10,
    elapsed_ms: 3.5,
    omitted: [],
    elements: [{
      i: 0,
      tag: 'button',
      role: 'button',
      bounds: { x: 10, y: 20, width: 80, height: 24 },
    }],
  }

  writeJson(elementsFile, {
    protocol: 1,
    extension_version: '0.1.8',
    events: [{
      t_ms: 0,
      type: 'dom.document.captured',
      tab: { url: 'https://example.test/', title: 'Fixture' },
      document: validDoc,
    }],
  })
  const capturedDocRes = runValidator()
  check('validate-capturepack recognizes dom.document.captured as known event',
    capturedDocRes.status === 0 && capturedDocRes.stdout.includes('result: VALID'))
  check('dom.document.captured does not emit unknown event type note',
    !capturedDocRes.stdout.includes('event(s) of a type this validator does not know'))

  const invalidDocViewport = JSON.parse(JSON.stringify(validDoc))
  delete invalidDocViewport.viewport.device_pixel_ratio
  writeJson(elementsFile, {
    protocol: 1,
    extension_version: '0.1.8',
    events: [{
      t_ms: 0,
      type: 'dom.document.captured',
      tab: { url: 'https://example.test/', title: 'Fixture' },
      document: invalidDocViewport,
    }],
  })
  const missingViewportRes = runValidator()
  check('validateChromeDom rejects document with missing viewport properties',
    missingViewportRes.status === 1
      && missingViewportRes.stdout.includes('result: INVALID')
      && missingViewportRes.stdout.includes('document.viewport MUST carry numbers'))

  const invalidDocElements = JSON.parse(JSON.stringify(validDoc))
  invalidDocElements.elements = [{ i: 0, tag: 'div' }]
  writeJson(elementsFile, {
    protocol: 1,
    extension_version: '0.1.8',
    events: [{
      t_ms: 0,
      type: 'dom.document.captured',
      tab: { url: 'https://example.test/', title: 'Fixture' },
      document: invalidDocElements,
    }],
  })
  const malformedElRes = runValidator()
  check('validateChromeDom rejects document with malformed element entry',
    malformedElRes.status === 1
      && malformedElRes.stdout.includes('result: INVALID')
      && malformedElRes.stdout.includes('document.elements[0] MUST be an object with'))

  // age_ms rules for still image captures vs video/replay packs (SPEC §11.4)
  manifest.format_version = '0.3.0'
  manifest.capture_kind = 'image'
  manifest.media.image_scope = 'fullscreen'
  rmSync(join(pack, 'timeline.json'), { force: true })
  rmSync(join(pack, 'skills', 'timeline.md'), { force: true })
  writeJson(manifestFile, manifest)

  writeJson(elementsFile, {
    protocol: 1,
    extension_version: '0.1.8',
    events: [{
      t_ms: 0,
      type: 'dom.document.captured',
      tab: { url: 'https://example.test/', title: 'Fixture' },
      document: validDoc,
    }],
  })
  const missingAgeStillRes = runValidator()
  check('validateChromeDom rejects still image event missing age_ms',
    missingAgeStillRes.status === 1
      && missingAgeStillRes.stdout.includes('result: INVALID')
      && missingAgeStillRes.stdout.includes('age_ms is REQUIRED in a still capture'))

  writeJson(elementsFile, {
    protocol: 1,
    extension_version: '0.1.8',
    events: [{
      t_ms: 0,
      age_ms: 0,
      type: 'dom.document.captured',
      tab: { url: 'https://example.test/', title: 'Fixture' },
      document: validDoc,
    }],
  })
  const validStillRes = runValidator()
  check('validateChromeDom accepts still image event with valid age_ms',
    validStillRes.status === 0 && validStillRes.stdout.includes('result: VALID'))

  manifest.capture_kind = 'video'
  manifest.media.replay = 'replay.webm'
  manifest.media.replay_duration_ms = 1_000
  delete manifest.media.image_scope
  writeFileSync(join(pack, 'replay.webm'), Buffer.alloc(0))
  writeJson(manifestFile, manifest)

  writeJson(elementsFile, {
    protocol: 1,
    extension_version: '0.1.8',
    events: [{
      t_ms: 0,
      age_ms: 0,
      type: 'dom.document.captured',
      tab: { url: 'https://example.test/', title: 'Fixture' },
      document: validDoc,
    }],
  })
  const replayWithAgeRes = runValidator()
  check('validateChromeDom rejects replay pack event carrying age_ms',
    replayWithAgeRes.status === 1
      && replayWithAgeRes.stdout.includes('result: INVALID')
      && replayWithAgeRes.stdout.includes('age_ms MUST NOT appear in a replay pack'))

  writeJson(elementsFile, {
    protocol: 1,
    extension_version: '0.1.8',
    events: [{
      t_ms: 0,
      type: 'dom.document.captured',
      tab: { url: 'https://example.test/', title: 'Fixture' },
      document: validDoc,
    }],
  })
  const replayWithoutAgeRes = runValidator()
  check('validateChromeDom accepts replay pack event omitting age_ms',
    replayWithoutAgeRes.status === 0 && replayWithoutAgeRes.stdout.includes('result: VALID'))

  cpSync(join(repositoryRoot, 'examples', 'minimal'), viewerPack, { recursive: true })
  writeFileSync(join(viewerPack, 'viewer.html'), '<!doctype html><title>CapturePack</title>', 'utf8')
  const viewerManifestFile = join(viewerPack, 'manifest.json')
  const viewerManifest = JSON.parse(readFileSync(viewerManifestFile, 'utf8'))
  const viewerOnOldFormat = runValidator(viewerPack)
  check('viewer.html requires format 0.5 or later',
    viewerOnOldFormat.status === 1
      && viewerOnOldFormat.stdout.includes('older than 0.5.0'))
  viewerManifest.format_version = '0.5.0'
  writeJson(viewerManifestFile, viewerManifest)
  const viewerOnCurrentFormat = runValidator(viewerPack)
  check('format 0.5 accepts the fixed-name optional viewer',
    viewerOnCurrentFormat.status === 0
      && viewerOnCurrentFormat.stdout.includes('fixed-name offline generated view'))

  cpSync(join(repositoryRoot, 'examples', 'minimal'), motionPack, { recursive: true })
  writeFileSync(join(motionPack, 'snapshot-d1.png'), pngHeader(800, 600))
  writeFileSync(join(motionPack, 'replay.webm'), Buffer.alloc(0))
  writeFileSync(join(motionPack, 'replay-d1.webm'), Buffer.alloc(0))
  const motionManifestFile = join(motionPack, 'manifest.json')
  const motionManifest = JSON.parse(readFileSync(motionManifestFile, 'utf8'))
  motionManifest.format_version = '0.3.0'
  motionManifest.environment.screens = [
    { width: 800, height: 600, scale: 1 },
    { width: 640, height: 400, scale: 1 },
  ]
  motionManifest.media.replay = 'replay.webm'
  motionManifest.media.replay_duration_ms = 1_000
  motionManifest.media.displays = [
    {
      index: 1,
      bounds: { x: -800, y: 0, width: 800, height: 600 },
      scale: 1,
      snapshot: 'snapshot-d1.png',
      replay: 'replay-d1.webm',
      replay_duration_ms: 975,
      replay_clock_offset_ms: -37,
      focused: false,
    },
    {
      index: 2,
      bounds: { x: 0, y: 0, width: 640, height: 400 },
      scale: 1,
      snapshot: 'snapshot.png',
      replay: 'replay.webm',
      replay_duration_ms: 1_000,
      replay_clock_offset_ms: 0,
      focused: true,
    },
  ]
  writeJson(motionManifestFile, motionManifest)

  const motionAnnotationsFile = join(motionPack, 'annotations.json')
  const motionAnnotations = JSON.parse(readFileSync(motionAnnotationsFile, 'utf8'))
  motionAnnotations.annotations[0].keyframes = [
    { t_ms: 100, x: 304, y: 280, width: 168, height: 56 },
    { t_ms: 200, display: 1, x: 700, y: 500, width: 50, height: 50 },
  ]
  writeJson(motionAnnotationsFile, motionAnnotations)

  const validMotion = runValidator(motionPack)
  check('mixed-display authored keyframes validate against their own snapshots',
    validMotion.status === 0
      && validMotion.stdout.includes('2 authored position(s), ascending and within each keyframe'))

  motionManifest.format_version = '0.4.0'
  motionManifest.media.cadence = {
    achieved_fps: 14.8,
    worst_stall_ms: 114,
    discarded_frames: 1,
    requested_fps: 15,
    backend: 'chromium-desktop-capture',
    quality: 'full',
    recorder_count: 1,
  }
  motionManifest.media.displays[0].cadence = {
    achieved_fps: 5,
    worst_stall_ms: 250,
    requested_fps: 15,
    backend: 'windows-gdi-bitblt',
    quality: 'degraded',
    recorder_count: 1,
  }
  motionManifest.media.displays[1].cadence = {
    ...motionManifest.media.cadence,
  }
  writeJson(motionManifestFile, motionManifest)
  const validCaptureDiagnostics = runValidator(motionPack)
  check('format 0.4 accepts honest per-display capture diagnostics',
    validCaptureDiagnostics.status === 0
      && validCaptureDiagnostics.stdout.includes('capture provenance is honest'))

  motionManifest.media.cadence.backend = 'native-dxgi'
  motionManifest.media.displays[1].cadence.backend = 'native-dxgi'
  writeJson(motionManifestFile, motionManifest)
  const validNativeCadence = runValidator(motionPack)
  check('native snapshot cadence provenance is accepted beside its replay',
    validNativeCadence.status === 0
      && validNativeCadence.stdout.includes('capture provenance is honest'))
  motionManifest.media.cadence.backend = 'chromium-desktop-capture'
  motionManifest.media.displays[1].cadence.backend = 'chromium-desktop-capture'

  motionManifest.media.cadence.requested_fps = 1
  motionManifest.media.displays[1].cadence.requested_fps = 1
  writeJson(motionManifestFile, motionManifest)
  const validLegacyRequestedFps = runValidator(motionPack)
  check('legacy requested_fps=1 provenance remains readable',
    validLegacyRequestedFps.status === 0
      && validLegacyRequestedFps.stdout.includes('capture provenance is honest'))

  motionManifest.media.cadence.requested_fps = 0
  motionManifest.media.displays[1].cadence.requested_fps = 0
  writeJson(motionManifestFile, motionManifest)
  const invalidLowRequestedFps = runValidator(motionPack)
  check('requested_fps=0 remains outside the legacy reader range',
    invalidLowRequestedFps.status === 1
      && invalidLowRequestedFps.stdout.includes('requested_fps MUST be a number in 1..30'))

  motionManifest.media.cadence.requested_fps = 15
  motionManifest.media.displays[1].cadence.requested_fps = 15
  motionManifest.media.displays[0].cadence.quality = 'full'
  writeJson(motionManifestFile, motionManifest)
  const dishonestFallback = runValidator(motionPack)
  check('a native GDI fallback cannot claim full quality',
    dishonestFallback.status === 1
      && dishonestFallback.stdout.includes('windows-gdi-bitblt MUST be declared degraded'))

  motionManifest.media.displays[0].cadence.quality = 'degraded'
  motionManifest.media.cadence.requested_fps = 31
  motionManifest.media.displays[1].cadence.requested_fps = 31
  writeJson(motionManifestFile, motionManifest)
  const invalidRequestedFps = runValidator(motionPack)
  check('capture diagnostics enforce the supported 1..30 requested FPS range',
    invalidRequestedFps.status === 1
      && invalidRequestedFps.stdout.includes('requested_fps MUST be a number in 1..30'))

  motionManifest.media.cadence.requested_fps = 15
  motionManifest.media.displays[1].cadence.requested_fps = 30
  writeJson(motionManifestFile, motionManifest)
  const divergentFocusedCadence = runValidator(motionPack)
  check('focused display diagnostics must equal top-level cadence',
    divergentFocusedCadence.status === 1
      && divergentFocusedCadence.stdout.includes('cadence MUST equal top-level media.cadence'))

  delete motionManifest.media.displays[1].cadence
  writeJson(motionManifestFile, motionManifest)
  const missingFocusedCadence = runValidator(motionPack)
  check('focused display missing cadence when top-level cadence is present is rejected (SPEC §5.6, #239)',
    missingFocusedCadence.status === 1
      && missingFocusedCadence.stdout.includes('cadence MUST equal top-level media.cadence'))

  motionManifest.media.displays[1].cadence = {
    ...motionManifest.media.cadence,
  }
  motionManifest.media.displays[1].cadence.requested_fps = 15
  motionManifest.format_version = '0.3.0'
  writeJson(motionManifestFile, motionManifest)
  const diagnosticsOnOldFormat = runValidator(motionPack)
  check('capture provenance requires format 0.4 or later',
    diagnosticsOnOldFormat.status === 1
      && diagnosticsOnOldFormat.stdout.includes('requires format_version 0.4.0 or later'))

  // A MEASURED SOURCE LATENCY MUST SAY WHAT IT WAS MEASURED AGAINST (#115).
  motionManifest.format_version = '0.6.0'
  const measuredLatency = {
    measured_ms: 37.7,
    reference: 'dxgi-desktop-duplication',
    timing: 'pixel-exposure',
    confidence: 0.92,
    uncertainty_ms: 0.4,
  }
  motionManifest.media.cadence.source_latency = { ...measuredLatency }
  motionManifest.media.displays[1].cadence.source_latency = { ...measuredLatency }
  motionManifest.media.displays[0].cadence.source_latency = {
    ...measuredLatency,
    reference: 'windows-gdi-bitblt',
    timing: 'pixel-exposure',
    age_ms: 812_345,
  }
  writeJson(motionManifestFile, motionManifest)
  const validSourceLatency = runValidator(motionPack)
  check('format 0.6 accepts a measured source latency, carried or fresh',
    validSourceLatency.status === 0
      && validSourceLatency.stdout.includes('says what it was measured against'))

  motionManifest.format_version = '0.5.0'
  writeJson(motionManifestFile, motionManifest)
  const latencyOnOldFormat = runValidator(motionPack)
  check('a measured source latency requires format 0.6 or later',
    latencyOnOldFormat.status === 1
      && latencyOnOldFormat.stdout.includes('requires format_version 0.6.0 or later'))

  motionManifest.format_version = '0.6.0'
  delete motionManifest.media.cadence.source_latency.reference
  delete motionManifest.media.displays[1].cadence.source_latency.reference
  writeJson(motionManifestFile, motionManifest)
  const anonymousLatency = runValidator(motionPack)
  check('a latency that will not name its reference is refused',
    anonymousLatency.status === 1
      && anonymousLatency.stdout.includes('MUST name the exposure reference it matched'))

  motionManifest.media.cadence.source_latency.reference = 'dxgi-desktop-duplication'
  motionManifest.media.displays[1].cadence.source_latency.reference = 'dxgi-desktop-duplication'
  motionManifest.media.displays[0].cadence.source_latency.timing = 'post-bitblt-completion'
  writeJson(motionManifestFile, motionManifest)
  const completionAsExposure = runValidator(motionPack)
  check('an operation completion cannot be published as a pixel exposure',
    completionAsExposure.status === 1
      && completionAsExposure.stdout.includes('is not a pixel exposure'))

  motionManifest.media.displays[0].cadence.source_latency.timing = 'pixel-exposure'
  motionManifest.media.cadence.source_latency.measured_ms = -1
  motionManifest.media.displays[1].cadence.source_latency.measured_ms = -1
  writeJson(motionManifestFile, motionManifest)
  const negativeLatency = runValidator(motionPack)
  check('a negative source latency is not a measurement',
    negativeLatency.status === 1
      && negativeLatency.stdout.includes('measured_ms MUST be a non-negative number'))

  motionManifest.media.cadence.source_latency.measured_ms = 37.7
  motionManifest.media.displays[1].cadence.source_latency.measured_ms = 37.7
  motionManifest.media.displays[0].cadence.source_latency.age_ms = 812_345.5
  writeJson(motionManifestFile, motionManifest)
  const fractionalAge = runValidator(motionPack)
  check('a carried measurement declares its age as whole milliseconds',
    fractionalAge.status === 1
      && fractionalAge.stdout.includes('age_ms MUST be an integer >= 0'))

  delete motionManifest.media.cadence
  delete motionManifest.media.displays[0].cadence
  delete motionManifest.media.displays[1].cadence
  motionManifest.format_version = '0.4.0'
  motionManifest.media.displays[1].replay_clock_offset_ms = 7
  writeJson(motionManifestFile, motionManifest)
  const nonzeroFocusedClock = runValidator(motionPack)
  check('the focused display clock offset must be exactly zero',
    nonzeroFocusedClock.status === 1
      && nonzeroFocusedClock.stdout.includes('MUST be 0 on the focused display'))

  motionManifest.media.displays[1].replay_clock_offset_ms = 0
  motionManifest.media.displays[0].replay = null
  motionManifest.media.displays[0].replay_duration_ms = null
  writeJson(motionManifestFile, motionManifest)
  const clockWithoutReplay = runValidator(motionPack)
  check('a display without replay cannot declare a replay clock offset',
    clockWithoutReplay.status === 1
      && clockWithoutReplay.stdout.includes('MUST be absent when replay is null'))

  motionManifest.media.displays[0].replay = 'replay-d1.webm'
  motionManifest.media.displays[0].replay_duration_ms = 975
  delete motionManifest.media.displays[0].replay_clock_offset_ms
  delete motionManifest.media.displays[1].replay_clock_offset_ms
  writeJson(motionManifestFile, motionManifest)
  const legacyClock = runValidator(motionPack)
  check('legacy multi-display packs without measured offsets remain valid',
    legacyClock.status === 0
      && legacyClock.stdout.includes('legacy duration-difference alignment fallback'))

  motionAnnotations.annotations[0].keyframes[1].display = 3
  writeJson(motionAnnotationsFile, motionAnnotations)
  const unknownDisplay = runValidator(motionPack)
  check('an authored keyframe cannot name an undeclared display',
    unknownDisplay.status === 1
      && unknownDisplay.stdout.includes('.display 3 names no display declared'))

  motionAnnotations.annotations[0].keyframes[1].display = 1
  motionAnnotations.annotations[0].keyframes[1].x = 760
  writeJson(motionAnnotationsFile, motionAnnotations)
  const outsideDisplay = runValidator(motionPack)
  check('authored geometry is bounded by the keyframe display, not the annotation display',
    outsideDisplay.status === 1
      && outsideDisplay.stdout.includes('right edge 810 > 800')
      && outsideDisplay.stdout.includes("keyframe's own display snapshot"))

  cpSync(join(repositoryRoot, 'examples', 'minimal'), imagePack, { recursive: true })
  const imageManifestFile = join(imagePack, 'manifest.json')
  const imageManifest = JSON.parse(readFileSync(imageManifestFile, 'utf8'))
  imageManifest.format_version = '0.3.0'
  imageManifest.capture_kind = 'image'
  delete imageManifest.media.replay_duration_ms
  imageManifest.media.image_scope = 'region'
  imageManifest.media.crop_bounds = {
    x: -1140,
    y: 100,
    width: 720,
    height: 480,
    coordinate_space: 'virtual-desktop-dip',
  }
  writeJson(imageManifestFile, imageManifest)
  rmSync(join(imagePack, 'timeline.json'), { force: true })
  rmSync(join(imagePack, 'skills', 'timeline.md'), { force: true })
  const validImage = runValidator(imagePack)
  check('an explicit region image without timeline artifacts is valid',
    validImage.status === 0
      && validImage.stdout.includes('image scope/provenance is explicit and valid')
      && validImage.stdout.includes('timeline.json: absent as required'))

  writeJson(join(imagePack, 'timeline.json'), { events: [] })
  const imageTimeline = runValidator(imagePack)
  check('an explicit image rejects a top-level event timeline',
    imageTimeline.status === 1
      && imageTimeline.stdout.includes('MUST be absent from an explicit still-image pack'))
  rmSync(join(imagePack, 'timeline.json'), { force: true })
  writeFileSync(join(imagePack, 'skills', 'timeline.md'), '# stale timeline\n', 'utf8')
  const imageTimelineSkill = runValidator(imagePack)
  check('an explicit image rejects a stale timeline skill',
    imageTimelineSkill.status === 1
      && imageTimelineSkill.stdout.includes('skills/timeline.md: MUST be absent'))
  rmSync(join(imagePack, 'skills', 'timeline.md'), { force: true })

  mkdirSync(join(imagePack, 'frames'), { recursive: true })
  imageManifest.media.keyframes = [{
    file: 'frames/frame-01_00-00.001.png',
    t_ms: 1,
  }]
  writeFileSync(
    join(imagePack, 'frames', 'frame-01_00-00.001.png'),
    readFileSync(join(imagePack, 'snapshot.png')),
  )
  writeJson(imageManifestFile, imageManifest)
  const timedImageStill = runValidator(imagePack)
  check('an image pack rejects a declared still away from t_ms 0',
    timedImageStill.status === 1
      && timedImageStill.stdout.includes('the one declared still MUST be at t_ms 0'))

  rmSync(join(imagePack, 'frames', 'frame-01_00-00.001.png'))
  imageManifest.media.keyframes = [{
    file: 'frames/frame-01_00-00.000.png',
    t_ms: 0,
  }]
  writeFileSync(join(imagePack, 'frames', 'frame-01_00-00.000.png'), pngHeader(640, 448))
  writeJson(imageManifestFile, imageManifest)
  const bottomGutterStill = runValidator(imagePack)
  check('an image pack accepts a same-width derived still with a result-only bottom gutter',
    bottomGutterStill.status === 0
      && bottomGutterStill.stdout.includes('preserves the 640x400 source viewport at top-left'))

  writeFileSync(join(imagePack, 'frames', 'frame-01_00-00.000.png'), pngHeader(641, 448))
  const widerImageStill = runValidator(imagePack)
  check('an image pack rejects a derived still whose source-width coordinate space changed',
    widerImageStill.status === 1
      && widerImageStill.stdout.includes('MUST preserve the source width and top-left viewport'))

  writeFileSync(join(imagePack, 'frames', 'frame-01_00-00.000.png'), pngHeader(640, 399))
  const shorterImageStill = runValidator(imagePack)
  check('an image pack rejects a derived still shorter than its source viewport',
    shorterImageStill.status === 1
      && shorterImageStill.stdout.includes('MUST preserve the source width and top-left viewport'))

  rmSync(join(imagePack, 'frames', 'frame-01_00-00.000.png'))
  delete imageManifest.media.keyframes
  writeJson(imageManifestFile, imageManifest)

  mkdirSync(join(imagePack, 'plugins', 'hidden-context'), { recursive: true })
  writeFileSync(join(imagePack, 'plugins', 'hidden-context', 'context.blob'), pngHeader(1920, 1080))
  const disguisedRaster = runValidator(imagePack)
  check('an image pack rejects a raster disguised inside a plugin',
    disguisedRaster.status === 1
      && disguisedRaster.stdout.includes('plugins/hidden-context/context.blob')
      && disguisedRaster.stdout.includes('hidden raster/video source media are forbidden'))

  // A WINDOW'S CLIENT RECTANGLE (SPEC §11.3, payload 0.5.0).
  //
  // The only route by which a chrome-dom page becomes placeable, so a payload
  // that carries a broken one has silently earned a reader's refusal of the
  // whole document while reading as valid in every other respect. That is the
  // failure mode §11.3 is written against, and it is why the validator tests the
  // rectangle against the frame it claims to be inside rather than merely
  // checking that four numbers are present.
  rmSync(join(imagePack, 'plugins', 'hidden-context'), { recursive: true, force: true })
  mkdirSync(join(imagePack, 'plugins', 'windows-uia'), { recursive: true })
  imageManifest.plugins = [{
    name: 'windows-uia',
    version: '0.5.0',
    path: 'plugins/windows-uia/',
  }]
  writeJson(imageManifestFile, imageManifest)
  writeJson(join(imagePack, 'plugins', 'windows-uia', 'meta.json'), {
    name: 'windows-uia',
    version: '0.5.0',
  })
  const uiaFile = join(imagePack, 'plugins', 'windows-uia', 'elements.json')
  const uiaPayload = (clientBounds) => ({
    captured_at: '2026-08-02T00:59:13+09:00',
    budget_ms: 3000,
    truncated: false,
    windows: [{
      hwnd: '9001',
      title: 'Checkout — Example - Chrome',
      process: 'chrome',
      class_name: 'Chrome_WidgetWin_1',
      bounds: { x: 100, y: 50, width: 1200, height: 951 },
      ...(clientBounds === null ? {} : { client_bounds: clientBounds }),
      focused: true,
      z: 0,
      tree: 'collected',
      element_count: 0,
    }],
    elements: [],
  })

  writeJson(uiaFile, uiaPayload({ x: 108, y: 58, width: 1184, height: 935 }))
  const withClient = runValidator(imagePack)
  check('a window carrying a client rectangle is valid and counted',
    withClient.status === 0
      && withClient.stdout.includes('1 window(s), 1 with a client rectangle'))

  writeJson(uiaFile, uiaPayload(null))
  const withoutClient = runValidator(imagePack)
  check('a window without one is equally valid — absence means "not measured"',
    withoutClient.status === 0
      && withoutClient.stdout.includes('1 window(s), 0 with a client rectangle'))

  writeJson(uiaFile, uiaPayload({ x: 90, y: 58, width: 1184, height: 935 }))
  const outsideClient = runValidator(imagePack)
  check('a client rectangle reaching outside its own frame is rejected',
    outsideClient.status === 1
      && outsideClient.stdout.includes('is not inside its own window'))

  writeJson(uiaFile, uiaPayload({ x: 108, y: 58, width: 0, height: 935 }))
  const emptyClient = runValidator(imagePack)
  check('a client rectangle with no area is rejected rather than treated as absent',
    emptyClient.status === 1 && emptyClient.stdout.includes('has no area'))

  writeJson(uiaFile, uiaPayload({ x: 108, y: 58, width: 1184 }))
  const malformedClient = runValidator(imagePack)
  check('a client rectangle missing a side is rejected',
    malformedClient.status === 1
      && malformedClient.stdout.includes('client_bounds MUST be { x, y, width, height }'))

  // WINDOW AND ELEMENT DISPLAY COORDINATE SPACE RESOLUTION (SPEC §11.3, #232).
  //
  // In SPEC §11.3, an omitted `display` on a window or element denotes the
  // focused display. Explicitly declaring the focused display index is also
  // conforming and legal (issuing an advisory note). Coordinate space agreement
  // between a control and its window must compare the resolved displays, so
  // mixing explicit and omitted representations for the focused display is
  // accepted as VALID.
  cpSync(join(repositoryRoot, 'examples', 'minimal'), uiaDisplayPack, { recursive: true })
  const uiaDisplayManifestFile = join(uiaDisplayPack, 'manifest.json')
  const uiaDisplayManifest = JSON.parse(readFileSync(uiaDisplayManifestFile, 'utf8'))
  uiaDisplayManifest.format_version = '0.7.0'
  uiaDisplayManifest.environment.screens = [
    { width: 640, height: 400, scale: 1 },
    { width: 800, height: 600, scale: 1 },
  ]
  uiaDisplayManifest.media.displays = [
    {
      index: 1,
      focused: true,
      bounds: { x: 0, y: 0, width: 640, height: 400 },
      scale: 1,
      snapshot: 'snapshot.png',
      snapshot_width: 640,
      snapshot_height: 400,
      replay: null,
    },
    {
      index: 2,
      focused: false,
      bounds: { x: 640, y: 0, width: 800, height: 600 },
      scale: 1,
      snapshot: 'snapshot-d2.png',
      snapshot_width: 800,
      snapshot_height: 600,
      replay: null,
    },
  ]
  writeFileSync(join(uiaDisplayPack, 'snapshot-d2.png'), pngHeader(800, 600))
  uiaDisplayManifest.plugins = [{
    name: 'windows-uia',
    version: '0.5.0',
    path: 'plugins/windows-uia/',
  }]
  writeJson(uiaDisplayManifestFile, uiaDisplayManifest)
  mkdirSync(join(uiaDisplayPack, 'plugins', 'windows-uia'), { recursive: true })
  writeJson(join(uiaDisplayPack, 'plugins', 'windows-uia', 'meta.json'), {
    name: 'windows-uia',
    version: '0.5.0',
  })

  const uiaDisplayElementsFile = join(uiaDisplayPack, 'plugins', 'windows-uia', 'elements.json')
  const makeUiaDisplayPayload = (windowDisplay, elementDisplay) => ({
    captured_at: uiaDisplayManifest.created_at,
    budget_ms: 500,
    truncated: false,
    windows: [{
      title: 'Test Window',
      process: 'test',
      class_name: 'TestClass',
      focused: true,
      bounds: { x: 0, y: 0, width: 640, height: 400 },
      z: 0,
      tree: 'collected',
      element_count: 1,
      ...(windowDisplay !== undefined ? { display: windowDisplay } : {}),
    }],
    elements: [{
      name: 'Test Button',
      control_type: 'Button',
      automation_id: 'btn1',
      class_name: 'Button',
      bounds: { x: 10, y: 10, width: 100, height: 30 },
      depth: 1,
      window: 0,
      ...(elementDisplay !== undefined ? { display: elementDisplay } : {}),
    }],
  })

  writeJson(uiaDisplayElementsFile, makeUiaDisplayPayload(undefined, 1))
  const omittedWinExplicitEl = runValidator(uiaDisplayPack)
  check('windows-uia accepts omitted window display with explicit focused element display',
    omittedWinExplicitEl.status === 0
      && omittedWinExplicitEl.stdout.includes('result: VALID')
      && omittedWinExplicitEl.stdout.includes('elements[0].display 1 names the FOCUSED display'))

  writeJson(uiaDisplayElementsFile, makeUiaDisplayPayload(1, undefined))
  const explicitWinOmittedEl = runValidator(uiaDisplayPack)
  check('windows-uia accepts explicit focused window display with omitted element display',
    explicitWinOmittedEl.status === 0
      && explicitWinOmittedEl.stdout.includes('result: VALID')
      && explicitWinOmittedEl.stdout.includes('windows[0].display 1 names the FOCUSED display'))

  writeJson(uiaDisplayElementsFile, makeUiaDisplayPayload(undefined, 2))
  const omittedWinDifferentEl = runValidator(uiaDisplayPack)
  check('windows-uia rejects element on different display when window display is omitted (focused)',
    omittedWinDifferentEl.status === 1
      && omittedWinDifferentEl.stdout.includes('elements[0].display 2 disagrees with windows[z=0].display null'))

  writeJson(uiaDisplayElementsFile, makeUiaDisplayPayload(2, undefined))
  const differentWinOmittedEl = runValidator(uiaDisplayPack)
  check('windows-uia rejects omitted element display when window is on a non-focused display',
    differentWinOmittedEl.status === 1
      && differentWinOmittedEl.stdout.includes('elements[0].display null disagrees with windows[z=0].display 2'))

  writeJson(uiaDisplayElementsFile, makeUiaDisplayPayload(1, 2))
  const explicitDisagreement = runValidator(uiaDisplayPack)
  check('windows-uia rejects genuinely disagreeing explicit window and element displays',
    explicitDisagreement.status === 1
      && explicitDisagreement.stdout.includes('elements[0].display 2 disagrees with windows[z=0].display 1'))

  // WINDOW CLIENT BOUNDS ON SECONDARY DISPLAY (SPEC §11.3, #217).
  //
  // A window on a secondary display mapped to snapshot pixel coordinates carries
  // client_bounds also mapped to that snapshot. When client_bounds is correctly
  // mapped within the window's bounds, validation passes. If client_bounds is
  // unmapped (e.g. left in desktop coordinates), validator fails with containment error.
  const makeMultiDisplayClientPayload = (secondaryClientBounds) => ({
    captured_at: uiaDisplayManifest.created_at,
    budget_ms: 500,
    truncated: false,
    windows: [
      {
        title: 'Focused Window',
        process: 'test',
        class_name: 'TestClass',
        focused: true,
        bounds: { x: 0, y: 0, width: 640, height: 400 },
        client_bounds: { x: 8, y: 30, width: 624, height: 360 },
        z: 0,
        tree: 'collected',
        element_count: 1,
      },
      {
        title: 'Secondary Window',
        process: 'test',
        class_name: 'TestClass',
        focused: false,
        display: 2,
        bounds: { x: 50, y: 50, width: 700, height: 500 },
        ...(secondaryClientBounds !== undefined ? { client_bounds: secondaryClientBounds } : {}),
        z: 1,
        tree: 'collected',
        element_count: 1,
      },
    ],
    elements: [
      {
        name: 'Btn 1',
        control_type: 'Button',
        automation_id: 'b1',
        class_name: 'Button',
        bounds: { x: 10, y: 40, width: 100, height: 30 },
        depth: 1,
        window: 0,
      },
      {
        name: 'Btn 2',
        control_type: 'Button',
        automation_id: 'b2',
        class_name: 'Button',
        display: 2,
        bounds: { x: 60, y: 90, width: 100, height: 30 },
        depth: 1,
        window: 1,
      },
    ],
  })

  writeJson(uiaDisplayElementsFile, makeMultiDisplayClientPayload({ x: 58, y: 80, width: 684, height: 460 }))
  const validMultiDisplayClient = runValidator(uiaDisplayPack)
  check('windows-uia accepts correctly mapped client_bounds on secondary display (SPEC §11.3)',
    validMultiDisplayClient.status === 0
      && validMultiDisplayClient.stdout.includes('result: VALID')
      && validMultiDisplayClient.stdout.includes('2 window(s), 2 with a client rectangle'))

  // Unmapped client_bounds in desktop coordinates (e.g. x=698 > bounds.x + bounds.width=750 on display 2)
  writeJson(uiaDisplayElementsFile, makeMultiDisplayClientPayload({ x: 698, y: 80, width: 684, height: 460 }))
  const unmappedSecondaryClient = runValidator(uiaDisplayPack)
  check('windows-uia rejects unmapped desktop-coordinate client_bounds on secondary display',
    unmappedSecondaryClient.status === 1
      && unmappedSecondaryClient.stdout.includes('is not inside its own window\'s bounds'))

  console.log(`\n${checks}/${checks} CapturePack validator checks passed`)
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
