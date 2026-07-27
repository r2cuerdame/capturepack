// Annotation store with snapshot-based undo/redo and the shared color palette.
import type { Annotation, AnnotationType } from '../../shared/types'

export type Tool = 'select' | AnnotationType

export const PALETTE = ['#FF3B30', '#FF9500', '#FFD60A', '#34C759', '#0A84FF'] as const

export class EditorState {
  annotations: Annotation[] = []
  selectedId: string | null = null
  private colorIndex = 0
  private undoStack: Annotation[][] = []
  private redoStack: Annotation[][] = []

  get color(): string {
    return PALETTE[this.colorIndex] ?? PALETTE[0]
  }

  cycleColor(): void {
    this.colorIndex = (this.colorIndex + 1) % PALETTE.length
  }

  // Derived from live annotations so ids/z stay contiguous across undo.
  nextStamp(): { id: string; z: number; created_at: string } {
    let max = 0
    for (const a of this.annotations) {
      const n = Number(a.id.slice(1))
      if (Number.isFinite(n) && n > max) max = n
      if (a.z > max) max = a.z
    }
    return { id: `a${max + 1}`, z: max + 1, created_at: new Date().toISOString() }
  }

  // Max existing numeric label + 1, so deleting pin 2 of [1,2,3] never yields a
  // duplicate "3" (a count-based label would).
  nextPinLabel(): string {
    let max = 0
    for (const a of this.annotations) {
      if (a.type !== 'pin') continue
      const n = Number(a.label)
      if (Number.isFinite(n) && n > max) max = n
    }
    return String(max + 1)
  }

  byId(id: string): Annotation | undefined {
    return this.annotations.find((a) => a.id === id)
  }

  cloneAnnotations(): Annotation[] {
    return structuredClone(this.annotations)
  }

  add(a: Annotation): void {
    this.pushUndoSnapshot(this.cloneAnnotations())
    this.annotations.push(a)
  }

  remove(id: string): void {
    this.pushUndoSnapshot(this.cloneAnnotations())
    this.annotations = this.annotations.filter((a) => a.id !== id)
    if (this.selectedId === id) this.selectedId = null
  }

  /** Records a pre-mutation snapshot; also used by drag-moves that mutate in place. */
  pushUndoSnapshot(before: Annotation[]): void {
    this.undoStack.push(before)
    this.redoStack.length = 0
  }

  undo(): void {
    const prev = this.undoStack.pop()
    if (prev === undefined) return
    this.redoStack.push(this.annotations)
    this.annotations = prev
    this.selectedId = null
  }

  redo(): void {
    const next = this.redoStack.pop()
    if (next === undefined) return
    this.undoStack.push(this.annotations)
    this.annotations = next
    this.selectedId = null
  }
}
