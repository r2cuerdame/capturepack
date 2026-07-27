// Bottom timeline bar: play/pause, coarse click/drag scrub track, elapsed
// label ("-12.4s" behind "now"), the replay-loading hint, and a compact lane
// strip above the track showing each annotation's lifetime as a slim bar.
import type { Annotation } from '../../shared/types'

// Lane strip geometry: 3px bars on a 5px pitch, greedily packed so
// non-overlapping lifetimes share a lane and the strip stays compact.
const LANE_STEP = 5
const LANE_GAP = 2
const NO_COLOR = '#9a9aa4' // blur carries no color (SPEC §8.3)

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
  /** A lifetime bar was clicked: select that annotation and scrub to its anchor. */
  selectAnnotation(id: string): void
}

export class Timebar {
  private readonly playBtn: HTMLButtonElement
  private readonly lanes: HTMLElement
  private readonly track: HTMLElement
  private readonly fill: HTMLElement
  private readonly playhead: HTMLElement
  private readonly label: HTMLElement
  private readonly hint: HTMLElement
  private ready = false
  private dragPointer: number | null = null

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
  }

  show(): void {
    this.root.hidden = false
  }

  update(s: TimebarState): void {
    this.ready = s.ready
    this.root.classList.toggle('loading', !s.ready)
    this.playBtn.disabled = !s.ready || s.failed
    this.playBtn.textContent = s.playing ? '❚❚' : '▶'
    const fraction = s.durationMs > 0 ? Math.max(0, Math.min(1, s.tMs / s.durationMs)) : 1
    this.fill.style.width = `${fraction * 100}%`
    this.playhead.style.left = `${fraction * 100}%`
    this.label.textContent = s.atNow ? 'now' : `-${((s.durationMs - s.tMs) / 1000).toFixed(1)}s`
    if (s.failed) {
      this.hint.textContent = 'replay unavailable'
      this.hint.hidden = false
    } else {
      this.hint.hidden = s.ready
    }
  }

  /** Rebuilds the lifetime lane strip; call when annotations or selection change. */
  setAnnotations(
    annotations: readonly Annotation[],
    selectedId: string | null,
    durationMs: number,
  ): void {
    // Half-open lifetimes default the absent bound to the capture edge (SPEC §8.3).
    const spans = annotations
      .filter((a) => a.t_start_ms !== undefined || a.t_end_ms !== undefined)
      .sort((a, b) => (a.t_start_ms ?? 0) - (b.t_start_ms ?? 0))
    this.lanes.textContent = ''
    this.lanes.hidden = spans.length === 0 || durationMs <= 0
    if (this.lanes.hidden) return
    const laneEnds: number[] = []
    for (const a of spans) {
      const start = a.t_start_ms ?? 0
      const end = a.t_end_ms ?? durationMs
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
      bar.classList.toggle('selected', a.id === selectedId)
      bar.style.left = `${(Math.min(start, durationMs) / durationMs) * 100}%`
      bar.style.width = `${(Math.max(0, Math.min(end, durationMs) - start) / durationMs) * 100}%`
      bar.style.top = `${lane * LANE_STEP}px`
      bar.style.background = a.type === 'blur' ? NO_COLOR : a.color
      bar.title = a.type
      bar.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return
        e.stopPropagation()
        this.cb.selectAnnotation(a.id)
      })
      this.lanes.appendChild(bar)
    }
    this.lanes.style.height = `${laneEnds.length * LANE_STEP - LANE_GAP}px`
  }

  private scrubToPointer(e: PointerEvent): void {
    const rect = this.track.getBoundingClientRect()
    if (rect.width <= 0) return
    const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    this.cb.scrubToFraction(fraction)
  }
}

function query<T extends HTMLElement>(root: HTMLElement, selector: string): T {
  const node = root.querySelector<T>(selector)
  if (!node) throw new Error(`missing ${selector} in timebar`)
  return node
}
