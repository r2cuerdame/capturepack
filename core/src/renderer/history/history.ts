// History window renderer: pack cards (thumbnail, title, metadata, badges,
// actions), case-insensitive search with lazily loaded report/annotation text,
// and filter chips. Kept dumb where possible: main owns the file system; every
// action is one bridge call keyed by the pack's absolute path.
import { applyDomI18n, makeT } from '../../shared/i18n'
import type { TranslateFn } from '../../shared/i18n'
import type {
  HistoryActionResult,
  HistoryCreateShareResult,
  HistoryCreateZipResult,
  HistoryListResult,
  HistoryPackSummary,
  HistoryRenameResult,
  HistoryRenderStatusPayload,
  HistorySharePlan,
  HistorySharePlanResult,
  StorageUsage,
} from '../../shared/ipc'
import { budgetLevel, budgetPercent, formatBytes } from '../../shared/retention'
import { DEFAULT_CAPTURE_HOTKEY } from '../../shared/types'

interface HistoryBridge {
  list(): Promise<HistoryListResult>
  thumb(packPath: string): Promise<string | null>
  size(packPath: string): Promise<number | null>
  usage(): Promise<StorageUsage | null>
  searchText(packPath: string): Promise<string>
  openPack(packPath: string): Promise<HistoryActionResult>
  play(packPath: string): Promise<HistoryActionResult>
  createZip(packPath: string): Promise<HistoryCreateZipResult>
  planShare(packPath: string): Promise<HistorySharePlanResult>
  createShare(packPath: string, revision: string): Promise<HistoryCreateShareResult>
  openFolder(packPath: string): void
  copyPath(packPath: string): void
  copyPrompt(packPath: string): Promise<boolean>
  rerender(packPath: string): Promise<HistoryActionResult>
  rename(packPath: string, newName: string): Promise<HistoryRenameResult>
  remove(packPath: string): Promise<HistoryActionResult>
  openSettings(): void
  onChanged(cb: () => void): void
  onRenderStatus(cb: (payload: HistoryRenderStatusPayload) => void): void
}

declare global {
  interface Window {
    historyBridge: HistoryBridge
  }
}

const bridge = window.historyBridge

const SEARCH_DEBOUNCE_MS = 150

type FilterId = 'all' | 'today' | 'week' | 'renderfailed'

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (node === null) throw new Error(`missing #${id}`)
  return node as T
}

const searchInput = el<HTMLInputElement>('search')
const filtersNav = el<HTMLElement>('filters')
const listEl = el<HTMLElement>('list')
const countLabel = el<HTMLSpanElement>('countLabel')
const settingsBtn = el<HTMLButtonElement>('settingsBtn')
const usageEl = el<HTMLElement>('usage')
const usageBar = el<HTMLElement>('usageBar')
const usageBarFill = el<HTMLElement>('usageBarFill')
const usageText = el<HTMLElement>('usageText')

settingsBtn.addEventListener('click', () => {
  bridge.openSettings()
})

// ---------------------------------------------------------------------------
// State

let packs: HistoryPackSummary[] = []
let outputDir = ''
// Active-language t(); every list result carries uiLanguage, so a language
// change from the settings GUI reaches this window on its next re-list.
let uiLanguage = 'en'
// Same deal for the capture accelerator the empty state tells the user to press.
let captureHotkey = DEFAULT_CAPTURE_HOTKEY
let t: TranslateFn = makeT('en')
let query = ''
let filter: FilterId = 'all'

// Lazy per-pack data (renderer side; main caches by content stamp too).
const thumbs = new Map<string, string | null>()
const sizes = new Map<string, number | null>()
const requestedThumbs = new Set<string>()
const requestedSizes = new Set<string>()
// Search text is loaded per pack on FIRST search use, then cached (cleared on
// every re-list so edits are picked up; main's cache makes reloads cheap).
const searchTexts = new Map<string, string>()
let searchTextsLoading = false

// In-flight renders (paths) — re-renders AND save-time renders; kept in sync
// by history:render-status pushes ('rendering' adds, terminal states clear).
const rendering = new Set<string>()
const fullZipping = new Set<string>()
const shareCreating = new Set<string>()
// 0..1 for the packs whose render has reported a real playhead. A path in
// `rendering` but NOT here is rendering without a measurement — queued, or a
// stage that cannot say — and its bar runs indeterminate.
const renderRatio = new Map<string, number>()

/** The bar for one card, built at the fill its render last reported. */
function renderProgressBar(packPath: string): HTMLElement {
  const bar = elc('span', 'renderBar')
  bar.dataset['progressFor'] = packPath
  bar.append(elc('span', 'renderBarFill'))
  applyProgress(bar, renderRatio.get(packPath))
  return bar
}

function applyProgress(bar: HTMLElement, ratio: number | undefined): void {
  const fill = bar.firstElementChild as HTMLElement | null
  if (fill === null) return
  const known = ratio !== undefined && Number.isFinite(ratio)
  bar.classList.toggle('indeterminate', !known)
  fill.style.width = known ? `${String(Math.round(Math.min(1, Math.max(0, ratio)) * 100))}%` : ''
  bar.title = known ? `${String(Math.round(ratio * 100))}%` : ''
}

/** Moves an existing bar without rebuilding the card it sits in. */
function paintRenderProgress(packPath: string): void {
  const bar = document.querySelector<HTMLElement>(
    `.renderBar[data-progress-for="${CSS.escape(packPath)}"]`,
  )
  if (bar === null) return
  applyProgress(bar, renderRatio.get(packPath))
}
// Per-card transient error lines, keyed by path.
const cardErrors = new Map<string, string>()

let openMenuFor: string | null = null
let renamingFor: string | null = null
let renameValue = ''
let renameError: string | null = null
let deletingFor: string | null = null
let sharingFor: string | null = null
let sharePlan: HistorySharePlan | null = null
let sharePlanLoading = false

let listInFlight = false
let refreshQueued = false

// ---------------------------------------------------------------------------
// Refresh

async function refresh(): Promise<void> {
  if (listInFlight) {
    refreshQueued = true
    return
  }
  listInFlight = true
  try {
    const result = await bridge.list()
    outputDir = result.outputDir
    packs = result.packs
    captureHotkey = result.captureHotkey
    if (result.uiLanguage !== uiLanguage) {
      uiLanguage = result.uiLanguage
      t = makeT(uiLanguage)
      applyDomI18n(t)
    }
    const live = new Set(packs.map((p) => p.path))
    for (const map of [thumbs, sizes, cardErrors]) {
      for (const key of [...map.keys()]) if (!live.has(key)) map.delete(key)
    }
    for (const key of [...rendering]) if (!live.has(key)) rendering.delete(key)
    for (const key of [...fullZipping]) if (!live.has(key)) fullZipping.delete(key)
    for (const key of [...shareCreating]) if (!live.has(key)) shareCreating.delete(key)
    // A pack whose annotated replay is now ready is definitely done rendering.
    for (const p of packs) if (p.annotated === 'ready') rendering.delete(p.path)
    // Re-request lazy data: main's stamp-keyed caches make unchanged packs free.
    requestedThumbs.clear()
    requestedSizes.clear()
    searchTexts.clear()
    if (renamingFor !== null && !live.has(renamingFor)) renamingFor = null
    if (deletingFor !== null && !live.has(deletingFor)) deletingFor = null
    if (sharingFor !== null && !live.has(sharingFor)) cancelShareReview(false)
    if (openMenuFor !== null && !live.has(openMenuFor)) openMenuFor = null
    render()
    fetchLazy()
    refreshUsage()
    if (query.trim() !== '') void ensureSearchTexts()
  } catch {
    // list failed (e.g. window closing): leave the current view
  } finally {
    listInFlight = false
    if (refreshQueued) {
      refreshQueued = false
      void refresh()
    }
  }
}

/**
 * The header's usage bar (issue #48).
 *
 * ONE ASK FOR THE WHOLE FOLDER, not a sum of the per-card sizes below: those
 * arrive one lazy invoke at a time as cards come into view, so a total built
 * from them would climb while the user reads it and would be short by every
 * pack they never scrolled to. Main answers from a cached snapshot, so calling
 * this on every re-list costs nothing worth avoiding.
 *
 * A failure hides the block rather than showing a zero — an empty bar next to
 * "0 packs" is a claim about the folder, and this window would be making it up.
 */
function refreshUsage(): void {
  void bridge
    .usage()
    .then((usage) => {
      if (usage === null) {
        usageEl.hidden = true
        return
      }
      usageEl.hidden = false
      const percent = budgetPercent(usage.totalBytes, usage.maxBytes)
      const level = budgetLevel(usage.totalBytes, usage.maxBytes)
      usageBarFill.style.width = `${String(Math.min(100, percent))}%`
      usageBar.classList.toggle('near', level === 'near')
      usageBar.classList.toggle('over', level === 'over')
      usageBar.title = t('common.storageMeter', {
        used: formatBytes(usage.totalBytes),
        max: formatBytes(usage.maxBytes),
        percent: String(percent),
      })
      usageText.textContent =
        usage.totalPacks === 0
          ? t('common.storageEmpty')
          : t('history.usage', {
              packs: String(usage.totalPacks),
              size: formatBytes(usage.totalBytes),
              date: oldestLabel(usage.oldestMs),
            })
    })
    .catch(() => {
      usageEl.hidden = true
    })
}

/** Day only: the oldest pack's clock time is noise next to how far back it is. */
function oldestLabel(oldestMs: number | null): string {
  if (oldestMs === null) return '—'
  const d = new Date(oldestMs)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function fetchLazy(): void {
  for (const p of packs) {
    const packPath = p.path
    if (!requestedThumbs.has(packPath)) {
      requestedThumbs.add(packPath)
      bridge
        .thumb(packPath)
        .then((dataUrl) => {
          thumbs.set(packPath, dataUrl)
          updateThumb(packPath)
        })
        .catch(() => {
          thumbs.set(packPath, null)
          updateThumb(packPath)
        })
    }
    if (!requestedSizes.has(packPath)) {
      requestedSizes.add(packPath)
      bridge
        .size(packPath)
        .then((bytes) => {
          sizes.set(packPath, bytes)
          updateSize(packPath)
        })
        .catch(() => {
          sizes.set(packPath, null)
          updateSize(packPath)
        })
    }
  }
}

async function ensureSearchTexts(): Promise<void> {
  if (searchTextsLoading) return
  const missing = packs.filter((p) => !searchTexts.has(p.path))
  if (missing.length === 0) return
  searchTextsLoading = true
  try {
    await Promise.all(
      missing.map(async (p) => {
        try {
          searchTexts.set(p.path, (await bridge.searchText(p.path)).toLowerCase())
        } catch {
          searchTexts.set(p.path, '')
        }
      }),
    )
  } finally {
    searchTextsLoading = false
  }
  if (query.trim() !== '') render()
}

// ---------------------------------------------------------------------------
// Filtering + search

function matchesFilter(p: HistoryPackSummary): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'today':
      return isToday(p.capturedAt)
    case 'week':
      return isThisWeek(p.capturedAt)
    case 'renderfailed':
      // Render Failed = replay present, annotated missing (contract)
      return p.annotated === 'missing'
  }
}

function capturedTime(iso: string | null): number | null {
  if (iso === null) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

function isToday(iso: string | null): boolean {
  const t = capturedTime(iso)
  if (t === null) return false
  const d = new Date(t)
  const now = new Date()
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  )
}

function isThisWeek(iso: string | null): boolean {
  const t = capturedTime(iso)
  if (t === null) return false
  // Calendar week starting Monday 00:00 local time.
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const dow = (start.getDay() + 6) % 7 // Mon=0 .. Sun=6
  start.setDate(start.getDate() - dow)
  return t >= start.getTime()
}

function matchesQuery(p: HistoryPackSummary, q: string): boolean {
  if (q === '') return true
  const base = [p.title ?? '', p.app ?? '', p.id, p.name, p.capturedAt ?? '']
    .join('\n')
    .toLowerCase()
  if (base.includes(q)) return true
  const extra = searchTexts.get(p.path)
  return extra !== undefined && extra.includes(q)
}

function visiblePacks(): HistoryPackSummary[] {
  const q = query.trim().toLowerCase()
  return packs.filter((p) => matchesFilter(p) && matchesQuery(p, q))
}

// ---------------------------------------------------------------------------
// Rendering

const cardEls = new Map<string, HTMLElement>()

function render(): void {
  cardEls.clear()
  listEl.replaceChildren()
  const visible = visiblePacks()
  const filtered = visible.length !== packs.length
  countLabel.textContent =
    packs.length === 0
      ? outputDir
      : filtered
        ? t('history.countFiltered', { visible: visible.length, count: packs.length, dir: outputDir })
        : packs.length === 1
          ? t('history.countOne', { dir: outputDir })
          : t('history.countMany', { count: packs.length, dir: outputDir })
  countLabel.title = outputDir
  if (visible.length === 0) {
    const empty = elc('div', 'empty')
    empty.textContent =
      packs.length === 0
        ? t('history.emptyNoPacks', { hotkey: captureHotkey })
        : t('history.emptyFiltered')
    listEl.append(empty)
    return
  }
  for (const p of visible) {
    const card = buildCard(p)
    cardEls.set(p.path, card)
    listEl.append(card)
  }
  if (renamingFor !== null) {
    const input = cardEls.get(renamingFor)?.querySelector<HTMLInputElement>('input[type="text"]')
    if (input) {
      input.focus()
      input.setSelectionRange(input.value.length, input.value.length)
    }
  }
}

function elc<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function buildCard(p: HistoryPackSummary): HTMLElement {
  const card = elc('article', 'card')
  card.dataset['path'] = p.path

  // Thumbnail (data URL only — never file://)
  const thumbWrap = elc('div', 'thumbWrap')
  const dataUrl = thumbs.get(p.path)
  if (typeof dataUrl === 'string') {
    const img = elc('img', 'thumb')
    img.alt = ''
    img.src = dataUrl
    thumbWrap.append(img)
  } else {
    thumbWrap.append(elc('div', 'thumbPh', dataUrl === null ? t('history.noSnapshot') : '…'))
  }
  card.append(thumbWrap)

  const body = elc('div', 'cardBody')

  // Title row
  const titleRow = elc('div', 'cardTitleRow')
  const title = elc('span', 'cardTitle', p.title ?? p.name)
  title.title = p.title ?? p.name
  titleRow.append(title)
  if (p.title !== null) {
    const name = elc('span', 'cardName', p.name)
    name.title = p.path
    titleRow.append(name)
  }
  body.append(titleRow)

  // Meta line
  const metaEl = elc('div', 'cardMeta', buildMetaText(p))
  metaEl.dataset['role'] = 'meta'
  body.append(metaEl)

  // Badges
  const badges = elc('div', 'cardBadges')
  if (p.warning !== null) {
    const warn = elc('span', 'badge warn', t('history.badgeUnreadable'))
    warn.title = p.warning
    badges.append(warn)
  }
  if (p.captureKind === 'image') {
    badges.append(elc('span', 'badge media image', t('history.badgeImage')))
  } else if (p.captureKind === 'video') {
    badges.append(elc('span', 'badge media video', t('history.badgeVideo')))
  }
  if (p.hasBlur) badges.append(elc('span', 'badge blur', t('history.badgeBlur')))
  if (p.annotated === 'ready') badges.append(elc('span', 'badge ready', t('history.badgeAnnotated')))
  else if (p.annotated === 'missing') {
    badges.append(
      elc(
        'span',
        'badge missing',
        rendering.has(p.path) ? t('history.badgeRendering') : t('history.badgeAnnotatedMissing'),
      ),
    )
  }
  // The bar the toast has, on the card that outlives it. Closing the toast used
  // to be the end of any view of a render that runs for minutes; History said
  // "Rendering…" and nothing more, so there was no way to tell a job that was
  // progressing from one that had wedged.
  if (rendering.has(p.path)) badges.append(renderProgressBar(p.path))
  if (p.zipTwin) badges.append(elc('span', 'badge', t('history.badgeZip')))
  if (p.shareTwin) badges.append(elc('span', 'badge ready', t('history.badgeShare')))
  if (fullZipping.has(p.path)) badges.append(elc('span', 'badge', t('history.zipping')))
  if (shareCreating.has(p.path)) {
    badges.append(elc('span', 'badge', t('history.shareCreating')))
  }
  if (p.kind === 'zip') badges.append(elc('span', 'badge', t('history.badgeZipPack')))
  body.append(badges)

  // Inline delete confirm / rename input replace the action row.
  if (sharingFor === p.path) {
    body.append(buildShareReview(p))
  } else if (deletingFor === p.path) {
    body.append(buildDeleteConfirm(p))
  } else if (renamingFor === p.path) {
    body.append(buildRenameRow(p))
  } else {
    body.append(buildActions(p))
  }

  const error = cardErrors.get(p.path)
  if (error !== undefined) body.append(elc('div', 'cardError', error))

  card.append(body)

  if (openMenuFor === p.path) card.append(buildMenu(p))
  return card
}

function buildActions(p: HistoryPackSummary): HTMLElement {
  const row = elc('div', 'cardActions')

  // The two headline actions, in this order: [Edit] reopens the pack in the
  // editor (main: startEditFlow), [Open Folder] reaches the files on disk.
  // A bare "Open" never said which of the two it meant.
  const editBtn = elc('button', 'primary', t('history.edit'))
  editBtn.type = 'button'
  editBtn.disabled = p.kind !== 'dir'
  editBtn.title = p.kind === 'dir' ? t('history.editTooltip') : t('history.editZipTooltip')
  editBtn.addEventListener('click', () => {
    editBtn.disabled = true
    void bridge
      .openPack(p.path)
      .then((result) => {
        if (result.ok) {
          // Do not leave History obscuring the editor it just opened. The next
          // tray/shortcut request recreates this single-instance window.
          window.close()
          return
        }
        editBtn.disabled = false
        showCardError(p.path, result.error ?? t('history.couldNotEdit'))
      })
      .catch((err: unknown) => {
        editBtn.disabled = false
        showCardError(p.path, err instanceof Error ? err.message : t('history.couldNotEdit'))
      })
  })
  row.append(editBtn)

  // Enabled for zip packs too: main reveals the .capturepack in Explorer
  // instead of opening a folder.
  const folderBtn = elc('button', undefined, t('toast.openFolder'))
  folderBtn.type = 'button'
  folderBtn.title = t('history.openFolderTooltip')
  folderBtn.addEventListener('click', () => bridge.openFolder(p.path))
  row.append(folderBtn)

  const playBtn = elc('button', undefined, t('history.play'))
  playBtn.type = 'button'
  playBtn.disabled = p.annotated !== 'ready' || p.kind !== 'dir'
  playBtn.title =
    p.annotated === 'none'
      ? t('history.playNoReplay')
      : p.annotated === 'missing'
        ? t('history.playNotRendered')
        : t('history.playTooltip')
  playBtn.addEventListener('click', () => {
    void bridge.play(p.path).then((result) => {
      if (!result.ok) showCardError(p.path, result.error ?? t('history.couldNotPlay'))
    })
  })
  row.append(playBtn)

  const shareBtn = elc(
    'button',
    'shareButton',
    p.shareTwin ? t('history.shareReviewReplace') : t('history.shareCreate'),
  )
  shareBtn.type = 'button'
  shareBtn.disabled = p.kind !== 'dir' || shareCreating.has(p.path)
  shareBtn.title = t('history.shareTooltip')
  shareBtn.addEventListener('click', () => beginShareReview(p))
  row.append(shareBtn)

  if (p.annotated === 'missing' && p.kind === 'dir') {
    const retryBtn = elc('button', undefined, rendering.has(p.path) ? t('history.renderingBtn') : t('history.retryRender'))
    retryBtn.type = 'button'
    retryBtn.disabled = rendering.has(p.path)
    retryBtn.addEventListener('click', () => startRerender(p))
    row.append(retryBtn)
  }

  const moreBtn = elc('button', 'moreBtn', '⋯')
  moreBtn.type = 'button'
  moreBtn.setAttribute('aria-label', t('history.moreActions'))
  moreBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    openMenuFor = openMenuFor === p.path ? null : p.path
    render()
  })
  row.append(moreBtn)

  return row
}

function buildMenu(p: HistoryPackSummary): HTMLElement {
  const menu = elc('div', 'menu')
  menu.addEventListener('click', (event) => event.stopPropagation())

  const item = (label: string, opts: { disabled?: boolean; danger?: boolean; title?: string }, onClick: () => void): void => {
    const btn = elc('button', `menuItem${opts.danger === true ? ' danger' : ''}`, label)
    btn.type = 'button'
    btn.disabled = opts.disabled === true
    if (opts.title !== undefined) btn.title = opts.title
    btn.addEventListener('click', () => {
      openMenuFor = null
      onClick()
    })
    menu.append(btn)
  }

  // Open Folder is NOT here: it is a visible button in the action row.
  item(t('toast.copyPath'), {}, () => {
    bridge.copyPath(p.path)
    render()
  })
  item(t('toast.copyPrompt'), {}, () => {
    void bridge.copyPrompt(p.path).catch(() => {})
    render()
  })
  menu.append(elc('div', 'menuSep'))
  item(
    p.zipTwin ? t('history.badgeZip') : t('history.menuFullZip'),
    {
      disabled: p.kind !== 'dir' || p.zipTwin || fullZipping.has(p.path),
      title: t('history.fullZipTooltip'),
    },
    () => startFullZip(p),
  )
  item(
    t('history.menuRerender'),
    {
      disabled: !p.hasReplay || p.kind !== 'dir' || rendering.has(p.path),
      title: !p.hasReplay ? t('history.playNoReplay') : t('history.rerenderTooltip'),
    },
    () => startRerender(p),
  )
  item(t('history.menuRename'), {}, () => {
    renamingFor = p.path
    renameValue = p.name
    renameError = null
    render()
  })
  menu.append(elc('div', 'menuSep'))
  item(t('history.menuDelete'), { danger: true }, () => {
    deletingFor = p.path
    render()
  })

  return menu
}

function beginShareReview(p: HistoryPackSummary): void {
  cardErrors.delete(p.path)
  sharingFor = p.path
  sharePlan = null
  sharePlanLoading = true
  openMenuFor = null
  render()
  void (async () => {
    try {
      const result = await bridge.planShare(p.path)
      if (sharingFor !== p.path) return
      if (!result.ok || result.plan === undefined) {
        sharingFor = null
        showCardError(p.path, result.error ?? t('history.sharePlanFailed'))
        return
      }
      sharePlan = result.plan
    } catch (err) {
      if (sharingFor !== p.path) return
      sharingFor = null
      showCardError(
        p.path,
        err instanceof Error ? err.message : t('history.sharePlanFailed'),
      )
      return
    } finally {
      if (sharingFor === p.path) sharePlanLoading = false
    }
    render()
  })()
}

function buildShareReview(p: HistoryPackSummary): HTMLElement {
  const review = elc('section', 'shareReview')
  if (sharePlanLoading || sharePlan === null) {
    review.append(elc('div', 'shareReviewTitle', t('history.sharePlanning')))
    return review
  }
  const plan = sharePlan
  review.append(elc('div', 'shareReviewTitle', t('history.shareReviewTitle')))
  review.append(elc('div', 'shareOutputName', plan.outputName))

  if (plan.previewDataUrls.length > 0) {
    const grid = elc('div', 'sharePreviewGrid')
    for (const dataUrl of plan.previewDataUrls) {
      const image = elc('img', 'sharePreview')
      image.alt = t('history.sharePreviewAlt')
      image.src = dataUrl
      grid.append(image)
    }
    review.append(grid)
    review.append(
      elc(
        'div',
        'shareReviewMeta',
        t('history.sharePreviewCount', {
          shown: plan.previewCount,
          total: plan.stillCount,
        }),
      ),
    )
  }

  review.append(
    elc(
      'div',
      'shareReviewMeta',
      t('history.shareContents', {
        displays: plan.displayCount,
        images: plan.stillCount,
      }),
    ),
  )
  review.append(elc('div', 'shareExcluded', t('history.shareExcluded')))
  review.append(elc('div', 'shareWarning', t('history.shareVisualWarning')))

  if (plan.visibleLabels.length > 0) {
    review.append(
      elc(
        'div',
        'shareLabelsTitle',
        t('history.shareVisibleLabels', { count: plan.visibleLabels.length }),
      ),
    )
    const labels = elc('ul', 'shareLabels')
    for (const label of plan.visibleLabels) labels.append(elc('li', undefined, label))
    review.append(labels)
  }

  const blocked = plan.blockers.includes('blur-label')
  if (blocked) review.append(elc('div', 'shareBlocker', t('history.shareErrBlurLabel')))

  const actions = elc('div', 'inlineRow')
  const createBtn = elc(
    'button',
    'primary',
    p.shareTwin ? t('history.shareReplace') : t('history.shareConfirm'),
  )
  createBtn.type = 'button'
  createBtn.disabled = blocked || shareCreating.has(p.path)
  createBtn.addEventListener('click', () => commitShare(p, plan))
  actions.append(createBtn)
  const cancelBtn = elc('button', undefined, t('common.cancel'))
  cancelBtn.type = 'button'
  cancelBtn.disabled = shareCreating.has(p.path)
  cancelBtn.addEventListener('click', () => {
    if (!shareCreating.has(p.path)) cancelShareReview()
  })
  actions.append(cancelBtn)
  review.append(actions)
  return review
}

function commitShare(p: HistoryPackSummary, plan: HistorySharePlan): void {
  if (shareCreating.has(p.path)) return
  shareCreating.add(p.path)
  render()
  void (async () => {
    try {
      const result = await bridge.createShare(p.path, plan.revision)
      if (!result.ok) {
        showCardError(p.path, result.error ?? t('history.shareCreateFailed'))
        return
      }
      p.shareTwin = true
      cancelShareReview(false)
      refreshUsage()
    } catch (err) {
      showCardError(
        p.path,
        err instanceof Error ? err.message : t('history.shareCreateFailed'),
      )
    } finally {
      shareCreating.delete(p.path)
      render()
    }
  })()
}

function cancelShareReview(shouldRender = true): void {
  sharingFor = null
  sharePlan = null
  sharePlanLoading = false
  if (shouldRender) render()
}

function startFullZip(p: HistoryPackSummary): void {
  if (fullZipping.has(p.path)) return
  cardErrors.delete(p.path)
  fullZipping.add(p.path)
  render()
  void (async () => {
    try {
      const result = await bridge.createZip(p.path)
      if (result.ok) {
        p.zipTwin = true
        refreshUsage()
      } else showCardError(p.path, result.error ?? t('history.createZipFailed'))
    } catch (err) {
      showCardError(
        p.path,
        err instanceof Error ? err.message : t('history.createZipFailed'),
      )
    } finally {
      fullZipping.delete(p.path)
      render()
    }
  })()
}

function buildRenameRow(p: HistoryPackSummary): HTMLElement {
  const row = elc('div', 'inlineRow')
  const input = elc('input')
  input.type = 'text'
  input.value = renameValue
  input.spellcheck = false
  input.addEventListener('input', () => {
    renameValue = input.value
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void commitRename(p)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      cancelRename()
    }
  })
  row.append(input)

  const saveBtn = elc('button', 'primary', t('history.menuRename'))
  saveBtn.type = 'button'
  saveBtn.addEventListener('click', () => void commitRename(p))
  row.append(saveBtn)

  const cancelBtn = elc('button', undefined, t('common.cancel'))
  cancelBtn.type = 'button'
  cancelBtn.addEventListener('click', () => cancelRename())
  row.append(cancelBtn)

  if (renameError !== null) row.append(elc('span', 'cardError', renameError))
  return row
}

async function commitRename(p: HistoryPackSummary): Promise<void> {
  const result = await bridge.rename(p.path, renameValue.trim())
  if (result.ok) {
    renamingFor = null
    renameValue = ''
    renameError = null
    await refresh()
  } else {
    renameError = result.error ?? t('history.renameFailed')
    render()
  }
}

function cancelRename(): void {
  renamingFor = null
  renameValue = ''
  renameError = null
  render()
}

function buildDeleteConfirm(p: HistoryPackSummary): HTMLElement {
  const row = elc('div', 'inlineRow')
  row.append(
    elc(
      'span',
      'confirmText',
      p.kind === 'dir' && (p.zipTwin || p.shareTwin)
        ? t('history.deleteConfirmZip')
        : t('history.deleteConfirm'),
    ),
  )
  const yesBtn = elc('button', 'danger', t('history.menuDelete'))
  yesBtn.type = 'button'
  yesBtn.addEventListener('click', () => {
    yesBtn.disabled = true
    void bridge.remove(p.path).then((result) => {
      deletingFor = null
      if (!result.ok) showCardError(p.path, result.error ?? t('history.deleteFailed'))
      void refresh()
    })
  })
  row.append(yesBtn)
  const noBtn = elc('button', undefined, t('common.cancel'))
  noBtn.type = 'button'
  noBtn.addEventListener('click', () => {
    deletingFor = null
    render()
  })
  row.append(noBtn)
  return row
}

function startRerender(p: HistoryPackSummary): void {
  cardErrors.delete(p.path)
  void bridge.rerender(p.path).then((result) => {
    if (result.ok) {
      rendering.add(p.path)
    } else {
      showCardError(p.path, result.error ?? t('history.rerenderFailed'))
    }
    render()
  })
  render()
}

function showCardError(packPath: string, message: string): void {
  cardErrors.set(packPath, message)
  render()
}

// In-place updates so lazy data never rebuilds the list mid-interaction.
function updateThumb(packPath: string): void {
  const card = cardEls.get(packPath)
  if (card === undefined) return
  const wrap = card.querySelector('.thumbWrap')
  if (wrap === null) return
  const dataUrl = thumbs.get(packPath)
  wrap.replaceChildren()
  if (typeof dataUrl === 'string') {
    const img = elc('img', 'thumb')
    img.alt = ''
    img.src = dataUrl
    wrap.append(img)
  } else {
    wrap.append(elc('div', 'thumbPh', t('history.noSnapshot')))
  }
}

function updateSize(packPath: string): void {
  const card = cardEls.get(packPath)
  const p = packs.find((entry) => entry.path === packPath)
  if (card === undefined || p === undefined) return
  const metaEl = card.querySelector('[data-role="meta"]')
  if (metaEl !== null) metaEl.textContent = buildMetaText(p)
}

function buildMetaText(p: HistoryPackSummary): string {
  const meta: string[] = []
  if (p.app !== null) meta.push(p.app)
  const when = formatDate(p.capturedAt)
  if (when !== null) meta.push(when)
  meta.push(
    p.replayDurationMs !== null
      ? t('history.metaReplay', { duration: formatDuration(p.replayDurationMs) })
      : t('history.metaScreenshotOnly'),
  )
  meta.push(
    (p.annotationCount === 1
      ? t('history.metaAnnotationsOne')
      : t('history.metaAnnotationsMany', { count: p.annotationCount })) +
      (p.numberedCount > 0 ? ` (${t('history.metaNumbered', { count: p.numberedCount })})` : ''),
  )
  const bytes = sizes.get(p.path)
  if (typeof bytes === 'number') meta.push(formatBytes(bytes))
  return meta.join('  ·  ')
}

// ---------------------------------------------------------------------------
// Formatting

function formatDate(iso: string | null): string | null {
  const t = capturedTime(iso)
  if (t === null) return null
  const d = new Date(t)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

// formatBytes now lives in shared/retention.ts: this window prints a pack's
// size on a card and the whole folder's size in the header, and Settings prints
// the same total beside the same bar. Two formatters that rounded differently
// would have had the two windows disagree about the size of one folder.

// ---------------------------------------------------------------------------
// Global events

let searchTimer: number | null = null
searchInput.addEventListener('input', () => {
  if (searchTimer !== null) window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    searchTimer = null
    query = searchInput.value
    render()
    if (query.trim() !== '') void ensureSearchTexts()
  }, SEARCH_DEBOUNCE_MS)
})

filtersNav.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  const chip = target.closest<HTMLButtonElement>('button.chip')
  if (chip === null) return
  const next = chip.dataset['filter'] as FilterId | undefined
  if (next === undefined) return
  filter = next
  for (const other of filtersNav.querySelectorAll('button.chip')) {
    other.classList.toggle('active', other === chip)
  }
  render()
})

// A click anywhere outside the open menu closes it (menu clicks stopPropagation).
document.addEventListener('click', () => {
  if (openMenuFor !== null) {
    openMenuFor = null
    render()
  }
})

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  // Esc peels UI layers before closing the window (contract: Esc closes).
  if (openMenuFor !== null) {
    openMenuFor = null
    render()
    return
  }
  if (renamingFor !== null) {
    cancelRename()
    return
  }
  if (deletingFor !== null) {
    deletingFor = null
    render()
    return
  }
  if (sharingFor !== null) {
    if (!shareCreating.has(sharingFor)) cancelShareReview()
    return
  }
  event.preventDefault()
  window.close()
})

// Live refresh: watcher pushes + window-focus backstop both arrive here.
bridge.onChanged(() => {
  void refresh()
})

bridge.onRenderStatus((payload) => {
  // Pushed for EVERY render (save-time renders too, not only [Retry Render]):
  // 'rendering' flips the card to "Rendering…" so an in-flight render can
  // never be doubled up via an enabled retry button.
  if (payload.state === 'rendering') {
    // A PROGRESS TICK IS NOT A LIST CHANGE. These arrive several times a second
    // per render, and rebuilding every card for each one would throw away
    // scroll position, hover, and any open rename box. The bar is moved where
    // it stands; only a card that was not already rendering needs a rebuild.
    const known = rendering.has(payload.path)
    rendering.add(payload.path)
    cardErrors.delete(payload.path)
    if (payload.ratio !== undefined) renderRatio.set(payload.path, payload.ratio)
    else renderRatio.delete(payload.path)
    if (known) {
      paintRenderProgress(payload.path)
      return
    }
  } else {
    renderRatio.delete(payload.path)
    rendering.delete(payload.path)
    if (payload.state === 'failed') {
      cardErrors.set(payload.path, t('history.renderFailedCard'))
    } else {
      cardErrors.delete(payload.path)
    }
  }
  void refresh()
})

void refresh()
