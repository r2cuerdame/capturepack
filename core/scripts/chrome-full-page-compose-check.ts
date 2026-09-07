import { app, nativeImage } from 'electron'
import { composeBrowserPageCapture } from '../src/main/chrome/pageCapture'
import type { BrowserPageCapture } from '../src/main/chrome/domBridge'

function tile(red: number, green: number, blue: number): Buffer {
  const bitmap = Buffer.alloc(2 * 2 * 4)
  for (let offset = 0; offset < bitmap.length; offset += 4) {
    bitmap[offset] = blue
    bitmap[offset + 1] = green
    bitmap[offset + 2] = red
    bitmap[offset + 3] = 255
  }
  return nativeImage.createFromBitmap(bitmap, { width: 2, height: 2 }).toPNG()
}

void app.whenReady().then(() => {
  try {
    const capture: BrowserPageCapture = {
      captureId: 'compose-check',
      extensionVersion: '0.4.0',
      tabId: 1,
      tab: { url: 'https://example.test/long', title: 'Long page' },
      capturedAt: new Date('2026-09-07T00:00:00Z'),
      geometry: {
        documentWidth: 2,
        documentHeight: 4,
        viewportWidth: 2,
        viewportHeight: 2,
        deviceScaleFactor: 1,
        originalScrollX: 0,
        originalScrollY: 1,
      },
      document: {
        viewport: {
          width: 2,
          height: 4,
          devicePixelRatio: 1,
          scrollX: 0,
          scrollY: 0,
        },
        url: 'https://example.test/long',
        title: 'Long page',
        elements: [],
        truncated: false,
        visitedCount: 0,
        elapsedMs: 0,
        omitted: [],
      },
      tiles: [
        { index: 0, x: 0, y: 0, png: tile(255, 0, 0) },
        { index: 1, x: 0, y: 2, png: tile(0, 0, 255) },
      ],
    }
    const result = composeBrowserPageCapture(capture)
    const decoded = nativeImage.createFromBuffer(result.png)
    const bitmap = decoded.toBitmap()
    const topIsRed = bitmap[2] === 255 && bitmap[1] === 0 && bitmap[0] === 0
    const bottomOffset = 2 * result.width * 4
    const bottomIsBlue = bitmap[bottomOffset] === 255 && bitmap[bottomOffset + 2] === 0
    if (result.width !== 2 || result.height !== 4 || !topIsRed || !bottomIsBlue) {
      throw new Error('composed pixels or dimensions do not match the tile grid')
    }
    console.log('PASS — Chrome full-page composition: exact 2x4 red/blue grid')
    app.exit(0)
  } catch (error) {
    console.error(`FAIL — Chrome full-page composition: ${String(error)}`)
    app.exit(1)
  }
})
