import { clipboard } from 'electron'
import { writeClipboardTextVerified } from '../shared/clipboard'
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
