/**
 * The narrow clipboard contract used by main-process copy actions.
 *
 * Electron's writeText() has no result. On Windows it can lose a short race
 * with another clipboard owner without giving the caller anything useful to
 * display, so a write is only successful once the same text can be read back.
 * Retries stay deliberately short: they cover transient ownership contention
 * without overwriting something the user intentionally copies later.
 */
export interface ClipboardTextPort {
  writeText(text: string): void
  readText(): string
}

export interface ClipboardWriteResult {
  ok: boolean
  attempts: number
}

/**
 * Main closes over the decoded NativeImage it intends to write; the shared
 * verifier only needs a deterministic pixel read-back for race recovery and
 * unit tests.
 */
export interface ClipboardImageSnapshot {
  width: number
  height: number
  pixels: Uint8Array
}

export interface ClipboardImagePort {
  writeImage(): void
  readImage(): ClipboardImageSnapshot
}

export const CLIPBOARD_RETRY_DELAYS_MS = [0, 20, 60] as const

type Wait = (delayMs: number) => Promise<void>

function defaultWait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

export async function writeClipboardTextVerified(
  port: ClipboardTextPort,
  text: string,
  wait: Wait = defaultWait,
): Promise<ClipboardWriteResult> {
  let attempts = 0
  for (const delayMs of CLIPBOARD_RETRY_DELAYS_MS) {
    if (delayMs > 0) await wait(delayMs)
    attempts += 1
    try {
      port.writeText(text)
      if (port.readText() === text) return { ok: true, attempts }
    } catch {
      // A clipboard owner can reject either operation briefly. The bounded
      // retry below is the recovery path; callers receive one honest result.
    }
  }
  return { ok: false, attempts }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let i = 0; i < left.byteLength; i += 1) {
    if (left[i] !== right[i]) return false
  }
  return true
}

export async function writeClipboardImageVerified(
  port: ClipboardImagePort,
  expected: ClipboardImageSnapshot,
  wait: Wait = defaultWait,
): Promise<ClipboardWriteResult> {
  let attempts = 0
  for (const delayMs of CLIPBOARD_RETRY_DELAYS_MS) {
    if (delayMs > 0) await wait(delayMs)
    attempts += 1
    try {
      port.writeImage()
      const actual = port.readImage()
      if (
        actual.width === expected.width &&
        actual.height === expected.height &&
        sameBytes(actual.pixels, expected.pixels)
      ) {
        return { ok: true, attempts }
      }
    } catch {
      // Same bounded contention recovery as text. A failed final-image action
      // never changes the already-saved pack.
    }
  }
  return { ok: false, attempts }
}
