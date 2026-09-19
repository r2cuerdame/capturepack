import { closeSync, openSync, readSync } from 'node:fs'

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

/**
 * Measure the raster's declared dimensions, never manifest metadata (SPEC §5.6).
 * Read only the first 24 bytes: signature, IHDR chunk header, width and height.
 * Reopening multi-display 4K packs must not load or decode entire PNGs for this.
 */
export function pngPixelSize(file: string): { width: number; height: number } | null {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const head = Buffer.alloc(24)
    if (readSync(fd, head, 0, head.length, 0) !== head.length) return null
    if (!head.subarray(0, 8).equals(PNG_SIGNATURE)
      || head.readUInt32BE(8) !== 13
      || head.toString('latin1', 12, 16) !== 'IHDR') return null
    const width = head.readUInt32BE(16)
    const height = head.readUInt32BE(20)
    return width > 0 && height > 0 ? { width, height } : null
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
