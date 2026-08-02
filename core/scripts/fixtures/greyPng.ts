// A real PNG for a fixture pack, because the readers under test measure the
// RASTER and not the manifest.
//
// `readPackObjectContext` learns a pack's annotation space from `snapshot.png`'s
// IHDR rather than from `snapshot_width`/`snapshot_height` — a declaration that
// disagrees with its own image is a bug it must expose, not inherit. So every
// fixture pack needs a file a PNG decoder would actually accept, and this is the
// one encoder they share: two copies of it would be two definitions of what a
// fixture pack looks like.

import { deflateSync } from 'node:zlib'

/** CRC-32 as PNG chunks carry it. */
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([head, body, tail])
}

/**
 * A real, valid, mid-grey 8-bit greyscale PNG.
 *
 * The reader only needs the IHDR to learn the annotation space, but a fixture
 * that shipped a truncated file would be asserting against a pack no writer
 * could ever produce — and the next person to point an image tool at it would
 * have to work out why. Zero-filled scanlines deflate to a few hundred bytes.
 */
export function greyPng(width: number, height: number): Buffer {
  const raw = Buffer.alloc((width + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0
    raw.fill(0x20, y * (width + 1) + 1, (y + 1) * (width + 1))
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
