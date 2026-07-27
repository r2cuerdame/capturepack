// History window renderer: pack cards (thumbnail, title, metadata, badges,
// actions), case-insensitive search with lazily loaded report/annotation text,
// and filter chips. Kept dumb where possible: main owns the file system; every
// action is one bridge call keyed by the pack's absolute path.
import type {
  HistoryActionResult,
  HistoryListResult,
  HistoryPackSummary,
  HistoryRenameResult,
  HistoryRenderStatusPayload,
  ToastCreateZipResult,
} from '../../shared/ipc'

interface HistoryBridge {
  list(): Promise<HistoryListResult>
  thumb(packPath: string): Promise<string | null>
  size(packPath: string): Promise<number | null>
  searchText(packPath: string): Promise<string>
  openPack(packPath: string): void
  play(packPath: string): Promise<HistoryActionResult>
  createZip(packPath: string): Promise<ToastCreateZipResult>
  openFolder(packPath: string): void
  copyPath(packPath: string): void
  copyPrompt(packPath: string): void
  rerender(packPath: string): Promise<HistoryActionResult>
  rename(packPath: string, newName: string): Promise<HistoryRenameResult>
  remove(packPath: string): Promise<HistoryActionResult>
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

type FilterId = 'all' | 'today' | 'week' | 'blur' | 'renderfailed' | 'notpackaged'

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (node === null) throw new Error(`missing #${id}`)
  return node as T
}

const searchInput = el<HTMLInputElement>('search')
const filtersNav = el<HTMLElement>('filters')
const listEl = el<HTMLElement>('list')
const countLabel = el<HTMLSpanElement>('countLabel')

// ---------------------------------------------------------------------------
// State

let packs: HistoryPackSummary[] = []
let outputDir = ''
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
// Per-card transient error lines, keyed by path.
const cardErrors = new Map<string, string>()

let openMenuFor: string | null = null
let renamingFor: string | null = null
let renameValue = ''
let renameError: string | null = null
let deletingFor: string | null = null

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
    const live = new Set(packs.map((p) => p.path))
    for (const map of [thumbs, sizes, cardErrors]) {
      for (const key of [...map.keys()]) if (!live.has(key)) map.delete(key)
    }
    for (const key of [...rendering]) if (!live.has(key)) rendering.delete(key)
    // A pack whose annotated replay is now ready is definitely done rendering.
    for (const p of packs) if (p.annotated === 'ready') rendering.delete(p.path)
    // Re-request lazy data: main's stamp-keyed caches make unchanged packs free.
    requestedThumbs.clear()
    requestedSizes.clear()
    searchTexts.clear()
    if (renamingFor !== null && !live.has(renamingFor)) renamingFor = null
    if (deletingFor !== null && !live.has(deletingFor)) deletingFor = null
    if (openMenuFor !== null && !live.has(openMenuFor)) openMenuFor = null
    render()
    fetchLazy()
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
    case 'blur':
      return p.hasBlur
    case 'renderfailed':
      // Render Failed = replay present, annotated missing (contract)
      return p.annotated === 'missing'
    case 'notpackaged':
      return !p.zipTwin
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
      : `${filtered ? `${visible.length} of ${packs.length}` : `${packs.length}`} pack${packs.length === 1 ? '' : 's'} — ${outputDir}`
  countLabel.title = outputDir
  if (visible.length === 0) {
    const empty = elc('div', 'empty')
    empty.textContent =
      packs.length === 0
        ? 'No CapturePacks yet — press Ctrl+Alt+C to capture.'
        : 'No packs match the current search / filter.'
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
    thumbWrap.append(elc('div', 'thumbPh', dataUrl === null ? 'no snapshot' : '…'))
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
    const warn = elc('span', 'badge warn', 'unreadable')
    warn.title = p.warning
    badges.append(warn)
  }
  if (p.hasBlur) badges.append(elc('span', 'badge blur', 'blur'))
  if (p.annotated === 'ready') badges.append(elc('span', 'badge ready', 'annotated ✓'))
  else if (p.annotated === 'missing') {
    badges.append(
      elc('span', 'badge missing', rendering.has(p.path) ? 'rendering…' : 'annotated missing'),
    )
  }
  if (p.zipTwin) badges.append(elc('span', 'badge', 'ZIP ✓'))
  if (p.kind === 'zip') badges.append(elc('span', 'badge', 'zip pack'))
  body.append(badges)

  // Inline delete confirm / rename input replace the action row.
  if (deletingFor === p.path) {
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

  // [Open] — re-edit. NEXT STAGE owns the flow; main logs until it exists.
  const openBtn = elc('button', 'primary', 'Open')
  openBtn.type = 'button'
  openBtn.disabled = p.kind !== 'dir'
  if (p.kind !== 'dir') openBtn.title = 'Extract the zip to re-edit it'
  openBtn.addEventListener('click', () => bridge.openPack(p.path))
  row.append(openBtn)

  const playBtn = elc('button', undefined, 'Play')
  playBtn.type = 'button'
  playBtn.disabled = p.annotated !== 'ready' || p.kind !== 'dir'
  playBtn.title =
    p.annotated === 'none'
      ? 'This pack has no replay'
      : p.annotated === 'missing'
        ? 'Annotated replay is not rendered yet'
        : 'Play replay_annotated.webm'
  playBtn.addEventListener('click', () => {
    void bridge.play(p.path).then((result) => {
      if (!result.ok) showCardError(p.path, result.error ?? 'Could not play')
    })
  })
  row.append(playBtn)

  const zipBtn = elc('button', undefined, p.zipTwin ? 'ZIP ✓' : 'Create ZIP')
  zipBtn.type = 'button'
  zipBtn.disabled = p.zipTwin || p.kind !== 'dir'
  zipBtn.addEventListener('click', () => {
    zipBtn.disabled = true
    zipBtn.textContent = 'Zipping…'
    void bridge.createZip(p.path).then((result) => {
      if (result.ok) {
        p.zipTwin = true
        render()
      } else {
        showCardError(p.path, result.error ?? 'Create ZIP failed')
      }
    })
  })
  row.append(zipBtn)

  if (p.annotated === 'missing' && p.kind === 'dir') {
    const retryBtn = elc('button', undefined, rendering.has(p.path) ? 'Rendering…' : 'Retry Render')
    retryBtn.type = 'button'
    retryBtn.disabled = rendering.has(p.path)
    retryBtn.addEventListener('click', () => startRerender(p))
    row.append(retryBtn)
  }

  const moreBtn = elc('button', 'moreBtn', '⋯')
  moreBtn.type = 'button'
  moreBtn.setAttribute('aria-label', 'More actions')
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

  item('Open Folder', {}, () => {
    bridge.openFolder(p.path)
    render()
  })
  item('Copy Folder Path', {}, () => {
    bridge.copyPath(p.path)
    render()
  })
  item('Copy Prompt', {}, () => {
    bridge.copyPrompt(p.path)
    render()
  })
  menu.append(elc('div', 'menuSep'))
  item(
    'Re-render',
    {
      disabled: !p.hasReplay || p.kind !== 'dir' || rendering.has(p.path),
      title: !p.hasReplay ? 'This pack has no replay' : 'Re-render the annotated replay',
    },
    () => startRerender(p),
  )
  item('Rename', {}, () => {
    renamingFor = p.path
    renameValue = p.name
    renameError = null
    render()
  })
  menu.append(elc('div', 'menuSep'))
  item('Delete', { danger: true }, () => {
    deletingFor = p.path
    render()
  })

  return menu
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

  const saveBtn = elc('button', 'primary', 'Rename')
  saveBtn.type = 'button'
  saveBtn.addEventListener('click', () => void commitRename(p))
  row.append(saveBtn)

  const cancelBtn = elc('button', undefined, 'Cancel')
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
    renameError = result.error ?? 'Rename failed'
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
      p.kind === 'dir' && p.zipTwin
        ? 'Move this CapturePack and its ZIP to the Recycle Bin?'
        : 'Move this CapturePack to the Recycle Bin?',
    ),
  )
  const yesBtn = elc('button', 'danger', 'Delete')
  yesBtn.type = 'button'
  yesBtn.addEventListener('click', () => {
    yesBtn.disabled = true
    void bridge.remove(p.path).then((result) => {
      deletingFor = null
      if (!result.ok) showCardError(p.path, result.error ?? 'Delete failed')
      void refresh()
    })
  })
  row.append(yesBtn)
  const noBtn = elc('button', undefined, 'Cancel')
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
      showCardError(p.path, result.error ?? 'Re-render failed')
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
    wrap.append(elc('div', 'thumbPh', 'no snapshot'))
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
  meta.push(p.replayDurationMs !== null ? `replay ${formatDuration(p.replayDurationMs)}` : 'screenshot only')
  meta.push(
    `${p.annotationCount} annotation${p.annotationCount === 1 ? '' : 's'}` +
      (p.numberedCount > 0 ? ` (${p.numberedCount} numbered)` : ''),
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes
  let unit = 'B'
  for (const next of units) {
    if (value < 1024) break
    value /= 1024
    unit = next
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`
}

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
    rendering.add(payload.path)
    cardErrors.delete(payload.path)
  } else {
    rendering.delete(payload.path)
    if (payload.state === 'failed') {
      cardErrors.set(payload.path, 'Annotated replay render failed — try Retry Render')
    } else {
      cardErrors.delete(payload.path)
    }
  }
  void refresh()
})

void refresh()
