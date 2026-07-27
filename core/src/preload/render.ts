// Preload for the hidden annotated-replay render window: narrow, typed bridge.
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { RenderFramePayload, RenderResultPayload, RenderStartPayload } from '../shared/ipc'

contextBridge.exposeInMainWorld('renderBridge', {
  onStart(cb: (payload: RenderStartPayload) => void): void {
    ipcRenderer.on(IPC.renderStart, (_event, payload: RenderStartPayload) => cb(payload))
  },
  // One annotated still, handed over as soon as it is encoded so the renderer
  // never holds the whole set (SPEC §7.3).
  frame(payload: RenderFramePayload): void {
    ipcRenderer.send(IPC.renderFrame, payload)
  },
  result(payload: RenderResultPayload): void {
    ipcRenderer.send(IPC.renderResult, payload)
  },
})
