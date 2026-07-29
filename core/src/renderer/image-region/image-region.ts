import type {
  ImageRegionSelectorCancelPayload,
  ImageRegionSelectorCommitPayload,
  ImageRegionSelectorDragPayload,
  ImageRegionSelectorFocusPayload,
  ImageRegionSelectorInitPayload,
  ImageRegionSelectorPreviewPayload,
  ImageRegionSelectorReadyPayload,
} from '../../shared/ipc'
import { resolveImageDesktopRegion } from '../../shared/imageRegion'
import { applyDomI18n, makeT } from '../../shared/i18n'
import type {
  ImageRegionCompositeLayout,
  ImageRegionPoint,
  ImageRegionRect,
  ImageRegionSelectorDisplay,
} from '../../shared/imageRegion'

interface ImageRegionBridge {
  onInit(cb: (payload: ImageRegionSelectorInitPayload) => void): void
  onFocus(cb: (payload: ImageRegionSelectorFocusPayload) => void): void
  onPreview(cb: (payload: ImageRegionSelectorPreviewPayload) => void): void
  ready(payload: ImageRegionSelectorReadyPayload): void
  drag(payload: ImageRegionSelectorDragPayload): void
  commit(payload: ImageRegionSelectorCommitPayload): void
  cancel(payload: ImageRegionSelectorCancelPayload): void
}

declare global {
  interface Window {
    imageRegionBridge: ImageRegionBridge
  }
}

const toolbar = required<HTMLElement>('toolbar')
const fullscreenBtn = required<HTMLButtonElement>('fullscreenBtn')
const selection = required<HTMLElement>('selection')
const size = required<HTMLOutputElement>('size')
const shadeTop = required<HTMLElement>('shadeTop')
const shadeLeft = required<HTMLElement>('shadeLeft')
const shadeRight = required<HTMLElement>('shadeRight')
const shadeBottom = required<HTMLElement>('shadeBottom')

let requestId: string | null = null
let display: ImageRegionSelectorDisplay | null = null
let displays: ImageRegionSelectorDisplay[] = []
let layout: ImageRegionCompositeLayout | null = null
let focused = false
let previewActive = false

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (element === null) throw new Error(`missing #${id}`)
  return element as T
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

function clientPoint(event: PointerEvent): ImageRegionPoint {
  return {
    x: clamp(event.clientX, 0, window.innerWidth),
    y: clamp(event.clientY, 0, window.innerHeight),
  }
}

/**
 * Each renderer owns one native monitor-sized overlay. Convert its CSS point
 * through that monitor's exact Electron bounds; Main then joins points arriving
 * from different overlays into one virtual-desktop drag.
 */
function desktopPoint(event: PointerEvent): ImageRegionPoint | null {
  if (display === null) return null
  const point = clientPoint(event)
  return {
    x: display.bounds.x +
      (point.x / Math.max(1, window.innerWidth)) * display.bounds.width,
    y: display.bounds.y +
      (point.y / Math.max(1, window.innerHeight)) * display.bounds.height,
  }
}

function localRect(rect: ImageRegionRect): ImageRegionRect | null {
  if (display === null) return null
  const xRatio = window.innerWidth / display.bounds.width
  const yRatio = window.innerHeight / display.bounds.height
  return {
    x: (rect.x - display.bounds.x) * xRatio,
    y: (rect.y - display.bounds.y) * yRatio,
    width: rect.width * xRatio,
    height: rect.height * yRatio,
  }
}

function setBox(desktopRect: ImageRegionRect): void {
  const raw = localRect(desktopRect)
  if (raw === null) return
  const left = clamp(raw.x, 0, window.innerWidth)
  const top = clamp(raw.y, 0, window.innerHeight)
  const right = clamp(raw.x + raw.width, 0, window.innerWidth)
  const bottom = clamp(raw.y + raw.height, 0, window.innerHeight)
  if (right <= left || bottom <= top) {
    resetBox()
    return
  }

  selection.hidden = false
  selection.style.left = `${left}px`
  selection.style.top = `${top}px`
  selection.style.width = `${right - left}px`
  selection.style.height = `${bottom - top}px`
  // Do not draw a false border at an internal monitor seam. Only the real outer
  // edge of the one shared rectangle gets a border.
  selection.classList.toggle('continues-left', raw.x < 0)
  selection.classList.toggle('continues-top', raw.y < 0)
  selection.classList.toggle('continues-right', raw.x + raw.width > window.innerWidth)
  selection.classList.toggle('continues-bottom', raw.y + raw.height > window.innerHeight)
  selection.classList.toggle('near-bottom', bottom > window.innerHeight - 50)

  shadeTop.classList.remove('shade-initial')
  Object.assign(shadeTop.style, {
    left: '0px',
    top: '0px',
    width: `${window.innerWidth}px`,
    height: `${top}px`,
  })
  Object.assign(shadeBottom.style, {
    left: '0px',
    top: `${bottom}px`,
    width: `${window.innerWidth}px`,
    height: `${Math.max(0, window.innerHeight - bottom)}px`,
  })
  Object.assign(shadeLeft.style, {
    left: '0px',
    top: `${top}px`,
    width: `${left}px`,
    height: `${bottom - top}px`,
  })
  Object.assign(shadeRight.style, {
    left: `${right}px`,
    top: `${top}px`,
    width: `${Math.max(0, window.innerWidth - right)}px`,
    height: `${bottom - top}px`,
  })

  const resolved =
    layout === null
      ? null
      : resolveImageDesktopRegion(displays, layout, desktopRect)
  size.hidden = !focused
  size.textContent =
    resolved === null
      ? ''
      : `${resolved.compositePixelRect.width} × ${resolved.compositePixelRect.height}`
}

function resetBox(): void {
  selection.hidden = true
  size.textContent = ''
  shadeTop.classList.add('shade-initial')
  shadeTop.removeAttribute('style')
  shadeLeft.removeAttribute('style')
  shadeRight.removeAttribute('style')
  shadeBottom.removeAttribute('style')
}

function sendDrag(phase: ImageRegionSelectorDragPayload['phase'], event: PointerEvent): void {
  if (requestId === null) return
  const point = desktopPoint(event)
  if (point === null) return
  window.imageRegionBridge.drag({
    requestId,
    phase,
    desktopDipPoint: point,
  })
}

window.imageRegionBridge.onInit((payload) => {
  requestId = payload.requestId
  display = payload.display
  displays = payload.displays
  layout = payload.layout
  focused = payload.focused
  document.documentElement.lang = payload.uiLanguage
  applyDomI18n(makeT(payload.uiLanguage))
  toolbar.hidden = !focused
  document.documentElement.dataset.ready = 'true'
  window.imageRegionBridge.ready({ requestId: payload.requestId })
})

window.imageRegionBridge.onFocus((payload) => {
  if (payload.requestId !== requestId) return
  focused = payload.focused
  toolbar.hidden = !focused
  size.hidden = !focused
})

window.imageRegionBridge.onPreview((payload) => {
  if (payload.requestId !== requestId) return
  previewActive = payload.desktopDipRect !== null
  if (payload.desktopDipRect === null) resetBox()
  else setBox(payload.desktopDipRect)
})

document.addEventListener('pointerdown', (event) => {
  if (
    requestId === null ||
    display === null ||
    layout === null ||
    event.button !== 0 ||
    (event.target instanceof Element && event.target.closest('#toolbar') !== null)
  ) {
    return
  }
  event.preventDefault()
  // Deliberately no setPointerCapture(): the next monitor's native overlay must
  // receive pointermove/pointerup after the cursor crosses the seam.
  sendDrag('start', event)
})

document.addEventListener('pointermove', (event) => {
  if (!previewActive) return
  // A release in a monitor gap has no overlay to receive pointerup. As soon as
  // the cursor re-enters any overlay, finish at that visible point.
  sendDrag((event.buttons & 1) === 0 ? 'end' : 'move', event)
})

document.addEventListener('pointerup', (event) => {
  if (!previewActive || event.button !== 0) return
  event.preventDefault()
  sendDrag('end', event)
})

fullscreenBtn.addEventListener('click', (event) => {
  event.preventDefault()
  event.stopPropagation()
  if (requestId === null) return
  window.imageRegionBridge.commit({ requestId, mode: 'fullscreen' })
})

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || requestId === null) return
  event.preventDefault()
  window.imageRegionBridge.cancel({ requestId })
})

window.addEventListener('resize', resetBox)
