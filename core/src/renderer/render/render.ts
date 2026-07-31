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
import { annotationColor } from '../../shared/annotationStyle'
import {
  annotationLabelBottomOutset,
  drawAnnotationBox,
  type AnnotationLabelStyle,
} from '../../shared/annotationCanvas'
import { renderedAnnotationAt } from '../../shared/track'
import { rectangleEdgeScore } from '../../shared/exposureAlignment'
import type { AuthoredMotionSpace } from '../../shared/track'

interface RenderBridge {
  onStart(cb: (payload: RenderStartPayload) => void): void
  frame(payload: RenderFramePayload): void
  /** How far through the replay this render has played, 0..1 (#96). */
  progress?(ratio: number): void
  result(payload: RenderResultPayload): void
}

declare global {
  interface Window {
    renderBridge: RenderBridge
  }
}

const BLUR_BLOCK = 12 // native px per pixelation block (matches the editor preview)

window.renderBridge.onStart((payload) => {
  void run(payload)
})

/**
 * SCORE THE PACK'S OWN PIXELS, AND DRAW NOTHING (#89).
 *
 * Seeks to a spread of instants across the range the landmark actually moved
 * over, reads each frame back, and scores it against every rectangle the
 * context recorded near that instant. The fit itself happens in main, from the
 * shared estimator, so this window's only job is to turn video into numbers.
 *
 * Seeking rather than playing is deliberate. Playing costs the replay's whole
 * duration in real time, which is what made every measurement placement too
 * expensive; forty seeks cost a fraction of it, and the estimator has been
 * measured to resolve to a few milliseconds on twelve frames.
 *
 * A seek that lands in a hole is a real case since the ring stopped compressing
 * stalls — the frame that comes back is the one being held, which is the honest
 * answer and is scored like any other.
 */
async function measureExposure(
  job: RenderStartPayload,
  request: NonNullable<RenderStartPayload['measure']>,
): Promise<{ scoreRows: NonNullable<RenderResultPayload['scoreRows']> }> {
  const replay = job.replayWebm
  if (replay === null) throw new Error('a measurement job needs a replay')
  const blob = new Blob([replay], {
    type: job.replayMimeType ?? 'video/webm',
  })
  const url = URL.createObjectURL(blob)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.src = url
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve()
      video.onerror = () => reject(new Error('measurement could not decode the replay'))
    })
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (ctx === null) throw new Error('no 2d context for measurement')
    // No smoothing: the scorer reads two-pixel gradients on window borders, and
    // a smoothed draw is exactly what resamples them away.
    ctx.imageSmoothingEnabled = false

    const times = request.candidates.map((c) => c.tMs)
    const firstMs = Math.min(...times)
    const lastMs = Math.max(...times)
    const spanMs = Math.max(0, lastMs - firstMs)
    const wanted = Math.max(2, Math.min(request.sampleCount, 120))
    const rows: NonNullable<RenderResultPayload['scoreRows']> = []
    for (let index = 0; index < wanted; index += 1) {
      const atMs = firstMs + (spanMs * index) / (wanted - 1)
      const presentedMs = await seekAndRead(video, atMs / 1000)
      if (presentedMs === null) continue
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
      // The red channel of an RGBA readback, used as the luminance plane the
      // scorer expects. A window border is a step in all three channels, so one
      // of them carries the same edge at a third of the memory.
      const gray = new Uint8Array(canvas.width * canvas.height)
      for (let i = 0; i < gray.length; i += 1) gray[i] = image.data[i * 4] as number
      const plane = { data: gray, width: canvas.width, height: canvas.height }
      const scores: Array<{ tMs: number; score: number }> = []
      for (const candidate of request.candidates) {
        if (Math.abs(candidate.tMs - presentedMs) > request.candidateWindowMs) continue
        const score = rectangleEdgeScore(plane, request.scale, candidate)
        if (score !== null) scores.push({ tMs: candidate.tMs, score })
      }
      if (scores.length > 0) rows.push({ ptsMs: presentedMs, scores })
    }
    return { scoreRows: rows }
  } finally {
    video.src = ''
    URL.revokeObjectURL(url)
  }
}

/** Seeks and returns the instant the frame that arrived actually carries. */
async function seekAndRead(
  video: HTMLVideoElement,
  seconds: number,
): Promise<number | null> {
  return await new Promise<number | null>((resolve) => {
    let settled = false
    const done = (value: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    // A seek that never completes must not hang the whole measurement; the
    // frames that did arrive are still evidence.
    const timer = setTimeout(() => done(null), 2_000)
    video.requestVideoFrameCallback((_now, metadata) => {
      done(metadata.mediaTime * 1000)
    })
    video.currentTime = seconds
  })
}

async function run(payload: RenderStartPayload): Promise<void> {
  try {
    const result =
      payload.measure !== undefined
        ? await measureExposure(payload, payload.measure)
        : payload.replayWebm === null
          ? await renderStill(payload)
          : await renderAnnotated(payload)
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
  /** Which display this job draws; undefined = the focused one. */
  display: number | undefined
  /** What an absent display index MEANS. Undefined = single-display pack. */
  focused: number | undefined
  scaleX: number
  scaleY: number
  motionSpace: AuthoredMotionSpace | undefined
}

/**
 * Whether a RESOLVED annotation is on the screen this job renders.
 *
 * An absent `display` means the FOCUSED one — on the job and on the annotation
 * alike (SPEC §8.8) — so both are resolved through `focused` before comparing.
 * Getting that wrong would silently drop every tracked box from the focused
 * display's own video, which is the one most people watch.
 */
function onThisDisplay(a: Annotation, overlay: Overlay): boolean {
  if (overlay.focused === undefined) return true // single-display pack: one screen, every box
  return (a.display ?? overlay.focused) === (overlay.display ?? overlay.focused)
}

function makeOverlay(job: RenderStartPayload, outputWidth: number, outputHeight: number): Overlay {
  const scaleX = job.width > 0 ? outputWidth / job.width : 1
  const scaleY = job.height > 0 ? outputHeight / job.height : 1
  return {
    // Stacking order for the overlay passes; z decides who draws on top.
    // Keep every source rectangle in its declared native-pixel space until
    // annotationAt resolves the current sample/keyframe. Scaling first used to
    // leave authored keyframes unscaled and overwrite the correct 0.5x bounds
    // with 4K coordinates on a 1920px annotated replay.
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
    ui: Math.max(1, outputWidth / 1280),
    display: job.display,
    focused: job.focusedDisplay,
    scaleX,
    scaleY,
    motionSpace: job.motionSpace,
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
  // Resolved to where each box IS at this moment (#86), by the same function
  // the editor draws with. A rendered view that placed tracked boxes any other
  // way would make the pack disagree with its own picture of itself.
  //
  // A still job (`tMs === null`) has no clock to follow, so a tracked box is
  // drawn at its stored `bounds` — the rectangle at its representative instant,
  // which is exactly what `bounds` means.
  const alive =
    tMs === null
      ? overlay.ordered.map((a) => scaleAnnotation(a, overlay.scaleX, overlay.scaleY))
      : overlay.ordered
          .filter((a) => visibleAt(a, tMs))
          .map((a) =>
            renderedAnnotationAt(
              a,
              tMs,
              overlay.scaleX,
              overlay.scaleY,
              overlay.motionSpace,
            ),
          )
          // A tracked box follows its object onto other screens (#86), and this
          // job draws ONE screen. A box currently on the neighbour's monitor
          // belongs in the neighbour's video, not painted at foreign
          // coordinates into this one.
          .filter((a) => onThisDisplay(a, overlay))
  for (const a of alive) {
    if (a.blur) pixelate(ctx, canvas, a)
  }
  for (const a of alive) {
    drawBox(ctx, a, overlay.numbers.get(a.annotation_id), overlay.ui)
  }
}

function renderedLabelStyle(text: string, ui: number): AnnotationLabelStyle {
  return {
    text,
    font: `700 ${Math.round(16 * ui)}px "Segoe UI", system-ui, sans-serif`,
    lineHeight: 20 * ui,
    padding: 6 * ui,
    gap: 3 * ui,
  }
}

/**
 * Derived results may grow below the source viewport, never by relocating a
 * bottom-edge box or flipping its callout above. The source frame remains at
 * (0, 0); this is result-only space and does not alter annotation coordinates.
 */
function renderedLabelBottomGutter(
  annotations: readonly Annotation[],
  ui: number,
): number {
  if (!annotations.some((annotation) => annotation.text.trim() !== '')) return 0
  return Math.ceil(annotationLabelBottomOutset(renderedLabelStyle('', ui)))
}

function renderedCanvasHeight(mediaHeight: number, bottomGutter: number): number {
  const requested = Math.max(1, Math.ceil(mediaHeight + bottomGutter))
  // Canvas MediaRecorder encoders are least surprising on 2-pixel chroma
  // boundaries. One spare dark result row is cheaper than a codec-specific
  // odd-height render failure.
  return requested % 2 === 0 ? requested : requested + 1
}

function scaleAnnotation(
  a: Annotation,
  scaleX: number,
  scaleY: number,
): Annotation {
  return {
    ...a,
    bounds: {
      x: a.bounds.x * scaleX,
      y: a.bounds.y * scaleY,
      width: a.bounds.width * scaleX,
      height: a.bounds.height * scaleY,
    },
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
    const mediaWidth = job.width
    const mediaHeight = job.height
    const overlay = makeOverlay(job, mediaWidth, mediaHeight)
    canvas.width = mediaWidth
    canvas.height = renderedCanvasHeight(
      mediaHeight,
      renderedLabelBottomGutter(overlay.ordered, overlay.ui),
    )
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 2d context unavailable')
    ctx.fillStyle = '#0b0b0f'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bitmap, 0, 0, mediaWidth, mediaHeight)
    drawOverlay(ctx, canvas, overlay, null)
    const shipped = await shipFrame(capturePng(canvas, 0))
    return { frameCount: shipped ? 1 : 0 }
  } finally {
    bitmap.close()
  }
}

async function renderAnnotated(
  job: RenderStartPayload,
): Promise<{ webm: ArrayBuffer; frameCount: number; producedMimeType: string }> {
  const replayWebm = job.replayWebm
  if (replayWebm === null) throw new Error('annotated render job carries no replay')
  const video = document.createElement('video')
  video.muted = true
  video.src = URL.createObjectURL(
    new Blob([replayWebm], { type: job.replayMimeType ?? 'video/webm' }),
  )
  await videoReady(video)

  // Plain-trim range (GOAL "Replay Trim"): play only [trimStartMs, trimEndMs]
  // of the source. Absent fields = 0 / the video end — the classic full-range
  // annotated render takes exactly the code path it always did.
  const trimStartMs = job.trimStartMs ?? 0
  const trimEndMs = job.trimEndMs
  if (trimStartMs > 0) await videoSeek(video, trimStartMs / 1000)

  const canvas = document.createElement('canvas')
  // Preserve the recorded stream's dimensions. The snapshot/reference size can
  // be native 4K while replayMaxWidth caps this video at 1920; upscaling the
  // canvas here would throw away the continuous-capture CPU saving during both
  // exact cuts and annotated renders.
  const mediaWidth = video.videoWidth > 0 ? video.videoWidth : job.width
  const mediaHeight = video.videoHeight > 0 ? video.videoHeight : job.height
  const overlay = makeOverlay(job, mediaWidth, mediaHeight)
  canvas.width = mediaWidth
  canvas.height = renderedCanvasHeight(
    mediaHeight,
    renderedLabelBottomGutter(overlay.ordered, overlay.ui),
  )
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d context unavailable')

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

  // Throttled so a 30 s render sends a few dozen progress messages, not a
  // thousand: the bar cannot show more than the eye can read anyway (#96).
  let lastProgressAt = 0
  const reportProgress = (tMs: number): void => {
    if (job.durationMs <= 0) return
    const now = performance.now()
    if (now - lastProgressAt < 200) return
    lastProgressAt = now
    window.renderBridge.progress?.(Math.max(0, Math.min(1, tMs / job.durationMs)))
  }

  // THE FRAME BEING DRAWN, NOT THE PLAYHEAD (#93/#98).
  //
  // `video.currentTime` is where playback has got to, which is not the
  // presentation time of the frame `drawImage` is about to copy. #93 corrected
  // that with a SECOND `requestVideoFrameCallback` chain feeding a variable —
  // and two independent chains have no ordering guarantee between them, so the
  // variable could still hold the previous frame's time when the draw ran.
  // Measured on CapturePack_2026-07-29_081301: the burned-in box sat 120 px
  // right and 44 px below its window, in a frame whose pixels and box were
  // composited by the SAME call and therefore cannot honestly disagree.
  //
  // So the time comes from the callback that DRIVES the draw. One chain, one
  // frame, one timestamp — nothing left to race.
  const drawFrame = (mediaTimeMs?: number): number => {
    // Clamp to the manifest replay_duration_ms (the lifetime clock cap): the
    // decoded clock can run slightly past the recorder's wall clock, which
    // would hide "until end" boxes (end_ms == replay_duration_ms) on the
    // final frames. Mirrors the editor's Math.min(tMs, replayDurationMs).
    const rawMs = mediaTimeMs ?? video.currentTime * 1000
    const tMs = job.durationMs > 0 ? Math.min(rawMs, job.durationMs) : rawMs
    ctx.fillStyle = '#0b0b0f'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(video, 0, 0, mediaWidth, mediaHeight)
    drawOverlay(ctx, canvas, overlay, tMs)
    reportProgress(tMs)
    return tMs
  }

  // Draw the first frame before recording starts so the stream never opens on
  // a blank canvas.
  captureDue(drawFrame())

  const stream = canvas.captureStream(job.fps)
  // Only a trim asks for a container: the annotated view is a derived file that
  // has always been WebM, and nothing declares it by codec.
  const producedMimeType = pickMimeType(job.preferMimeType)
  const recorder = new MediaRecorder(stream, {
    mimeType: producedMimeType,
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
  const reachedOutPoint = (): boolean =>
    trimEndMs !== undefined && video.currentTime * 1000 >= trimEndMs
  const stopAtOutPoint = (): void => {
    video.pause()
    reachedTrimEnd()
  }
  const scheduleDraw = (mediaTimeMs?: number): void => {
    if (video.ended) return
    captureDue(drawFrame(mediaTimeMs))
    // Out-point reached: stop like 'ended' would, holding the current frame.
    if (reachedOutPoint()) {
      stopAtOutPoint()
      return
    }
    // The metadata of the frame that JUST became current, handed straight to
    // the draw it triggers (#98).
    video.requestVideoFrameCallback((_now, metadata) => scheduleDraw(metadata.mediaTime * 1000))
  }
  // AN OUT-POINT INSIDE A HELD FRAME STILL STOPS THERE (#116).
  //
  // The test above rides requestVideoFrameCallback, which fires only when a NEW
  // frame is presented. A replay holds one frame for as long as its next sample
  // says, so across a long-held frame nothing fires and the cut is only noticed
  // at the far side of it: the trim overshoots by up to that sample's duration.
  //
  // Measured, not assumed. replay-d1.mp4 of CapturePack_2026-07-31_202834 holds
  // single frames for up to 197 ms, and a recorder stop/restart writes a real
  // multi-second hole into the timeline — this file's own
  // `observedFragmentTimeline` exists to preserve exactly that. Both are longer
  // than the frame interval this test was written against.
  //
  // The playhead keeps moving through a held frame, so a clock test sees what
  // the frame callback cannot. Idempotent with the callback path: both only
  // ever pause and resolve, and `done` resolves once.
  const outPointTimer =
    trimEndMs === undefined
      ? null
      : setInterval(() => {
          if (!video.ended && reachedOutPoint()) stopAtOutPoint()
        }, 25)
  recorder.start(1000)
  scheduleDraw()
  await video.play()
  try {
    await done
  } finally {
    if (outPointTimer !== null) clearInterval(outPointTimer)
  }
  // Final frame. A plain trim must not append the old 200 ms still-frame tail:
  // the saved replay's upper bound is the configured window, never N + 200 ms.
  drawFrame()
  // Targets the playhead never reached (the decoded clock can end just short of
  // the recorder's wall clock) resolve against this last composited frame.
  captureDue(Number.POSITIVE_INFINITY)
  const plainTrim =
    job.annotations.length === 0 &&
    job.keyframes !== true &&
    (job.trimStartMs !== undefined || job.trimEndMs !== undefined)
  if (!plainTrim) await new Promise((r) => setTimeout(r, 200))
  recorder.stop()
  await stopped
  URL.revokeObjectURL(video.src)

  const blob = new Blob(chunks, { type: producedMimeType === '' ? 'video/webm' : producedMimeType })
  if (blob.size === 0) throw new Error('recorded annotated replay is empty')
  const shipped = (await Promise.all(pending)).filter(Boolean).length
  // The caller declares the bytes it was given, not the type it asked for
  // (SPEC 5.3: "A writer MUST declare the filename matching the bytes it
  // actually produced").
  return {
    webm: await blob.arrayBuffer(),
    frameCount: shipped,
    producedMimeType: blob.type,
  }
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

/**
 * A TRIM MUST NOT ALSO CHANGE THE CODEC (#113).
 *
 * SPEC 5.3: "Writers SHOULD prefer a platform H.264 encoder in `replay.mp4`
 * when one is available, then fall back to VP8 and VP9 in `replay.webm`." The
 * recorder follows that and chose MP4/avc1; this re-encode then handed back VP8
 * because the list below was the only list, so cutting a tail off a capture
 * silently demoted it to the container the spec ranks second — measured on
 * CapturePack_2026-07-31_185602, where an H.264 recording came out of a 310 ms
 * tail trim as VP8.
 *
 * `prefer` is the source's own type. It is a preference, never a claim: an
 * unsupported one falls through to exactly the order that shipped before, and
 * the caller declares whatever actually came back rather than what it asked
 * for.
 */
function pickMimeType(prefer?: string): string {
  const ordered = [
    ...(prefer === undefined || prefer === '' ? [] : [prefer]),
    'video/webm;codecs=vp8',
    'video/webm;codecs=vp9',
    'video/webm',
  ]
  for (const t of ordered) {
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
  const color = annotationColor(a)
  const text = a.text.trim()
  drawAnnotationBox(ctx, a.bounds, {
    color,
    borderWidth: 3 * ui,
    badge:
      displayNumber === undefined
        ? null
        : {
            text: String(displayNumber),
            radius: 14 * ui,
            borderWidth: 2 * ui,
            font: `700 ${Math.round(14 * ui)}px "Segoe UI", system-ui, sans-serif`,
            baselineOffset: ui,
          },
    label: text === '' ? null : renderedLabelStyle(text, ui),
  })
}
