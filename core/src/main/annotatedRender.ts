// Background annotated-replay render (SPEC §7.2): after every save with a
// replay, a hidden BrowserWindow plays replay.webm into a canvas, draws the
// per-frame annotation overlays (blur -> border -> number badge -> text,
// lifetime-gated, GLOBAL display numbers, no editor controls), records the
// canvas, and returns webm bytes; main writes replay_annotated.webm into the
// pack folder and declares it in manifest.json. Failures are logged, never
// fatal — the pack stays valid without the annotated view.
//
// The SAME pass returns the annotated KEYFRAME stills (SPEC §7.3, GOAL
// "Annotated keyframes (LLM-first)") — one PNG per annotation state change,
// written into frames/ and declared as manifest.media.keyframes alongside
// replay_annotated. A pack with no replay has no video to render, so its single
// still comes from startKeyframeStill() below.
import { app, BrowserWindow, ipcMain } from 'electron'
import type { IpcMainEvent } from 'electron'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { IPC } from '../shared/ipc'
import type { RenderFramePayload, RenderResultPayload, RenderStartPayload } from '../shared/ipc'
import { keyframeFileName } from '../shared/keyframes'
import type { Annotation, ManifestKeyframe } from '../shared/types'
import { setManifestRenderOutputs, type PackHandle } from './exporter'

export interface AnnotatedRenderJob {
  replayWebm: Buffer
  annotations: Annotation[]
  width: number
  height: number
  fps: number
  replayDurationMs: number
}

/** A screenshot-only pack's single annotated still, drawn from snapshot.png. */
export interface KeyframeStillJob {
  snapshotPng: Buffer
  annotations: Annotation[]
  width: number
  height: number
}

// The render plays in real time; allow twice the replay plus startup slack
// before declaring the hidden window stuck.
const RENDER_TIMEOUT_SLACK_MS = 60_000
// A still job decodes one PNG and draws once — no playback, no recorder.
const STILL_RENDER_TIMEOUT_MS = 30_000

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
  const payload: RenderStartPayload = {
    replayWebm: toArrayBuffer(job.replayWebm),
    annotations: job.annotations,
    width: job.width,
    height: job.height,
    fps: job.fps,
    durationMs: job.replayDurationMs,
    // The annotated stills come out of this same pass (SPEC §7.3).
    keyframes: true,
  }
  const result = await runRenderWindow(payload, job.replayDurationMs * 2 + RENDER_TIMEOUT_SLACK_MS)
  if (result.webm === undefined) throw new Error('render window returned no video')
  await writeFile(path.join(handle.dirPath, 'replay_annotated.webm'), Buffer.from(result.webm))
  // The stills are the smaller half of this job: losing them must never cost
  // the annotated replay its declaration (SPEC §5.7 — keyframes are optional).
  let keyframes: ManifestKeyframe[] = []
  try {
    keyframes = await writeKeyframes(handle, result.frames ?? [])
  } catch (err) {
    console.error('capturepack: writing annotated keyframes failed:', errorMessage(err))
  }
  await setManifestRenderOutputs(handle, { replayAnnotated: true, keyframes })
}

/**
 * The ONE annotated still of a screenshot-only pack (SPEC §7.3): there is no
 * video to play, so the hidden window composites snapshot.png + the overlays
 * and hands back a single PNG.
 *
 * Deliberately NOT on the render lifecycle bus: 'rendering'/'done' there means
 * the annotated REPLAY (the save toast's status line, History's [Retry Render]),
 * and a pack without a replay has none. Fire-and-forget, failures logged only —
 * the pack is already complete and valid without frames/.
 */
export function startKeyframeStill(handle: PackHandle, job: KeyframeStillJob): void {
  void renderKeyframeStill(handle, job).catch((err) => {
    console.error('capturepack: annotated keyframe render failed:', errorMessage(err))
  })
}

async function renderKeyframeStill(handle: PackHandle, job: KeyframeStillJob): Promise<void> {
  const payload: RenderStartPayload = {
    // No video: the still job draws snapshot.png instead.
    replayWebm: null,
    snapshotPng: toArrayBuffer(job.snapshotPng),
    annotations: job.annotations,
    width: job.width,
    height: job.height,
    fps: 1, // unused without a recorder
    durationMs: 0,
    keyframes: true,
  }
  const result = await runRenderWindow(payload, STILL_RENDER_TIMEOUT_MS)
  const keyframes = await writeKeyframes(handle, result.frames ?? [])
  if (keyframes.length === 0) throw new Error('still render produced no keyframe')
  await setManifestRenderOutputs(handle, { replayAnnotated: false, keyframes })
}

/**
 * Writes frames/ from scratch and returns the manifest declarations.
 * Stale stills never outlive the render that replaced them: the directory is
 * removed first (the same rule replay_annotated.webm follows), so a re-edit or
 * a History re-render can only ever leave the CURRENT set behind.
 */
async function writeKeyframes(
  handle: PackHandle,
  frames: readonly RenderFramePayload[],
): Promise<ManifestKeyframe[]> {
  const framesDir = path.join(handle.dirPath, 'frames')
  await rm(framesDir, { recursive: true, force: true })
  if (frames.length === 0) return []
  await mkdir(framesDir, { recursive: true })
  const declared: ManifestKeyframe[] = []
  // Order is the render's own ascending order; NN is the 1-based position in
  // the surviving list, so the numbering stays contiguous even if a still
  // failed to encode.
  for (const [i, frame] of frames.entries()) {
    const t_ms = Math.max(0, Math.round(frame.t_ms))
    const file = keyframeFileName(i + 1, t_ms)
    await writeFile(path.join(handle.dirPath, file), Buffer.from(frame.png))
    declared.push({ file, t_ms })
  }
  return declared
}

export interface TrimRenderJob {
  replayWebm: Buffer
  width: number
  height: number
  fps: number
  // Wall-clock duration of the SOURCE replay (manifest replay_duration_ms) —
  // the lifetime clock cap, kept for pipeline parity (the overlay set is empty)
  sourceDurationMs: number
  // Kept range on the source replay clock; trimEndMs null = to the video end
  trimStartMs: number
  trimEndMs: number | null
}

/**
 * Plain-trim render (GOAL "Replay Trim"): the SAME hidden render pipeline with
 * an EMPTY overlay set over an arbitrary [start, end] range, returning the
 * re-encoded trimmed replay bytes for the session to write as replay.webm.
 * Unlike startAnnotatedRender this is a FOREGROUND save step: the caller
 * awaits it and reports it on the save toast ("Trimming replay…"). It never
 * touches the pack folder, the manifest, or the render lifecycle bus — those
 * track replay_annotated renders only.
 */
export async function renderTrimmedReplay(job: TrimRenderJob): Promise<Buffer> {
  const endMs = job.trimEndMs ?? job.sourceDurationMs
  const lengthMs = Math.max(0, endMs - job.trimStartMs)
  const payload: RenderStartPayload = {
    replayWebm: toArrayBuffer(job.replayWebm),
    annotations: [],
    width: job.width,
    height: job.height,
    fps: job.fps,
    durationMs: job.sourceDurationMs,
    trimStartMs: job.trimStartMs,
  }
  if (job.trimEndMs !== null) payload.trimEndMs = job.trimEndMs
  // The render plays only the kept range in real time. No keyframes: the trim
  // job draws no overlays, and the annotated render that follows it produces
  // the stills from the trimmed bytes.
  const result = await runRenderWindow(payload, lengthMs * 2 + RENDER_TIMEOUT_SLACK_MS)
  if (result.webm === undefined) throw new Error('render window returned no video')
  return Buffer.from(result.webm)
}

/** Opens the hidden render window, runs one job, and returns its result. */
async function runRenderWindow(
  payload: RenderStartPayload,
  timeoutMs: number,
): Promise<RenderResultPayload> {
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
    const result = await awaitRenderResult(win, payload, timeoutMs)
    if (!result.ok) throw new Error(result.error ?? 'render window reported a failure')
    return result
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
