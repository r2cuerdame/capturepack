// Save-complete toast renderer: folder name, the four actions, the blur
// warning line, and the background render status. Kept dumb: every action is
// one bridge call; main owns the file system and the clipboard.
import type {
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
const renderStatus = el<HTMLDivElement>('renderStatus')

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
  if (state === 'rendering') {
    renderStatus.hidden = false
    renderStatus.textContent = 'rendering annotated replay…'
  } else if (state === 'done') {
    renderStatus.hidden = false
    renderStatus.classList.add('done')
    renderStatus.textContent = 'annotated replay ready'
  } else if (state === 'failed') {
    renderStatus.hidden = false
    renderStatus.classList.add('failed')
    renderStatus.textContent = 'annotated replay render failed'
  } else {
    renderStatus.hidden = true
  }
}

window.toastBridge.onInit((payload) => {
  folderName.textContent = payload.folderName
  folderName.title = payload.folderPath
  blurWarning.hidden = !payload.hasBlur
  setRenderStatus(payload.renderState)
})

window.toastBridge.onRenderStatus((payload) => {
  setRenderStatus(payload.state)
})

closeBtn.addEventListener('click', () => window.toastBridge.close())
openFolderBtn.addEventListener('click', () => window.toastBridge.openFolder())
copyPathBtn.addEventListener('click', () => {
  window.toastBridge.copyPath()
  flash(copyPathBtn, 'Copied!')
})
copyPromptBtn.addEventListener('click', () => {
  window.toastBridge.copyPrompt()
  flash(copyPromptBtn, 'Copied!')
})
createZipBtn.addEventListener('click', () => {
  createZipBtn.disabled = true
  void window.toastBridge
    .createZip()
    .then((result) => {
      if (result.ok) {
        createZipBtn.textContent = 'ZIP created'
      } else {
        createZipBtn.disabled = false
        flash(createZipBtn, 'ZIP failed')
      }
    })
    .catch(() => {
      createZipBtn.disabled = false
      flash(createZipBtn, 'ZIP failed')
    })
})

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.toastBridge.close()
})
