export interface DisplayMediaSourceLike {
  display_id: string
}

export type DisplayMediaRequestFailureStage = 'source-lookup' | 'callback'

/**
 * Resolve and answer one display-media request without ever retrying its
 * one-shot callback. Electron throws when that callback is invoked twice, so
 * callback failures are reported independently from source lookup failures.
 */
export async function completeDisplayMediaRequest<T>(
  sourceForRequest: () => Promise<T | undefined>,
  callback: (response: { video?: T }) => void,
  reportFailure: (stage: DisplayMediaRequestFailureStage, error: unknown) => void,
): Promise<void> {
  const report = (stage: DisplayMediaRequestFailureStage, error: unknown): void => {
    try {
      reportFailure(stage, error)
    } catch {
      // Diagnostics must not prevent the one required callback or turn its
      // failure into an unhandled rejection.
    }
  }

  let source: T | undefined
  try {
    source = await sourceForRequest()
  } catch (error) {
    report('source-lookup', error)
  }

  try {
    callback(source === undefined ? {} : { video: source })
  } catch (error) {
    report('callback', error)
  }
}

export interface SnapshotThumbnailLike {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  toPNG(): Buffer
}

export interface SnapshotSourceLike extends DisplayMediaSourceLike {
  thumbnail: SnapshotThumbnailLike
}

export type DisplaySnapshotReadResult =
  | { ok: true; snapshot: { png: Buffer; width: number; height: number } }
  | {
      ok: false
      reason: 'source-unavailable' | 'thumbnail-empty' | 'invalid-size' | 'empty-png' | 'read-failed'
      error?: unknown
    }

export function displaySnapshotFailureMessage(
  failure: Extract<DisplaySnapshotReadResult, { ok: false }>,
): string {
  switch (failure.reason) {
    case 'source-unavailable':
      return 'desktop source disappeared'
    case 'thumbnail-empty':
      return 'thumbnail is empty'
    case 'invalid-size':
      return 'thumbnail has zero or invalid dimensions'
    case 'empty-png':
      return 'thumbnail encoded to an empty PNG'
    case 'read-failed':
      return 'thumbnail could not be read'
  }
}

/**
 * Read one exact display source into a snapshot, failing closed before invalid
 * image bytes can reach the editor. A missing source is never replaced with a
 * different display's pixels.
 */
export function readDisplaySnapshot(
  sources: readonly SnapshotSourceLike[],
  displayId: string,
): DisplaySnapshotReadResult {
  const source = sources.find((candidate) => candidate.display_id === displayId)
  if (source === undefined) return { ok: false, reason: 'source-unavailable' }

  try {
    if (source.thumbnail.isEmpty()) return { ok: false, reason: 'thumbnail-empty' }
    const { width, height } = source.thumbnail.getSize()
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width <= 0 ||
      height <= 0
    ) {
      return { ok: false, reason: 'invalid-size' }
    }
    const png = source.thumbnail.toPNG()
    if (png.length === 0) return { ok: false, reason: 'empty-png' }
    return { ok: true, snapshot: { png, width, height } }
  } catch (error) {
    return { ok: false, reason: 'read-failed', error }
  }
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
