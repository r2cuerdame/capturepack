// Newline-delimited UTF-8 off a pipe, without breaking characters (#549).
//
// A pipe delivers bytes in whatever pieces the kernel chose, and a long page
// header or a six-window DOM reply arrives as dozens of them. Turning each piece
// into a string on its own — `chunk.toString('utf8')` — breaks every character
// whose two to four bytes happen to straddle a boundary: both halves decode to
// U+FFFD and the pack keeps the damage for good (a Korean title, an emoji in a
// button label, a typographic dash).
//
// SPLIT ON BYTES, DECODE WHOLE LINES. 0x0A never occurs inside a multibyte
// UTF-8 sequence, so a line cut at the newline byte is always whole and can be
// decoded in one go. That also lets the bound be counted in bytes, exactly, and
// keeps the work linear: only the newly arrived piece is searched for a newline,
// never everything held so far.
//
// THE BOUND. A peer that never sends a newline must not grow this without
// limit. A line longer than `maxBytes` — finished or still arriving — is the
// peer misbehaving: the reader drops everything it holds, reports the overflow
// once and ignores further input until it is reset. The caller hangs up.

export interface Utf8LineReaderOptions {
  /** The longest line, in bytes and without its newline, that is accepted. */
  readonly maxBytes: number
  /** One complete line, decoded, without its newline. */
  readonly onLine: (line: string) => void
  /** Called once when a line exceeds `maxBytes`; the caller should hang up. */
  readonly onOverflow: () => void
}

export interface Utf8LineReader {
  /** Feeds the next piece of the stream. */
  push(chunk: Buffer): void
  /** Drops any unterminated tail and clears an overflow, e.g. on close. */
  reset(): void
  /** Bytes held for a line whose newline has not arrived yet. */
  readonly pendingBytes: number
}

const NEWLINE = 0x0a

export function createUtf8LineReader(options: Utf8LineReaderOptions): Utf8LineReader {
  const { maxBytes, onLine, onOverflow } = options
  let held: Buffer[] = []
  let heldBytes = 0
  let overflowed = false

  const overflow = (): void => {
    held = []
    heldBytes = 0
    overflowed = true
    onOverflow()
  }

  return {
    push(chunk: Buffer): void {
      if (overflowed) return
      let start = 0
      let cut = chunk.indexOf(NEWLINE, start)
      while (cut !== -1) {
        if (heldBytes + (cut - start) > maxBytes) {
          overflow()
          return
        }
        const tail = chunk.subarray(start, cut)
        const line = held.length === 0
          ? tail.toString('utf8')
          : Buffer.concat([...held, tail], heldBytes + tail.length).toString('utf8')
        held = []
        heldBytes = 0
        start = cut + 1
        onLine(line)
        cut = chunk.indexOf(NEWLINE, start)
      }
      if (start < chunk.length) {
        if (heldBytes + (chunk.length - start) > maxBytes) {
          overflow()
          return
        }
        // A copy, so a held tail never pins or aliases the caller's buffer.
        held.push(Buffer.from(chunk.subarray(start)))
        heldBytes += chunk.length - start
      }
    },
    reset(): void {
      held = []
      heldBytes = 0
      overflowed = false
    },
    get pendingBytes(): number {
      return heldBytes
    },
  }
}
