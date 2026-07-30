// Box-annotation store with snapshot-based undo/redo.
// The editor works directly in format 0.1.0 BoxAnnotations (SPEC §8) — what it
// holds is exactly what gets saved into annotations.json.
import type { Annotation } from '../../shared/types'

export class EditorState {
  annotations: Annotation[] = []
  selectedId: string | null = null
  private undoStack: Annotation[][] = []
  private redoStack: Annotation[][] = []
  // Every annotation_id ever handed out this session, so an id freed by undo
  // is never reissued — core.annotation.added timeline events (sent at commit
  // time) must stay unambiguous.
  private usedIds = new Set<string>()

  /** Identity + stacking stamp for a new box: "ann_" + 6 lowercase hex (SPEC §8.3). */
  nextStamp(): { annotation_id: string; z: number; created_at: string } {
    let id: string
    do {
      const bytes = crypto.getRandomValues(new Uint8Array(3))
      id = `ann_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
    } while (this.usedIds.has(id))
    this.usedIds.add(id)
    let maxZ = 0
    for (const a of this.annotations) {
      if (a.z > maxZ) maxZ = a.z
    }
    return { annotation_id: id, z: maxZ + 1, created_at: new Date().toISOString() }
  }

  /**
   * Re-edit (GOAL "History — Open & re-edit"): adopts a saved pack's boxes as
   * the session's starting state. The undo baseline is THIS state (undo never
   * walks past it), and every loaded id is registered so nextStamp() continues
   * past the existing ann_ ids instead of ever reissuing one.
   */
  restore(annotations: Annotation[]): void {
    this.annotations = structuredClone(annotations)
    for (const a of this.annotations) this.usedIds.add(a.annotation_id)
    this.undoStack.length = 0
    this.redoStack.length = 0
    this.selectedId = null
  }

  byId(id: string): Annotation | undefined {
    return this.annotations.find((a) => a.annotation_id === id)
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
    this.annotations = this.annotations.filter((a) => a.annotation_id !== id)
    if (this.selectedId === id) this.selectedId = null
  }

  /** Records a pre-mutation snapshot; also used by drags that mutate in place. */
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
