// Bottom timeline bar: play/pause, coarse click/drag scrub track, elapsed
// label ("-12.4s" behind "now"), the replay-loading hint, and a compact lane
// strip above the track showing each annotation's lifetime as a slim bar.
import { makeT } from '../../shared/i18n'
import type { TranslateFn } from '../../shared/i18n'
import type { Annotation } from '../../shared/types'
import { boxColor } from './render'

// Lane strip geometry: 3px bars on a 5px pitch, greedily packed so
// non-overlapping lifetimes share a lane and the strip stays compact.
const LANE_STEP = 5
const LANE_GAP = 2

export interface TimebarState {
  ready: boolean
  failed: boolean
  playing: boolean
  tMs: number
  durationMs: number
  atNow: boolean
}

export interface TimebarCallbacks {
  /** Scrub to a fraction (0..1) of the replay duration. */
  scrubToFraction(fraction: number): void
  togglePlay(): void
  /** A lifetime bar was clicked: select that box and scrub to its lifetime midpoint. */
  selectAnnotation(id: string): void
  /** A trim handle was dragged to a fraction (0..1) of the replay duration. */
  trimTo(kind: 'in' | 'out', fraction: number): void
  /** A trim handle was double-clicked: reset that side to the track edge. */
  resetTrim(kind: 'in' | 'out'): void
}

export class Timebar {
  private readonly playBtn: HTMLButtonElement
  private readonly lanes: HTMLElement
  private readonly track: HTMLElement
  private readonly fill: HTMLElement
  private readonly playhead: HTMLElement
  private readonly label: HTMLElement
  private readonly hint: HTMLElement
  private readonly trimInHandle: HTMLElement
  private readonly trimOutHandle: HTMLElement
  private readonly trimDimIn: HTMLElement
  private readonly trimDimOut: HTMLElement
  private readonly trimChip: HTMLElement
  private ready = false
  private dragPointer: number | null = null
  // Replay Trim (GOAL "Replay Trim"): mirrored from the editor via setTrim();
  // trimOutMs null = untrimmed end. Handles exist only in the fresh-capture
  // flow (trimEnabled) — edit mode never shows them.
  // Active-language t(); editor.ts injects it at init (setT).
  private t: TranslateFn = makeT('en')
  private trimEnabled = false
  private trimInMs = 0
  private trimOutMs: number | null = null
  private durationMs = 0
  private trimDrag: { kind: 'in' | 'out'; pointerId: number } | null = null

  constructor(
    private readonly root: HTMLElement,
    private readonly cb: TimebarCallbacks,
  ) {
    this.playBtn = query(root, '#playBtn')
    this.lanes = query(root, '#lanes')
    this.track = query(root, '#track')
    this.fill = query(root, '#trackFill')
    this.playhead = query(root, '#playhead')
    this.label = query(root, '#timeLabel')
    this.hint = query(root, '#scrubHint')
    this.trimInHandle = query(root, '#trimIn')
    this.trimOutHandle = query(root, '#trimOut')
    this.trimDimIn = query(root, '#trimDimIn')
    this.trimDimOut = query(root, '#trimDimOut')
    this.trimChip = query(root, '#trimChip')

    this.playBtn.addEventListener('click', () => {
      this.cb.togglePlay()
      this.playBtn.blur()
    })
    this.track.addEventListener('pointerdown', (e) => {
      if (!this.ready || e.button !== 0) return
      this.track.setPointerCapture(e.pointerId)
      this.dragPointer = e.pointerId
      this.scrubToPointer(e)
    })
    this.track.addEventListener('pointermove', (e) => {
      if (this.dragPointer === e.pointerId) this.scrubToPointer(e)
    })
    const endDrag = (e: PointerEvent): void => {
      if (this.dragPointer === e.pointerId) this.dragPointer = null
    }
    this.track.addEventListener('pointerup', endDrag)
    this.track.addEventListener('pointercancel', endDrag)

    this.wireTrimHandle(this.trimInHandle, 'in')
    this.wireTrimHandle(this.trimOutHandle, 'out')
  }

  show(): void {
    this.root.hidden = false
  }

  /** Injects the active-language t() (editor init). */
  setT(t: TranslateFn): void {
    this.t = t
  }

  /** Fresh-capture flow only (GOAL "Replay Trim"): edit mode keeps this false. */
  setTrimEnabled(enabled: boolean): void {
    this.trimEnabled = enabled
    this.renderTrim()
  }

  /** Mirrors the editor's trim state; outMs null = the untrimmed end. */
  setTrim(inMs: number, outMs: number | null): void {
    this.trimInMs = inMs
    this.trimOutMs = outMs
    this.renderTrim()
  }

  update(s: TimebarState): void {
    this.ready = s.ready
    this.durationMs = s.durationMs
    this.root.classList.toggle('loading', !s.ready)
    this.playBtn.disabled = !s.ready || s.failed
    this.playBtn.textContent = s.playing ? '❚❚' : '▶'
    const fraction = s.durationMs > 0 ? Math.max(0, Math.min(1, s.tMs / s.durationMs)) : 1
    this.fill.style.width = `${fraction * 100}%`
    this.playhead.style.left = `${fraction * 100}%`
    this.label.textContent = s.atNow ? this.t('editor.now') : `-${((s.durationMs - s.tMs) / 1000).toFixed(1)}s`
    if (s.failed) {
      this.hint.textContent = this.t('editor.replayUnavailable')
      this.hint.hidden = false
    } else {
      this.hint.hidden = s.ready
    }
    this.renderTrim() // the duration (fraction basis) may have just changed
  }

  private wireTrimHandle(handle: HTMLElement, kind: 'in' | 'out'): void {
    handle.addEventListener('pointerdown', (e) => {
      if (!this.ready || !this.trimEnabled || e.button !== 0) return
      e.stopPropagation() // the track underneath must not start a scrub drag
      handle.setPointerCapture(e.pointerId)
      this.trimDrag = { kind, pointerId: e.pointerId }
      this.cb.trimTo(kind, this.trackFraction(e))
    })
    handle.addEventListener('pointermove', (e) => {
      if (this.trimDrag?.kind === kind && this.trimDrag.pointerId === e.pointerId) {
        this.cb.trimTo(kind, this.trackFraction(e))
      }
    })
    const endDrag = (e: PointerEvent): void => {
      if (this.trimDrag?.pointerId === e.pointerId) this.trimDrag = null
    }
    handle.addEventListener('pointerup', endDrag)
    handle.addEventListener('pointercancel', endDrag)
    handle.addEventListener('dblclick', (e) => {
      e.stopPropagation()
      this.cb.resetTrim(kind)
    })
  }

  /** Positions the trim handles, dims the outside regions, updates the chip. */
  private renderTrim(): void {
    const show = this.trimEnabled && this.ready
    this.trimInHandle.hidden = !show
    this.trimOutHandle.hidden = !show
    const active = show && (this.trimInMs > 0 || this.trimOutMs !== null)
    const d = this.durationMs
    const inF = d > 0 ? Math.max(0, Math.min(1, this.trimInMs / d)) : 0
    const outF = this.trimOutMs !== null && d > 0 ? Math.max(0, Math.min(1, this.trimOutMs / d)) : 1
    this.trimInHandle.style.left = `${inF * 100}%`
    this.trimOutHandle.style.left = `${outF * 100}%`
    this.trimDimIn.hidden = !active || inF <= 0
    this.trimDimIn.style.left = '0'
    this.trimDimIn.style.width = `${inF * 100}%`
    this.trimDimOut.hidden = !active || outF >= 1
    this.trimDimOut.style.left = `${outF * 100}%`
    this.trimDimOut.style.width = `${(1 - outF) * 100}%`
    this.trimChip.hidden = !active
    if (active) {
      const lengthMs = Math.max(0, (this.trimOutMs ?? d) - this.trimInMs)
      this.trimChip.textContent = this.t('editor.trimChip', { seconds: (lengthMs / 1000).toFixed(1) })
    }
  }

  private trackFraction(e: PointerEvent): number {
    const rect = this.track.getBoundingClientRect()
    if (rect.width <= 0) return 0
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  }

  /** Rebuilds the lifetime lane strip; call when annotations or selection change. */
  setAnnotations(
    annotations: readonly Annotation[],
    selectedId: string | null,
    durationMs: number,
  ): void {
    // Lifetimes are both-or-neither (SPEC §8.4); boxes without one apply to
    // the whole capture and stay out of the lane strip.
    const spans = annotations
      .filter((a) => a.start_ms !== undefined && a.end_ms !== undefined)
      .sort((a, b) => (a.start_ms ?? 0) - (b.start_ms ?? 0))
    this.lanes.textContent = ''
    this.lanes.hidden = spans.length === 0 || durationMs <= 0
    if (this.lanes.hidden) return
    const laneEnds: number[] = []
    for (const a of spans) {
      const start = a.start_ms ?? 0
      const end = a.end_ms ?? durationMs
      // First lane whose last bar ended before this one starts; else a new lane.
      let lane = laneEnds.findIndex((endMs) => endMs <= start)
      if (lane === -1) {
        lane = laneEnds.length
        laneEnds.push(end)
      } else {
        laneEnds[lane] = end
      }
      const bar = document.createElement('div')
      bar.className = 'laneBar'
      bar.classList.toggle('selected', a.annotation_id === selectedId)
      bar.style.left = `${(Math.min(start, durationMs) / durationMs) * 100}%`
      bar.style.width = `${(Math.max(0, Math.min(end, durationMs) - start) / durationMs) * 100}%`
      bar.style.top = `${lane * LANE_STEP}px`
      bar.style.background = boxColor(a)
      bar.title = a.text !== '' ? a.text : this.t('editor.box')
      bar.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return
        e.stopPropagation()
        this.cb.selectAnnotation(a.annotation_id)
      })
      this.lanes.appendChild(bar)
    }
    this.lanes.style.height = `${laneEnds.length * LANE_STEP - LANE_GAP}px`
  }

  private scrubToPointer(e: PointerEvent): void {
    this.cb.scrubToFraction(this.trackFraction(e))
  }
}

function query<T extends HTMLElement>(root: HTMLElement, selector: string): T {
  const node = root.querySelector<T>(selector)
  if (!node) throw new Error(`missing ${selector} in timebar`)
  return node
}
