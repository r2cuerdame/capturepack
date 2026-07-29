// Narrow bridge for the image-region overlays. The renderer can submit only
// geometry tied to the request id main gave it; it never receives source image
// bytes or filesystem paths.
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  ImageRegionSelectorCancelPayload,
  ImageRegionSelectorCommitPayload,
  ImageRegionSelectorDragPayload,
  ImageRegionSelectorFocusPayload,
  ImageRegionSelectorInitPayload,
  ImageRegionSelectorPreviewPayload,
  ImageRegionSelectorReadyPayload,
} from '../shared/ipc'

contextBridge.exposeInMainWorld('imageRegionBridge', {
  onInit(cb: (payload: ImageRegionSelectorInitPayload) => void): void {
    ipcRenderer.on(IPC.imageRegionInit, (_event, payload: ImageRegionSelectorInitPayload) => {
      cb(payload)
    })
  },
  onFocus(cb: (payload: ImageRegionSelectorFocusPayload) => void): void {
    ipcRenderer.on(IPC.imageRegionFocus, (_event, payload: ImageRegionSelectorFocusPayload) => {
      cb(payload)
    })
  },
  onPreview(cb: (payload: ImageRegionSelectorPreviewPayload) => void): void {
    ipcRenderer.on(
      IPC.imageRegionPreview,
      (_event, payload: ImageRegionSelectorPreviewPayload) => cb(payload),
    )
  },
  ready(payload: ImageRegionSelectorReadyPayload): void {
    ipcRenderer.send(IPC.imageRegionReady, payload)
  },
  drag(payload: ImageRegionSelectorDragPayload): void {
    ipcRenderer.send(IPC.imageRegionDrag, payload)
  },
  commit(payload: ImageRegionSelectorCommitPayload): void {
    ipcRenderer.send(IPC.imageRegionCommit, payload)
  },
  cancel(payload: ImageRegionSelectorCancelPayload): void {
    ipcRenderer.send(IPC.imageRegionCancel, payload)
  },
})
