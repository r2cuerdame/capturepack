import { normalizeCaptureFps } from '../../shared/types'

export interface RecorderFormat {
  mimeType: string
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

interface UnsupportedRecorderFormat {
  mimeType: string
  strategy: 'unsupported-container'
}

/**
 * Probe hardware-friendly platform AVC first. Matroska/AVC remains in the
 * capability order because Chromium exposes it on some Windows builds, but it
 * can never be selected: H.264 is not WebM-compatible and CapturePack has no
 * legal replay.mkv media name. The legal fallback is VP8/VP9 in WebM.
 */
export const RECORDER_FORMATS: readonly (
  | RecorderFormat
  | UnsupportedRecorderFormat
)[] = [
  {
    mimeType: 'video/mp4;codecs=avc1',
    replayFile: 'replay.mp4',
    strategy: 'fragmented-mp4',
  },
  {
    mimeType: 'video/x-matroska;codecs=avc1',
    strategy: 'unsupported-container',
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
    if (!isTypeSupported(candidate.mimeType)) continue
    // This candidate intentionally has no replayFile at all: Matroska/AVC must
    // never exist in memory as a purported replay.webm pairing.
    if (candidate.strategy === 'unsupported-container') continue
    return candidate
  }
  return null
}
