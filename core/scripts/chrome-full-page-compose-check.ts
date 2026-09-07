import { app, nativeImage } from 'electron'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  browserPageCaptureContext,
  composeBrowserPageCapture,
  saveBrowserPageCapture,
} from '../src/main/chrome/pageCapture'
import type { BrowserPageCapture } from '../src/main/chrome/domBridge'
import { openPackContextSession, readPackObjectContext } from '../src/main/context/packObjects'
import { saveAsNewPack, updatePack } from '../src/main/exporter'
import { loadSettings } from '../src/main/settings'

function tile(red: number, green: number, blue: number, width = 2, height = 2): Buffer {
  const bitmap = Buffer.alloc(width * height * 4)
  for (let offset = 0; offset < bitmap.length; offset += 4) {
    bitmap[offset] = blue
    bitmap[offset + 1] = green
    bitmap[offset + 2] = red
    bitmap[offset + 3] = 255
  }
  return nativeImage.createFromBitmap(bitmap, { width, height }).toPNG()
}

void app.whenReady().then(async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'capturepack-full-page-compose-'))
  let exitCode = 0
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
        elements: [{
          i: 0,
          tag: 'button',
          role: 'button',
          bounds: { x: 0, y: 2, width: 2, height: 2 },
          text: 'Save',
        }],
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

    const saved = await saveBrowserPageCapture(capture, {
      ...loadSettings().settings,
      outputDir,
    })
    const packContext = readPackObjectContext(saved.dirPath)
    if (packContext === null || packContext.history.length === 0 || packContext.domEvents.length === 0) {
      throw new Error('browser context did not survive savePack and pack reload')
    }
    const session = openPackContextSession(packContext)
    const frame = await session.frameAt(0)
    const candidate = frame.displays[0]?.candidates.find((item) => item.providerId === 'chrome-dom')
    if (
      candidate?.name !== 'Save' ||
      candidate.bounds.x !== 0 ||
      candidate.bounds.y !== 2 ||
      candidate.bounds.width !== 2 ||
      candidate.bounds.height !== 2
    ) {
      throw new Error(`full-page DOM did not reach the editor context session: ${JSON.stringify(candidate)}`)
    }
    console.log('PASS — Chrome full-page context: saved pack reopens through the normal editor session')

    const savedManifest = JSON.parse(readFileSync(join(saved.dirPath, 'manifest.json'), 'utf8'))
    const savedBrowserContext = browserPageCaptureContext(
      capture,
      result.width,
      result.height,
      result.scale,
    )
    const reeditInput = {
      captureKind: 'image' as const,
      imageScope: 'fullscreen' as const,
      imageContextMode: 'browser-page' as const,
      snapshotPng: result.png,
      width: result.width,
      height: result.height,
      capturedAt: capture.capturedAt,
      replayWebm: null,
      replayDurationMs: 0,
      annotations: [],
      title: 'Re-edited full page',
      note: '',
      snapshotTMs: null,
      timeline: { t0: capture.capturedAt.toISOString(), events: [] },
      plugins: savedManifest.plugins,
      windowsContext: savedBrowserContext.windowsContext,
      screens: [{ width: 2, height: 4, scale: 1 }],
      clipboardAfterSave: 'off' as const,
    }
    await updatePack(saved, reeditInput, { keepReplay: true })
    const savedAsNew = await saveAsNewPack(saved.dirPath, reeditInput)
    for (const handle of [saved, savedAsNew]) {
      const reopened = readPackObjectContext(handle.dirPath)
      if (reopened === null || reopened.history.length !== 1 || reopened.domEvents.length !== 1) {
        throw new Error('re-edit dropped the browser page context bundle')
      }
      const reopenedCandidate = (await openPackContextSession(reopened).frameAt(0))
        .displays[0]?.candidates.find((item) => item.providerId === 'chrome-dom')
      if (reopenedCandidate?.name !== 'Save') {
        throw new Error('re-edit no longer exposes the saved DOM candidate')
      }
    }
    console.log('PASS — Chrome full-page context: Save and Save As New preserve the DOM bundle')

    const fractional: BrowserPageCapture = {
      ...capture,
      captureId: 'compose-fractional-check',
      geometry: { ...capture.geometry, deviceScaleFactor: 1.49 },
      tiles: [
        { index: 0, x: 0, y: 0, png: tile(255, 0, 0, 3, 3) },
        { index: 1, x: 0, y: 2, png: tile(0, 0, 255, 3, 3) },
      ],
    }
    const fractionalResult = composeBrowserPageCapture(fractional)
    const fractionalContext = browserPageCaptureContext(
      fractional,
      fractionalResult.width,
      fractionalResult.height,
      fractionalResult.scale,
    )
    if (
      fractionalResult.width !== 3 ||
      fractionalResult.height !== 6 ||
      fractionalResult.scale !== 1.5 ||
      fractionalContext.event.viewport?.dpr !== 1.5 ||
      fractionalContext.event.viewport?.height !== 4
    ) {
      throw new Error('fractional DPR did not use the compositor measured raster scale')
    }
    console.log('PASS — Chrome full-page mapping: fractional DPR uses measured raster scale')
  } catch (error) {
    console.error(`FAIL — Chrome full-page composition: ${String(error)}`)
    exitCode = 1
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
    app.exit(exitCode)
  }
})
