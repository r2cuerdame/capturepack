let editorsDeciding = 0
let packWrites = 0

export function awaitEditorDecision<T>(decision: Promise<T>): Promise<T> {
  editorsDeciding += 1
  return decision.finally(() => {
    editorsDeciding -= 1
  })
}

export function trackPackWrite<T>(work: Promise<T>): Promise<T> {
  packWrites += 1
  return work.finally(() => {
    packWrites -= 1
  })
}

export function captureOrSaveInProgress(flowActive: boolean): boolean {
  return packWrites > 0 || (flowActive && editorsDeciding === 0)
}
