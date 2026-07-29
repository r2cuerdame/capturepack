// Image-pack contract and MCP exposure regression check.
//
// A region capture is intentionally LESS evidence than a normal video capture:
// the pixels outside the rectangle were never consented to. This check pins the
// privacy boundary in the storage model, rather than relying on a UI promise.
import {
  captureKindOf,
  captureMediaForMcp,
  captureMediaViolations,
  type ImageCropBounds,
} from '../src/shared/captureMedia'

let failed = 0

function check(ok: boolean, message: string): void {
  if (!ok) failed += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${message}`)
}

const crop: ImageCropBounds = {
  x: -1140,
  y: 120,
  width: 720,
  height: 480,
  coordinate_space: 'virtual-desktop-dip',
}

const regionManifest = {
  capture_kind: 'image',
  media: {
    snapshot: 'snapshot.png',
    replay: null,
    image_scope: 'region',
    crop_bounds: crop,
  },
}

console.log('KIND + MCP VIEW')
check(captureKindOf(regionManifest) === 'image', 'an explicit region capture is an image')
check(
  captureKindOf({ media: { snapshot: 'snapshot.png', replay: 'replay.webm' } }) === 'video',
  'legacy packs with a replay remain video captures',
)
check(
  captureKindOf({
    format_version: '0.3.0',
    media: {
      snapshot: 'snapshot.png',
      replay: 'replay.webm',
      keyframes: [{ file: 'frames/frame-01_00-00.000.png', t_ms: 0 }],
    },
  }) === 'video',
  'a keyframe-era 0.3 pack without capture_kind remains a legacy video',
)
check(
  captureKindOf({ media: { snapshot: 'snapshot.png', replay: null } }) === 'video',
  'legacy screenshot-only packs retain their failed-recorder video intent',
)
const legacyNoReplayMcp = captureMediaForMcp({
  format_version: '0.3.0',
  media: { snapshot: 'snapshot.png', replay: null },
})
check(
  legacyNoReplayMcp.capture_kind === 'video' &&
    legacyNoReplayMcp.legacy_inferred &&
    legacyNoReplayMcp.snapshot.scope === 'video_frame' &&
    legacyNoReplayMcp.replay === null,
  'MCP reports capture_kind-absent screenshot-only evidence as legacy video',
)
const regionMcp = captureMediaForMcp(regionManifest)
check(regionMcp.capture_kind === 'image', 'MCP states capture_kind explicitly')
check(regionMcp.snapshot.scope === 'region', 'MCP states that snapshot.png is a crop')
check(
  JSON.stringify(regionMcp.snapshot.crop_bounds) === JSON.stringify(crop),
  'MCP exposes crop placement provenance',
)
check(regionMcp.replay === null, 'MCP never advertises a replay for an image pack')
check(
  !('full_context' in regionMcp.snapshot) && !('context_full' in regionMcp.snapshot),
  'MCP has no hidden/full-context image route',
)

console.log('VALID IMAGE PACKS')
check(
  captureMediaViolations(regionManifest, [
    'manifest.json',
    'snapshot.png',
    'annotations.json',
    'report.md',
  ]).length === 0,
  'a cropped still pack with image, annotations and report is valid',
)
check(
  captureMediaViolations(regionManifest, [
    'manifest.json',
    'snapshot.png',
    'annotations.json',
    'timeline.json',
  ]).some((v) => v.code === 'image.timeline_forbidden'),
  'an explicit image pack rejects a video event timeline',
)
check(
  captureMediaViolations({
    capture_kind: 'image',
    media: {
      snapshot: 'snapshot.png',
      replay: null,
      image_scope: 'fullscreen',
    },
  }).length === 0,
  'an explicitly requested full virtual desktop uses snapshot.png itself',
)

console.log('PRIVACY + FORMAT FAILURES')
const secondImage = captureMediaViolations(regionManifest, [
  'manifest.json',
  'snapshot.png',
  'context-full.png',
])
check(
  secondImage.some((v) => v.code === 'image.unexpected_raster_asset'),
  'a cropped pack rejects context-full.png',
)
const disguisedSecondImage = captureMediaViolations(regionManifest, [
  'manifest.json',
  'snapshot.png',
  'plugins/context/desktop.webp',
])
check(
  disguisedSecondImage.some((v) => v.code === 'image.unexpected_raster_asset'),
  'a second raster is rejected even when hidden under a plugin directory',
)
check(
  captureMediaViolations({
    ...regionManifest,
    media: { ...regionManifest.media, replay: 'replay.webm' },
  }).some((v) => v.code === 'image.replay_forbidden'),
  'image packs cannot declare a replay',
)
check(
  captureMediaViolations({
    capture_kind: 'image',
    media: { snapshot: 'snapshot.png', replay: null, image_scope: 'region' },
  }).some((v) => v.code === 'image.crop_bounds_required'),
  'region images require crop_bounds provenance',
)
check(
  captureMediaViolations({
    capture_kind: 'image',
    media: {
      snapshot: 'snapshot.png',
      replay: null,
      image_scope: 'fullscreen',
      crop_bounds: crop,
    },
  }).some((v) => v.code === 'image.crop_bounds_forbidden'),
  'full-screen images cannot masquerade as a crop',
)
check(
  captureMediaViolations({
    ...regionManifest,
    media: {
      ...regionManifest.media,
      displays: [
        { index: 1, snapshot: 'snapshot.png' },
        { index: 2, snapshot: 'snapshot-d2.png' },
      ],
    },
  }).some((v) => v.code === 'image.per_display_media_forbidden'),
  'image packs cannot smuggle extra per-display source snapshots',
)
check(
  captureMediaViolations({
    capture_kind: 'video',
    media: { snapshot: 'snapshot.png', replay: null },
  }).length === 0,
  'a requested video capture remains video even when its recorder failed',
)

// Annotated stills are derived views of the SAME consented crop, not a second
// source capture. They are allowed only when explicitly declared.
const withDerivedFrame = {
  ...regionManifest,
  media: {
    ...regionManifest.media,
    keyframes: [{ file: 'frames/frame-01_00-00.000.png', t_ms: 0 }],
  },
}
check(
  captureMediaViolations(withDerivedFrame, [
    'snapshot.png',
    'frames/frame-01_00-00.000.png',
  ]).length === 0,
  'a declared annotated still of the crop is allowed',
)
check(
  captureMediaViolations(
    withDerivedFrame,
    ['snapshot.png', 'frames/frame-01_00-00.000.png'],
    [
      { file: 'snapshot.png', width: 1080, height: 720 },
      { file: 'frames/frame-01_00-00.000.png', width: 1080, height: 720 },
    ],
  ).length === 0,
  'an annotated still stays in the exact crop pixel domain',
)
check(
  captureMediaViolations(
    withDerivedFrame,
    ['snapshot.png', 'frames/frame-01_00-00.000.png'],
    [
      { file: 'snapshot.png', width: 1080, height: 720 },
      { file: 'frames/frame-01_00-00.000.png', width: 1920, height: 1080 },
    ],
  ).some((v) => v.code === 'image.raster_dimensions_mismatch'),
  'a crop-derived still cannot expand to full-screen dimensions',
)
check(
  captureMediaViolations(withDerivedFrame, [
    'snapshot.png',
    'frames/frame-01_00-00.000.png',
    'frames/undeclared.png',
  ]).some((v) => v.code === 'image.unexpected_raster_asset'),
  'an undeclared derived-looking image is still rejected',
)
const forgedDerivedFrame = {
  ...regionManifest,
  media: {
    ...regionManifest.media,
    keyframes: [{ file: 'frames/context-full.png', t_ms: 0 }],
  },
}
check(
  captureMediaViolations(forgedDerivedFrame, [
    'snapshot.png',
    'frames/context-full.png',
  ]).some((v) => v.code === 'image.unexpected_raster_asset'),
  'a full-context image cannot be disguised as a declared keyframe',
)

console.log(failed === 0 ? '\nimage-pack-check ok' : `\nimage-pack-check FAILED (${failed})`)
process.exitCode = failed === 0 ? 0 : 1
