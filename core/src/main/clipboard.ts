import { clipboard, nativeImage } from 'electron'
import {
  writeClipboardImageVerified,
  writeClipboardTextVerified,
} from '../shared/clipboard'
import { logWarn } from './log'

/**
 * Writes and verifies text through one shared path for automatic saves and
 * manual Copy Prompt actions. Never logs the copied text or pack path.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  const result = await writeClipboardTextVerified(clipboard, text)
  if (!result.ok) {
    logWarn(`[clipboard] text copy failed after ${result.attempts} attempt(s)`)
  }
  return result.ok
}

/** Copies the rendered result, never the unannotated source snapshot. */
export async function copyPngToClipboard(png: Buffer): Promise<boolean> {
  const image = nativeImage.createFromBuffer(png)
  if (image.isEmpty()) {
    logWarn('[clipboard] final image copy rejected an invalid PNG')
    return false
  }
  const expectedSize = image.getSize()
  const result = await writeClipboardImageVerified(
    {
      writeImage() {
        clipboard.writeImage(image)
      },
      readImage() {
        const readBack = clipboard.readImage()
        return {
          ...readBack.getSize(),
          pixels: readBack.toBitmap(),
        }
      },
    },
    {
      ...expectedSize,
      pixels: image.toBitmap(),
    },
  )
  if (!result.ok) {
    logWarn(`[clipboard] final image copy failed after ${result.attempts} attempt(s)`)
  }
  return result.ok
}
