// Preload for the save-complete toast window: narrow, typed bridge.
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  ToastCreateZipResult,
  ToastInitPayload,
  ToastRenderStatusPayload,
} from '../shared/ipc'

contextBridge.exposeInMainWorld('toastBridge', {
  onInit(cb: (payload: ToastInitPayload) => void): void {
    ipcRenderer.on(IPC.toastInit, (_event, payload: ToastInitPayload) => cb(payload))
  },
  onRenderStatus(cb: (payload: ToastRenderStatusPayload) => void): void {
    ipcRenderer.on(IPC.toastRenderStatus, (_event, payload: ToastRenderStatusPayload) => cb(payload))
  },
  openFolder(): void {
    ipcRenderer.send(IPC.toastOpenFolder)
  },
  copyPath(): void {
    ipcRenderer.send(IPC.toastCopyPath)
  },
  createZip(): Promise<ToastCreateZipResult> {
    return ipcRenderer.invoke(IPC.toastCreateZip) as Promise<ToastCreateZipResult>
  },
  copyPrompt(): Promise<boolean> {
    return ipcRenderer.invoke(IPC.toastCopyPrompt) as Promise<boolean>
  },
  close(): void {
    ipcRenderer.send(IPC.toastClose)
  },
})
