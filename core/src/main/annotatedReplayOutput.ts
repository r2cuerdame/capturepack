import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { displayAnnotatedName } from '../shared/keyframes'

/** Filename used by both the renderer's disk write and the manifest declaration. */
export function annotatedReplayOutputName(
  replayMimeType: string,
  display?: number,
): string {
  const replayFile =
    replayMimeType.split(';', 1)[0]?.trim().toLowerCase() === 'video/mp4'
      ? 'replay.mp4'
      : 'replay.webm'
  return display === undefined
    ? `replay_annotated.${replayFile.endsWith('.mp4') ? 'mp4' : 'webm'}`
    : displayAnnotatedName(display, replayFile)
}

/** Persist the encoded annotated replay under its container-matched filename. */
export async function writeAnnotatedReplayOutput(
  dirPath: string,
  replay: Uint8Array,
  replayMimeType: string,
  display?: number,
): Promise<string> {
  const file = annotatedReplayOutputName(replayMimeType, display)
  await writeFile(path.join(dirPath, file), replay)
  return file
}
