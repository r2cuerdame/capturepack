import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  CaptureFramesPayload,
  CaptureReadyPayload,
  CaptureReplayResultPayload,
  CaptureStartPayload,
  CaptureTickPayload,
} from '../shared/ipc'

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
  sendReady(payload: CaptureReadyPayload): void {
    ipcRenderer.send(IPC.captureReady, payload)
  },
  sendFrames(payload: CaptureFramesPayload): void {
    ipcRenderer.send(IPC.captureFrames, payload)
  },
  // One captured frame, announcing its own time (#105).
  sendTick(payload: CaptureTickPayload): void {
    ipcRenderer.send(IPC.captureTick, payload)
  },
  sendError(message: string): void {
    ipcRenderer.send(IPC.captureError, message)
  },
})
