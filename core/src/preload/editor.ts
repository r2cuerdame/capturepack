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
import type { ObjectTrackRequest, ObjectTrackResult } from '../shared/ipc'
import type { EditorWindowMode } from '../shared/types'
import { replayOnce } from './replayOnce'

// Installed before the page module runs. `ready-to-show` can precede the
// renderer's `onInit()` subscription; without this mailbox that race leaves a
// visible but completely blank editor with the native caption buttons sitting
// over the uninitialized toolbar.
const editorInit = replayOnce<EditorInitPayload>()
ipcRenderer.on(IPC.editorInit, (_event, payload: EditorInitPayload) => {
  editorInit.push(payload)
})

contextBridge.exposeInMainWorld('editorBridge', {
  onInit(cb: (payload: EditorInitPayload) => void): void {
    editorInit.subscribe(cb)
  },
  initialized(): void {
    ipcRenderer.send(IPC.editorInitialized)
  },
  initializationFailed(message: string): void {
    ipcRenderer.send(IPC.editorInitFailed, message.slice(0, 2_000))
  },
  onCloseRequested(cb: () => void): void {
    ipcRenderer.on(IPC.editorCloseRequested, () => cb())
  },
  closePromptShown(): void {
    ipcRenderer.send(IPC.editorClosePromptShown)
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
  // WHERE A PICKED OBJECT WENT (#86). Asked ONCE, when a box is picked — the
  // answer is a path, and the renderer interpolates over it, so a box that
  // follows its object costs nothing per scrub tick.
  requestObjectTrack(request: ObjectTrackRequest): Promise<ObjectTrackResult | null> {
    return ipcRenderer.invoke(IPC.contextRequestTrack, request) as Promise<ObjectTrackResult | null>
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
  // First-run tutorial (GOAL "First-Run Tutorial"): remember whether it may
  // appear again. Absolute state, never a toggle.
  setTutorial(show: boolean): void {
    ipcRenderer.send(IPC.editorSetTutorial, show)
  },
})
