// Preload for the hidden annotated-replay render window: narrow, typed bridge.
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { RenderResultPayload, RenderStartPayload } from '../shared/ipc'

contextBridge.exposeInMainWorld('renderBridge', {
  onStart(cb: (payload: RenderStartPayload) => void): void {
    ipcRenderer.on(IPC.renderStart, (_event, payload: RenderStartPayload) => cb(payload))
  },
  result(payload: RenderResultPayload): void {
    ipcRenderer.send(IPC.renderResult, payload)
  },
})
