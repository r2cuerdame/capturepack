// Pure generator for the fixed-name offline browser view (SPEC §12.4).
// It deliberately has no filesystem, Electron, network, or runtime dependency.

import { captureKindOf } from '../shared/captureMedia'
import { makeT } from '../shared/i18n'
import type { Language } from '../shared/i18n'
import { computeDisplayNumbers } from '../shared/numbering'
import {
  annotationDisplayIndex,
  declaredDisplayIndices,
  focusedDisplayIndex,
  type Annotation,
  type AnnotationsFile,
  type Manifest,
  type ManifestDisplayMedia,
  type ManifestKeyframe,
  type TimelineFile,
} from '../shared/types'
import { formatClock, humanDate, lifetimeLabel } from './report'

/** `viewer.html` is a standard optional generated view from format 0.5.0. */
export const VIEWER_FORMAT_VERSION = '0.5.0'

const SAFE_PATH_CONTROL_RE = /[\u0000-\u001f\u007f]/u

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * Pack media may only resolve inside the pack folder. `file://` needs ordinary
 * relative paths, not fetch or a localhost escape hatch.
 */
export function safeViewerPath(value: unknown): string | null {
  if (typeof value !== 'string' || value === '' || value !== value.trim()) return null
  if (
    value.startsWith('/') ||
    value.startsWith('\\') ||
    value.includes('\\') ||
    value.includes(':') ||
    value.includes('%') ||
    value.includes('?') ||
    value.includes('#') ||
    SAFE_PATH_CONTROL_RE.test(value)
  ) {
    return null
  }
  const segments = value.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return null
  }
  return value
}

function versionParts(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(value)
  if (match === null) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function versionIsAtLeast(value: string, minimum: string): boolean {
  const current = versionParts(value)
  const target = versionParts(minimum)
  if (current === null || target === null) return false
  if (current[0] !== target[0]) return current[0] > target[0]
  if (current[1] !== target[1]) return current[1] > target[1]
  return current[2] >= target[2]
}

/** A copy suitable for generating a viewer; future versions are never lowered. */
export function manifestWithViewerFormat(manifest: Manifest): Manifest {
  return versionIsAtLeast(manifest.format_version, VIEWER_FORMAT_VERSION)
    ? manifest
    : { ...manifest, format_version: VIEWER_FORMAT_VERSION }
}

function safeKeyframes(value: readonly ManifestKeyframe[] | undefined): ManifestKeyframe[] {
  if (!Array.isArray(value)) return []
  const safe: ManifestKeyframe[] = []
  for (const frame of value) {
    if (
      frame === null ||
      typeof frame !== 'object' ||
      !Number.isFinite(frame.t_ms)
    ) {
      continue
    }
    const file = safeViewerPath(frame.file)
    if (file !== null) safe.push({ file, t_ms: Math.max(0, Math.round(frame.t_ms)) })
  }
  return safe
}

function mediaFigure(
  kind: 'image' | 'video',
  file: string,
  label: string,
  provenance: string,
  className = '',
): string {
  const safeFile = safeViewerPath(file)
  if (safeFile === null) return ''
  const media =
    kind === 'video'
      ? `<video controls preload="metadata" src="${escapeHtml(safeFile)}"></video>`
      : `<img src="${escapeHtml(safeFile)}" alt="${escapeHtml(label)}" loading="lazy">`
  return `<figure${className === '' ? '' : ` class="${escapeHtml(className)}"`}>
${media}
<figcaption><strong>${escapeHtml(label)}</strong><span>${escapeHtml(provenance)}</span><code>${escapeHtml(safeFile)}</code></figcaption>
</figure>`
}

function primaryMedia(manifest: Manifest, captureKind: 'image' | 'video'): string {
  const keyframes = safeKeyframes(manifest.media.keyframes)
  if (captureKind === 'image') {
    const annotated = keyframes[0]
    if (annotated !== undefined) {
      return mediaFigure(
        'image',
        annotated.file,
        'Annotated still',
        'Derived view — annotations and blur are rendered into these pixels.',
        'primary-media',
      )
    }
    const snapshot = safeViewerPath(manifest.media.snapshot)
    return snapshot === null
      ? ''
      : mediaFigure(
          'image',
          snapshot,
          'Original captured still',
          'Original evidence — unannotated and never modified.',
          'primary-media',
        )
  }

  const annotatedReplay = safeViewerPath(manifest.media.replay_annotated)
  if (annotatedReplay !== null) {
    return mediaFigure(
      'video',
      annotatedReplay,
      'Annotated replay',
      'Derived view — annotations and blur are rendered into the video.',
      'primary-media',
    )
  }
  const replay = safeViewerPath(manifest.media.replay)
  if (replay !== null) {
    return mediaFigure(
      'video',
      replay,
      'Unannotated original replay',
      'Original evidence — no annotations or blur are rendered into this video.',
      'primary-media',
    )
  }
  const snapshot = safeViewerPath(manifest.media.snapshot)
  return snapshot === null
    ? ''
    : mediaFigure(
        'image',
        snapshot,
        'Original captured frame',
        'Original evidence — no usable replay is declared.',
        'primary-media',
      )
}

function displayMedia(
  manifest: Manifest,
  display: ManifestDisplayMedia,
  focused: boolean,
): string {
  const snapshot = focused ? manifest.media.snapshot : display.snapshot
  const replay = focused ? manifest.media.replay : display.replay
  const annotatedReplay = focused
    ? manifest.media.replay_annotated
    : display.replay_annotated
  const keyframes = safeKeyframes(focused ? manifest.media.keyframes : display.keyframes)
  const figures: string[] = []
  const safeAnnotated = safeViewerPath(annotatedReplay)
  const safeReplay = safeViewerPath(replay)
  const safeSnapshot = safeViewerPath(snapshot)
  if (safeAnnotated !== null) {
    figures.push(
      mediaFigure(
        'video',
        safeAnnotated,
        `Display ${display.index} annotated replay`,
        'Derived annotated view.',
      ),
    )
  } else if (safeReplay !== null) {
    figures.push(
      mediaFigure(
        'video',
        safeReplay,
        `Display ${display.index} original replay`,
        'Original, unannotated evidence.',
      ),
    )
  }
  if (safeSnapshot !== null) {
    figures.push(
      mediaFigure(
        'image',
        safeSnapshot,
        `Display ${display.index} snapshot`,
        'Original captured pixels.',
      ),
    )
  }
  if (keyframes.length > 0) {
    figures.push(
      ...keyframes.map((frame) =>
        mediaFigure(
          'image',
          frame.file,
          `Display ${display.index} keyframe at ${formatClock(frame.t_ms)}`,
          'Derived annotated still.',
        ),
      ),
    )
  }
  if (figures.length === 0) return '<p class="empty">No safe declared media is available.</p>'
  return `<div class="media-grid">${figures.join('\n')}</div>`
}

function displaySection(manifest: Manifest, focusedIndex: number, lang: Language): string {
  const displays = manifest.media.displays
  if (!Array.isArray(displays) || displays.length < 2) return ''
  const t = makeT(lang)
  const ordered = [...displays].sort((left, right) => {
    const leftFocused = left.index === focusedIndex ? 0 : 1
    const rightFocused = right.index === focusedIndex ? 0 : 1
    return leftFocused - rightFocused || left.index - right.index
  })
  return `<section aria-labelledby="displays-heading">
<h2 id="displays-heading">${escapeHtml(t('pack.displays'))}</h2>
<div class="display-list">
${ordered
  .map((display) => {
    const focused = display.index === focusedIndex
    // The size the entry DECLARES (SPEC §5.6, 0.7.0), falling back to
    // bounds × scale for a pack written before the field existed. The summary
    // label is the reader's answer to "which image are these coordinates in",
    // so it should be the raster's real size, not an arithmetic near-miss.
    const width =
      typeof display.snapshot_width === 'number' && display.snapshot_width > 0
        ? display.snapshot_width
        : Math.round(display.bounds.width * display.scale)
    const height =
      typeof display.snapshot_height === 'number' && display.snapshot_height > 0
        ? display.snapshot_height
        : Math.round(display.bounds.height * display.scale)
    return `<details${focused ? ' open' : ''}>
<summary>Display ${escapeHtml(display.index)}${focused ? ' · focused' : ''} · ${escapeHtml(width)}×${escapeHtml(height)} @${escapeHtml(display.scale)}x</summary>
${displayMedia(manifest, display, focused)}
</details>`
  })
  .join('\n')}
</div>
</section>`
}

const TARGET_KEY_ORDER = [
  'source',
  'level',
  'name',
  'role',
  'control_type',
  'automation_id',
  'selector',
  'title',
  'process',
  'url',
  'state',
] as const

function targetSummary(target: Annotation['target']): string {
  if (target === undefined || target === null || typeof target !== 'object') return '—'
  const entries = Object.entries(target)
    .filter(([, value]) =>
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean',
    )
    .sort(([left], [right]) => {
      const leftOrder = TARGET_KEY_ORDER.indexOf(left as (typeof TARGET_KEY_ORDER)[number])
      const rightOrder = TARGET_KEY_ORDER.indexOf(right as (typeof TARGET_KEY_ORDER)[number])
      const normalizedLeft = leftOrder < 0 ? TARGET_KEY_ORDER.length : leftOrder
      const normalizedRight = rightOrder < 0 ? TARGET_KEY_ORDER.length : rightOrder
      return normalizedLeft - normalizedRight || left.localeCompare(right)
    })
  if (entries.length === 0) return '—'
  return entries
    .map(([key, value]) => `<span><b>${escapeHtml(key)}:</b> ${escapeHtml(value)}</span>`)
    .join(' ')
}

function annotationSection(
  manifest: Manifest,
  annotationsFile: AnnotationsFile,
  lang: Language,
): string {
  const t = makeT(lang)
  const annotations = Array.isArray(annotationsFile.annotations)
    ? annotationsFile.annotations
    : []
  if (annotations.length === 0) {
    return `<section aria-labelledby="annotations-heading">
<h2 id="annotations-heading">${escapeHtml(t('pack.annotations'))}</h2>
<p class="empty">${escapeHtml(t('pack.none'))}</p>
</section>`
  }
  const numbers = computeDisplayNumbers(annotations)
  const focused = focusedDisplayIndex(manifest.media.displays)
  const declared = declaredDisplayIndices(manifest.media.displays)
  return `<section aria-labelledby="annotations-heading">
<h2 id="annotations-heading">${escapeHtml(t('pack.annotations'))}</h2>
<ol class="annotations">
${annotations
  .map((annotation, index) => {
    const marker = numbers.get(annotation.annotation_id)
    const display = annotationDisplayIndex(annotation, focused, declared)
    const bounds = annotation.bounds
    const text = annotation.text.trim() === '' ? t('pack.none') : annotation.text
    return `<li>
<article>
<header><span class="annotation-number">${escapeHtml(marker ?? index + 1)}</span><strong>${escapeHtml(text)}</strong></header>
<dl>
<div><dt>Time</dt><dd>${escapeHtml(lifetimeLabel(annotation, t))}</dd></div>
<div><dt>${escapeHtml(t('pack.display'))}</dt><dd>${escapeHtml(display)}${display === focused ? ` (${escapeHtml(t('pack.displayFocused'))})` : ''}</dd></div>
<div><dt>Bounds</dt><dd><code>${escapeHtml(`${Math.round(bounds.x)}, ${Math.round(bounds.y)} · ${Math.round(bounds.width)}×${Math.round(bounds.height)}`)}</code></dd></div>
<div><dt>Target</dt><dd class="target">${targetSummary(annotation.target)}</dd></div>
<div><dt>Flags</dt><dd>${annotation.blur ? 'blur' : '—'}${annotation.numbered ? `${annotation.blur ? ', ' : ''}numbered` : ''}</dd></div>
</dl>
</article>
</li>`
  })
  .join('\n')}
</ol>
</section>`
}

function keyframeSection(manifest: Manifest, lang: Language): string {
  const t = makeT(lang)
  const keyframes = safeKeyframes(manifest.media.keyframes)
  if (keyframes.length === 0) return ''
  return `<section aria-labelledby="keyframes-heading">
<h2 id="keyframes-heading">${escapeHtml(t('pack.keyframes'))}</h2>
<div class="media-grid">
${keyframes
  .map((frame) =>
    mediaFigure(
      'image',
      frame.file,
      `Keyframe at ${formatClock(frame.t_ms)}`,
      'Derived annotated still.',
    ),
  )
  .join('\n')}
</div>
</section>`
}

function pluginSection(manifest: Manifest, lang: Language): string {
  const t = makeT(lang)
  const plugins = Array.isArray(manifest.plugins) ? manifest.plugins : []
  return `<section aria-labelledby="plugins-heading">
<h2 id="plugins-heading">${escapeHtml(t('pack.skillDom'))}</h2>
${
  plugins.length === 0
    ? '<p class="empty">No plugin data is declared.</p>'
    : `<ul class="plugins">${plugins
        .map((plugin) => {
          const path = safeViewerPath(plugin.path)
          return `<li><strong>${escapeHtml(plugin.name)}</strong> <span>${escapeHtml(plugin.version)}</span>${path === null ? '' : ` <code>${escapeHtml(path)}</code>`}</li>`
        })
        .join('')}</ul>`
}
</section>`
}

function inventory(
  manifest: Manifest,
  timeline: TimelineFile | undefined,
  captureKind: 'image' | 'video',
): string[] {
  const files = new Set<string>([
    'manifest.json',
    'annotations.json',
    'viewer.html',
    'report.md',
    'README.md',
    'skills/',
  ])
  const add = (value: unknown): void => {
    const safe = safeViewerPath(value)
    if (safe !== null) files.add(safe)
  }
  add(manifest.media.snapshot)
  add(manifest.media.replay)
  add(manifest.media.replay_annotated)
  for (const frame of safeKeyframes(manifest.media.keyframes)) add(frame.file)
  if (captureKind === 'video' && timeline !== undefined) files.add('timeline.json')
  for (const display of manifest.media.displays ?? []) {
    add(display.snapshot)
    add(display.replay)
    add(display.replay_annotated)
    for (const frame of safeKeyframes(display.keyframes)) add(frame.file)
  }
  for (const plugin of manifest.plugins ?? []) add(plugin.path)
  return [...files]
}

function fileSection(
  manifest: Manifest,
  timeline: TimelineFile | undefined,
  captureKind: 'image' | 'video',
  lang: Language,
): string {
  const t = makeT(lang)
  return `<section aria-labelledby="files-heading">
<h2 id="files-heading">${escapeHtml(t('pack.files'))}</h2>
<ul class="files">${inventory(manifest, timeline, captureKind)
  .map((file) => `<li><code>${escapeHtml(file)}</code></li>`)
  .join('')}</ul>
</section>`
}

/**
 * Builds a complete script-free HTML document. Only manifest-declared media is
 * rendered; `renderPending` guesses intentionally have no representation here.
 */
export function buildViewerHtml(
  manifestInput: Manifest,
  annotationsFile: AnnotationsFile,
  timeline?: TimelineFile,
  lang: Language = 'en',
): string {
  const manifest = manifestWithViewerFormat(manifestInput)
  const t = makeT(lang)
  const captureKind = captureKindOf(manifest)
  const title = manifest.title ?? t('pack.untitled')
  const focused = focusedDisplayIndex(manifest.media.displays)
  const blurCount = annotationsFile.annotations.filter((annotation) => annotation.blur).length
  const duration =
    captureKind === 'video' && manifest.media.replay_duration_ms !== undefined
      ? `${(manifest.media.replay_duration_ms / 1000).toFixed(1)}s`
      : '—'
  const screens = manifest.environment.screens
    .map((screen) => `${screen.width}×${screen.height} @${screen.scale}x`)
    .join('; ')
  const mainMedia = primaryMedia(manifest, captureKind)
  const privacyWarning =
    blurCount > 0
      ? `<aside class="warning danger" role="note"><strong>Privacy warning — ${escapeHtml(blurCount)} blur annotation${blurCount === 1 ? '' : 's'}.</strong><p>Blur is applied to derived views only. <code>snapshot.png</code> and original replay media can still contain sensitive pixels. This viewer is not a sanitized share.</p></aside>`
      : '<aside class="warning" role="note"><strong>Original evidence may contain private information.</strong><p>This offline viewer is not a sanitized share.</p></aside>'

  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; font-src 'none'; connect-src 'none'; script-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(title)} — CapturePack</title>
<style>
:root{color-scheme:dark;--bg:#111217;--panel:#1a1c24;--line:#303440;--text:#f4f6fb;--muted:#aab1c2;--accent:#4d8dff;--warn:#ffca57;--danger:#ff7b72}
*{box-sizing:border-box}
html{background:var(--bg);color:var(--text);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
body{margin:0}
main{width:min(1120px,100%);margin:auto;padding:clamp(16px,4vw,48px)}
h1,h2{line-height:1.2;overflow-wrap:anywhere}
h1{font-size:clamp(2rem,6vw,4.2rem);margin:.2em 0}
h2{margin:0 0 18px;font-size:clamp(1.25rem,3vw,1.8rem)}
p,dd,figcaption,li,code{overflow-wrap:anywhere;word-break:break-word}
.eyebrow{color:var(--accent);font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.subtitle{font-size:1.1rem;color:var(--muted);max-width:70ch}
section,.warning{margin:24px 0;padding:clamp(16px,3vw,28px);border:1px solid var(--line);border-radius:16px;background:var(--panel)}
.warning{border-color:#6b5723;color:#fff6da}.warning.danger{border-color:#773d39;color:#ffe6e3}
.warning p{margin:.5em 0 0}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:12px;margin:24px 0}
.facts div,dl div{min-width:0}.facts dt,dl dt{color:var(--muted);font-size:.86rem}.facts dd,dl dd{margin:2px 0 0}
figure{margin:0;min-width:0}
img,video{display:block;width:100%;height:auto;max-height:72vh;object-fit:contain;background:#090a0e;border-radius:12px}
figcaption{display:grid;gap:2px;margin-top:9px;color:var(--muted)}figcaption strong{color:var(--text)}
code{font:0.9em ui-monospace,SFMono-Regular,Consolas,monospace;color:#c9d9ff}
.media-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr));gap:20px}
.primary-media img,.primary-media video{max-height:78vh}
.annotations{display:grid;gap:12px;padding-left:1.5rem}
.annotations article{padding:16px;border:1px solid var(--line);border-radius:12px}
.annotations header{display:flex;gap:10px;align-items:flex-start}
.annotation-number{display:inline-grid;place-items:center;flex:0 0 30px;height:30px;border-radius:9px;background:var(--accent);font-weight:800}
.annotations dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(180px,100%),1fr));gap:12px;margin:14px 0 0}
.target{display:flex;flex-wrap:wrap;gap:4px 10px}
.display-list{display:grid;gap:12px}details{border:1px solid var(--line);border-radius:12px;padding:12px}summary{cursor:pointer;font-weight:700}
details .media-grid{margin-top:16px}
.plugins,.files{display:grid;gap:8px;margin:0;padding-left:1.25rem}
.empty{color:var(--muted)}
a:focus-visible,summary:focus-visible,video:focus-visible{outline:3px solid var(--accent);outline-offset:4px}
@media(max-width:390px){main{padding:12px}section,.warning{margin:14px 0;padding:14px;border-radius:12px}.facts{grid-template-columns:1fr}.media-grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<main>
<header>
<div class="eyebrow">CapturePack · offline viewer</div>
<h1>${escapeHtml(title)}</h1>
<p class="subtitle">${escapeHtml(manifest.note ?? t('pack.noNote'))}</p>
<dl class="facts">
<div><dt>${escapeHtml(t('pack.captured'))}</dt><dd>${escapeHtml(humanDate(manifest.created_at))}</dd></div>
<div><dt>Capture</dt><dd>${escapeHtml(captureKind)}${captureKind === 'image' && manifest.media.image_scope !== undefined ? ` · ${escapeHtml(manifest.media.image_scope)}` : ''}</dd></div>
<div><dt>${escapeHtml(t('pack.application'))}</dt><dd>${escapeHtml(manifest.environment.app ?? t('pack.unknown'))}</dd></div>
<div><dt>${escapeHtml(t('pack.duration'))}</dt><dd>${escapeHtml(duration)}</dd></div>
<div><dt>${escapeHtml(t('pack.os'))}</dt><dd>${escapeHtml(`${manifest.environment.os} ${manifest.environment.os_version}`)}</dd></div>
<div><dt>${escapeHtml(t('pack.screens'))}</dt><dd>${escapeHtml(screens === '' ? t('pack.unknown') : screens)}</dd></div>
<div><dt>${escapeHtml(t('pack.display'))}</dt><dd>${escapeHtml(focused)} (${escapeHtml(t('pack.displayFocused'))})</dd></div>
</dl>
</header>
${privacyWarning}
<section aria-labelledby="result-heading">
<h2 id="result-heading">${escapeHtml(captureKind === 'video' ? t('pack.replay') : t('pack.snapshotFrame'))}</h2>
${mainMedia === '' ? '<p class="empty">No safe declared media is available.</p>' : mainMedia}
</section>
${keyframeSection(manifest, lang)}
${annotationSection(manifest, annotationsFile, lang)}
${displaySection(manifest, focused, lang)}
${pluginSection(manifest, lang)}
${fileSection(manifest, timeline, captureKind, lang)}
</main>
</body>
</html>
`
}
