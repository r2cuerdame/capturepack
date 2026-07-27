import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { CaptureReplayResultPayload, CaptureStartPayload } from '../shared/ipc'

contextBridge.exposeInMainWorld('captureBridge', {
  onStart(cb: (payload: CaptureStartPayload) => void): void {
    ipcRenderer.on(IPC.captureStart, (_event, payload: CaptureStartPayload) => cb(payload))
  },
  onRequestReplay(cb: (requestId: string) => void): void {
    ipcRenderer.on(IPC.captureRequestReplay, (_event, requestId: string) => cb(requestId))
  },
  sendReplayResult(payload: CaptureReplayResultPayload): void {
    ipcRenderer.send(IPC.captureReplayResult, payload)
  },
  sendError(message: string): void {
    ipcRenderer.send(IPC.captureError, message)
  },
})
