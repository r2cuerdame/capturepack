// Hidden annotated-replay renderer (SPEC §7.2): plays the ORIGINAL replay into
// a canvas and draws the annotation overlays per frame — blur first, then
// border, number badge, text — lifetime-gated, with GLOBAL display numbers
// (never re-compressed per frame). No editor controls, header, or handles are
// ever drawn: the video contains results only. The canvas is recorded with
// captureStream + MediaRecorder and the webm bytes go back to main.
//
// The SAME pass also captures the annotated KEYFRAME stills (SPEC §7.3, GOAL
// "Annotated keyframes (LLM-first)"): whenever the playhead reaches an
// annotation state change, the composited canvas is copied off as a PNG. The
// stills are therefore drawn exactly like the video, by construction — one
// canvas, one code path. A screenshot-only pack has no video to play, so its
// single still is drawn from snapshot.png instead (the `replayWebm: null` job).
import type { RenderFramePayload, RenderResultPayload, RenderStartPayload } from '../../shared/ipc'
import type { Annotation } from '../../shared/types'
import { computeDisplayNumbers } from '../../shared/numbering'
import { computeKeyframeTimes } from '../../shared/keyframes'

interface RenderBridge {
  onStart(cb: (payload: RenderStartPayload) => void): void
  frame(payload: RenderFramePayload): void
  result(payload: RenderResultPayload): void
}

declare global {
  interface Window {
    renderBridge: RenderBridge
  }
}

const BLUR_BLOCK = 12 // native px per pixelation block (matches the editor preview)
const FALLBACK_COLOR = '#FF3B30' // boxes without style.color (editor palette default)

window.renderBridge.onStart((payload) => {
  void run(payload)
})

async function run(payload: RenderStartPayload): Promise<void> {
  try {
    const result =
      payload.replayWebm === null ? await renderStill(payload) : await renderAnnotated(payload)
    window.renderBridge.result({ ok: true, ...result })
  } catch (err) {
    window.renderBridge.result({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Ships one still to main the moment it is encoded and RELEASES it here.
 *
 * The stills used to be accumulated for the whole render and sent with the
 * video in a single structured clone: on a 4K capture that is up to 24
 * multi-megabyte PNGs retained through a real-time playback, then copied
 * renderer -> main in one message. Streaming keeps the renderer's peak at ONE
 * still, and main writes each into frames/ as it lands.
 *
 * Resolves to true when the still was handed over, false when it was dropped
 * (an encode failure is never fatal to the annotated replay).
 */
async function shipFrame(pending: Promise<RenderFramePayload>): Promise<boolean> {
  try {
    const frame = await pending
    window.renderBridge.frame(frame)
    return true
  } catch (err) {
    console.error('capturepack: keyframe capture failed:', err)
    return false
  }
}

/** The overlay drawing state shared by every frame of a job. */
interface Overlay {
  ordered: Annotation[]
  numbers: Map<string, number>
  ui: number
}

function makeOverlay(job: RenderStartPayload): Overlay {
  return {
    // Stacking order for the overlay passes; z decides who draws on top.
    ordered: [...job.annotations].sort((a, b) => a.z - b.z),
    // GLOBAL display numbers (SPEC §8.5) — global over the whole PACK, not just
    // over this job's boxes: a frame where only box 2 is alive still labels it
    // 2, and so does a per-display render that received box 2 alone. The map is
    // computed once per save from the full annotation set and shipped in;
    // recomputing it here from `job.annotations` (a subset on every
    // multi-display job) is what would make the video's numbers disagree with
    // report.md's. Absent = the subset IS the whole set (single-display pack).
    numbers:
      job.displayNumbers === undefined
        ? computeDisplayNumbers(job.annotations)
        : new Map(job.displayNumbers),
    // Overlay sizes scale with the capture resolution so a 4K replay does not
    // get hairline borders.
    ui: Math.max(1, job.width / 1280),
  }
}

/** Draw order per frame (SPEC §7.2): original -> blur -> border -> badge -> text.
 * `tMs` null = no clock (still job): every box is drawn. */
function drawOverlay(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  overlay: Overlay,
  tMs: number | null,
): void {
  const alive = tMs === null ? overlay.ordered : overlay.ordered.filter((a) => visibleAt(a, tMs))
  for (const a of alive) {
    if (a.blur) pixelate(ctx, canvas, a)
  }
  for (const a of alive) {
    drawBox(ctx, a, overlay.numbers.get(a.annotation_id), overlay.ui)
  }
}

/**
 * Screenshot-only pack (SPEC §7.3): no video exists, so the one annotated
 * keyframe is composited from snapshot.png. Lifetimes are a replay-clock
 * interval (SPEC §8.4) and have nothing to anchor to without a replay, so every
 * box is drawn.
 */
async function renderStill(job: RenderStartPayload): Promise<{ frameCount: number }> {
  const snapshotPng = job.snapshotPng
  if (snapshotPng === undefined) throw new Error('still render job carries no snapshot')
  // createImageBitmap decodes the bytes directly — no object URL, so the
  // window's CSP (which allows blob: for media only) is never in play. Same
  // mechanism the editor decodes its snapshot with.
  const bitmap = await createImageBitmap(new Blob([snapshotPng], { type: 'image/png' }))
  try {
    const canvas = document.createElement('canvas')
    canvas.width = job.width
    canvas.height = job.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 2d context unavailable')
    ctx.drawImage(bitmap, 0, 0, job.width, job.height)
    drawOverlay(ctx, canvas, makeOverlay(job), null)
    const shipped = await shipFrame(capturePng(canvas, 0))
    return { frameCount: shipped ? 1 : 0 }
  } finally {
    bitmap.close()
  }
}

async function renderAnnotated(
  job: RenderStartPayload,
): Promise<{ webm: ArrayBuffer; frameCount: number }> {
  const replayWebm = job.replayWebm
  if (replayWebm === null) throw new Error('annotated render job carries no replay')
  const video = document.createElement('video')
  video.muted = true
  video.src = URL.createObjectURL(new Blob([replayWebm], { type: 'video/webm' }))
  await videoReady(video)

  // Plain-trim range (GOAL "Replay Trim"): play only [trimStartMs, trimEndMs]
  // of the source. Absent fields = 0 / the video end — the classic full-range
  // annotated render takes exactly the code path it always did.
  const trimStartMs = job.trimStartMs ?? 0
  const trimEndMs = job.trimEndMs
  if (trimStartMs > 0) await videoSeek(video, trimStartMs / 1000)

  const canvas = document.createElement('canvas')
  canvas.width = job.width
  canvas.height = job.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d context unavailable')

  const overlay = makeOverlay(job)

  // Annotated keyframes (SPEC §7.3): the instants a still is captured at, from
  // the SHARED rule — the exporter names the files from the same list, and the
  // pack documents reference those names before this render even finishes.
  // These times are on the job's own clock, so the two modes never combine: the
  // trim job asks for no keyframes, and the annotated render that follows it
  // runs over the already-trimmed bytes with no trim range.
  const targets = job.keyframes === true ? computeKeyframeTimes(job.annotations, job.durationMs) : []
  // Each still leaves for main as soon as it encodes (shipFrame); only the
  // in-flight promises are tracked, so the loop below can wait for them before
  // reporting how many actually made it.
  const pending: Array<Promise<boolean>> = []
  let nextTarget = 0
  // Copies the composited canvas off whenever the playhead has reached the next
  // target. toBlob snapshots the bitmap synchronously and encodes off-thread,
  // so the real-time recording is never stalled by PNG compression.
  const captureDue = (tMs: number): void => {
    for (;;) {
      const target = targets[nextTarget]
      if (target === undefined || target > tMs) return
      nextTarget += 1
      pending.push(shipFrame(capturePng(canvas, target)))
    }
  }

  const drawFrame = (): number => {
    // Clamp to the manifest replay_duration_ms (the lifetime clock cap): the
    // decoded clock can run slightly past the recorder's wall clock, which
    // would hide "until end" boxes (end_ms == replay_duration_ms) on the
    // final frames. Mirrors the editor's Math.min(tMs, replayDurationMs).
    const rawMs = video.currentTime * 1000
    const tMs = job.durationMs > 0 ? Math.min(rawMs, job.durationMs) : rawMs
    ctx.drawImage(video, 0, 0, job.width, job.height)
    drawOverlay(ctx, canvas, overlay, tMs)
    return tMs
  }

  // Draw the first frame before recording starts so the stream never opens on
  // a blank canvas.
  captureDue(drawFrame())

  const stream = canvas.captureStream(job.fps)
  const recorder = new MediaRecorder(stream, {
    mimeType: pickMimeType(),
    videoBitsPerSecond: 8_000_000,
  })
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }
  const stopped = new Promise<void>((resolve, reject) => {
    recorder.onstop = () => resolve()
    recorder.onerror = () => reject(new Error('MediaRecorder failed'))
  })

  // Real-time render: the video plays once while every presented frame is
  // composited. requestVideoFrameCallback ties drawing to decoded frames;
  // backgroundThrottling is disabled on this hidden window so it keeps firing.
  let reachedTrimEnd = (): void => {}
  const done = new Promise<void>((resolve, reject) => {
    reachedTrimEnd = resolve
    video.onended = () => resolve()
    video.onerror = () => reject(new Error('replay video failed to decode'))
  })
  const scheduleDraw = (): void => {
    if (video.ended) return
    captureDue(drawFrame())
    // Out-point reached: stop like 'ended' would, holding the current frame.
    if (trimEndMs !== undefined && video.currentTime * 1000 >= trimEndMs) {
      video.pause()
      reachedTrimEnd()
      return
    }
    video.requestVideoFrameCallback(() => scheduleDraw())
  }
  recorder.start(1000)
  scheduleDraw()
  await video.play()
  await done
  // Final frame + a short tail so the recorder flushes the last chunk.
  drawFrame()
  // Targets the playhead never reached (the decoded clock can end just short of
  // the recorder's wall clock) resolve against this last composited frame.
  captureDue(Number.POSITIVE_INFINITY)
  await new Promise((r) => setTimeout(r, 200))
  recorder.stop()
  await stopped
  URL.revokeObjectURL(video.src)

  const blob = new Blob(chunks, { type: 'video/webm' })
  if (blob.size === 0) throw new Error('recorded annotated replay is empty')
  const shipped = (await Promise.all(pending)).filter(Boolean).length
  return { webm: await blob.arrayBuffer(), frameCount: shipped }
}

/** Encodes the canvas as a PNG still without blocking the real-time render. */
function capturePng(canvas: HTMLCanvasElement, tMs: number): Promise<RenderFramePayload> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(new Error('keyframe encoding failed'))
        return
      }
      blob
        .arrayBuffer()
        .then((png) => resolve({ t_ms: tMs, png }))
        .catch(reject)
    }, 'image/png')
  })
}

function videoReady(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    video.onloadeddata = () => resolve()
    video.onerror = () => reject(new Error('replay video failed to load'))
  })
}

/** Seeks to the trim in-point before recording starts (cue-less MediaRecorder
 * webm resolves mid-file seeks by parsing — same mechanism the editor scrubs with). */
function videoSeek(video: HTMLVideoElement, seconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    video.onseeked = () => {
      video.onseeked = null
      resolve()
    }
    video.onerror = () => reject(new Error('replay video failed to seek'))
    video.currentTime = seconds
  })
}

function pickMimeType(): string {
  for (const t of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
    if (MediaRecorder.isTypeSupported(t)) return t
  }
  return ''
}

/** Lifetime gate (SPEC §8.4): absent lifetime = the whole capture. */
function visibleAt(a: Annotation, tMs: number): boolean {
  if (a.start_ms === undefined || a.end_ms === undefined) return true
  return tMs >= a.start_ms && tMs <= a.end_ms
}

/** Pixelates the box interior from the already-drawn frame (non-destructive blur view). */
function pixelate(ctx: CanvasRenderingContext2D, source: HTMLCanvasElement, a: Annotation): void {
  const x0 = Math.max(0, Math.floor(a.bounds.x))
  const y0 = Math.max(0, Math.floor(a.bounds.y))
  const cw = Math.min(Math.ceil(a.bounds.width), source.width - x0)
  const ch = Math.min(Math.ceil(a.bounds.height), source.height - y0)
  if (cw < 1 || ch < 1) return
  const tiny = document.createElement('canvas')
  tiny.width = Math.max(1, Math.round(cw / BLUR_BLOCK))
  tiny.height = Math.max(1, Math.round(ch / BLUR_BLOCK))
  const tctx = tiny.getContext('2d')
  if (!tctx) return
  tctx.drawImage(source, x0, y0, cw, ch, 0, 0, tiny.width, tiny.height)
  ctx.save()
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(tiny, 0, 0, tiny.width, tiny.height, x0, y0, cw, ch)
  ctx.restore()
}

/** Border + number badge + text for one alive box. Results only — no controls. */
function drawBox(
  ctx: CanvasRenderingContext2D,
  a: Annotation,
  displayNumber: number | undefined,
  ui: number,
): void {
  const { x, y, width: w, height: h } = a.bounds
  const color = a.style?.color ?? FALLBACK_COLOR

  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = 3 * ui
  ctx.strokeRect(x, y, w, h)

  if (displayNumber !== undefined) {
    const r = 14 * ui
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    ctx.lineWidth = 2 * ui
    ctx.strokeStyle = '#ffffff'
    ctx.stroke()
    ctx.fillStyle = '#ffffff'
    ctx.font = `700 ${Math.round(14 * ui)}px "Segoe UI", system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(displayNumber), x, y + ui)
  }

  const text = a.text.trim()
  if (text !== '') {
    const font = `700 ${Math.round(16 * ui)}px "Segoe UI", system-ui, sans-serif`
    ctx.font = font
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    const pad = 6 * ui
    const metrics = ctx.measureText(text)
    const lineH = 20 * ui
    // Below the box when it fits, above otherwise; clamped into the frame.
    let ty = y + h + pad
    if (ty + lineH + pad > ctx.canvas.height) ty = y - lineH - pad * 2
    ty = Math.max(pad, ty)
    const tx = Math.min(Math.max(pad, x), Math.max(pad, ctx.canvas.width - metrics.width - pad * 2))
    ctx.fillStyle = 'rgba(0, 0, 0, 0.65)'
    ctx.fillRect(tx - pad, ty - pad * 0.5, metrics.width + pad * 2, lineH + pad)
    ctx.fillStyle = '#ffffff'
    ctx.fillText(text, tx, ty)
  }
  ctx.restore()
}
