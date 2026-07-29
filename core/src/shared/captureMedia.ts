/**
 * Capture-kind extension shared by History, pack validation and MCP.
 *
 * `capture_kind` records what evidence the user explicitly captured. Old packs
 * predate the field, so readers infer their kind from media.replay. New image
 * packs MUST declare image_scope; a region pack records only the selected
 * pixels in snapshot.png and the rectangle's desktop placement provenance.
 */
export type CaptureKind = 'image' | 'video'
export type ImageCaptureScope = 'region' | 'fullscreen'

export interface ImageCropBounds {
  /**
   * Rectangle in Electron/Windows virtual-desktop device-independent pixels.
   * x/y may be negative when a monitor is left of or above the primary.
   */
  x: number
  y: number
  width: number
  height: number
  coordinate_space: 'virtual-desktop-dip'
}

export interface CaptureMediaViolation {
  code:
    | 'capture_kind.invalid'
    | 'media.missing'
    | 'media.snapshot_invalid'
    | 'image.replay_forbidden'
    | 'image.replay_metadata_forbidden'
    | 'image.scope_invalid'
    | 'image.crop_bounds_required'
    | 'image.crop_bounds_forbidden'
    | 'image.per_display_media_forbidden'
    | 'image.timeline_forbidden'
    | 'image.snapshot_missing'
    | 'image.unexpected_raster_asset'
    | 'image.raster_dimensions_invalid'
    | 'image.raster_dimensions_mismatch'
    | 'video.image_metadata_forbidden'
  message: string
  file?: string
}

export interface PackRasterDimensions {
  file: string
  width: number
  height: number
}

export interface McpCaptureMedia {
  capture_kind: CaptureKind
  /** True only for a pre-capture_kind pack whose kind was inferred. */
  legacy_inferred: boolean
  snapshot: {
    file: 'snapshot.png'
    scope: ImageCaptureScope | 'video_frame' | 'legacy_screenshot'
    crop_bounds?: ImageCropBounds
  }
  replay: {
    filename: string
    duration_ms: number | null
  } | null
}

type JsonRecord = Record<string, unknown>

function recordOf(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null
}

function mediaOf(manifest: unknown): JsonRecord | null {
  return recordOf(recordOf(manifest)?.media)
}

function explicitCaptureKind(manifest: unknown): CaptureKind | null {
  const value = recordOf(manifest)?.capture_kind
  return value === 'image' || value === 'video' ? value : null
}

/**
 * Backward-compatible capture classification.
 *
 * A valid explicit declaration wins. Every pack written before explicit image
 * capture came from the video command, including screenshot-only packs whose
 * recorder failed. Missing capture_kind therefore means legacy video intent;
 * only an explicit 0.3 image declaration may enter the stricter image path.
 */
export function captureKindOf(manifest: unknown): CaptureKind {
  const explicit = explicitCaptureKind(manifest)
  if (explicit !== null) return explicit
  return 'video'
}

function cropBoundsOf(value: unknown): ImageCropBounds | null {
  const raw = recordOf(value)
  if (raw === null) return null
  const { x, y, width, height, coordinate_space: coordinateSpace } = raw
  if (
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y) ||
    typeof width !== 'number' ||
    !Number.isFinite(width) ||
    width <= 0 ||
    typeof height !== 'number' ||
    !Number.isFinite(height) ||
    height <= 0 ||
    coordinateSpace !== 'virtual-desktop-dip'
  ) {
    return null
  }
  return { x, y, width, height, coordinate_space: coordinateSpace }
}

/**
 * Stable MCP-facing inventory. It never invents/probes a context image:
 * snapshot.png is the only source image route for an image capture.
 */
export function captureMediaForMcp(manifest: unknown): McpCaptureMedia {
  const explicit = explicitCaptureKind(manifest)
  const captureKind = explicit ?? captureKindOf(manifest)
  const media = mediaOf(manifest)
  const replay = media?.replay
  const duration = media?.replay_duration_ms

  if (captureKind === 'video') {
    return {
      capture_kind: captureKind,
      legacy_inferred: explicit === null,
      snapshot: { file: 'snapshot.png', scope: 'video_frame' },
      replay:
        typeof replay === 'string' && /^replay\.(?:webm|mp4)$/.test(replay)
          ? {
              filename: replay,
              duration_ms:
                typeof duration === 'number' && Number.isFinite(duration) && duration >= 0
                  ? duration
                  : null,
            }
          : null,
    }
  }

  const explicitScope = media?.image_scope
  const scope: ImageCaptureScope | 'legacy_screenshot' =
    explicitScope === 'region' || explicitScope === 'fullscreen'
      ? explicitScope
      : 'legacy_screenshot'
  const crop = scope === 'region' ? cropBoundsOf(media?.crop_bounds) : null
  return {
    capture_kind: captureKind,
    legacy_inferred: explicit === null,
    snapshot: {
      file: 'snapshot.png',
      scope,
      ...(crop !== null ? { crop_bounds: crop } : {}),
    },
    // Even a malformed image manifest cannot make MCP advertise video bytes.
    replay: null,
  }
}

function declaredDerivedRasterFiles(media: JsonRecord): Set<string> {
  const allowed = new Set<string>(['snapshot.png'])
  const keyframes = media.keyframes
  if (!Array.isArray(keyframes)) return allowed
  for (const item of keyframes) {
    const record = recordOf(item)
    const file = record?.file
    const tMs = record?.t_ms
    if (
      typeof file === 'string' &&
      /^frames\/frame-[0-9]{2,}_[0-9]{2,}-[0-9]{2}\.[0-9]{3}\.png$/.test(file) &&
      typeof tMs === 'number' &&
      Number.isInteger(tMs) &&
      tMs >= 0
    ) {
      allowed.add(file)
    }
  }
  return allowed
}

function normalizedPackPath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\/+/, '')
}

function isRasterAsset(file: string): boolean {
  return /\.(?:png|jpe?g|webp|bmp|gif|tiff?|avif)$/i.test(file)
}

/**
 * Validates the capture-kind/media invariants a writer must satisfy.
 *
 * `packFiles` is optional for manifest-only callers. When supplied for an image
 * pack, every raster must be either snapshot.png or a manifest-declared
 * annotated keyframe of that SAME snapshot. `rasterDimensions`, when supplied
 * by an on-disk validator, also proves every derived raster stays in exactly the
 * selected crop's pixel domain. This catches accidental context-full.png writes
 * and similarly disguised copies.
 */
export function captureMediaViolations(
  manifest: unknown,
  packFiles?: readonly string[],
  rasterDimensions?: readonly PackRasterDimensions[],
): CaptureMediaViolation[] {
  const violations: CaptureMediaViolation[] = []
  const root = recordOf(manifest)
  const rawKind = root?.capture_kind
  if (rawKind !== undefined && rawKind !== 'image' && rawKind !== 'video') {
    violations.push({
      code: 'capture_kind.invalid',
      message: 'capture_kind must be "image" or "video"',
    })
  }
  const explicit = explicitCaptureKind(manifest)
  const media = mediaOf(manifest)
  if (media === null) {
    violations.push({ code: 'media.missing', message: 'media must be an object' })
    return violations
  }
  if (media.snapshot !== 'snapshot.png') {
    violations.push({
      code: 'media.snapshot_invalid',
      message: 'media.snapshot must be "snapshot.png"',
    })
  }

  // Missing capture_kind is legal for legacy packs. New invariants only apply
  // after a writer opts into the explicit declaration.
  if (explicit === null) return violations

  if (explicit === 'video') {
    if (media.image_scope !== undefined || media.crop_bounds !== undefined) {
      violations.push({
        code: 'video.image_metadata_forbidden',
        message: 'video captures must not declare image_scope or crop_bounds',
      })
    }
    return violations
  }

  if (media.replay !== null) {
    violations.push({
      code: 'image.replay_forbidden',
      message: 'an image capture must declare media.replay as null',
    })
  }
  if (
    (media.replay_duration_ms !== undefined && media.replay_duration_ms !== null) ||
    media.replay_annotated !== undefined ||
    media.snapshot_t_ms !== undefined ||
    media.trim_offset_ms !== undefined
  ) {
    violations.push({
      code: 'image.replay_metadata_forbidden',
      message: 'an image capture must not carry replay-only metadata',
    })
  }
  if (media.displays !== undefined) {
    violations.push({
      code: 'image.per_display_media_forbidden',
      message: 'an image capture has one explicit source snapshot, not per-display source images',
    })
  }

  const scope = media.image_scope
  if (scope !== 'region' && scope !== 'fullscreen') {
    violations.push({
      code: 'image.scope_invalid',
      message: 'an image capture must declare image_scope as "region" or "fullscreen"',
    })
  } else if (scope === 'region' && cropBoundsOf(media.crop_bounds) === null) {
    violations.push({
      code: 'image.crop_bounds_required',
      message: 'a region image requires valid virtual-desktop crop_bounds',
    })
  } else if (scope === 'fullscreen' && media.crop_bounds !== undefined) {
    violations.push({
      code: 'image.crop_bounds_forbidden',
      message: 'a full-screen image is snapshot.png itself and must not declare crop_bounds',
    })
  }

  const inventoryFiles =
    packFiles ?? rasterDimensions?.map((entry) => entry.file)
  if (inventoryFiles !== undefined) {
    const files = inventoryFiles.map(normalizedPackPath)
    if (files.includes('timeline.json')) {
      violations.push({
        code: 'image.timeline_forbidden',
        message: 'a still-image pack must not contain the video event timeline',
        file: 'timeline.json',
      })
    }
    if (!files.includes('snapshot.png')) {
      violations.push({
        code: 'image.snapshot_missing',
        message: 'an image pack must contain snapshot.png',
        file: 'snapshot.png',
      })
    }
    const allowed = declaredDerivedRasterFiles(media)
    for (const file of files) {
      if (!isRasterAsset(file) || allowed.has(file)) continue
      violations.push({
        code: 'image.unexpected_raster_asset',
        message:
          'image packs may contain only snapshot.png and declared annotated stills of that image',
        file,
      })
    }
  }
  if (rasterDimensions !== undefined) {
    const rasters = rasterDimensions.map((entry) => ({
      ...entry,
      file: normalizedPackPath(entry.file),
    }))
    const snapshot = rasters.find((entry) => entry.file === 'snapshot.png')
    if (
      snapshot === undefined ||
      !Number.isInteger(snapshot.width) ||
      snapshot.width <= 0 ||
      !Number.isInteger(snapshot.height) ||
      snapshot.height <= 0
    ) {
      violations.push({
        code: 'image.raster_dimensions_invalid',
        message: 'snapshot.png must have positive integer pixel dimensions',
        file: 'snapshot.png',
      })
    } else {
      const allowed = declaredDerivedRasterFiles(media)
      for (const raster of rasters) {
        if (raster.file === 'snapshot.png' || !allowed.has(raster.file)) continue
        if (
          !Number.isInteger(raster.width) ||
          !Number.isInteger(raster.height) ||
          raster.width !== snapshot.width ||
          raster.height !== snapshot.height
        ) {
          violations.push({
            code: 'image.raster_dimensions_mismatch',
            message:
              'an annotated image must keep the exact pixel domain of the selected crop',
            file: raster.file,
          })
        }
      }
    }
  }
  return violations
}
