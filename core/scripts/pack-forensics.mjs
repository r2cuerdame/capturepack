import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPORT_SCHEMA_VERSION = 1
const MAX_MEDIA_PROBE_BYTES = 128 * 1024 * 1024
const TIME_EPSILON_MS = 1

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function rounded(value, digits = 3) {
  return Number(value.toFixed(digits))
}

function normaliseProcess(value) {
  return typeof value === 'string' ? value.toLocaleLowerCase().replace(/\.exe$/u, '') : ''
}

function isBounds(value) {
  return isRecord(value)
    && isFiniteNumber(value.x)
    && isFiniteNumber(value.y)
    && isFiniteNumber(value.width)
    && isFiniteNumber(value.height)
    && value.width > 0
    && value.height > 0
}

function sizeDistance(a, b) {
  return Math.abs(Math.log(a.width / b.width)) + Math.abs(Math.log(a.height / b.height))
}

function mediaDurationFromMp4(file) {
  const size = statSync(file).size
  if (size === 0) return { status: 'skipped', reason: 'empty media file' }
  if (size > MAX_MEDIA_PROBE_BYTES) {
    return {
      status: 'skipped',
      reason: `media is larger than the ${MAX_MEDIA_PROBE_BYTES} byte deterministic probe limit`,
    }
  }

  const bytes = readFileSync(file)
  const containers = new Set(['moov'])
  let found = null

  const visit = (start, end) => {
    let cursor = start
    while (cursor + 8 <= end) {
      let boxSize = bytes.readUInt32BE(cursor)
      const type = bytes.toString('ascii', cursor + 4, cursor + 8)
      let headerSize = 8
      if (boxSize === 1) {
        if (cursor + 16 > end) return
        const wideSize = bytes.readBigUInt64BE(cursor + 8)
        if (wideSize > BigInt(Number.MAX_SAFE_INTEGER)) return
        boxSize = Number(wideSize)
        headerSize = 16
      } else if (boxSize === 0) {
        boxSize = end - cursor
      }
      if (boxSize < headerSize || cursor + boxSize > end) return

      const dataStart = cursor + headerSize
      const boxEnd = cursor + boxSize
      if (type === 'mvhd') {
        const version = bytes[dataStart]
        const timeScaleOffset = dataStart + (version === 1 ? 20 : 12)
        const durationOffset = dataStart + (version === 1 ? 24 : 16)
        const durationBytes = version === 1 ? 8 : 4
        if (durationOffset + durationBytes <= boxEnd) {
          const timeScale = bytes.readUInt32BE(timeScaleOffset)
          const duration = version === 1
            ? Number(bytes.readBigUInt64BE(durationOffset))
            : bytes.readUInt32BE(durationOffset)
          if (timeScale > 0 && duration > 0 && Number.isSafeInteger(duration)) {
            found = (duration / timeScale) * 1000
            return
          }
        }
      } else if (containers.has(type)) {
        visit(dataStart, boxEnd)
        if (found !== null) return
      }
      cursor = boxEnd
    }
  }

  visit(0, bytes.length)
  return found === null
    ? { status: 'skipped', reason: 'MP4 mvhd has no finite non-zero duration (typical for fragmented MP4)' }
    : { status: 'measured', duration_ms: rounded(found) }
}

function pngDimensions(file) {
  const bytes = readFileSync(file)
  if (bytes.length < 24 || bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a') return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function parseCli(argv) {
  const options = {
    pack: process.env.CAPTUREPACK_QA_PACK ?? null,
    strict: process.env.CAPTUREPACK_QA_PACK_STRICT === '1',
    json: process.env.CAPTUREPACK_QA_PACK_REPORT ?? null,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--strict') options.strict = true
    else if (arg === '--json') options.json = argv[++i] ?? null
    else if (!arg.startsWith('-') && options.pack === null) options.pack = arg
    else if (!arg.startsWith('-')) options.pack = arg
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return options
}

export function inspectPack(inputPath, { strict = false } = {}) {
  const started = process.hrtime.bigint()
  const packPath = resolve(inputPath)
  const findings = []
  const metrics = {
    annotation_count: 0,
    uia_window_count: 0,
    uia_element_count: 0,
    matched_control_targets: 0,
    unmatched_control_targets: 0,
    owner_window_bound_contradictions: 0,
    control_target_geometry_contradictions: 0,
    media_duration_probes: [],
  }

  const add = (
    severity,
    category,
    code,
    message,
    detail = undefined,
    gating = severity === 'error',
  ) => {
    findings.push({
      severity,
      category,
      code,
      message,
      gating,
      ...(detail === undefined ? {} : { detail }),
    })
  }

  if (!existsSync(packPath) || !statSync(packPath).isDirectory()) {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6
    return {
      kind: 'capturepack-pack-forensics',
      schema_version: REPORT_SCHEMA_VERSION,
      pack_path: packPath,
      strict,
      status: 'error',
      gate_status: 'failed',
      configuration_error: true,
      duration_ms: rounded(durationMs),
      counts: { errors: 1, warnings: 0, infos: 0, gating: 1 },
      metrics,
      findings: [{
        severity: 'error',
        category: 'configuration',
        code: 'pack_directory_missing',
        message: `CapturePack directory does not exist: ${packPath}`,
        gating: true,
      }],
    }
  }

  const containedPath = (reference, field) => {
    if (typeof reference !== 'string' || reference.trim() === '') {
      add('error', 'structure', 'invalid_file_reference', `${field} must be a non-empty relative path`)
      return null
    }
    if (isAbsolute(reference)) {
      add('error', 'structure', 'absolute_file_reference', `${field} must stay inside the pack`, { reference })
      return null
    }
    const candidate = resolve(packPath, reference)
    const rel = relative(packPath, candidate)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      add('error', 'structure', 'escaping_file_reference', `${field} escapes the pack directory`, { reference })
      return null
    }
    return candidate
  }

  const requireFile = (name) => {
    const file = resolve(packPath, name)
    if (!existsSync(file) || !statSync(file).isFile()) {
      add('error', 'structure', 'required_file_missing', `Required file is missing: ${name}`)
      return null
    }
    return file
  }

  const readJson = (file, name) => {
    if (file === null) return null
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      add('error', 'structure', 'invalid_json', `${name} is not valid JSON`, {
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  const manifestFile = requireFile('manifest.json')
  const annotationsFile = requireFile('annotations.json')
  requireFile('README.md')
  requireFile('report.md')
  const manifest = readJson(manifestFile, 'manifest.json')
  const stillImage = isRecord(manifest) && manifest.capture_kind === 'image'
  const timelinePath = resolve(packPath, 'timeline.json')
  let timelineFile = null
  if (stillImage) {
    if (existsSync(timelinePath) && statSync(timelinePath).isFile()) {
      timelineFile = timelinePath
      add(
        'error',
        'structure',
        'image_timeline_present',
        'Explicit still-image packs must not contain timeline.json',
      )
    }
  } else {
    timelineFile = requireFile('timeline.json')
  }

  const skillsDirectory = resolve(packPath, 'skills')
  if (!existsSync(skillsDirectory) || !statSync(skillsDirectory).isDirectory()) {
    add('error', 'structure', 'skills_directory_missing', 'Required skills/ directory is missing')
  } else if (!readdirSync(skillsDirectory).some((entry) => entry.toLocaleLowerCase().endsWith('.md'))) {
    add('error', 'structure', 'skills_documents_missing', 'skills/ contains no Markdown documents')
  } else if (stillImage && existsSync(resolve(skillsDirectory, 'timeline.md'))) {
    add(
      'error',
      'structure',
      'image_timeline_skill_present',
      'Explicit still-image packs must not include skills/timeline.md',
    )
  }

  const annotationDocument = readJson(annotationsFile, 'annotations.json')
  const timeline = readJson(timelineFile, 'timeline.json')

  if (isRecord(manifest) && Array.isArray(manifest.plugins) && manifest.plugins.length > 0) {
    const domDocument = resolve(skillsDirectory, 'dom.md')
    const overviewDocument = resolve(skillsDirectory, 'overview.md')
    const domText =
      existsSync(domDocument) && statSync(domDocument).isFile()
        ? readFileSync(domDocument, 'utf8')
        : ''
    const overviewText =
      existsSync(overviewDocument) && statSync(overviewDocument).isFile()
        ? readFileSync(overviewDocument, 'utf8')
        : ''
    if (
      domText.includes('No plugin contributed semantic object data')
      || overviewText.includes('0 plugins.')
    ) {
      add(
        'error',
        'documents',
        'generated_docs_plugin_contradiction',
        'Generated skills say no plugin data exists, but manifest.json declares plugin payloads',
        {
          declared_plugins: manifest.plugins
            .filter((plugin) => isRecord(plugin) && typeof plugin.name === 'string')
            .map((plugin) => plugin.name),
        },
      )
    }
  }

  if (!isRecord(manifest)) {
    if (manifest !== null) add('error', 'schema', 'manifest_not_object', 'manifest.json must contain an object')
  } else {
    if (manifest.format !== 'capturepack') {
      add('error', 'schema', 'invalid_pack_identity', 'manifest.format must equal "capturepack"', {
        actual: manifest.format ?? null,
      })
    }
    if (typeof manifest.format_version !== 'string' || manifest.format_version === '') {
      add('error', 'schema', 'format_version_missing', 'manifest.format_version must be a non-empty string')
    }
    if (typeof manifest.id !== 'string' || manifest.id === '') {
      add('error', 'schema', 'pack_id_missing', 'manifest.id must be a non-empty string')
    }
    if (!isRecord(manifest.media)) {
      add('error', 'schema', 'media_missing', 'manifest.media must be an object')
    }
  }

  if (!isRecord(annotationDocument)) {
    if (annotationDocument !== null) {
      add('error', 'schema', 'annotations_not_object', 'annotations.json must contain an object')
    }
  } else {
    if (!isFiniteNumber(annotationDocument.reference_width) || annotationDocument.reference_width <= 0) {
      add('error', 'schema', 'reference_width_invalid', 'annotations.reference_width must be positive')
    }
    if (!isFiniteNumber(annotationDocument.reference_height) || annotationDocument.reference_height <= 0) {
      add('error', 'schema', 'reference_height_invalid', 'annotations.reference_height must be positive')
    }
    if (!Array.isArray(annotationDocument.annotations)) {
      add('error', 'schema', 'annotation_array_missing', 'annotations.annotations must be an array')
    }
  }
  if (timeline !== null && !isRecord(timeline)) {
    add('error', 'schema', 'timeline_not_object', 'timeline.json must contain an object')
  }

  const media = isRecord(manifest?.media) ? manifest.media : {}
  const displayMedia = Array.isArray(media.displays)
    ? media.displays.filter((display) => isRecord(display))
    : []
  const displayByIndex = new Map(displayMedia
    .filter((display) => Number.isInteger(display.index))
    .map((display) => [display.index, display]))
  const focusedDisplay = displayMedia.find((display) => display.focused === true)
  const focusedDisplayIndex = Number.isInteger(focusedDisplay?.index) ? focusedDisplay.index : null

  displayMedia.forEach((display, index) => {
    if (display.replay_clock_offset_ms === undefined) return
    const prefix = `manifest.media.displays[${index}].replay_clock_offset_ms`
    if (display.replay === null) {
      add('error', 'schema', 'replay_clock_without_replay',
        `${prefix} must be absent when replay is null`)
    } else if (!Number.isInteger(display.replay_clock_offset_ms)) {
      add('error', 'schema', 'replay_clock_offset_invalid',
        `${prefix} must be an integer number of milliseconds`)
    } else if (display.focused === true && display.replay_clock_offset_ms !== 0) {
      add('error', 'timeline', 'focused_replay_clock_nonzero',
        `${prefix} must be 0 because the focused replay is the pack clock`)
    }
  })

  const declaredDurationFor = (display) => {
    if (Number.isInteger(display)) {
      const specific = displayByIndex.get(display)
      return isFiniteNumber(specific?.replay_duration_ms) ? specific.replay_duration_ms : null
    }
    if (isFiniteNumber(media.replay_duration_ms)) return media.replay_duration_ms
    return isFiniteNumber(focusedDisplay?.replay_duration_ms) ? focusedDisplay.replay_duration_ms : null
  }

  const snapshotDimensionsByDisplay = new Map()
  const inspectMediaFile = (owner, prefix) => {
    if (!isRecord(owner)) return
    if (typeof owner.snapshot !== 'string' || owner.snapshot === '') {
      add('error', 'schema', 'snapshot_reference_missing', `${prefix}.snapshot must be a non-empty path`)
    }
    if (owner.replay === null) {
      if (owner.replay_duration_ms !== null && owner.replay_duration_ms !== undefined) {
        add('error', 'schema', 'screenshot_duration_present',
          `${prefix}.replay_duration_ms must be null when replay is null`)
      }
    } else if (typeof owner.replay === 'string' && owner.replay !== '') {
      if (!isFiniteNumber(owner.replay_duration_ms) || owner.replay_duration_ms < 0) {
        add('error', 'schema', 'replay_duration_invalid',
          `${prefix}.replay_duration_ms must be a non-negative finite number`)
      }
    } else {
      add('error', 'schema', 'replay_reference_invalid',
        `${prefix}.replay must be a non-empty path or null`)
    }
    for (const key of ['snapshot', 'replay', 'replay_annotated']) {
      const reference = owner[key]
      if (reference === null || reference === undefined) continue
      const file = containedPath(reference, `${prefix}.${key}`)
      if (file === null) continue
      if (!existsSync(file) || !statSync(file).isFile()) {
        add('error', 'structure', 'referenced_media_missing', `${prefix}.${key} does not exist`, {
          reference,
        })
        continue
      }
      if (key === 'snapshot' && file.toLocaleLowerCase().endsWith('.png')) {
        try {
          const dimensions = pngDimensions(file)
          if (dimensions === null) {
            add('warning', 'media', 'snapshot_header_invalid', `${prefix}.${key} is not a readable PNG`, {
              reference,
            })
          } else {
            snapshotDimensionsByDisplay.set(owner.index ?? 'main', dimensions)
          }
        } catch (error) {
          add('warning', 'media', 'snapshot_probe_failed', `Could not inspect ${prefix}.${key}`, {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      if (key === 'replay' && file.toLocaleLowerCase().endsWith('.mp4')) {
        try {
          const probe = mediaDurationFromMp4(file)
          const declared = isFiniteNumber(owner.replay_duration_ms) ? owner.replay_duration_ms : null
          const result = { reference, declared_duration_ms: declared, ...probe }
          metrics.media_duration_probes.push(result)
          if (probe.status === 'measured' && declared !== null) {
            const delta = Math.abs(probe.duration_ms - declared)
            if (delta > Math.max(1_000, declared * 0.1)) {
              add('warning', 'media', 'replay_duration_mismatch',
                `${prefix}.replay duration differs materially from the manifest`, {
                  reference,
                  declared_duration_ms: declared,
                  measured_duration_ms: probe.duration_ms,
                  absolute_delta_ms: rounded(delta),
                })
            }
          }
        } catch (error) {
          metrics.media_duration_probes.push({
            reference,
            status: 'skipped',
            reason: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }
    if (Array.isArray(owner.keyframes)) {
      owner.keyframes.forEach((keyframe, index) => {
        if (!isRecord(keyframe)) {
          add('error', 'schema', 'manifest_keyframe_invalid', `${prefix}.keyframes[${index}] must be an object`)
          return
        }
        const file = containedPath(keyframe.file, `${prefix}.keyframes[${index}].file`)
        if (file !== null && (!existsSync(file) || !statSync(file).isFile())) {
          add('error', 'structure', 'keyframe_file_missing',
            `${prefix}.keyframes[${index}].file does not exist`, { reference: keyframe.file })
        }
        if (!isFiniteNumber(keyframe.t_ms) || keyframe.t_ms < 0) {
          add('error', 'timeline', 'manifest_keyframe_time_invalid',
            `${prefix}.keyframes[${index}].t_ms must be a non-negative finite number`)
        } else if (isFiniteNumber(owner.replay_duration_ms)
          && keyframe.t_ms > owner.replay_duration_ms + TIME_EPSILON_MS) {
          add('error', 'timeline', 'manifest_keyframe_after_replay',
            `${prefix}.keyframes[${index}] is after its replay`, {
              t_ms: keyframe.t_ms,
              replay_duration_ms: owner.replay_duration_ms,
            })
        }
      })
    }
  }

  inspectMediaFile(media, 'manifest.media')
  displayMedia.forEach((display, index) => inspectMediaFile(display, `manifest.media.displays[${index}]`))

  const mainSnapshotDimensions = snapshotDimensionsByDisplay.get('main')
  if (mainSnapshotDimensions !== undefined && isRecord(annotationDocument)) {
    if (annotationDocument.reference_width !== mainSnapshotDimensions.width
      || annotationDocument.reference_height !== mainSnapshotDimensions.height) {
      add('warning', 'coordinates', 'annotation_reference_mismatch',
        'annotations reference dimensions do not match manifest.media.snapshot', {
          annotation_reference: {
            width: annotationDocument.reference_width,
            height: annotationDocument.reference_height,
          },
          snapshot: mainSnapshotDimensions,
        })
    }
  }

  const annotations = Array.isArray(annotationDocument?.annotations)
    ? annotationDocument.annotations
    : []
  metrics.annotation_count = annotations.length
  const annotationIds = new Set()

  const dimensionsFor = (display) => {
    if (Number.isInteger(display)) {
      const probed = snapshotDimensionsByDisplay.get(display)
      if (probed !== undefined) return probed
      const screen = Array.isArray(manifest?.environment?.screens)
        ? manifest.environment.screens[display - 1]
        : null
      if (isRecord(screen) && isFiniteNumber(screen.width) && isFiniteNumber(screen.height)) {
        return { width: screen.width, height: screen.height }
      }
    }
    if (isFiniteNumber(annotationDocument?.reference_width)
      && isFiniteNumber(annotationDocument?.reference_height)) {
      return {
        width: annotationDocument.reference_width,
        height: annotationDocument.reference_height,
      }
    }
    return null
  }

  const validateTime = (value, field, display) => {
    if (!isFiniteNumber(value) || value < 0) {
      add('error', 'timeline', 'annotation_time_invalid', `${field} must be a non-negative finite number`, {
        value: value ?? null,
      })
      return
    }
    const duration = declaredDurationFor(display)
    if (duration !== null && value > duration + TIME_EPSILON_MS) {
      add('error', 'timeline', 'annotation_time_after_replay', `${field} is after its replay`, {
        t_ms: value,
        replay_duration_ms: duration,
        display: display ?? null,
      })
    }
  }

  const validateBounds = (bounds, field, display) => {
    if (!isBounds(bounds)) {
      add('error', 'schema', 'annotation_bounds_invalid', `${field} must be a finite positive rectangle`)
      return
    }
    const dimensions = dimensionsFor(display)
    if (bounds.x < 0 || bounds.y < 0
      || (dimensions !== null
        && (bounds.x + bounds.width > dimensions.width + 1
          || bounds.y + bounds.height > dimensions.height + 1))) {
      add('warning', 'coordinates', 'annotation_bounds_outside_snapshot',
        `${field} extends outside its snapshot pixel space`, {
          display: display ?? null,
          bounds,
          snapshot: dimensions,
        })
    }
  }

  annotations.forEach((annotation, index) => {
    const prefix = `annotations[${index}]`
    if (!isRecord(annotation)) {
      add('error', 'schema', 'annotation_invalid', `${prefix} must be an object`)
      return
    }
    if (annotation.type !== 'box') {
      add('error', 'schema', 'annotation_type_invalid', `${prefix}.type must equal "box"`)
    }
    if (typeof annotation.text !== 'string') {
      add('error', 'schema', 'annotation_text_invalid', `${prefix}.text must be a string`)
    }
    if (typeof annotation.numbered !== 'boolean' || typeof annotation.blur !== 'boolean') {
      add('error', 'schema', 'annotation_flags_invalid',
        `${prefix}.numbered and ${prefix}.blur must be booleans`)
    }
    if (!isFiniteNumber(annotation.z)) {
      add('error', 'schema', 'annotation_z_invalid', `${prefix}.z must be a finite number`)
    }
    if (typeof annotation.created_at !== 'string' || !Number.isFinite(Date.parse(annotation.created_at))) {
      add('error', 'schema', 'annotation_created_at_invalid',
        `${prefix}.created_at must be an ISO-compatible timestamp`)
    }
    if (typeof annotation.annotation_id !== 'string' || annotation.annotation_id === '') {
      add('error', 'schema', 'annotation_id_invalid', `${prefix}.annotation_id must be a non-empty string`)
    } else if (annotationIds.has(annotation.annotation_id)) {
      add('error', 'schema', 'annotation_id_duplicate', `${prefix}.annotation_id is duplicated`, {
        annotation_id: annotation.annotation_id,
      })
    } else {
      annotationIds.add(annotation.annotation_id)
    }
    validateBounds(annotation.bounds, `${prefix}.bounds`, annotation.display)

    const hasStart = annotation.start_ms !== undefined
    const hasEnd = annotation.end_ms !== undefined
    if (hasStart !== hasEnd) {
      add('error', 'timeline', 'annotation_lifetime_incomplete',
        `${prefix} must contain both start_ms and end_ms, or neither`)
    }
    if (hasStart) validateTime(annotation.start_ms, `${prefix}.start_ms`, annotation.display)
    if (hasEnd) validateTime(annotation.end_ms, `${prefix}.end_ms`, annotation.display)
    if (isFiniteNumber(annotation.start_ms) && isFiniteNumber(annotation.end_ms)
      && annotation.start_ms > annotation.end_ms) {
      add('error', 'timeline', 'annotation_lifetime_reversed', `${prefix}.start_ms is after end_ms`)
    }

    if (isRecord(annotation.tracking)) {
      if (annotation.tracking.picked_at_ms !== undefined) {
        validateTime(annotation.tracking.picked_at_ms, `${prefix}.tracking.picked_at_ms`, annotation.display)
      }
      if (annotation.tracking.samples !== undefined && !Array.isArray(annotation.tracking.samples)) {
        add('error', 'schema', 'tracking_samples_invalid', `${prefix}.tracking.samples must be an array`)
      } else if (Array.isArray(annotation.tracking.samples)) {
        let previousTime = -Infinity
        annotation.tracking.samples.forEach((sample, sampleIndex) => {
          const samplePrefix = `${prefix}.tracking.samples[${sampleIndex}]`
          if (!isRecord(sample)) {
            add('error', 'schema', 'tracking_sample_invalid', `${samplePrefix} must be an object`)
            return
          }
          validateTime(sample.t_ms, `${samplePrefix}.t_ms`, sample.display ?? annotation.display)
          validateBounds(sample, samplePrefix, sample.display ?? annotation.display)
          if (isFiniteNumber(sample.t_ms) && sample.t_ms < previousTime) {
            add('error', 'timeline', 'tracking_samples_unsorted',
              `${samplePrefix}.t_ms is earlier than the previous sample`)
          }
          if (isFiniteNumber(sample.t_ms)) previousTime = sample.t_ms
        })
      }
    } else {
      add('error', 'schema', 'annotation_tracking_missing', `${prefix}.tracking must be an object`)
    }

    if (annotation.keyframes !== undefined && !Array.isArray(annotation.keyframes)) {
      add('error', 'schema', 'annotation_keyframes_invalid', `${prefix}.keyframes must be an array`)
    } else if (Array.isArray(annotation.keyframes)) {
      let previousTime = -Infinity
      annotation.keyframes.forEach((keyframe, keyframeIndex) => {
        const keyframePrefix = `${prefix}.keyframes[${keyframeIndex}]`
        if (!isRecord(keyframe)) {
          add('error', 'schema', 'annotation_keyframe_invalid', `${keyframePrefix} must be an object`)
          return
        }
        let keyframeDisplay = annotation.display
        if (keyframe.display !== undefined) {
          if (!Number.isInteger(keyframe.display) || keyframe.display < 1) {
            add('error', 'schema', 'annotation_keyframe_display_invalid',
              `${keyframePrefix}.display must be an integer >= 1`, {
                display: keyframe.display,
              })
          } else {
            keyframeDisplay = keyframe.display
            if (!displayByIndex.has(keyframe.display)) {
              add('error', 'schema', 'annotation_keyframe_display_unknown',
                `${keyframePrefix}.display does not name a declared manifest.media.displays entry`, {
                  display: keyframe.display,
                  declared_displays: [...displayByIndex.keys()],
                })
            }
          }
        }
        validateTime(keyframe.t_ms, `${keyframePrefix}.t_ms`, keyframeDisplay)
        validateBounds(keyframe, keyframePrefix, keyframeDisplay)
        if (isFiniteNumber(keyframe.t_ms) && keyframe.t_ms < previousTime) {
          add('error', 'timeline', 'annotation_keyframes_unsorted',
            `${keyframePrefix}.t_ms is earlier than the previous keyframe`)
        }
        if (isFiniteNumber(keyframe.t_ms)) previousTime = keyframe.t_ms
      })
    }
  })

  const uiaFile = resolve(packPath, 'plugins', 'windows-uia', 'elements.json')
  let uia = null
  if (existsSync(uiaFile) && statSync(uiaFile).isFile()) {
    uia = readJson(uiaFile, 'plugins/windows-uia/elements.json')
    if (!isRecord(uia) || !Array.isArray(uia.windows) || !Array.isArray(uia.elements)) {
      add('error', 'schema', 'uia_shape_invalid',
        'plugins/windows-uia/elements.json must contain windows[] and elements[]')
      uia = null
    }
  }

  const controlAnnotations = annotations.filter((annotation) =>
    isRecord(annotation)
    && isRecord(annotation.target)
    && annotation.target.source === 'uia'
    && (annotation.target.level === 'control' || annotation.target.level === undefined))

  if (controlAnnotations.length > 0 && uia === null) {
    add('warning', 'semantic', 'uia_evidence_missing',
      'UIA control targets exist, but plugins/windows-uia/elements.json is unavailable')
  }

  if (uia !== null) {
    metrics.uia_window_count = uia.windows.length
    metrics.uia_element_count = uia.elements.length
    const windowsByZ = new Map(uia.windows
      .filter((window) => isRecord(window) && Number.isInteger(window.z))
      .map((window) => [window.z, window]))

    const effectiveDisplay = (primary, fallback = undefined) => {
      if (Number.isInteger(primary)) return primary
      if (Number.isInteger(fallback)) return fallback
      return focusedDisplayIndex
    }

    const pickedGeometryOf = (annotation) => {
      if (!isRecord(annotation.tracking)
        || annotation.tracking.enabled !== true
        || !isFiniteNumber(annotation.tracking.picked_at_ms)
        || !Array.isArray(annotation.tracking.samples)) {
        return null
      }
      let best = null
      for (let index = 0; index < annotation.tracking.samples.length; index += 1) {
        const sample = annotation.tracking.samples[index]
        if (!isRecord(sample) || !isFiniteNumber(sample.t_ms) || !isBounds(sample)) continue
        const gap = Math.abs(sample.t_ms - annotation.tracking.picked_at_ms)
        if (best === null
          || gap < best.gap
          || (gap === best.gap && best.sample.display !== undefined && sample.display === undefined)) {
          best = { sample, index, gap }
        }
      }
      if (best === null) return null
      return {
        bounds: {
          x: best.sample.x,
          y: best.sample.y,
          width: best.sample.width,
          height: best.sample.height,
        },
        display: effectiveDisplay(best.sample.display, annotation.display),
        source: `tracking.samples[${best.index}]`,
        t_ms: best.sample.t_ms,
        picked_at_ms: annotation.tracking.picked_at_ms,
        delta_ms: best.gap,
      }
    }

    const exactSemanticIdentity = (target, element, owner) => {
      let decisive = false
      for (const key of ['automation_id', 'name', 'control_type', 'class_name']) {
        if (typeof target[key] !== 'string' || target[key] === '') continue
        if (element[key] !== target[key]) return false
        if (key === 'automation_id' || key === 'name') decisive = true
      }
      if (typeof target.process === 'string' && target.process !== '') {
        if (!isRecord(owner)
          || normaliseProcess(owner.process) !== normaliseProcess(target.process)) return false
      }
      return decisive
    }

    const uniformScaleContradiction = (actual, expected) => {
      if (Math.min(actual.width, actual.height, expected.width, expected.height) < 8) return null
      if (Math.abs(actual.width - expected.width) < 3
        || Math.abs(actual.height - expected.height) < 3) return null
      const widthScale = actual.width / expected.width
      const heightScale = actual.height / expected.height
      const scale = Math.sqrt(widthScale * heightScale)
      // A translated control can be clipped at a display edge and therefore
      // shrink in both axes. It cannot grow. Only the observed rectangle being
      // materially larger than the capture-instant element is high-confidence
      // evidence of the rc.37 scale mix-up.
      if (scale < 1.2) return null
      // Translation is expected when a tracked owner window moves. A near-
      // uniform change in BOTH dimensions on the SAME display is different:
      // control tracking deliberately preserves the picked control's size and
      // only translates it with its owner. rc.37's ann_2171f2 is 1.5x in both
      // axes (230x36 vs 153x24), the signature of a coordinate-scale mix-up.
      if (Math.abs(Math.log(widthScale / heightScale)) > Math.log(1.08)) return null
      return { widthScale, heightScale, scale }
    }

    for (const annotation of controlAnnotations) {
      const target = annotation.target
      const pickedGeometry = pickedGeometryOf(annotation)
      const geometryDisplay = pickedGeometry?.display
        ?? effectiveDisplay(annotation.display)
      const candidates = uia.elements
        .filter((element) => isRecord(element) && isBounds(element.bounds))
        .map((element) => {
          const owner = windowsByZ.get(element.window)
          const elementDisplay = effectiveDisplay(element.display, owner?.display)
          const ownerDisplay = effectiveDisplay(owner?.display)
          let score = 0
          let decisive = false
          if (typeof target.automation_id === 'string' && target.automation_id !== '') {
            if (element.automation_id !== target.automation_id) return null
            score += 100
            decisive = true
          }
          if (typeof target.name === 'string' && target.name !== '') {
            if (element.name === target.name) {
              score += 30
              decisive = true
            } else {
              score -= 30
            }
          }
          if (typeof target.control_type === 'string' && target.control_type !== '') {
            score += element.control_type === target.control_type ? 12 : -12
          }
          if (typeof target.class_name === 'string' && target.class_name !== '') {
            score += element.class_name === target.class_name ? 6 : -6
          }
          if (typeof target.process === 'string' && isRecord(owner)) {
            score += normaliseProcess(owner.process) === normaliseProcess(target.process) ? 8 : -8
          }
          return decisive && score > 0
            ? {
                element,
                owner,
                elementDisplay,
                displayConsistent: ownerDisplay === null || elementDisplay === ownerDisplay,
                score,
              }
            : null
        })
        .filter((candidate) => candidate !== null)
        .sort((a, b) => b.score - a.score)

      if (candidates.length === 0) {
        metrics.unmatched_control_targets += 1
        add('warning', 'semantic', 'control_target_not_found',
          'A UIA control annotation cannot be matched to the captured element ledger', {
            annotation_id: annotation.annotation_id ?? null,
            target,
          })
        continue
      }

      metrics.matched_control_targets += 1
      const {
        element,
        owner,
        elementDisplay,
        score,
      } = candidates[0]

      // The UIA payload is a capture-instant ledger while a tracked box can
      // legitimately move with its owner later. Compare the observation nearest
      // picked_at_ms, ignore x/y translation, and only gate when exactly one
      // element has the target's full available semantic identity on that same
      // display. Ambiguous names and cross-display DPI changes stay diagnostic,
      // never evidence for a contradiction.
      const exactCandidates = pickedGeometry === null
        ? []
        : candidates.filter((candidate) =>
          candidate.displayConsistent
          && candidate.elementDisplay === pickedGeometry.display
          && (displayByIndex.size === 0
            ? pickedGeometry.display === null
            : displayByIndex.has(pickedGeometry.display))
          && exactSemanticIdentity(target, candidate.element, candidate.owner))
      if (exactCandidates.length === 1) {
        const exact = exactCandidates[0]
        const dimensions = dimensionsFor(pickedGeometry.display)
        const touchesEdge = (bounds) => dimensions !== null
          && (bounds.x <= 1
            || bounds.y <= 1
            || bounds.x + bounds.width >= dimensions.width - 1
            || bounds.y + bounds.height >= dimensions.height - 1)
        const scale = touchesEdge(pickedGeometry.bounds) || touchesEdge(exact.element.bounds)
          ? null
          : uniformScaleContradiction(pickedGeometry.bounds, exact.element.bounds)
        if (scale !== null) {
          metrics.control_target_geometry_contradictions += 1
          add('warning', 'semantic', 'control_target_geometry_contradiction',
            'A UIA control target has a uniformly scaled rectangle on the same display at its picked instant', {
              annotation_id: annotation.annotation_id ?? null,
              identity_score: exact.score,
              target,
              geometry_source: pickedGeometry.source,
              geometry_display: pickedGeometry.display,
              picked_at_ms: pickedGeometry.picked_at_ms,
              geometry_t_ms: pickedGeometry.t_ms,
              geometry_delta_ms: pickedGeometry.delta_ms,
              annotation_bounds: pickedGeometry.bounds,
              matched_element_bounds: exact.element.bounds,
              width_scale: rounded(scale.widthScale),
              height_scale: rounded(scale.heightScale),
              uniform_scale: rounded(scale.scale),
            }, true)
        }
      }

      if (geometryDisplay !== elementDisplay
        || !isBounds(annotation.bounds)
        || !isBounds(owner?.bounds)) continue

      const annotationArea = annotation.bounds.width * annotation.bounds.height
      const elementArea = element.bounds.width * element.bounds.height
      const ownerDistance = sizeDistance(annotation.bounds, owner.bounds)
      const elementDistance = sizeDistance(annotation.bounds, element.bounds)
      const areaRatio = annotationArea / elementArea

      // Coordinates can move across displays and DPI domains, so position is
      // deliberately not part of this signal. A control rectangle whose SIZE
      // is near its owner and orders of magnitude from its matched UIA element
      // is the rc.36 attachTrack contradiction preserved by _210107.
      if (areaRatio >= 4 && ownerDistance <= 0.6 && elementDistance >= ownerDistance + 0.8) {
        metrics.owner_window_bound_contradictions += 1
        add('warning', 'semantic', 'control_matches_owner_window_bounds',
          'Control-level target carries owner-window-sized annotation bounds', {
            annotation_id: annotation.annotation_id ?? null,
            identity_score: score,
            target,
            annotation_bounds: annotation.bounds,
            matched_element_bounds: element.bounds,
            owner_window: {
              title: owner.title ?? null,
              process: owner.process ?? null,
              bounds: owner.bounds,
            },
            annotation_to_element_area_ratio: rounded(areaRatio),
            owner_size_distance: rounded(ownerDistance),
            element_size_distance: rounded(elementDistance),
          }, true)
      }
    }
  }

  const counts = findings.reduce((result, finding) => {
    result[`${finding.severity}s`] += 1
    if (finding.gating) result.gating += 1
    return result
  }, { errors: 0, warnings: 0, infos: 0, gating: 0 })
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6

  return {
    kind: 'capturepack-pack-forensics',
    schema_version: REPORT_SCHEMA_VERSION,
    pack_path: packPath,
    strict,
    status: counts.errors > 0 ? 'issues' : counts.warnings > 0 ? 'warnings' : 'passed',
    gate_status: strict && counts.gating > 0 ? 'failed' : 'passed',
    configuration_error: false,
    duration_ms: rounded(durationMs),
    counts,
    metrics,
    findings,
  }
}

function printResult(result) {
  const marker = result.gate_status === 'failed' ? 'FAIL' : result.status === 'passed' ? 'PASS' : 'WARN'
  console.log(`[${marker}] CapturePack forensics: ${result.pack_path}`)
  console.log(
    `       ${result.counts.errors} errors, ${result.counts.warnings} warnings, `
    + `${result.counts.gating} gating findings, ${result.metrics.annotation_count} annotations, `
    + `${result.duration_ms} ms`,
  )
  for (const finding of result.findings) {
    console.log(
      `  - ${finding.severity.toUpperCase()}${finding.gating ? ' [GATE]' : ''} `
      + `${finding.code}: ${finding.message}`,
    )
  }
  if (!result.strict && (result.counts.errors > 0 || result.counts.warnings > 0)) {
    console.log('       Findings are non-gating. Re-run with --strict to gate a newly produced RC pack.')
  }
}

async function main() {
  let options
  try {
    options = parseCli(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 2
    return
  }
  if (options.pack === null) {
    console.error('Provide a pack path, or set CAPTUREPACK_QA_PACK.')
    process.exitCode = 2
    return
  }

  const result = inspectPack(options.pack, { strict: options.strict })
  printResult(result)
  if (options.json !== null) {
    const output = resolve(options.json)
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    console.log(`JSON: ${output}`)
  }
  if (result.gate_status === 'failed' || result.configuration_error) process.exitCode = 1
}

const invokedDirectly = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) await main()
