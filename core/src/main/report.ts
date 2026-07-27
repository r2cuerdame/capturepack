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
import { computeKeyframes, keyframeFileName } from '../shared/keyframes'

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

// ---------------------------------------------------------------------------
// All-displays capture (GOAL "Multi-Monitor Support", SPEC §5.3): every
// document lists every captured display, so a reader knows the pack holds more
// than the one screen the annotations live on.
// ---------------------------------------------------------------------------

/** Physical pixel size of a declared display (bounds are DIP × scale). */
function displayPixels(d: NonNullable<Manifest['media']['displays']>[number]): string {
  return `${Math.round(d.bounds.width * d.scale)}×${Math.round(d.bounds.height * d.scale)}`
}

/**
 * The captured displays as markdown bullets, e.g.
 * `- **Displays:** 2 captured` + one indented line per display.
 * Empty for a single-display pack (no media.displays).
 */
export function displaySummaryLines(manifest: Manifest, t: TranslateFn = makeT('en')): string[] {
  const displays = manifest.media.displays
  if (displays === undefined || displays.length === 0) return []
  const lines = [`- **${t('pack.displays')}:** ${displays.length} captured`]
  for (const d of displays) {
    const replay =
      d.replay === null
        ? 'no replay'
        : `${((d.replay_duration_ms ?? 0) / 1000).toFixed(1)}s \`${d.replay}\``
    const focused = d.focused ? ` (${t('pack.displayFocused')})` : ''
    lines.push(
      `  - ${d.index}: ${displayPixels(d)} at ${px(d.bounds.x)},${px(d.bounds.y)} @${d.scale}x — ` +
        `\`${d.snapshot}\`, ${replay}${focused}`,
    )
  }
  return lines
}

/**
 * The per-display files a single-display pack does not have: the NON-focused
 * displays' media (the focused display's files are snapshot.png/replay.webm,
 * already listed by every document).
 */
export function extraDisplayFiles(manifest: Manifest): Array<{ name: string; what: string }> {
  const displays = manifest.media.displays
  if (displays === undefined) return []
  const files: Array<{ name: string; what: string }> = []
  for (const d of displays) {
    if (d.focused) continue
    files.push({
      name: d.snapshot,
      what: `Display ${d.index}, ${displayPixels(d)} — the same instant on another screen (original pixels, no annotations)`,
    })
    if (d.replay !== null) {
      files.push({
        name: d.replay,
        what: `Display ${d.index} screen recording, ${((d.replay_duration_ms ?? 0) / 1000).toFixed(1)}s — original evidence, never modified`,
      })
    }
  }
  return files
}

// ---------------------------------------------------------------------------
// Annotated keyframes (GOAL "Annotated keyframes (LLM-first)", SPEC §5.7):
// every generated document links the stills as markdown images, so a model
// reconstructs the whole story from text + images alone — no video decoding.
// ---------------------------------------------------------------------------

export interface KeyframeRef {
  // 1-based position — the NN in the filename and the order to read them in
  n: number
  // Pack-relative path, e.g. "frames/frame-01_00-03.200.png"
  file: string
  tMs: number
}

export interface KeyframeSet {
  frames: KeyframeRef[]
  // true  = manifest.media.keyframes declares them: the render finished and
  //         every listed file is in the pack.
  // false = the documents were generated BEFORE the background render (the
  //         normal case at save time), so these are the names it will write.
  //         Deterministic: the same shared rule produces both.
  declared: boolean
  // State changes the MAX_KEYFRAMES cap left without a still. 0 normally.
  dropped: number
}

/**
 * The pack's keyframes: the manifest's declaration when it has one, else the
 * set the PENDING render will produce (computeKeyframeTimes, shared rule).
 *
 * `renderPending` is the caller's promise that a render really is coming. A
 * save-first folder (which no render follows) and a document regenerated AFTER
 * a render pass false: an undeclared set is then simply an absent one, and the
 * documents say nothing about stills that will never exist (SPEC §12.2).
 */
export function keyframeSet(
  manifest: Manifest,
  annotationsFile: AnnotationsFile,
  renderPending = false,
): KeyframeSet {
  const durationMs =
    manifest.media.replay === null ? 0 : (manifest.media.replay_duration_ms ?? 0)
  // The same input the render used, so the cap it hit is the cap reported here.
  const { times, dropped } = computeKeyframes(annotationsFile.annotations, durationMs)
  const declared = manifest.media.keyframes
  if (Array.isArray(declared) && declared.length > 0) {
    const frames: KeyframeRef[] = []
    declared.forEach((k, i) => {
      if (k === null || typeof k !== 'object') return
      if (typeof k.file !== 'string' || typeof k.t_ms !== 'number') return
      frames.push({ n: i + 1, file: k.file, tMs: k.t_ms })
    })
    if (frames.length > 0) return { frames, declared: true, dropped }
  }
  if (!renderPending) return { frames: [], declared: false, dropped: 0 }
  return {
    frames: times.map((tMs, i) => ({ n: i + 1, file: keyframeFileName(i + 1, tMs), tMs })),
    declared: false,
    dropped,
  }
}

/**
 * The "Annotated keyframes" section BODY (the caller supplies its own heading),
 * shared by report.md, README.md and skills/overview.md so the three documents
 * can never list different stills.
 */
export function keyframeSectionLines(set: KeyframeSet, t: TranslateFn): string[] {
  if (set.frames.length === 0) return []
  const lines: string[] = [
    'Stills rendered exactly like the annotated replay — one per annotation state change (a box',
    'appearing or disappearing), with blur, borders, number badges and text drawn in. Read them in',
    'order to reconstruct the capture without decoding any video.',
    '',
  ]
  for (const f of set.frames) {
    const clock = formatClock(f.tMs)
    lines.push(`- **${clock}** — ![${t('pack.keyframeAlt', { n: String(f.n), time: clock })}](${f.file})`)
  }
  // Honesty about the MAX_KEYFRAMES cap: "read them in order to reconstruct the
  // capture" stops being the whole truth once a state change had no slot left.
  if (set.dropped > 0) {
    lines.push('')
    lines.push(
      `${set.dropped} further annotation state change${set.dropped === 1 ? '' : 's'} ` +
        'were not rendered as stills (per-pack still limit); annotations.json carries every ' +
        'lifetime, and replay_annotated.webm shows them all.',
    )
  }
  if (!set.declared) {
    lines.push('')
    lines.push(
      'These render in the background right after save. A link that does not resolve yet means the',
    )
    lines.push('render is still running (or failed) — the media and annotations.json are complete either way.')
  }
  return lines
}

/** The frames/ entry for a document's file list, or null when there are none. */
export function keyframeFileEntry(set: KeyframeSet): { name: string; what: string } | null {
  if (set.frames.length === 0) return null
  const n = set.frames.length
  return {
    name: 'frames/',
    what:
      `${n} annotated still${n === 1 ? '' : 's'} (frame-NN_MM-SS.mmm.png), one per annotation state ` +
      'change — the same overlays the annotated replay draws' +
      (set.declared
        ? ', declared in manifest.media.keyframes'
        : '; manifest.media.keyframes declares them once the background render finishes'),
  }
}

export function buildReport(
  manifest: Manifest,
  annotationsFile: AnnotationsFile,
  lang: Language = 'en',
  // True only when a background render really is about to write the stills the
  // keyframe section names — see keyframeSet().
  renderPending = false,
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
  // All-displays capture: what the trigger actually froze, per display.
  lines.push(...displaySummaryLines(manifest, t))
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

  // Annotated keyframes (GOAL "Annotated keyframes"): images beat video for an
  // LLM, so they sit directly under the annotation list they illustrate.
  const keyframes = keyframeSet(manifest, annotationsFile, renderPending)
  const keyframeLines = keyframeSectionLines(keyframes, t)
  if (keyframeLines.length > 0) {
    lines.push(`## ${t('pack.keyframes')}`)
    lines.push('')
    lines.push(...keyframeLines)
    lines.push('')
  }

  lines.push(`## ${t('pack.files')}`)
  lines.push('')
  lines.push('- manifest.json — pack identity, environment, file inventory')
  lines.push(
    `- snapshot.png — captured frame, ${annotationsFile.reference_width}×${annotationsFile.reference_height} (original pixels, never modified)`,
  )
  lines.push('- annotations.json — the annotation boxes above, as editable data (the true source)')
  lines.push('- timeline.json — timestamped events from capture start to save')
  if (hasReplay) {
    // The DECLARED name (SPEC §5.3 allows replay.mp4 too) — never assumed.
    lines.push(
      `- ${manifest.media.replay} — ${replaySeconds}s screen recording (original evidence, never modified)`,
    )
    lines.push(
      '- replay_annotated.webm — the replay with annotations rendered in ' +
        '(generated in the background; may appear shortly after save)',
    )
  }
  for (const f of extraDisplayFiles(manifest)) {
    lines.push(`- ${f.name} — ${f.what}`)
  }
  const framesEntry = keyframeFileEntry(keyframes)
  if (framesEntry !== null) lines.push(`- ${framesEntry.name} — ${framesEntry.what}`)
  lines.push('- README.md — human-first entry point')
  lines.push('- skills/ — AI-first context documents')
  lines.push('- report.md — this file')
  lines.push('')

  return lines.join('\n')
}
