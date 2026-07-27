// Background annotated-replay render (SPEC §7.2): after every save with a
// replay, a hidden BrowserWindow plays replay.webm into a canvas, draws the
// per-frame annotation overlays (blur -> border -> number badge -> text,
// lifetime-gated, GLOBAL display numbers, no editor controls), records the
// canvas, and returns webm bytes; main writes replay_annotated.webm into the
// pack folder and declares it in manifest.json. Failures are logged, never
// fatal — the pack stays valid without the annotated view.
import { app, BrowserWindow, ipcMain } from 'electron'
import type { IpcMainEvent } from 'electron'
import { writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { IPC } from '../shared/ipc'
import type { RenderResultPayload, RenderStartPayload } from '../shared/ipc'
import type { Annotation } from '../shared/types'
import { setManifestReplayAnnotated, type PackHandle } from './exporter'

export interface AnnotatedRenderJob {
  replayWebm: Buffer
  annotations: Annotation[]
  width: number
  height: number
  fps: number
  replayDurationMs: number
}

// The render plays in real time; allow twice the replay plus startup slack
// before declaring the hidden window stuck.
const RENDER_TIMEOUT_SLACK_MS = 60_000

// EVERY render's lifecycle (fresh-capture save, re-edit save, History
// re-render), observable in one place: the History window subscribes so a
// save-started render shows as "Rendering…" instead of an enabled
// [Retry Render], and isRenderInFlight lets it join a running render rather
// than stack a second hidden render window for the same pack.
export type RenderLifecycleState = 'rendering' | 'done' | 'failed'
type RenderStateListener = (dirPath: string, state: RenderLifecycleState) => void
const renderStateListeners = new Set<RenderStateListener>()
// In-flight render count per resolved pack dir (concurrent renders of one
// pack are possible when a re-edit save races an older render).
const inFlight = new Map<string, number>()

/** Subscribe to every render's start/terminal state. Returns unsubscribe. */
export function onRenderStateChange(listener: RenderStateListener): () => void {
  renderStateListeners.add(listener)
  return () => {
    renderStateListeners.delete(listener)
  }
}

/** True while any render for this pack folder is still running. */
export function isRenderInFlight(dirPath: string): boolean {
  return (inFlight.get(path.resolve(dirPath)) ?? 0) > 0
}

function emitRenderState(dirPath: string, state: RenderLifecycleState): void {
  for (const listener of [...renderStateListeners]) {
    try {
      listener(dirPath, state)
    } catch (err) {
      console.error('capturepack: render state listener failed:', errorMessage(err))
    }
  }
}

/**
 * Fire-and-forget: never blocks the save toast. `onDone` reports the terminal
 * state so the toast can flip its "rendering annotated replay…" status line.
 */
export function startAnnotatedRender(
  handle: PackHandle,
  job: AnnotatedRenderJob,
  onDone: (state: 'done' | 'failed') => void,
): void {
  const key = path.resolve(handle.dirPath)
  inFlight.set(key, (inFlight.get(key) ?? 0) + 1)
  emitRenderState(handle.dirPath, 'rendering')
  const finish = (state: 'done' | 'failed'): void => {
    const count = (inFlight.get(key) ?? 1) - 1
    if (count <= 0) inFlight.delete(key)
    else inFlight.set(key, count)
    emitRenderState(handle.dirPath, state)
    onDone(state)
  }
  void renderAnnotatedReplay(handle, job)
    .then(() => finish('done'))
    .catch((err) => {
      console.error('capturepack: annotated replay render failed:', errorMessage(err))
      finish('failed')
    })
}

async function renderAnnotatedReplay(handle: PackHandle, job: AnnotatedRenderJob): Promise<void> {
  const win = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist', 'preload', 'render.js'),
      // A hidden window throttles rAF/timers by default, which would stall the
      // realtime canvas capture — the whole render runs unseen.
      backgroundThrottling: false,
    },
  })
  try {
    await win.loadFile(path.join(app.getAppPath(), 'dist', 'renderer', 'render', 'render.html'))
    const payload: RenderStartPayload = {
      replayWebm: toArrayBuffer(job.replayWebm),
      annotations: job.annotations,
      width: job.width,
      height: job.height,
      fps: job.fps,
      durationMs: job.replayDurationMs,
    }
    const result = await awaitRenderResult(win, payload, job.replayDurationMs * 2 + RENDER_TIMEOUT_SLACK_MS)
    if (!result.ok || result.webm === undefined) {
      throw new Error(result.error ?? 'render window returned no video')
    }
    await writeFile(path.join(handle.dirPath, 'replay_annotated.webm'), Buffer.from(result.webm))
    await setManifestReplayAnnotated(handle)
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

function awaitRenderResult(
  win: BrowserWindow,
  payload: RenderStartPayload,
  timeoutMs: number,
): Promise<RenderResultPayload> {
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ipcMain.removeListener(IPC.renderResult, onResult)
      win.removeListener('closed', onClosed)
      fn()
    }
    const onResult = (event: IpcMainEvent, result: RenderResultPayload): void => {
      if (win.isDestroyed() || event.sender !== win.webContents) return
      settle(() => resolve(result))
    }
    const onClosed = (): void => settle(() => reject(new Error('render window closed prematurely')))
    const timer = setTimeout(
      () => settle(() => reject(new Error(`render timed out after ${timeoutMs} ms`))),
      timeoutMs,
    )
    ipcMain.on(IPC.renderResult, onResult)
    win.on('closed', onClosed)
    win.webContents.send(IPC.renderStart, payload)
  })
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  const ab = new ArrayBuffer(buf.byteLength)
  new Uint8Array(ab).set(buf)
  return ab
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
