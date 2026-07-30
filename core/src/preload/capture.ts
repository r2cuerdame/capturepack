import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  CaptureDxgiTimingReferencePayload,
  CaptureFramesPayload,
  CaptureNativeFallbackErrorPayload,
  CaptureNativeFallbackFramePayload,
  CaptureNativeFallbackRequest,
  CaptureNativeFallbackStartPayload,
  CaptureReadyPayload,
  CaptureReplayRequestPayload,
  CaptureReplayResumePayload,
  CaptureReplayResultPayload,
  CaptureStartPayload,
  CaptureTickPayload,
} from '../shared/ipc'

contextBridge.exposeInMainWorld('captureBridge', {
  onStart(cb: (payload: CaptureStartPayload) => void): void {
    ipcRenderer.on(IPC.captureStart, (_event, payload: CaptureStartPayload) => cb(payload))
  },
  onRequestReplay(cb: (payload: CaptureReplayRequestPayload) => void): void {
    ipcRenderer.on(
      IPC.captureRequestReplay,
      (_event, payload: CaptureReplayRequestPayload) => cb(payload),
    )
  },
  onResumeReplay(cb: (payload: CaptureReplayResumePayload) => void): void {
    ipcRenderer.on(
      IPC.captureResumeReplay,
      (_event, payload: CaptureReplayResumePayload) => cb(payload),
    )
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
  captureDxgiTimingReference(): Promise<CaptureDxgiTimingReferencePayload> {
    return ipcRenderer.invoke(IPC.captureDxgiTimingReference)
  },
  startNativeFallback(
    request: CaptureNativeFallbackRequest,
  ): Promise<CaptureNativeFallbackStartPayload> {
    return ipcRenderer.invoke(IPC.captureNativeFallbackStart, request)
  },
  onNativeFallbackFrame(
    cb: (payload: CaptureNativeFallbackFramePayload) => void,
  ): void {
    ipcRenderer.on(
      IPC.captureNativeFallbackFrame,
      (_event, payload: CaptureNativeFallbackFramePayload) => cb(payload),
    )
  },
  onNativeFallbackError(
    cb: (payload: CaptureNativeFallbackErrorPayload) => void,
  ): void {
    ipcRenderer.on(
      IPC.captureNativeFallbackError,
      (_event, payload: CaptureNativeFallbackErrorPayload) => cb(payload),
    )
  },
  stopNativeFallback(sessionId: string): void {
    ipcRenderer.send(IPC.captureNativeFallbackStop, sessionId)
  },
  ackNativeFallbackFrame(sessionId: string, sequence: number): void {
    ipcRenderer.send(
      IPC.captureNativeFallbackFrameAck,
      sessionId,
      sequence,
    )
  },
  presentedNativeFallbackFrame(sessionId: string, sequence: number): void {
    ipcRenderer.send(
      IPC.captureNativeFallbackFramePresented,
      sessionId,
      sequence,
    )
  },
})
