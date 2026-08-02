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
import { annotationsOnDisplay, declaredDisplayIndices, focusedDisplayIndex } from '../shared/types'
import { computeDisplayNumbers } from '../shared/numbering'
import { computeKeyframes, keyframeFileName } from '../shared/keyframes'
import { replayCoverage } from '../shared/displayClock'

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

/**
 * Pixel size of a declared display's snapshot — the frame its boxes live in.
 *
 * The entry STATES it from 0.7.0 (SPEC §5.6), so that is what gets printed. The
 * bounds × scale fallback is for a pack written before the field existed, and it
 * is a fallback rather than the rule for a reason: the arithmetic disagrees with
 * the real raster by a pixel at 1.25x/1.5x, and this string ends up in report.md
 * as a fact about a file the reader can open.
 */
function displayPixels(d: NonNullable<Manifest['media']['displays']>[number]): string {
  const width =
    typeof d.snapshot_width === 'number' && d.snapshot_width > 0
      ? d.snapshot_width
      : Math.round(d.bounds.width * d.scale)
  const height =
    typeof d.snapshot_height === 'number' && d.snapshot_height > 0
      ? d.snapshot_height
      : Math.round(d.bounds.height * d.scale)
  return `${width}×${height}`
}

/**
 * True when this pack carries media for MORE THAN ONE screen (SPEC §5.6).
 *
 * Not "declares media.displays": from 0.7.0 every video pack does, a one-screen
 * capture included. What the documents branch on is whether there is more than
 * one screen to tell the reader about.
 */
export function isMultiDisplay(manifest: Manifest): boolean {
  const displays = manifest.media.displays
  return Array.isArray(displays) && displays.length > 1
}

/** The pack's focused display index — where a box without `display` lives. */
export function packFocusedDisplay(manifest: Manifest): number {
  return focusedDisplayIndex(manifest.media.displays)
}

/**
 * The display indices this pack declares. Passed to every annotationsOnDisplay
 * call below so a box naming a display the manifest does not have resolves to
 * the FOCUSED display (SPEC §8.8) instead of belonging to no group at all — it
 * would otherwise vanish from the per-display sections and the counts while the
 * editor kept drawing it.
 */
function packDisplayIndices(manifest: Manifest): ReadonlySet<number> | undefined {
  return declaredDisplayIndices(manifest.media.displays)
}

/** One display's boxes (SPEC §8.8), in array order. */
export function boxesOnDisplay(
  manifest: Manifest,
  annotations: readonly Annotation[],
  index: number,
): Annotation[] {
  return annotationsOnDisplay(
    annotations,
    index,
    packFocusedDisplay(manifest),
    packDisplayIndices(manifest),
  )
}

/**
 * The boxes of the pack grouped by the display they were drawn on (SPEC §8.8),
 * FOCUSED display first and the rest by index — the reading order a human would
 * pick, and the order every generated document uses.
 *
 * Empty for a single-display pack: there is one display, so grouping by it
 * would only add a heading that says nothing.
 */
export function groupByDisplay(
  manifest: Manifest,
  annotations: readonly Annotation[],
): Array<{ index: number; focused: boolean; annotations: Annotation[] }> {
  const displays = manifest.media.displays
  if (!Array.isArray(displays) || displays.length < 2) return []
  const focused = packFocusedDisplay(manifest)
  const declared = packDisplayIndices(manifest)
  const ordered = [...displays].sort((a, b) =>
    a.focused === b.focused ? a.index - b.index : a.focused ? -1 : 1,
  )
  return ordered.map((d) => ({
    index: d.index,
    focused: d.focused,
    annotations: annotationsOnDisplay(annotations, d.index, focused, declared),
  }))
}

/**
 * The captured displays as markdown bullets, e.g.
 * `- **Displays:** 2 captured` + one indented line per display.
 *
 * Empty for a ONE-SCREEN pack, and the test is `< 2` rather than "is the array
 * there". From 0.7.0 the array is always there, so the old absent/empty guard
 * would have started printing "Displays: 1 captured" and an indented line
 * describing snapshot.png into every single-monitor report.md — a format change
 * silently rewriting what users read. One screen has nothing to disambiguate;
 * the media table already names snapshot.png and its size.
 */
export function displaySummaryLines(
  manifest: Manifest,
  t: TranslateFn = makeT('en'),
  annotations: readonly Annotation[] = [],
): string[] {
  const displays = manifest.media.displays
  if (displays === undefined || displays.length < 2) return []
  const focusedIndex = packFocusedDisplay(manifest)
  const declared = packDisplayIndices(manifest)
  const lines = [`- **${t('pack.displays')}:** ${displays.length} captured`]
  for (const d of displays) {
    // A DISPLAY WHOSE REPLAY IS NOT ON THE CAPTURE'S CLOCK SAYS SO (#110).
    //
    // A screen nobody touched makes almost no frames, and the ones it makes are
    // laid end to end — 18.7 s of capture came back as 3.7 s of media. Nothing
    // downstream can stretch that back, so the pack's own description of itself
    // is where a reader finds out, rather than after placing a box in the wrong
    // second.
    const coverage = replayCoverage(
      d.replay_duration_ms ?? 0,
      manifest.media.replay_duration_ms ?? 0,
      d.replay_clock_offset_ms,
    )
    const compressed =
      d.replay !== null && coverage.compressed
        ? ` — ${t('pack.replayCompressed', {
            media: (coverage.mediaMs / 1000).toFixed(1),
            capture: (coverage.captureMs / 1000).toFixed(1),
          })}`
        : ''
    const replay =
      d.replay === null
        ? 'no replay'
        : `${((d.replay_duration_ms ?? 0) / 1000).toFixed(1)}s \`${d.replay}\`${compressed}`
    const focused = d.focused ? ` (${t('pack.displayFocused')})` : ''
    // How many boxes were drawn on THIS screen — the single most useful thing
    // to know about a display once every display is annotatable (SPEC §8.8).
    const count = annotationsOnDisplay(annotations, d.index, focusedIndex, declared).length
    const boxes = count === 0 ? '' : `, ${count} annotation${count === 1 ? '' : 's'}`
    lines.push(
      `  - ${d.index}: ${displayPixels(d)} at ${px(d.bounds.x)},${px(d.bounds.y)} @${d.scale}x — ` +
        `\`${d.snapshot}\`, ${replay}${boxes}${focused}`,
    )
  }
  return lines
}

/**
 * The per-display files a single-display pack does not have: the NON-focused
 * displays' media (the focused display's files are snapshot.png/replay.webm,
 * already listed by every document) and, for a screen that carries boxes, its
 * OWN annotated views.
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
    // Declared only once the background render for that display has finished
    // (SPEC §5.6), so naming them here is naming files that exist.
    if (typeof d.replay_annotated === 'string') {
      files.push({
        name: d.replay_annotated,
        what: `Display ${d.index} replay with ITS OWN annotation boxes rendered in — watch this one for that screen`,
      })
    }
    const frames = d.keyframes
    if (Array.isArray(frames) && frames.length > 0) {
      const dir = frames[0]?.file.split('/')[0] ?? `frames-d${d.index}`
      files.push({
        name: `${dir}/`,
        what:
          `${frames.length} annotated still${frames.length === 1 ? '' : 's'} of display ${d.index}, ` +
          'one per annotation state change on that screen — times are on THAT display’s replay clock',
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
  // The pack's OWN stills cover the FOCUSED display (SPEC §5.6): a box on
  // another screen is rendered into that screen's own stills, so counting it
  // here would predict filenames the render never writes.
  const { times, dropped } = computeKeyframes(
    boxesOnDisplay(manifest, annotationsFile.annotations, packFocusedDisplay(manifest)),
    durationMs,
  )
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
export function keyframeSectionLines(
  set: KeyframeSet,
  t: TranslateFn,
  imageCapture = false,
): string[] {
  if (set.frames.length === 0) return []
  if (imageCapture) {
    const frame = set.frames[0]
    if (frame === undefined) return []
    const lines = [
      'An annotated rendering of the captured still image, with blur, borders, number badges and',
      'text drawn in. `snapshot.png` remains the unmodified source image.',
      '',
      `![Annotated image](${frame.file})`,
    ]
    if (!set.declared) {
      lines.push(
        '',
        'This rendering is generated in the background after save. The source image and',
        'annotations.json are complete even if the link does not resolve yet.',
      )
    }
    return lines
  }
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
export function keyframeFileEntry(
  set: KeyframeSet,
  imageCapture = false,
): { name: string; what: string } | null {
  if (set.frames.length === 0) return null
  if (imageCapture) {
    return {
      name: set.frames[0]?.file ?? 'frames/',
      what:
        'annotated rendering of snapshot.png — derived from the same still-image pixels' +
        (set.declared
          ? ', declared in manifest.media.keyframes'
          : '; declared after the background render finishes'),
    }
  }
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

/**
 * One list of boxes: numbered ones first in display-number order, then the
 * unnumbered ones as plain bullets. Shared by the flat single-display list and
 * by each per-display group, so the two can never drift apart.
 */
function annotationLines(
  annotations: readonly Annotation[],
  numbers: ReadonlyMap<string, number>,
  t: TranslateFn,
): string[] {
  const lines: string[] = []
  const numbered = annotations
    .filter((a) => numbers.has(a.annotation_id))
    .sort((a, b) => (numbers.get(a.annotation_id) ?? 0) - (numbers.get(b.annotation_id) ?? 0))
  for (const a of numbered) {
    lines.push(`${numbers.get(a.annotation_id)}. ${describeAnnotation(a, t)}`)
  }
  for (const a of annotations) {
    if (!numbers.has(a.annotation_id)) lines.push(`- ${describeAnnotation(a, t)}`)
  }
  return lines
}

export function buildReport(
  manifest: Manifest,
  annotationsFile: AnnotationsFile,
  lang: Language = 'en',
  // True only when a background render really is about to write the stills the
  // keyframe section names — see keyframeSet().
  renderPending = false,
  // The exporter passes true only after viewer.html was written successfully.
  includeViewer = false,
): string {
  const t = makeT(lang)
  const lines: string[] = []
  const imageCapture = manifest.capture_kind === 'image'

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
  const replayName = manifest.media.replay ?? 'replay.webm'
  const annotatedReplayName = manifest.media.replay_annotated
  const annotatedReplayPending = hasReplay && renderPending && annotatedReplayName === undefined
  const hasAnnotatedReplay = annotatedReplayName !== undefined || annotatedReplayPending
  const annotatedReplayFile = annotatedReplayName ?? 'replay_annotated.webm'
  const replaySeconds = ((manifest.media.replay_duration_ms ?? 0) / 1000).toFixed(1)
  lines.push(`## ${t('pack.environment')}`)
  lines.push('')
  lines.push(`- **${t('pack.os')}:** ${manifest.environment.os} (version ${manifest.environment.os_version})`)
  const screens = manifest.environment.screens
    .map((s) => `${s.width}×${s.height} @${s.scale}x scale`)
    .join('; ')
  lines.push(`- **${t('pack.screens')}:** ${screens}`)
  // All-displays capture: what the trigger actually froze, per display.
  lines.push(...displaySummaryLines(manifest, t, annotationsFile.annotations))
  if (manifest.environment.app !== undefined) {
    lines.push(`- **${t('pack.focusedApp')}:** ${manifest.environment.app}`)
  }
  if (!imageCapture) {
    lines.push(
      hasReplay
        ? `- **${t('pack.replay')}:** ${replaySeconds}s screen recording (${manifest.media.replay})` +
            (manifest.media.replay_annotated !== undefined
              ? `; annotated view: ${manifest.media.replay_annotated}`
              : '')
        : `- **${t('pack.replay')}:** ${t('pack.replayNone')}`,
    )
  }
  if (!imageCapture && manifest.media.snapshot_t_ms !== undefined) {
    lines.push(`- **${t('pack.snapshotFrame')}:** ${formatClock(manifest.media.snapshot_t_ms)} into the replay`)
  }
  lines.push('')

  lines.push(`## ${t('pack.annotations')}`)
  lines.push('')
  const annotations = annotationsFile.annotations
  if (annotations.length === 0) {
    lines.push(t('pack.none'))
  } else {
    // Numbers come from the shared helper, never from storage — and they are
    // GLOBAL across the whole pack, so the sequence runs on through the
    // per-display groups below rather than restarting on each screen.
    const numbers = computeDisplayNumbers(annotations)
    const groups = groupByDisplay(manifest, annotations)
    if (groups.length === 0) {
      lines.push(
        `Coordinates are pixels in snapshot.png (${annotationsFile.reference_width}×${annotationsFile.reference_height}). ` +
          'Numbers are the computed display numbers (SPEC §8.5) — identical in every rendered view.',
      )
      lines.push('')
      lines.push(...annotationLines(annotations, numbers, t))
    } else {
      // Multi-display pack: a box belongs to the screen it was drawn on, and
      // its coordinates are in THAT screen's snapshot (SPEC §8.8). Listing them
      // in one flat list would silently mix three coordinate spaces.
      lines.push(
        'This capture froze more than one display. Boxes are grouped by the display they were ' +
          'drawn on; each group’s coordinates are pixels in THAT display’s snapshot (SPEC §8.2, ' +
          '§8.8). Numbers are the computed display numbers (SPEC §8.5) — one global sequence ' +
          'across the whole pack, identical in every rendered view.',
      )
      const declaredDisplays = manifest.media.displays ?? []
      for (const g of groups) {
        if (g.annotations.length === 0) continue
        // The name and size the manifest DECLARES, not ones re-derived from the
        // index: the format now states both (SPEC §5.6), and this line tells a
        // reader which file to open a box's coordinates against.
        const entry = declaredDisplays.find((d) => d.index === g.index)
        const snapshot = g.focused
          ? `snapshot.png, ${annotationsFile.reference_width}×${annotationsFile.reference_height}`
          : entry === undefined
            ? `snapshot-d${g.index}.png`
            : `${entry.snapshot}, ${displayPixels(entry)}`
        lines.push('')
        lines.push(
          `### ${t('pack.display')} ${g.index}${g.focused ? ` (${t('pack.displayFocused')})` : ''} — ${snapshot}`,
        )
        lines.push('')
        lines.push(...annotationLines(g.annotations, numbers, t))
      }
    }
  }
  const blurCount = annotations.filter((a) => a.blur).length
  if (blurCount > 0) {
    // SPEC §9: blur is non-destructive — originals keep the unredacted pixels.
    const subject = blurCount === 1 ? '1 box is' : `${blurCount} boxes are`
    lines.push('')
    lines.push(
      `${subject} marked blur. snapshot.png${hasReplay ? ` and ${replayName}` : ''} contain the ` +
        'original, unredacted pixels; blur renders only into derived views ' +
        `(${hasAnnotatedReplay ? `${annotatedReplayFile}, ` : ''}editor previews).`,
    )
  }
  lines.push('')

  // Annotated keyframes (GOAL "Annotated keyframes"): images beat video for an
  // LLM, so they sit directly under the annotation list they illustrate.
  const keyframes = keyframeSet(manifest, annotationsFile, renderPending)
  const keyframeLines = keyframeSectionLines(keyframes, t, imageCapture)
  if (keyframeLines.length > 0) {
    lines.push(imageCapture ? '## Annotated image' : `## ${t('pack.keyframes')}`)
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
  if (!imageCapture) lines.push('- timeline.json — timestamped events from capture start to save')
  if (hasReplay) {
    // The DECLARED name (SPEC §5.3 allows replay.mp4 too) — never assumed.
    lines.push(
      `- ${manifest.media.replay} — ${replaySeconds}s screen recording (original evidence, never modified)`,
    )
    if (hasAnnotatedReplay) {
      lines.push(
        `- ${annotatedReplayFile} — the replay with annotations rendered in` +
          (annotatedReplayPending
            ? ' (generated in the background; may appear shortly after save)'
            : ' (declared in manifest.json)'),
      )
    }
  }
  for (const f of extraDisplayFiles(manifest)) {
    lines.push(`- ${f.name} — ${f.what}`)
  }
  const framesEntry = keyframeFileEntry(keyframes, imageCapture)
  if (framesEntry !== null) lines.push(`- ${framesEntry.name} — ${framesEntry.what}`)
  lines.push('- README.md — human-first entry point')
  lines.push('- skills/ — AI-first context documents')
  if (includeViewer) {
    lines.push('- viewer.html — double-clickable offline view (no install or server)')
  }
  lines.push('- report.md — this file')
  lines.push('')

  return lines.join('\n')
}
