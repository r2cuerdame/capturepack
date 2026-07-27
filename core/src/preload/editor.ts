// Preload for the editor window: narrow, typed bridge over the IPC contract.
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { EditorAnnotationAddedPayload, EditorExportPayload, EditorInitPayload } from '../shared/ipc'

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
})
