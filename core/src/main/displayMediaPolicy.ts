export interface DisplayMediaSourceLike {
  display_id: string
}

/**
 * Resolve one screen source for a getDisplayMedia request.
 *
 * Recorder windows are assigned to an exact display before they load. Once
 * assigned, silently substituting primary/source[0] would duplicate another
 * monitor while reporting the missing monitor as healthy, so that path must
 * fail closed. Requests without an assignment retain the legacy primary/first
 * fallback used during startup and by callers outside the recorder set.
 */
export function selectDisplayMediaSource<T extends DisplayMediaSourceLike>(
  sources: readonly T[],
  assignedDisplayId: string | undefined,
  primaryDisplayId: string,
): T | undefined {
  if (assignedDisplayId !== undefined) {
    return sources.find((source) => source.display_id === assignedDisplayId)
  }
  return (
    sources.find((source) => source.display_id === primaryDisplayId) ??
    sources[0]
  )
}

/**
 * `--simulate-no-frames` keeps its original all-display behaviour.
 * `--simulate-no-frames=<display-id>` isolates the failure to one recorder so
 * QA can prove that healthy displays continue recording.
 */
export function shouldSimulateNoFrames(
  argv: readonly string[],
  displayId: string,
): boolean {
  return (
    argv.includes('--simulate-no-frames') ||
    argv.includes(`--simulate-no-frames=${displayId}`)
  )
}
