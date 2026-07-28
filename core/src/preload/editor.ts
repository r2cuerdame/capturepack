// Preload for the editor window: narrow, typed bridge over the IPC contract.
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  EditorAnnotationAddedPayload,
  EditorExportPayload,
  EditorInitPayload,
  EditorUiaObjectsPayload,
} from '../shared/ipc'
import type { EditorWindowMode } from '../shared/types'

contextBridge.exposeInMainWorld('editorBridge', {
  onInit(cb: (payload: EditorInitPayload) => void): void {
    ipcRenderer.on(IPC.editorInit, (_event, payload: EditorInitPayload) => cb(payload))
  },
  // Static object picking (GOAL): the capture-instant object dump, delivered
  // LATE. The dump is budgeted and killed independently of the editor window, so
  // on a slow machine it settles a few hundred ms after the editor is on screen;
  // without this bridge that payload would be dropped and picking would stay
  // dead for the whole session (the editor opens with empty lists).
  onUiaObjects(cb: (payload: EditorUiaObjectsPayload) => void): void {
    ipcRenderer.on(IPC.editorUiaObjects, (_event, payload: EditorUiaObjectsPayload) => cb(payload))
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
