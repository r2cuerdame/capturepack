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
import type { Language } from '../shared/i18n'
import { displayAnnotatedName, displayFramesDir, keyframeFileName } from '../shared/keyframes'
import type { Annotation, ManifestKeyframe } from '../shared/types'
import type { AuthoredMotionSpace } from '../shared/track'
import {
  BoundedBackgroundMediaQueue,
  copyBufferResponsively,
} from './backgroundMediaQueue'
import { refreshPackDocs, setManifestRenderOutputs, type PackHandle } from './exporter'
import { beginPackOperation } from './packOperations'
import { PackRenderBatchTracker, type RenderBatchFinish } from './renderBatch'

export interface AnnotatedRenderJob {
  replayWebm: Buffer
  replayMimeType: string
  annotations: Annotation[]
  motionSpace?: AuthoredMotionSpace
  // GLOBAL display numbers (SPEC §8.5) over the pack's WHOLE annotation set,
  // as annotation_id -> number pairs. `annotations` above is this display's
  // subset, so the renderer must not derive the numbering from it — see
  // RenderStartPayload.displayNumbers.
  displayNumbers?: Array<[string, number]>
  // The pack's focused display index — what an ABSENT `display` means, here and
  // on an annotation (SPEC §8.8). Only needed once a box can follow its object
  // onto another screen (#86); absent in a single-display pack.
  focusedDisplay?: number
  width: number
  height: number
  fps: number
  replayDurationMs: number
  // Pack document language: the documents are REGENERATED once the stills are
  // declared, so their image links describe what the render actually wrote.
  docLanguage?: Language
  // WHICH captured display this job renders (GOAL "Multi-Monitor Support").
  // Absent = the focused display: replay_annotated.webm + frames/, declared as
  // the top-level media. A 1-based index renders THAT display's own boxes into
  // replay_annotated-d<N>.webm + frames-d<N>/, declared inside its
  // media.displays entry — a box belongs to the screen it was drawn on, so a
  // display's rendering may only ever carry its own.
  display?: number
}

/** A pack's (or one display's) single annotated still, drawn from a snapshot. */
export interface KeyframeStillJob {
  snapshotPng: Buffer
  annotations: Annotation[]
  motionSpace?: AuthoredMotionSpace
  /** Same rule as AnnotatedRenderJob.displayNumbers. */
  displayNumbers?: Array<[string, number]>
  /** Same rule as AnnotatedRenderJob.focusedDisplay. */
  focusedDisplay?: number
  width: number
  height: number
  docLanguage?: Language
  // Same rule as AnnotatedRenderJob.display.
  display?: number
}

export interface KeyframeStillCallbacks {
  /** Runs only after the final PNG and manifest declaration are durable. */
  onRendered?: (png: Buffer) => Promise<void> | void
  /** Reports a missing final image without relabelling the already-saved pack. */
  onFailed?: (error: Error) => Promise<void> | void
}

// The render plays in real time; allow twice the replay plus startup slack
// before declaring the hidden window stuck.
const RENDER_TIMEOUT_SLACK_MS = 60_000
// A still job decodes one PNG and draws once — no playback, no recorder.
const STILL_RENDER_TIMEOUT_MS = 30_000

// EVERY render's aggregate lifecycle (focused replay, non-focused displays and
// still-only jobs), observable in one place. A pack emits `rendering` on the
// first job and one terminal state only after the last job finishes, so History
// and --await-render cannot mistake a focused render for the whole pack.
export type RenderLifecycleState = 'rendering' | 'done' | 'failed'
// `ratio` rides along on the 'rendering' state so a subscriber can draw a
// progress bar without a second channel to keep in sync with this one. It is
// undefined while a render is queued or has no measurable playhead — an
// indeterminate bar is the honest picture there, and a filled fraction nobody
// measured is a lie the eye believes.
type RenderStateListener = (
  dirPath: string,
  state: RenderLifecycleState,
  ratio?: number,
) => void
const renderStateListeners = new Set<RenderStateListener>()
// ---------------------------------------------------------------------------
// The render job queue
//
// Every hidden render window is a full Chromium renderer doing real-time video
// decode + VP9 encode + full-resolution PNG encodes, and it competes with the
// always-on per-display recorders that must never stutter. So background
// renders run ONE AT A TIME, globally: History's [Retry Render] on ten cards
// queues ten jobs instead of spawning ten render processes, and a burst of
// saves cannot fan out either.
//
// Serializing globally also makes the frames/ directory swap safe by
// construction: writeKeyframes() removes frames/ and rewrites it, so two
// renders of the SAME pack overlapping could leave the manifest declaring
// files the other render deleted.
//
// Plain-trim renders use this queue too. Exact-length cutting is background
// work, and serializing it with annotated renders prevents a multi-display save
// from spawning one extra real-time encoder per screen.
// ---------------------------------------------------------------------------
const renderQueue = new BoundedBackgroundMediaQueue(1)

function enqueueRender<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return renderQueue.enqueue(run)
}

// Quitting is cancellation, not a render failure that should rewrite a pack.
// Queued buffers are released immediately and the active hidden window is
// destroyed through its AbortSignal.
app.on('before-quit', () => {
  renderQueue.shutdown()
})

/** Subscribe to every render's start/terminal state. Returns unsubscribe. */
export function onRenderStateChange(listener: RenderStateListener): () => void {
  renderStateListeners.add(listener)
  return () => {
    renderStateListeners.delete(listener)
  }
}

/** True while any render for this pack folder is still running. */
export function isRenderInFlight(dirPath: string): boolean {
  return renderBatches.isInFlight(dirPath)
}

function emitRenderState(dirPath: string, state: RenderLifecycleState, ratio?: number): void {
  for (const listener of [...renderStateListeners]) {
    try {
      listener(dirPath, state, ratio)
    } catch (err) {
      console.error('capturepack: render state listener failed:', errorMessage(err))
    }
  }
}

const renderBatches = new PackRenderBatchTracker(beginPackOperation, emitRenderState)

/**
 * Joins one pack-wide render batch and returns its idempotent terminal hook.
 * A null result means a sibling mutation already owns the pack; rendering must
 * fail closed instead of waiting and later writing through a renamed/deleted
 * path.
 */
function beginTrackedRender(
  dirPath: string,
): RenderBatchFinish | null {
  return renderBatches.begin(dirPath)
}

function reportBusyRender(dirPath: string, kind: string): Error {
  const error = new Error(`pack operation already active before ${kind}`)
  console.error(`capturepack: ${kind} did not start:`, error.message)
  return error
}

/**
 * Fire-and-forget: never blocks the save toast. `onDone` reports the terminal
 * state so the toast can flip its "rendering annotated replay…" status line.
 */
export function startAnnotatedRender(
  handle: PackHandle,
  job: AnnotatedRenderJob,
  onDone: (state: 'done' | 'failed') => void,
  onProgress?: (ratio: number) => void,
): void {
  const finishTracking = beginTrackedRender(handle.dirPath)
  if (finishTracking === null) {
    reportBusyRender(handle.dirPath, 'annotated replay render')
    try {
      onDone('failed')
    } catch (err) {
      console.error('capturepack: annotated replay completion callback failed:', errorMessage(err))
    }
    return
  }
  let finished = false
  const finish = (state: 'done' | 'failed'): void => {
    if (finished) return
    finished = true
    finishTracking(state)
    try {
      onDone(state)
    } catch (err) {
      console.error('capturepack: annotated replay completion callback failed:', errorMessage(err))
    }
  }
  // Progress goes BOTH ways: to the caller that asked for it (the save toast)
  // and to every lifecycle subscriber (the History window), so closing the
  // toast mid-render does not lose the only view of how far it got.
  const relay = (ratio: number): void => {
    renderBatches.progress(handle.dirPath, ratio)
    onProgress?.(ratio)
  }
  void renderAnnotatedReplay(handle, job, relay)
    .then(() => finish('done'))
    .catch((err) => {
      console.error('capturepack: annotated replay render failed:', errorMessage(err))
      finish('failed')
    })
}

async function renderAnnotatedReplay(
  handle: PackHandle,
  job: AnnotatedRenderJob,
  onProgress?: (ratio: number) => void,
): Promise<void> {
  // The render AND its write phase are one queued unit: writeKeyframes()
  // removes frames/ and rewrites it, so another render of the same pack landing
  // between the writes and the declaration would leave the manifest pointing at
  // files that no longer exist.
  const video =
    job.display === undefined ? 'replay_annotated.webm' : displayAnnotatedName(job.display)
  const framesDir = job.display === undefined ? 'frames' : displayFramesDir(job.display)
  await enqueueRender(async (signal) => {
    // Allocate/copy only after this job owns the single media lane. Queued
    // displays retain their source Buffer but create neither an ArrayBuffer nor
    // a hidden Chromium renderer until every earlier job has released both.
    const payload: RenderStartPayload = {
      replayWebm: await copyBufferResponsively(job.replayWebm, signal),
      replayMimeType: job.replayMimeType,
      annotations: job.annotations,
      ...(job.motionSpace === undefined ? {} : { motionSpace: job.motionSpace }),
      ...(job.displayNumbers === undefined ? {} : { displayNumbers: job.displayNumbers }),
      ...(job.display === undefined ? {} : { display: job.display }),
      ...(job.focusedDisplay === undefined ? {} : { focusedDisplay: job.focusedDisplay }),
      width: job.width,
      height: job.height,
      fps: job.fps,
      durationMs: job.replayDurationMs,
      // The annotated stills come out of this same pass (SPEC §7.3).
      keyframes: true,
    }
    const { result, frames } = await runRenderWindow(
      payload,
      job.replayDurationMs * 2 + RENDER_TIMEOUT_SLACK_MS,
      onProgress,
      signal,
    )
    throwIfRenderAborted(signal)
    if (result.webm === undefined) throw new Error('render window returned no video')
    await writeFile(path.join(handle.dirPath, video), Buffer.from(result.webm))
    throwIfRenderAborted(signal)
    // The stills are the smaller half of this job: losing them must never cost
    // the annotated replay its declaration (SPEC §5.7 — keyframes are optional).
    let keyframes: ManifestKeyframe[] = []
    try {
      keyframes = await writeKeyframes(handle, frames, framesDir)
    } catch (err) {
      console.error('capturepack: writing annotated keyframes failed:', errorMessage(err))
    }
    await setManifestRenderOutputs(handle, {
      replayAnnotated: true,
      keyframes,
      ...(job.display === undefined ? {} : { display: job.display }),
    })
    await refreshDocs(handle, job.docLanguage)
  })
}

/**
 * One NON-FOCUSED display's annotated replay + stills (GOAL "Multi-Monitor
 * Support"). It joins the pack's aggregate lifecycle and operation lock even
 * though its own progress is not shown: Share Copy and --await-render must wait
 * for every display that can still change the manifest/keyframes. Failures are
 * logged; the source pack remains valid without this optional derived view.
 */
export function startDisplayRender(handle: PackHandle, job: AnnotatedRenderJob): void {
  const finishTracking = beginTrackedRender(handle.dirPath)
  if (finishTracking === null) {
    reportBusyRender(handle.dirPath, `annotated replay render for display ${job.display ?? 0}`)
    return
  }
  void renderAnnotatedReplay(handle, job).then(
    () => finishTracking('done'),
    (err: unknown) => {
      console.error(
        `capturepack: annotated replay render for display ${job.display ?? 0} failed:`,
        errorMessage(err),
      )
      finishTracking('failed')
    },
  )
}

/**
 * Rewrites report.md / README.md / skills from the manifest the render just
 * declared: the documents were generated BEFORE the render, from the predicted
 * filenames, and a still that failed to encode renumbers the survivors. Never
 * fatal — the pack is complete and valid either way.
 */
async function refreshDocs(handle: PackHandle, docLanguage: Language | undefined): Promise<void> {
  try {
    await refreshPackDocs(handle.dirPath, docLanguage)
  } catch (err) {
    console.error('capturepack: refreshing the pack documents failed:', errorMessage(err))
  }
}

/**
 * The ONE annotated still of a screenshot-only pack (SPEC §7.3): there is no
 * video to play, so the hidden window composites snapshot.png + the overlays
 * and hands back a single PNG.
 *
 * It joins the same aggregate lifecycle and operation lock as video renders:
 * this job writes frames/ and the manifest too, so Share Copy must not plan or
 * publish while it is queued. Fire-and-forget; the source pack remains valid
 * if the optional derived still fails.
 */
export function startKeyframeStill(
  handle: PackHandle,
  job: KeyframeStillJob,
  callbacks: KeyframeStillCallbacks = {},
): void {
  const finishTracking = beginTrackedRender(handle.dirPath)
  if (finishTracking === null) {
    const error = reportBusyRender(handle.dirPath, 'annotated keyframe render')
    void Promise.resolve().then(() => callbacks.onFailed?.(error)).catch((callbackError: unknown) => {
      console.error(
        'capturepack: annotated keyframe failure action failed:',
        errorMessage(callbackError),
      )
    })
    return
  }
  void renderKeyframeStill(handle, job)
    .then(async (renderedPng) => {
      finishTracking('done')
      try {
        await callbacks.onRendered?.(renderedPng)
      } catch (err) {
        console.error('capturepack: annotated keyframe post-save action failed:', errorMessage(err))
      }
    })
    .catch(async (err) => {
      finishTracking('failed')
      console.error('capturepack: annotated keyframe render failed:', errorMessage(err))
      try {
        await callbacks.onFailed?.(
          err instanceof Error ? err : new Error(errorMessage(err)),
        )
      } catch (callbackError) {
        console.error(
          'capturepack: annotated keyframe failure action failed:',
          errorMessage(callbackError),
        )
      }
    })
}

async function renderKeyframeStill(handle: PackHandle, job: KeyframeStillJob): Promise<Buffer> {
  const framesDir = job.display === undefined ? 'frames' : displayFramesDir(job.display)
  return await enqueueRender(async (signal) => {
    const payload: RenderStartPayload = {
      // No video: the still job draws snapshot.png instead.
      replayWebm: null,
      snapshotPng: await copyBufferResponsively(job.snapshotPng, signal),
      annotations: job.annotations,
      ...(job.motionSpace === undefined ? {} : { motionSpace: job.motionSpace }),
      ...(job.displayNumbers === undefined ? {} : { displayNumbers: job.displayNumbers }),
      ...(job.display === undefined ? {} : { display: job.display }),
      ...(job.focusedDisplay === undefined ? {} : { focusedDisplay: job.focusedDisplay }),
      width: job.width,
      height: job.height,
      fps: 1, // unused without a recorder
      durationMs: 0,
      keyframes: true,
    }
    const { frames } = await runRenderWindow(
      payload,
      STILL_RENDER_TIMEOUT_MS,
      undefined,
      signal,
    )
    throwIfRenderAborted(signal)
    const keyframes = await writeKeyframes(handle, frames, framesDir)
    if (keyframes.length === 0) throw new Error('still render produced no keyframe')
    await setManifestRenderOutputs(handle, {
      replayAnnotated: false,
      keyframes,
      ...(job.display === undefined ? {} : { display: job.display }),
    })
    await refreshDocs(handle, job.docLanguage)
    const rendered = frames[0]
    if (rendered === undefined) throw new Error('still render produced no final image')
    return Buffer.from(rendered.png)
  })
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
  dir: string,
): Promise<ManifestKeyframe[]> {
  const framesDir = path.join(handle.dirPath, dir)
  await rm(framesDir, { recursive: true, force: true })
  if (frames.length === 0) return []
  await mkdir(framesDir, { recursive: true })
  const declared: ManifestKeyframe[] = []
  // Order is the render's own ascending order; NN is the 1-based position in
  // the surviving list, so the numbering stays contiguous even if a still
  // failed to encode.
  for (const [i, frame] of frames.entries()) {
    const t_ms = Math.max(0, Math.round(frame.t_ms))
    const file = keyframeFileName(i + 1, t_ms, dir)
    const png = Buffer.from(frame.png)
    await writeFile(path.join(handle.dirPath, file), png)
    // Read back from the bytes just written, not from the job's requested size:
    // the render adds a label gutter below the source frame (#133), so the two
    // legitimately differ and only the file knows by how much.
    const size = pngSize(png)
    declared.push({ file, t_ms, ...(size === null ? {} : size) })
  }
  return declared
}

/**
 * A PNG's declared dimensions, straight out of its IHDR.
 *
 * Eight-byte signature, then the first chunk, which a PNG REQUIRES to be IHDR:
 * 4 length + 4 type + width + height. Cheaper and more honest than trusting the
 * size the render was asked for — the written file is what a reader will open.
 */
function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || png.toString('ascii', 12, 16) !== 'IHDR') return null
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  return width > 0 && height > 0 ? { width, height } : null
}

export interface TrimRenderJob {
  replayWebm: Buffer
  replayMimeType: string
  width: number
  height: number
  fps: number
  // Wall-clock duration of the SOURCE replay (manifest replay_duration_ms) —
  // the lifetime clock cap, kept for pipeline parity (the overlay set is empty)
  sourceDurationMs: number
  // Kept range on the source replay clock; trimEndMs null = to the video end
  trimStartMs: number
  trimEndMs: number | null
  /** Container to re-encode into when the encoder supports it (#113). */
  preferMimeType?: string
}

/**
 * Plain-trim render (GOAL "Replay Trim"): the SAME hidden render pipeline with
 * an EMPTY overlay set over an arbitrary [start, end] range, returning the
 * re-encoded trimmed replay bytes for the session to write as replay.webm.
 * It never touches the pack folder, the manifest, or the render lifecycle bus;
 * callers run it in their background finalization and then atomically update
 * the replay declaration and clock data together.
 */
export async function renderTrimmedReplay(
  job: TrimRenderJob,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const endMs = job.trimEndMs ?? job.sourceDurationMs
  const lengthMs = Math.max(0, endMs - job.trimStartMs)
  // The render plays only the kept range in real time. No keyframes: the trim
  // job draws no overlays, and the annotated render that follows it produces
  // the stills from the trimmed bytes.
  const { result } = await enqueueRender(async (signal) => {
    const payload: RenderStartPayload = {
      replayWebm: await copyBufferResponsively(job.replayWebm, signal),
      replayMimeType: job.replayMimeType,
      annotations: [],
      width: job.width,
      height: job.height,
      fps: job.fps,
      durationMs: job.sourceDurationMs,
      trimStartMs: job.trimStartMs,
    }
    if (job.trimEndMs !== null) payload.trimEndMs = job.trimEndMs
    if (job.preferMimeType !== undefined) payload.preferMimeType = job.preferMimeType
    const outcome = await runRenderWindow(
      payload,
      lengthMs * 2 + RENDER_TIMEOUT_SLACK_MS,
      undefined,
      signal,
    )
    throwIfRenderAborted(signal)
    return outcome
  })
  if (result.webm === undefined) throw new Error('render window returned no video')
  return {
    bytes: Buffer.from(result.webm),
    // What the encoder gave back, which is what the caller must declare.
    mimeType:
      result.producedMimeType === undefined || result.producedMimeType === ''
        ? 'video/webm'
        : result.producedMimeType,
  }
}

/** A finished render: the video plus the stills that were streamed in. */
interface RenderOutcome {
  result: RenderResultPayload
  frames: RenderFramePayload[]
}

/** Opens the hidden render window, runs one job, and returns its result. */
async function runRenderWindow(
  payload: RenderStartPayload,
  timeoutMs: number,
  onProgress?: (ratio: number) => void,
  signal?: AbortSignal,
): Promise<RenderOutcome> {
  throwIfRenderAborted(signal)
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
  const onAbort = (): void => {
    if (!win.isDestroyed()) win.destroy()
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    await win.loadFile(path.join(app.getAppPath(), 'dist', 'renderer', 'render', 'render.html'))
    throwIfRenderAborted(signal)
    const outcome = await awaitRenderResult(win, payload, timeoutMs, onProgress)
    if (!outcome.result.ok) throw new Error(outcome.result.error ?? 'render window reported a failure')
    return outcome
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (!win.isDestroyed()) win.destroy()
  }
}

function throwIfRenderAborted(signal?: AbortSignal): void {
  if (signal?.aborted !== true) return
  throw signal.reason instanceof Error ? signal.reason : new Error('render cancelled')
}

function awaitRenderResult(
  win: BrowserWindow,
  payload: RenderStartPayload,
  timeoutMs: number,
  onProgress?: (ratio: number) => void,
): Promise<RenderOutcome> {
  return new Promise((resolve, reject) => {
    let settled = false
    // The stills arrive one at a time while the render runs (IPC.renderFrame).
    const frames: RenderFramePayload[] = []
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ipcMain.removeListener(IPC.renderResult, onResult)
      ipcMain.removeListener(IPC.renderFrame, onFrame)
      ipcMain.removeListener(IPC.renderProgress, onProgressMsg)
      win.removeListener('closed', onClosed)
      fn()
    }
    const onFrame = (event: IpcMainEvent, frame: RenderFramePayload): void => {
      if (win.isDestroyed() || event.sender !== win.webContents) return
      if (frame === null || typeof frame !== 'object') return
      frames.push(frame)
    }
    const onProgressMsg = (event: IpcMainEvent, ratio: unknown): void => {
      if (win.isDestroyed() || event.sender !== win.webContents) return
      if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return
      onProgress?.(Math.max(0, Math.min(1, ratio)))
    }
    const onResult = (event: IpcMainEvent, result: RenderResultPayload): void => {
      if (win.isDestroyed() || event.sender !== win.webContents) return
      // Ascending by t_ms is what makes NN the reading order (SPEC §5.7); the
      // stills are shipped as they finish ENCODING, which need not be in order.
      frames.sort((a, b) => a.t_ms - b.t_ms)
      settle(() => resolve({ result, frames }))
    }
    const onClosed = (): void => settle(() => reject(new Error('render window closed prematurely')))
    const timer = setTimeout(
      () => settle(() => reject(new Error(`render timed out after ${timeoutMs} ms`))),
      timeoutMs,
    )
    ipcMain.on(IPC.renderResult, onResult)
    ipcMain.on(IPC.renderFrame, onFrame)
    ipcMain.on(IPC.renderProgress, onProgressMsg)
    win.on('closed', onClosed)
    win.webContents.send(IPC.renderStart, payload)
  })
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
