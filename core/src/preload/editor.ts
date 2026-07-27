// Preload for the editor window: narrow, typed bridge over the IPC contract.
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { EditorAnnotationAddedPayload, EditorExportPayload, EditorInitPayload } from '../shared/ipc'
import type { EditorWindowMode } from '../shared/types'

contextBridge.exposeInMainWorld('editorBridge', {
  onInit(cb: (payload: EditorInitPayload) => void): void {
    ipcRenderer.on(IPC.editorInit, (_event, payload: EditorInitPayload) => cb(payload))
  },
  export(payload: EditorExportPayload): void {
    ipcRenderer.send(IPC.editorExport, payload)
  },
  // Edit mode only: write the edited state into a NEW pack folder.
  saveAsNew(payload: EditorExportPayload): void {
    ipcRenderer.send(IPC.editorSaveAsNew, payload)
  },
  cancel(): void {
    ipcRenderer.send(IPC.editorCancel)
  },
  annotationAdded(payload: EditorAnnotationAddedPayload): void {
    ipcRenderer.send(IPC.editorAnnotationAdded, payload)
  },
  // Editor Window Mode (GOAL): ask main to put the window into `mode`. Absolute,
  // never a toggle — main applies it idempotently and pushes back what stuck.
  setWindowMode(mode: EditorWindowMode): void {
    ipcRenderer.send(IPC.editorSetWindowMode, mode)
  },
  onWindowMode(cb: (mode: EditorWindowMode) => void): void {
    ipcRenderer.on(IPC.editorWindowMode, (_event, mode: EditorWindowMode) => cb(mode))
  },
})
