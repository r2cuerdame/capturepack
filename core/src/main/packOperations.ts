import * as path from 'node:path'

// Operations that publish, rename, or remove files beside one pack must share
// one main-process lock. A Share Copy finishing after History renamed/deleted
// its folder would otherwise publish an unindexed orphan at the old path.
const active = new Set<string>()

export type PackOperationRelease = () => void

export function beginPackOperation(packPath: string): PackOperationRelease | null {
  const key = path.resolve(packPath).toLowerCase()
  if (active.has(key)) return null
  active.add(key)
  let released = false
  return () => {
    if (released) return
    released = true
    active.delete(key)
  }
}

export function packOperationActive(packPath: string): boolean {
  return active.has(path.resolve(packPath).toLowerCase())
}

export function anyPackOperationActive(): boolean {
  return active.size > 0
}

// Not the exclusive lock above: the editor's own save, render and History's
// Share Copy still run on a pack the editor holds; only removal is refused.
const editorHeld = new Map<string, number>()
let editorFlowsOpen = 0

export interface EditorFlowHold {
  hold(packPath: string): void
  release(): void
}

export function beginEditorFlow(): EditorFlowHold {
  editorFlowsOpen += 1
  const keys = new Set<string>()
  let released = false
  return {
    hold(packPath: string): void {
      if (released) return
      const key = path.resolve(packPath).toLowerCase()
      if (keys.has(key)) return
      keys.add(key)
      editorHeld.set(key, (editorHeld.get(key) ?? 0) + 1)
    },
    release(): void {
      if (released) return
      released = true
      editorFlowsOpen -= 1
      for (const key of keys) {
        const count = (editorHeld.get(key) ?? 1) - 1
        if (count > 0) editorHeld.set(key, count)
        else editorHeld.delete(key)
      }
      keys.clear()
    },
  }
}

export function packHeldByEditor(packPath: string): boolean {
  return editorHeld.has(path.resolve(packPath).toLowerCase())
}

export function editorFlowOpen(): boolean {
  return editorFlowsOpen > 0
}
