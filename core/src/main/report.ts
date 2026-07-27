// Builds report.md — the first file a human or LLM reads inside a .capturepack.
// Pure functions only; no Electron or filesystem access.

import type { Annotation, AnnotationsFile, Manifest } from '../shared/types'

const px = (n: number): number => Math.round(n)
const secs = (ms: number): string => (ms / 1000).toFixed(1)

/** One human-readable line per annotation, e.g. `rect (612,340 → 918,520): "Submit button overflows"`. */
export function describeAnnotation(a: Annotation): string {
  switch (a.type) {
    case 'pin':
      return `pin at (${px(a.x)},${px(a.y)})${a.label ? `: "${a.label}"` : ''}`
    case 'arrow':
      return `arrow (${px(a.x1)},${px(a.y1)} → ${px(a.x2)},${px(a.y2)})`
    case 'rect':
      return `rect (${px(a.x)},${px(a.y)} → ${px(a.x + a.w)},${px(a.y + a.h)})${a.label ? `: "${a.label}"` : ''}`
    case 'blur':
      return `blur (${px(a.x)},${px(a.y)} → ${px(a.x + a.w)},${px(a.y + a.h)}) — redacted region`
    case 'text':
      return `text at (${px(a.x)},${px(a.y)}): "${a.text}"`
  }
}

export function buildReport(manifest: Manifest, annotationsFile: AnnotationsFile): string {
  const lines: string[] = []

  lines.push(`# ${manifest.title ?? 'CapturePack capture'}`)
  lines.push('')
  lines.push(`- Captured: ${manifest.created_at}`)
  lines.push(`- Pack ID: ${manifest.id}`)
  lines.push(`- Generator: ${manifest.generator.name} ${manifest.generator.version}`)
  lines.push('')

  lines.push('## Intent')
  lines.push('')
  lines.push(manifest.note ?? '(no note provided)')
  lines.push('')

  const hasReplay = manifest.media.replay !== null
  const replaySeconds = ((manifest.media.replay_duration_ms ?? 0) / 1000).toFixed(1)
  lines.push('## Environment')
  lines.push('')
  lines.push(`- OS: ${manifest.environment.os} (version ${manifest.environment.os_version})`)
  const screens = manifest.environment.screens
    .map((s) => `${s.width}x${s.height} @${s.scale}x scale`)
    .join('; ')
  lines.push(`- Screens: ${screens}`)
  lines.push(
    hasReplay
      ? `- Capture: screenshot + ${replaySeconds}s replay video (${manifest.media.replay})`
      : '- Capture: screenshot only (no replay)',
  )
  if (manifest.media.snapshot_t_ms !== undefined) {
    lines.push(`- Snapshot frame: ${secs(manifest.media.snapshot_t_ms)}s into the replay`)
  }
  lines.push('')

  lines.push('## Annotations')
  lines.push('')
  // SPEC §8.1: array order is reading order; z is stacking, for rendering only.
  const annotations = annotationsFile.annotations
  if (annotations.length === 0) {
    lines.push('(none)')
  } else {
    annotations.forEach((a, i) => {
      const at = a.t_ms !== undefined ? ` — at ${secs(a.t_ms)}s in the replay` : ''
      lines.push(`${i + 1}. ${describeAnnotation(a)}${at}`)
    })
  }
  const blurCount = annotations.filter((a) => a.type === 'blur').length
  if (blurCount > 0) {
    // SPEC §12.1 + §9.4: state the redaction, and the replay gap when a replay ships.
    const subject = blurCount === 1 ? '1 region of the snapshot is' : `${blurCount} regions of the snapshot are`
    lines.push('')
    lines.push(
      `${subject} permanently redacted (blur).` +
        (hasReplay ? ' The replay video is not redacted.' : ''),
    )
  }
  lines.push('')

  lines.push('## Files')
  lines.push('')
  lines.push('- manifest.json — pack metadata: format version, capture id, generator, environment')
  lines.push(
    `- snapshot.png — screenshot, ${annotationsFile.reference_width}x${annotationsFile.reference_height} pixels`,
  )
  lines.push('- annotations.json — machine-readable annotations (see note below)')
  lines.push('- timeline.json — timestamped events from capture start to export')
  lines.push('- report.md — this summary')
  if (hasReplay) {
    lines.push(`- replay.webm — ${replaySeconds}s screen recording ending at the snapshot`)
  }
  lines.push('')
  lines.push(
    'annotations.json contains the machine-readable versions of the annotations listed above. ' +
      'All coordinates are pixels in snapshot.png coordinate space.',
  )
  lines.push('')

  return lines.join('\n')
}
