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
const createZipBtn = el<HTMLButtonElement>('createZipBtn')
const copyPromptBtn = el<HTMLButtonElement>('copyPromptBtn')
const blurWarning = el<HTMLDivElement>('blurWarning')
const replayWarning = el<HTMLDivElement>('replayWarning')
const renderStatus = el<HTMLDivElement>('renderStatus')

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

function setRenderStatus(state: string): void {
  renderStatus.classList.remove('done', 'failed')
  if (state === 'trimming') {
    // Trim save (GOAL "Replay Trim"): the plain-trim render runs first, then
    // the annotated render flips this line to 'rendering'.
    renderStatus.hidden = false
    renderStatus.textContent = t('toast.trimming')
  } else if (state === 'rendering') {
    renderStatus.hidden = false
    renderStatus.textContent = t('toast.rendering')
  } else if (state === 'done') {
    renderStatus.hidden = false
    renderStatus.classList.add('done')
    renderStatus.textContent = t('toast.renderReady')
  } else if (state === 'failed') {
    renderStatus.hidden = false
    renderStatus.classList.add('failed')
    renderStatus.textContent = t('toast.renderFailed')
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
  setRenderStatus(payload.state)
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
createZipBtn.addEventListener('click', () => {
  createZipBtn.disabled = true
  void window.toastBridge
    .createZip()
    .then((result) => {
      if (result.ok) {
        createZipBtn.textContent = t('toast.zipCreated')
      } else {
        createZipBtn.disabled = false
        flash(createZipBtn, t('toast.zipFailed'))
      }
    })
    .catch(() => {
      createZipBtn.disabled = false
      flash(createZipBtn, t('toast.zipFailed'))
    })
})

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.toastBridge.close()
})
