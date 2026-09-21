export const REPLAY_NAME_RE = /^replay\.(webm|mp4)$/
export const DISPLAY_REPLAY_NAME_RE = /^replay-d[1-9][0-9]*\.(webm|mp4)$/

/** MIME type implied by a validated top-level or per-display replay filename. */
export function replayMimeType(declared: string | null | undefined): string {
  const replayFile =
    typeof declared === 'string' &&
    (REPLAY_NAME_RE.test(declared) || DISPLAY_REPLAY_NAME_RE.test(declared))
      ? declared
      : 'replay.webm'
  return replayFile.endsWith('.mp4') ? 'video/mp4' : 'video/webm'
}
