export interface RecorderFormat {
  mimeType: string
  replayFile: 'replay.webm' | 'replay.mp4'
  strategy: 'fragmented-mp4' | 'dual-slot-webm'
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
