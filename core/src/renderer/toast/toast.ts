// Save-complete toast renderer: folder name, the four actions, the blur
// warning line, and the background render status. Kept dumb: every action is
// one bridge call; main owns the file system and the clipboard.
import { applyDomI18n, makeT, recorderFailureText } from '../../shared/i18n'
import type { TranslateFn } from '../../shared/i18n'
import type {
  ReplayUnavailablePayload,
  ToastCreateZipResult,
  ToastInitPayload,
  ToastRenderStatusPayload,
} from '../../shared/ipc'

interface ToastBridge {
  onInit(cb: (payload: ToastInitPayload) => void): void
  onRenderStatus(cb: (payload: ToastRenderStatusPayload) => void): void
  openFolder(): void
  copyPath(): void
  createZip(): Promise<ToastCreateZipResult>
  copyPrompt(): void
  close(): void
}

declare global {
  interface Window {
    toastBridge: ToastBridge
  }
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`missing #${id}`)
  return node as T
}

const folderName = el<HTMLSpanElement>('folderName')
const closeBtn = el<HTMLButtonElement>('closeBtn')
const openFolderBtn = el<HTMLButtonElement>('openFolderBtn')
const copyPathBtn = el<HTMLButtonElement>('copyPathBtn')
const copyPromptBtn = el<HTMLButtonElement>('copyPromptBtn')
const blurWarning = el<HTMLDivElement>('blurWarning')
const replayWarning = el<HTMLDivElement>('replayWarning')
const renderStatus = el<HTMLDivElement>('renderStatus')
const renderLabel = el<HTMLSpanElement>('renderLabel')
const renderBar = el<HTMLDivElement>('renderBar')
const renderBarFill = el<HTMLDivElement>('renderBarFill')

// Active-language t(); replaced by the init payload's uiLanguage.
let t: TranslateFn = makeT('en')

/** Briefly confirms a click by swapping the button label. */
function flash(btn: HTMLButtonElement, label: string): void {
  const original = btn.textContent
  btn.textContent = label
  setTimeout(() => {
    btn.textContent = original
  }, 1500)
}

/**
 * The render's own account of itself (#96).
 *
 * `progress` is ABSENT until the render reports a playhead, and the bar is
 * indeterminate until then rather than sitting at a number nobody measured.
 * The annotated render is real-time playback, so the playhead is the only
 * honest source — main cannot compute one without guessing.
 */
function setRenderStatus(state: string, progress?: number): void {
  renderStatus.classList.remove('done', 'failed')
  const running = state === 'trimming' || state === 'rendering'
  renderBar.hidden = !running
  if (running) {
    const known = typeof progress === 'number' && Number.isFinite(progress)
    renderBar.classList.toggle('indeterminate', !known)
    if (known) renderBarFill.style.width = `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`
  }
  if (state === 'trimming') {
    // Trim save (GOAL "Replay Trim"): the plain-trim render runs first, then
    // the annotated render flips this line to 'rendering'.
    renderStatus.hidden = false
    renderLabel.textContent = t('toast.trimming')
  } else if (state === 'rendering') {
    renderStatus.hidden = false
    renderLabel.textContent = t('toast.rendering')
  } else if (state === 'done') {
    renderStatus.hidden = false
    renderStatus.classList.add('done')
    renderLabel.textContent = t('toast.renderReady')
  } else if (state === 'failed') {
    renderStatus.hidden = false
    renderStatus.classList.add('failed')
    renderLabel.textContent = t('toast.renderFailed')
  } else {
    renderStatus.hidden = true
  }
}

/**
 * "Saved" must never read as "saved everything" (GOAL "Say that you are
 * recording"): when a display's buffer was not running, the pack has no replay
 * for it and the toast says so — with the recorder's reason, worded exactly as
 * the tray words it.
 */
function setReplayWarning(unavailable: ReplayUnavailablePayload | null): void {
  if (unavailable === null) {
    replayWarning.hidden = true
    replayWarning.textContent = ''
    return
  }
  const reason = recorderFailureText(t, unavailable.reason)
  replayWarning.hidden = false
  // The pack's OWN replay is missing -> say that plainly; otherwise name how
  // many of the captured screens went without one.
  replayWarning.textContent = unavailable.focused
    ? t('toast.replayUnavailable', { reason })
    : t('toast.replayUnavailableScreens', {
        count: unavailable.screens,
        total: unavailable.total,
        reason,
      })
}

window.toastBridge.onInit((payload) => {
  t = makeT(payload.uiLanguage)
  applyDomI18n(t)
  folderName.textContent = payload.folderName
  folderName.title = payload.folderPath
  blurWarning.hidden = !payload.hasBlur
  setReplayWarning(payload.replayUnavailable)
  setRenderStatus(payload.renderState)
})

window.toastBridge.onRenderStatus((payload) => {
  setRenderStatus(payload.state, payload.progress)
})

closeBtn.addEventListener('click', () => window.toastBridge.close())
openFolderBtn.addEventListener('click', () => window.toastBridge.openFolder())
copyPathBtn.addEventListener('click', () => {
  window.toastBridge.copyPath()
  flash(copyPathBtn, t('toast.copiedFlash'))
})
copyPromptBtn.addEventListener('click', () => {
  window.toastBridge.copyPrompt()
  flash(copyPromptBtn, t('toast.copiedFlash'))
})

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.toastBridge.close()
})
