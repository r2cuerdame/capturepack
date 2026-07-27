// Bottom timeline bar: play/pause, coarse click/drag scrub track, elapsed
// label ("-12.4s" behind "now"), and the replay-loading hint.

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
}

export class Timebar {
  private readonly playBtn: HTMLButtonElement
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
