// Generators for README.md (human-first) and skills/ (AI-first) — SPEC §12.2/§12.3.
// Pure functions only; no Electron or filesystem access. Regenerated on every
// save so the documents always match annotations.json (GOAL "Pin Numbering":
// documents are regenerated when annotations change).
//
// i18n scope (GOAL "Internationalization", packLanguage): template HEADINGS
// and short labels are localized via the pack.* dictionary keys; explanatory
// PROSE stays English on purpose so the documents remain canonical for AI
// readers (like the MCP tool descriptions). The user's own title/note text is
// NEVER translated.

import { makeT } from '../shared/i18n'
import type { Language, TranslateFn } from '../shared/i18n'
import type { Annotation, AnnotationsFile, Manifest, TimelineFile } from '../shared/types'
import { computeDisplayNumbers } from '../shared/numbering'
import { annotationDisplayIndex, declaredDisplayIndices } from '../shared/types'
import {
  displaySummaryLines,
  extraDisplayFiles,
  formatClock,
  groupByDisplay,
  humanDate,
  isMultiDisplay,
  keyframeFileEntry,
  keyframeSectionLines,
  keyframeSet,
  lifetimeLabel,
  packFocusedDisplay,
} from './report'

const px = (n: number): number => Math.round(n)

export interface SkillsDocs {
  overview: string
  timeline: string
  annotation: string
  dom: string
  project: string
}

/** The five well-known skills docs, keyed by filename inside skills/. */
export const SKILLS_FILES: ReadonlyArray<keyof SkillsDocs> = [
  'overview',
  'timeline',
  'annotation',
  'dom',
  'project',
]

function replayLabel(manifest: Manifest, t: TranslateFn): string {
  if (manifest.media.replay === null) return t('pack.screenshotOnly')
  const seconds = ((manifest.media.replay_duration_ms ?? 0) / 1000).toFixed(1)
  return t('pack.replaySnapshot', { seconds })
}

function annotationCounts(annotations: readonly Annotation[]): string {
  const numbered = annotations.filter((a) => a.numbered).length
  const blurred = annotations.filter((a) => a.blur).length
  const plain = annotations.filter((a) => !a.numbered && !a.blur).length
  const n = annotations.length
  if (n === 0) return 'no annotation boxes'
  const parts = [`${numbered} numbered`, `${blurred} blurred`, `${plain} plain`]
  return `${n} annotation box${n === 1 ? '' : 'es'} (${parts.join(', ')})`
}

// ---------------------------------------------------------------------------
// README.md — the first document a human reads. Reading it alone must be
// enough to understand the whole pack (GOAL "Output layout — Folder First").
// ---------------------------------------------------------------------------

export function buildReadme(
  manifest: Manifest,
  annotationsFile: AnnotationsFile,
  lang: Language = 'en',
  // True only when a background render really is about to write the annotated
  // stills this document names — see report.ts keyframeSet().
  renderPending = false,
): string {
  const t = makeT(lang)
  const annotations = annotationsFile.annotations
  const hasReplay = manifest.media.replay !== null
  const replayName = manifest.media.replay ?? 'replay.webm'
  const blurCount = annotations.filter((a) => a.blur).length
  const lines: string[] = []

  // The user's own title is never translated; only the fallback is localized.
  lines.push(`# ${manifest.title ?? t('pack.untitled')}`)
  lines.push('')
  lines.push(`- **${t('pack.created')}:** ${humanDate(manifest.created_at)}`)
  lines.push(`- **${t('pack.application')}:** ${manifest.environment.app ?? t('pack.unknown')}`)
  lines.push(`- **${t('pack.duration')}:** ${replayLabel(manifest, t)}`)
  // All-displays capture (GOAL "Multi-Monitor Support"): the pack holds every
  // screen the trigger froze, with the boxes drawn on each.
  lines.push(...displaySummaryLines(manifest, t, annotations))
  lines.push('')

  lines.push(`## ${t('pack.description')}`)
  lines.push('')
  const description = manifest.note ?? manifest.title
  lines.push(description ?? t('pack.noDescription'))
  lines.push('')

  // Annotated keyframes (GOAL "Annotated keyframes (LLM-first)"): the story as
  // images, right after the description — before the reader is asked to open
  // anything at all.
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
  lines.push(`| ${t('pack.fileCol')} | ${t('pack.whatCol')} |`)
  lines.push('|---|---|')
  lines.push(
    `| snapshot.png | The captured frame, ${annotationsFile.reference_width}×${annotationsFile.reference_height} — original pixels, never modified |`,
  )
  if (hasReplay) {
    const seconds = ((manifest.media.replay_duration_ms ?? 0) / 1000).toFixed(1)
    // The DECLARED name (SPEC §5.3 allows replay.mp4 too) — never assumed.
    lines.push(
      `| ${manifest.media.replay} | ${seconds}s screen recording before the capture — original, never modified |`,
    )
    lines.push(
      '| replay_annotated.webm | The replay with annotations rendered in — watch this one (generated in the background; may appear shortly after save) |',
    )
  }
  for (const f of extraDisplayFiles(manifest)) {
    lines.push(`| ${f.name} | ${f.what} |`)
  }
  const framesEntry = keyframeFileEntry(keyframes)
  if (framesEntry !== null) lines.push(`| ${framesEntry.name} | ${framesEntry.what} |`)
  lines.push(`| annotations.json | ${annotationCounts(annotations)} — the editable source |`)
  lines.push('| timeline.json | When the capture and each annotation happened |')
  lines.push('| report.md | The full generated narrative of this pack |')
  lines.push('| skills/ | Context documents structured for AI readers |')
  lines.push('| manifest.json | Pack identity, environment, and file inventory |')
  lines.push('')

  lines.push(`## ${t('pack.howToUse')}`)
  lines.push('')
  if (hasReplay) {
    lines.push('1. Watch `replay_annotated.webm` — the annotations are rendered into the video.')
  } else {
    lines.push(
      '1. Open `snapshot.png` — this pack is screenshot-only, so there is no `replay_annotated.webm`',
    )
    lines.push('   to watch. (In packs with a replay, watch `replay_annotated.webm` first.)')
  }
  if (keyframeLines.length > 0) {
    lines.push(
      '2. In a hurry — or reading as an AI: the stills above (`frames/`) show every annotation state',
    )
    lines.push('   without decoding video. They are rendered in the background right after save.')
    lines.push('3. Read `report.md` for the full narrative.')
    lines.push('4. AI: read the documents in `skills/`, or connect through a CapturePack MCP server.')
  } else {
    lines.push('2. Read `report.md` for the full narrative.')
    lines.push('3. AI: read the documents in `skills/`, or connect through a CapturePack MCP server.')
  }

  if (blurCount > 0) {
    const which =
      blurCount === 1 ? 'one annotation box is marked blur' : `${blurCount} annotation boxes are marked blur`
    lines.push('')
    lines.push(
      `Note: ${which}. Blur is non-destructive — \`snapshot.png\`${hasReplay ? ` and \`${replayName}\`` : ''} contain ` +
        'the original, unredacted pixels; blur renders only into derived views. Keep that in mind before',
    )
    lines.push('forwarding this folder.')
  }
  lines.push('')

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// skills/ — five well-known documents, structured so an LLM understands the
// pack immediately even without the MCP server.
// ---------------------------------------------------------------------------

export function buildSkills(
  manifest: Manifest,
  annotationsFile: AnnotationsFile,
  timeline: TimelineFile,
  lang: Language = 'en',
  renderPending = false,
): SkillsDocs {
  // skills/ documents are AI-first: only the top-level headings follow
  // packLanguage; the body prose deliberately stays English (see header note).
  const t = makeT(lang)
  return {
    overview: buildOverviewSkill(manifest, annotationsFile, timeline, t, renderPending),
    timeline: buildTimelineSkill(manifest, timeline, t),
    annotation: buildAnnotationSkill(manifest, annotationsFile, t),
    dom: buildDomSkill(manifest, annotationsFile, t),
    project: buildProjectSkill(manifest, t),
  }
}

function buildOverviewSkill(
  manifest: Manifest,
  annotationsFile: AnnotationsFile,
  timeline: TimelineFile,
  t: TranslateFn,
  renderPending: boolean,
): string {
  const annotations = annotationsFile.annotations
  const hasReplay = manifest.media.replay !== null
  const replayName = manifest.media.replay ?? 'replay.webm'
  const numbers = computeDisplayNumbers(annotations)
  const lines: string[] = []

  lines.push(`# ${t('pack.skillOverview')}`)
  lines.push('')
  lines.push(`**Title:** ${manifest.title ?? '(untitled capture)'}`)
  lines.push(
    `**Captured:** ${humanDate(manifest.created_at)} on ${manifest.environment.os} ${manifest.environment.os_version}` +
      (manifest.environment.app !== undefined ? `, focused app ${manifest.environment.app}` : '') +
      '.',
  )
  const size = `${annotationsFile.reference_width}×${annotationsFile.reference_height}`
  lines.push(
    hasReplay
      ? `**Media:** ${size} snapshot.png + ${((manifest.media.replay_duration_ms ?? 0) / 1000).toFixed(1)}s ${replayName}` +
          '; the annotated view replay_annotated.webm is generated in the background after save.'
      : `**Media:** screenshot only (${size} snapshot.png); no replay, no annotated replay.`,
  )
  // All-displays capture: say plainly which screen each box belongs to.
  const displays = manifest.media.displays
  if (displays !== undefined && displays.length > 1) {
    const focused = displays.find((d) => d.focused)
    const counts = groupByDisplay(manifest, annotations)
      .filter((g) => g.annotations.length > 0)
      .map((g) => `display ${g.index}: ${g.annotations.length}`)
      .join(', ')
    lines.push(
      `**Displays:** ${displays.length} screens were frozen by the same trigger` +
        (focused === undefined ? '' : `; display ${focused.index} is the FOCUSED one`) +
        '. snapshot.png and the top-level replay are the FOCUSED display; the other screens ship ' +
        'as synchronized context (snapshot-d<N>.png / replay-d<N>.webm, declared in ' +
        'manifest.media.displays). EVERY display can carry annotations: a box names its screen in ' +
        '`display` (1-based manifest.media.displays[].index) and an ABSENT `display` means the ' +
        'focused one. A box’s bounds are pixels in ITS OWN display’s snapshot, never the ' +
        'focused one’s' +
        (counts === '' ? '.' : ` (${counts}).`),
    )
  }
  lines.push('')
  lines.push(
    manifest.note ??
      manifest.title ??
      'The user did not provide a description. The annotations and timeline below are the context.',
  )
  lines.push('')

  // Annotated keyframes (GOAL "Annotated keyframes (LLM-first)"): the whole
  // story as images — the single most useful thing in this document for a
  // model that cannot decode video.
  const keyframes = keyframeSet(manifest, annotationsFile, renderPending)
  const keyframeLines = keyframeSectionLines(keyframes, t)
  if (keyframeLines.length > 0) {
    lines.push(`## ${t('pack.keyframes')}`)
    lines.push('')
    lines.push(...keyframeLines)
    lines.push('')
  }

  if (annotations.length > 0) {
    lines.push('Where to look:')
    lines.push('')
    if (hasReplay) lines.push('- `replay_annotated.webm` shows the annotations in place, in time.')
    // Only when this pack really has (or is about to have) stills — a pointer
    // to frames/ in a pack that will never contain it is a dead end.
    if (keyframeLines.length > 0) {
      lines.push('- `frames/` holds the same annotations as stills, one per state change.')
    }
    lines.push('- `snapshot.png` shows the captured frame.')
    const multi = isMultiDisplay(manifest)
    const focusedIndex = packFocusedDisplay(manifest)
    const numbered = annotations
      .filter((a) => numbers.has(a.annotation_id))
      .sort((a, b) => (numbers.get(a.annotation_id) ?? 0) - (numbers.get(b.annotation_id) ?? 0))
    for (const a of numbered) {
      const text = a.text.trim() !== '' ? ` — "${a.text.trim()}"` : ''
      // WHICH screen those coordinates are in: without it, a reader of a
      // multi-display pack has no way to place the box at all.
      const where = multi
        ? ` on display ${annotationDisplayIndex(a, focusedIndex, declaredDisplayIndices(manifest.media.displays))}`
        : ''
      lines.push(
        `- Box ${numbers.get(a.annotation_id)}${where} at (${px(a.bounds.x)}, ${px(a.bounds.y)}), ` +
          `${px(a.bounds.width)}×${px(a.bounds.height)}${text}`,
      )
    }
    lines.push('')
  }

  lines.push(
    `Counts: ${annotationCounts(annotations)}, ${timeline.events.length} timeline events, ` +
      `${manifest.plugins.length} plugins.`,
  )

  const blurCount = annotations.filter((a) => a.blur).length
  if (blurCount > 0) {
    lines.push('')
    lines.push(
      `Blur present: yes — ${blurCount === 1 ? 'one box marks' : `${blurCount} boxes mark`} sensitive content. ` +
        `snapshot.png${hasReplay ? ` and ${replayName} are` : ' is'} NOT redacted (blur is non-destructive and ` +
        'renders only into derived views), so treat the raw media as containing that content.',
    )
  }
  lines.push('')
  return lines.join('\n')
}

function buildTimelineSkill(manifest: Manifest, timeline: TimelineFile, t: TranslateFn): string {
  const hasReplay = manifest.media.replay !== null
  const replayName = manifest.media.replay ?? 'replay.webm'
  const lines: string[] = []
  lines.push(`# ${t('pack.skillTimeline')}`)
  lines.push('')
  lines.push(
    `\`t0\` = ${timeline.t0} (${
      hasReplay
        ? `the start of ${replayName} — offsets are positions on the replay clock`
        : 'the capture trigger — this pack has no replay, so offsets are relative to the trigger'
    }).`,
  )
  lines.push('')
  if (timeline.events.length === 0) {
    lines.push('No events were recorded.')
    lines.push('')
    return lines.join('\n')
  }
  lines.push('| Offset | Event | Detail |')
  lines.push('|---|---|---|')
  for (const e of timeline.events) {
    lines.push(`| ${formatClock(e.t_ms)} | ${e.type} | ${timelineEventDetail(e.type, e.data)} |`)
  }
  lines.push('')
  lines.push(
    'Event types: `core.capture.triggered` is the hotkey press, `core.annotation.added` is one ' +
      'annotation box being created in the editor (its `annotation_id` matches annotations.json), ' +
      'and `core.export.created` is the pack being saved. Other `source` values would be plugins.',
  )
  lines.push('')
  return lines.join('\n')
}

function timelineEventDetail(type: string, data: Record<string, unknown> | undefined): string {
  // SPEC §10.2 allows data.hotkey on this event; the accelerator is
  // configurable, so never spell a fixed one out here.
  if (type === 'core.capture.triggered') {
    return typeof data?.hotkey === 'string' ? `Hotkey ${data.hotkey}` : 'Capture hotkey'
  }
  if (type === 'core.export.created') return 'Pack saved'
  if (type === 'core.annotation.added') {
    const id = typeof data?.annotation_id === 'string' ? data.annotation_id : 'unknown'
    return `${id} (box)`
  }
  if (data === undefined) return ''
  return JSON.stringify(data).replaceAll('|', '\\|')
}

function buildAnnotationSkill(
  manifest: Manifest,
  annotationsFile: AnnotationsFile,
  t: TranslateFn,
): string {
  const annotations = annotationsFile.annotations
  const numbers = computeDisplayNumbers(annotations)
  const multi = isMultiDisplay(manifest)
  const focusedIndex = packFocusedDisplay(manifest)
  const lines: string[] = []
  lines.push(`# ${t('pack.annotations')}`)
  lines.push('')
  lines.push(
    `Coordinate space: snapshot.png, ${annotationsFile.reference_width}×${annotationsFile.reference_height} pixels, origin top-left.`,
  )
  if (multi) {
    lines.push('')
    lines.push(
      `This capture froze ${manifest.media.displays?.length ?? 0} displays and boxes may sit on any of them. A box's`,
    )
    lines.push(
      `\`display\` field names its screen (manifest.media.displays[].index); ABSENT means display ${focusedIndex},`,
    )
    lines.push(
      'the focused one, whose snapshot is `snapshot.png`. Bounds are always pixels in THAT display’s',
    )
    lines.push(
      'own snapshot — never the focused display’s — so read each box against the file named below it.',
    )
  }
  lines.push('')
  lines.push(
    'Display numbers are computed, never stored: boxes with `numbered: true`, sorted by start_ms',
  )
  lines.push(
    'ascending (absent = 0), then z ascending, then annotation_id ascending, numbered from 1. The',
  )
  lines.push('same numbers appear in every rendered view and document.')
  lines.push('')

  if (annotations.length === 0) {
    lines.push('This pack has no annotation boxes.')
    lines.push('')
    return lines.join('\n')
  }

  // Numbered boxes first in display order, then the rest in array order.
  const ordered = [
    ...annotations
      .filter((a) => numbers.has(a.annotation_id))
      .sort((a, b) => (numbers.get(a.annotation_id) ?? 0) - (numbers.get(b.annotation_id) ?? 0)),
    ...annotations.filter((a) => !numbers.has(a.annotation_id)),
  ]
  for (const a of ordered) {
    const number = numbers.get(a.annotation_id)
    const flags: string[] = []
    flags.push(number !== undefined ? 'numbered' : 'unnumbered')
    if (a.blur) flags.push('blur')
    lines.push(
      number !== undefined
        ? `## Box ${number} — ${a.annotation_id} (${flags.join(', ')})`
        : `## ${a.annotation_id} (${flags.join(', ')})`,
    )
    lines.push('')
    if (a.text.trim() !== '') lines.push(`- **Text:** "${a.text.trim()}"`)
    if (multi) {
      // The DECLARED set resolves a box naming a display this pack does not
      // have back onto the focused one (SPEC §8.8), so the file named below is
      // always one the pack actually contains.
      const index = annotationDisplayIndex(a, focusedIndex, declaredDisplayIndices(manifest.media.displays))
      const entry = manifest.media.displays?.find((d) => d.index === index)
      const file = entry?.snapshot ?? 'snapshot.png'
      lines.push(
        `- **Display:** ${index}${index === focusedIndex ? ' (focused)' : ''} — bounds below are pixels in \`${file}\``,
      )
    }
    lines.push(
      `- **Bounds:** (${px(a.bounds.x)}, ${px(a.bounds.y)}) size ${px(a.bounds.width)}×${px(a.bounds.height)}`,
    )
    lines.push(
      a.start_ms !== undefined && a.end_ms !== undefined
        ? `- **Lifetime:** ${lifetimeLabel(a, t)} on the replay clock`
        : '- **Lifetime:** none (applies to the whole capture)',
    )
    if (a.blur) {
      lines.push(
        '- **Blur:** true — this region is sensitive. Blur is non-destructive: the original media keeps',
      )
      lines.push(
        '  the unredacted pixels; the blur renders only into derived views (annotated replay, editor',
      )
      lines.push('  previews). Do not quote the content of this region.')
    }
    lines.push('')
  }

  const tracked = annotations.some((a) => a.tracking.enabled)
  const targeted = annotations.some((a) => a.target !== undefined)
  if (!tracked && !targeted) {
    lines.push(
      'No box has tracking enabled and none carries a semantic `target` (both are reserved in format',
    )
    lines.push('0.1.0).')
    lines.push('')
  }
  return lines.join('\n')
}

function buildDomSkill(manifest: Manifest, annotationsFile: AnnotationsFile, t: TranslateFn): string {
  const lines: string[] = []
  lines.push(`# ${t('pack.skillDom')}`)
  lines.push('')
  const targeted = annotationsFile.annotations.filter((a) => a.target !== undefined)
  if (manifest.plugins.length === 0 && targeted.length === 0) {
    // Honest empty: no invented structure when no plugin contributed data.
    lines.push('No DOM metadata in this pack.')
    lines.push('')
    lines.push(
      'No plugin contributed semantic object data (there is no `plugins/` payload and no annotation',
    )
    lines.push(
      'carries a `target`). If a future pack includes it, DOM metadata lives under `plugins/<name>/`',
    )
    lines.push('and semantic object references appear as the reserved `target` field on annotation boxes.')
    lines.push('')
    return lines.join('\n')
  }
  if (manifest.plugins.length > 0) {
    lines.push('Plugins that contributed data (see `plugins/`):')
    lines.push('')
    for (const p of manifest.plugins) {
      lines.push(`- **${p.name}** v${p.version} — files under \`${p.path}\``)
    }
    lines.push('')
  }
  if (targeted.length > 0) {
    lines.push('Annotation boxes carrying semantic `target` metadata:')
    lines.push('')
    for (const a of targeted) {
      lines.push(`- ${a.annotation_id}: ${JSON.stringify(a.target)}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

function buildProjectSkill(manifest: Manifest, t: TranslateFn): string {
  const hasReplay = manifest.media.replay !== null
  const replayName = manifest.media.replay ?? 'replay.webm'
  const lines: string[] = []
  lines.push(`# ${t('pack.skillProject')}`)
  lines.push('')
  lines.push('A CapturePack is a local-first context package that explains a visual situation — usually a')
  lines.push('bug — to humans and to LLMs. It is a plain folder (optionally zipped as `.capturepack`, a')
  lines.push('standard ZIP) of well-known files. The format specification lives at')
  lines.push(`https://github.com/r2cuerdame/capturepack (SPEC.md, format ${manifest.format_version}).`)
  lines.push('')
  lines.push(`This pack: id \`${manifest.id}\`, created ${humanDate(manifest.created_at)}, generated by`)
  lines.push(`${manifest.generator.name} ${manifest.generator.version}.`)
  lines.push('')
  lines.push('How this folder is laid out:')
  lines.push('')
  lines.push('- `manifest.json` — REQUIRED entry point: identity, environment, media inventory.')
  lines.push('- `snapshot.png` — REQUIRED captured frame; defines the annotation coordinate space. Original')
  lines.push('  pixels, never modified.')
  lines.push(
    hasReplay
      ? `- \`${replayName}\` — the last seconds before the capture. Original evidence, never modified.`
      : '- `replay.webm` — optional last seconds before capture (absent here: screenshot-only pack).',
  )
  lines.push(
    hasReplay
      ? '- `replay_annotated.webm` — the replay with annotations rendered in. Generated in the background'
      : '- `replay_annotated.webm` — optional rendering of the replay with annotations burned in',
  )
  lines.push(
    hasReplay
      ? `  after save, regenerable at any time from ${replayName} + annotations.json.`
      : '  (absent here — it only exists when there is a replay).',
  )
  if (manifest.media.displays !== undefined && manifest.media.displays.length > 1) {
    lines.push('- `snapshot-d<N>.png` / `replay-d<N>.webm` — the OTHER displays this capture froze, one')
    lines.push('  set per display, declared in `manifest.media.displays` (N = the display index there).')
    lines.push(`  The focused display’s media is the top-level snapshot.png/${replayName}.`)
    lines.push('- `replay_annotated-d<N>.webm` / `frames-d<N>/` — one display’s OWN annotated views,')
    lines.push('  declared in its `manifest.media.displays` entry and present only when that display')
    lines.push('  carries annotations. Every display is annotatable: a box names its screen in')
    lines.push('  `display` (absent = the focused one) and its bounds are pixels in THAT screen’s')
    lines.push('  snapshot. Per-display times are on that display’s own replay clock.')
  }
  lines.push('- `frames/frame-NN_MM-SS.mmm.png` — annotated STILLS, one per annotation state change,')
  lines.push('  declared in `manifest.media.keyframes` with their replay-clock time. Same overlays as the')
  lines.push('  annotated replay: read these instead of decoding video. Rendered in the background after')
  lines.push('  save, so they may be absent (a screenshot-only pack still gets exactly one).')
  lines.push('- `annotations.json` — annotation boxes: bounds + text + optional number, blur, lifetime.')
  lines.push('  The single source of truth for annotations; rendered views are derived from it.')
  lines.push('- `timeline.json` — machine-readable event log.')
  lines.push('- `report.md` — generated narrative for humans and LLMs.')
  lines.push('- `README.md` — human-first entry point.')
  lines.push('- `skills/` — these AI-first documents.')
  lines.push('- `plugins/` — optional structured metadata from plugins.')
  lines.push('')
  lines.push('Reading rules: trust `manifest.json` for filenames; skip what you do not recognize; the JSON')
  lines.push('files win over any generated document, including this one.')
  lines.push('')
  lines.push('If a CapturePack MCP server is connected, prefer it over reading files directly: call')
  lines.push('`capturepack_latest` for the newest pack or `capturepack_open` for a specific one.')
  lines.push('')
  return lines.join('\n')
}
