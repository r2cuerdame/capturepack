// Builds report.md — the generated narrative of a pack (SPEC §12.1).
// Pure functions only; no Electron or filesystem access.
//
// i18n scope (GOAL "Internationalization", packLanguage): template HEADINGS
// and short labels are localized via the pack.* dictionary keys; explanatory
// PROSE stays English on purpose so the generated documents remain canonical
// for AI readers. The user's own title/note text is NEVER translated.

import { makeT } from '../shared/i18n'
import type { Language, TranslateFn } from '../shared/i18n'
import type { Annotation, AnnotationsFile, Manifest } from '../shared/types'
import { computeDisplayNumbers } from '../shared/numbering'

const px = (n: number): number => Math.round(n)

/** Replay-clock label, e.g. 3200 -> "00:03.200". */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms))
  const minutes = Math.floor(total / 60_000)
  const seconds = Math.floor((total % 60_000) / 1000)
  const millis = total % 1000
  const pad = (n: number, w: number): string => String(n).padStart(w, '0')
  return `${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(millis, 3)}`
}

/**
 * Human date from a manifest created_at ISO string with offset,
 * e.g. "2026-07-27T14:30:52+09:00" -> "2026-07-27 14:30 (+09:00)".
 * Falls back to the raw string when it does not look like ISO 8601.
 */
export function humanDate(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.exec(iso)
  if (!m) return iso
  const offset = m[3] === undefined || m[3] === 'Z' ? 'UTC' : m[3]
  return `${m[1]} ${m[2]} (${offset})`
}

/** "00:03.200–00:04.200" for a lifetime box, or "entire capture" without one. */
export function lifetimeLabel(a: Annotation, t: TranslateFn = makeT('en')): string {
  if (a.start_ms === undefined || a.end_ms === undefined) return t('pack.entireCapture')
  return `${formatClock(a.start_ms)}–${formatClock(a.end_ms)}`
}

/**
 * One human-readable line per box (without the display number), e.g.
 * `00:03.200–00:04.200 — "Submit overflows" — box at (612, 340) size 306×180, blur`.
 */
export function describeAnnotation(a: Annotation, t: TranslateFn = makeT('en')): string {
  const parts: string[] = [lifetimeLabel(a, t)]
  if (a.text.trim() !== '') parts.push(`"${a.text.trim()}"`)
  const b = a.bounds
  const flags = a.blur ? ', blur' : ''
  parts.push(`box at (${px(b.x)}, ${px(b.y)}) size ${px(b.width)}×${px(b.height)}${flags}`)
  return parts.join(' — ')
}

export function buildReport(
  manifest: Manifest,
  annotationsFile: AnnotationsFile,
  lang: Language = 'en',
): string {
  const t = makeT(lang)
  const lines: string[] = []

  // The user's own title is never translated; only the fallback is localized.
  lines.push(`# ${manifest.title ?? t('pack.untitled')}`)
  lines.push('')
  lines.push(`- **${t('pack.captured')}:** ${humanDate(manifest.created_at)}`)
  lines.push(`- **${t('pack.packId')}:** ${manifest.id}`)
  lines.push(`- **${t('pack.generator')}:** ${manifest.generator.name} ${manifest.generator.version}`)
  lines.push('')

  lines.push(`## ${t('pack.note')}`)
  lines.push('')
  lines.push(manifest.note ?? t('pack.noNote'))
  lines.push('')

  const hasReplay = manifest.media.replay !== null
  const replaySeconds = ((manifest.media.replay_duration_ms ?? 0) / 1000).toFixed(1)
  lines.push(`## ${t('pack.environment')}`)
  lines.push('')
  lines.push(`- **${t('pack.os')}:** ${manifest.environment.os} (version ${manifest.environment.os_version})`)
  const screens = manifest.environment.screens
    .map((s) => `${s.width}×${s.height} @${s.scale}x scale`)
    .join('; ')
  lines.push(`- **${t('pack.screens')}:** ${screens}`)
  if (manifest.environment.app !== undefined) {
    lines.push(`- **${t('pack.focusedApp')}:** ${manifest.environment.app}`)
  }
  lines.push(
    hasReplay
      ? `- **${t('pack.replay')}:** ${replaySeconds}s screen recording (${manifest.media.replay})` +
          (manifest.media.replay_annotated !== undefined
            ? `; annotated view: ${manifest.media.replay_annotated}`
            : '')
      : `- **${t('pack.replay')}:** ${t('pack.replayNone')}`,
  )
  if (manifest.media.snapshot_t_ms !== undefined) {
    lines.push(`- **${t('pack.snapshotFrame')}:** ${formatClock(manifest.media.snapshot_t_ms)} into the replay`)
  }
  lines.push('')

  lines.push(`## ${t('pack.annotations')}`)
  lines.push('')
  const annotations = annotationsFile.annotations
  if (annotations.length === 0) {
    lines.push(t('pack.none'))
  } else {
    lines.push(
      `Coordinates are pixels in snapshot.png (${annotationsFile.reference_width}×${annotationsFile.reference_height}). ` +
        'Numbers are the computed display numbers (SPEC §8.5) — identical in every rendered view.',
    )
    lines.push('')
    // Numbered boxes first, in display-number order; unnumbered boxes follow as
    // plain bullets. Numbers come from the shared helper, never from storage.
    const numbers = computeDisplayNumbers(annotations)
    const numbered = annotations
      .filter((a) => numbers.has(a.annotation_id))
      .sort((a, b) => (numbers.get(a.annotation_id) ?? 0) - (numbers.get(b.annotation_id) ?? 0))
    for (const a of numbered) {
      lines.push(`${numbers.get(a.annotation_id)}. ${describeAnnotation(a, t)}`)
    }
    for (const a of annotations) {
      if (!numbers.has(a.annotation_id)) lines.push(`- ${describeAnnotation(a, t)}`)
    }
  }
  const blurCount = annotations.filter((a) => a.blur).length
  if (blurCount > 0) {
    // SPEC §9: blur is non-destructive — originals keep the unredacted pixels.
    const subject = blurCount === 1 ? '1 box is' : `${blurCount} boxes are`
    lines.push('')
    lines.push(
      `${subject} marked blur. snapshot.png${hasReplay ? ' and replay.webm' : ''} contain the ` +
        'original, unredacted pixels; blur renders only into derived views ' +
        `(${hasReplay ? 'replay_annotated.webm, ' : ''}editor previews).`,
    )
  }
  lines.push('')

  lines.push(`## ${t('pack.files')}`)
  lines.push('')
  lines.push('- manifest.json — pack identity, environment, file inventory')
  lines.push(
    `- snapshot.png — captured frame, ${annotationsFile.reference_width}×${annotationsFile.reference_height} (original pixels, never modified)`,
  )
  lines.push('- annotations.json — the annotation boxes above, as editable data (the true source)')
  lines.push('- timeline.json — timestamped events from capture start to save')
  if (hasReplay) {
    lines.push(`- replay.webm — ${replaySeconds}s screen recording (original evidence, never modified)`)
    lines.push(
      '- replay_annotated.webm — the replay with annotations rendered in ' +
        '(generated in the background; may appear shortly after save)',
    )
  }
  lines.push('- README.md — human-first entry point')
  lines.push('- skills/ — AI-first context documents')
  lines.push('- report.md — this file')
  lines.push('')

  return lines.join('\n')
}
