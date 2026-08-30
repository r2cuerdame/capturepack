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
