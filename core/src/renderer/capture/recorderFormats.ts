import { normalizeCaptureFps } from '../../shared/types'

export interface RecorderFormat {
  /** Public replay MIME; bytes written to a pack always match it. */
  mimeType: string
  /** Internal AVC transport, remuxed before any replay decoder or pack sees it. */
  recordingMimeType?: string
  replayFile: 'replay.webm' | 'replay.mp4'
  strategy: 'fragmented-mp4' | 'dual-slot-webm'
}

/**
 * Keep each independently muxed MP4 fragment inside the same three-frame
 * uncertainty budget used by the field cadence gate. Every supported rate
 * retains three nominal frames per fragment, with a 100 ms floor at 30 fps.
 * That avoids an every-frame IDR while keeping a full ring from losing more
 * than three frames at its privacy-safe whole-fragment cutoff.
 */
export function mp4FragmentIntervalMs(fps: number): number {
  const boundedFps = normalizeCaptureFps(fps)
  return Math.max(100, Math.floor(3_000 / boundedFps))
}

/**
 * Keep the platform AVC encoder, but own the MP4 muxer: Chromium's internal
 * Matroska stream avoids its uint32 MP4 output-position lifetime. The bounded
 * AVC remuxer produces replay.mp4; Matroska is never mislabeled as WebM or saved
 * in a pack. The existing legal VP8/VP9 WebM fallback remains available.
 */
export const RECORDER_FORMATS: readonly RecorderFormat[] = [
  {
    mimeType: 'video/mp4;codecs=avc1',
    recordingMimeType: 'video/x-matroska;codecs=avc1',
    replayFile: 'replay.mp4',
    strategy: 'fragmented-mp4',
  },
  {
    mimeType: 'video/webm;codecs=vp8',
    replayFile: 'replay.webm',
    strategy: 'dual-slot-webm',
  },
  {
    mimeType: 'video/webm;codecs=vp9',
    replayFile: 'replay.webm',
    strategy: 'dual-slot-webm',
  },
]

export function pickRecorderFormat(
  isTypeSupported: (mimeType: string) => boolean,
): RecorderFormat | null {
  for (const candidate of RECORDER_FORMATS) {
    if (!isTypeSupported(candidate.recordingMimeType ?? candidate.mimeType)) continue
    return candidate
  }
  return null
}
