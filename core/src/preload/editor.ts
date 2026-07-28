// Preload for the editor window: narrow, typed bridge over the IPC contract.
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  ContextFrameRequest,
  EditorAnnotationAddedPayload,
  EditorExportPayload,
  EditorInitPayload,
} from '../shared/ipc'
import type { ContextFrame } from '../shared/context/protocol'
import type { EditorWindowMode } from '../shared/types'

contextBridge.exposeInMainWorld('editorBridge', {
  onInit(cb: (payload: EditorInitPayload) => void): void {
    ipcRenderer.on(IPC.editorInit, (_event, payload: EditorInitPayload) => cb(payload))
  },
  // OBJECT PICKING FOLLOWS TIME (#66): the candidate set at one scrub position.
  // Asked when the scrub SETTLES, never per pointer move — the editor indexes
  // the answer and hovers over its own index, which is what keeps hovering free.
  requestContextFrame(request: ContextFrameRequest): Promise<ContextFrame | null> {
    return ipcRenderer.invoke(IPC.contextRequestFrame, request) as Promise<ContextFrame | null>
  },
  // A frame Core pushed on its own: a provider that answered late, or the
  // capture-instant observation settling after the editor opened. Without this
  // bridge that answer would be dropped and picking would stay dead for the
  // session.
  onContextFrame(cb: (frame: ContextFrame) => void): void {
    ipcRenderer.on(IPC.contextFrame, (_event, frame: ContextFrame) => cb(frame))
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
  // Shortcut sheet (GOAL "Editor Chrome"): remember the `?` / F1 toggle in
  // settings.showShortcutOverlay. Absolute state, never a toggle.
  setShortcutOverlay(show: boolean): void {
    ipcRenderer.send(IPC.editorSetShortcutOverlay, show)
  },
})
