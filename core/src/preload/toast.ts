// Preload for the save-complete toast window: narrow, typed bridge.
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  ActionRetryResult,
  ToastActionResultsPayload,
  ToastInitPayload,
  ToastRenderStatusPayload,
} from '../shared/ipc'
import type { ActionResult } from '../shared/actions'

contextBridge.exposeInMainWorld('toastBridge', {
  onInit(cb: (payload: ToastInitPayload) => void): void {
    ipcRenderer.on(IPC.toastInit, (_event, payload: ToastInitPayload) => cb(payload))
  },
  onRenderStatus(cb: (payload: ToastRenderStatusPayload) => void): void {
    ipcRenderer.on(IPC.toastRenderStatus, (_event, payload: ToastRenderStatusPayload) => cb(payload))
  },
  onActionResults(cb: (payload: ToastActionResultsPayload) => void): void {
    ipcRenderer.on(IPC.toastActionResults, (_event, payload: ToastActionResultsPayload) => cb(payload))
  },
  actionRetry(configId: string): Promise<ActionRetryResult> {
    return ipcRenderer.invoke(IPC.toastActionRetry, configId) as Promise<ActionRetryResult>
  },
  actionResults(): Promise<ActionResult[]> {
    return ipcRenderer.invoke(IPC.toastActionResults) as Promise<ActionResult[]>
  },
  openFolder(): void {
    ipcRenderer.send(IPC.toastOpenFolder)
  },
  copyPath(): void {
    ipcRenderer.send(IPC.toastCopyPath)
  },
  copyPrompt(): Promise<boolean> {
    return ipcRenderer.invoke(IPC.toastCopyPrompt) as Promise<boolean>
  },
  close(): void {
    ipcRenderer.send(IPC.toastClose)
  },
})
