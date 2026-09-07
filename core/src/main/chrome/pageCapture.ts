import { nativeImage } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Settings, TimelineFile } from '../../shared/types'
import { uiLanguage } from '../locale'
import { logInfo } from '../log'
import {
  addManifestPlugin,
  domEventForPack,
  domPluginDeclaration,
  savePack,
  writeDomPlugin,
  type DomPluginPayload,
  type PackHandle,
} from '../exporter'
import {
  exportWindowsContextTimeline,
  type WindowsContextTimelineV1,
} from '../context/windowsContextTimeline'
import {
  BROWSER_PAGE_SURFACE_ID,
  DOM_PROTOCOL_VERSION,
  type BrowserPageCapture,
  type DomEvent,
} from './domBridge'

const MAX_BITMAP_BYTES = 160 * 1024 * 1024

export function browserPageCaptureContext(
  capture: BrowserPageCapture,
  rasterWidth: number,
  rasterHeight: number,
  rasterScale = capture.geometry.deviceScaleFactor,
): { event: DomEvent; windowsContext: WindowsContextTimelineV1 } {
  // This event describes a document raster, not the browser's on-screen
  // viewport. Giving it the raster's effective CSS extent lets the ordinary
  // Chrome DOM provider map document-space rectangles straight onto the saved
  // image without inventing a second editor or candidate path.
  const event: DomEvent = {
    tMs: 0,
    type: 'dom.document.captured',
    tab: capture.tab,
    viewport: {
      width: rasterWidth / rasterScale,
      height: rasterHeight / rasterScale,
      dpr: rasterScale,
      screenX: 0,
      screenY: 0,
      outerWidth: rasterWidth / rasterScale,
      outerHeight: rasterHeight / rasterScale,
    },
    document: capture.document,
  }
  const bounds = { x: 0, y: 0, width: rasterWidth, height: rasterHeight }
  const windowsContext = exportWindowsContextTimeline([{
    tMs: 0,
    windows: [{
      surface_id: BROWSER_PAGE_SURFACE_ID,
      title: capture.tab.title,
      process: 'chrome',
      class_name: 'Chrome_WidgetWin_1',
      bounds,
      client_bounds: bounds,
      display: 1,
      focused: true,
      z: 0,
      hasControls: false,
      tree: 'unavailable',
    }],
    elements: [],
  }])
  if (windowsContext === null) throw new Error('full-page browser surface could not be encoded')
  return { event, windowsContext }
}

function axisPositions(length: number, viewport: number): number[] {
  if (length <= viewport) return [0]
  const positions: number[] = []
  for (let value = 0; value < length - viewport; value += viewport) positions.push(value)
  const last = length - viewport
  if (positions[positions.length - 1] !== last) positions.push(last)
  return positions
}

/** Assemble exact captureVisibleTab rasters without resampling. */
export function composeBrowserPageCapture(capture: BrowserPageCapture): {
  png: Buffer
  width: number
  height: number
  scale: number
} {
  const first = capture.tiles[0]
  if (first === undefined) throw new Error('page capture has no tiles')
  const firstImage = nativeImage.createFromBuffer(first.png)
  const firstSize = firstImage.getSize()
  if (firstImage.isEmpty() || firstSize.width <= 0 || firstSize.height <= 0) {
    throw new Error('page capture tile is unreadable')
  }
  const scaleX = firstSize.width / capture.geometry.viewportWidth
  const scaleY = firstSize.height / capture.geometry.viewportHeight
  const tolerance = Math.max(scaleX, scaleY, 1) * 0.02
  if (Math.abs(scaleX - scaleY) > tolerance) {
    throw new Error(`page tile scale differs by axis (${scaleX} vs ${scaleY})`)
  }
  const scale = (scaleX + scaleY) / 2
  if (Math.abs(scale - capture.geometry.deviceScaleFactor) > tolerance) {
    throw new Error(
      `page tile scale ${scale} disagrees with deviceScaleFactor ` +
      `${capture.geometry.deviceScaleFactor}`,
    )
  }
  const width = Math.round(capture.geometry.documentWidth * scale)
  const height = Math.round(capture.geometry.documentHeight * scale)
  const bytes = width * height * 4
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_BITMAP_BYTES) {
    throw new Error(`full-page bitmap ${width}x${height} exceeds the 160 MiB safety bound`)
  }

  const expected = axisPositions(
    capture.geometry.documentHeight,
    capture.geometry.viewportHeight,
  ).flatMap((y) => axisPositions(
    capture.geometry.documentWidth,
    capture.geometry.viewportWidth,
  ).map((x) => ({ x, y })))
  if (expected.length !== capture.tiles.length) {
    throw new Error(`page tile count ${capture.tiles.length} does not match geometry ${expected.length}`)
  }

  // Opaque black makes an impossible gap obvious. A complete, validated grid
  // overwrites every document pixel with captured page pixels.
  const bitmap = Buffer.alloc(bytes)
  for (let offset = 3; offset < bitmap.length; offset += 4) bitmap[offset] = 255
  for (let index = 0; index < capture.tiles.length; index += 1) {
    const tile = capture.tiles[index]
    const wanted = expected[index]
    if (tile === undefined || wanted === undefined) throw new Error('page tile sequence is incomplete')
    if (Math.abs(tile.x - wanted.x) > 2 || Math.abs(tile.y - wanted.y) > 2) {
      throw new Error(
        `page tile ${index} landed at ${tile.x},${tile.y}; expected ${wanted.x},${wanted.y}`,
      )
    }
    const image = nativeImage.createFromBuffer(tile.png)
    const size = image.getSize()
    if (
      image.isEmpty() ||
      Math.abs(size.width - firstSize.width) > 1 ||
      Math.abs(size.height - firstSize.height) > 1
    ) {
      throw new Error(`page tile ${index} has an inconsistent raster size`)
    }
    const source = image.toBitmap()
    const destinationX = Math.round(tile.x * scale)
    const destinationY = Math.round(tile.y * scale)
    const copyWidth = Math.min(size.width, width - destinationX)
    const copyHeight = Math.min(size.height, height - destinationY)
    if (destinationX < 0 || destinationY < 0 || copyWidth <= 0 || copyHeight <= 0) {
      throw new Error(`page tile ${index} falls outside the document bitmap`)
    }
    for (let row = 0; row < copyHeight; row += 1) {
      source.copy(
        bitmap,
        ((destinationY + row) * width + destinationX) * 4,
        row * size.width * 4,
        (row * size.width + copyWidth) * 4,
      )
    }
  }
  const image = nativeImage.createFromBitmap(bitmap, { width, height })
  const outputSize = image.getSize()
  if (image.isEmpty() || outputSize.width !== width || outputSize.height !== height) {
    throw new Error('assembled full-page bitmap could not be encoded')
  }
  return { png: image.toPNG(), width, height, scale }
}

/** Reuses the ordinary save-first image pack and chrome-dom contracts. */
export async function saveBrowserPageCapture(
  capture: BrowserPageCapture,
  settings: Settings,
): Promise<PackHandle> {
  const assembled = composeBrowserPageCapture(capture)
  const browserContext = browserPageCaptureContext(
    capture,
    assembled.width,
    assembled.height,
    assembled.scale,
  )
  const timeline: TimelineFile = {
    t0: capture.capturedAt.toISOString(),
    events: [{
      t_ms: 0,
      type: 'core.image.capture.triggered',
      source: 'core',
      data: {
        hotkey: 'chrome.action',
        scope: 'fullscreen',
        source: 'chrome-full-page',
        url: capture.tab.url,
        document_width_css: capture.geometry.documentWidth,
        document_height_css: capture.geometry.documentHeight,
        viewport_width_css: capture.geometry.viewportWidth,
        viewport_height_css: capture.geometry.viewportHeight,
        device_scale_factor: capture.geometry.deviceScaleFactor,
        original_scroll_x: capture.geometry.originalScrollX,
        original_scroll_y: capture.geometry.originalScrollY,
        tiles: capture.tiles.length,
      },
    }],
  }
  const handle = await savePack({
    captureKind: 'image',
    imageScope: 'fullscreen',
    snapshotPng: assembled.png,
    width: assembled.width,
    height: assembled.height,
    capturedAt: capture.capturedAt,
    replayWebm: null,
    replayDurationMs: 0,
    timeline,
    outputDir: settings.outputDir,
    screens: [{
      width: capture.geometry.documentWidth,
      height: capture.geometry.documentHeight,
      scale: capture.geometry.deviceScaleFactor,
    }],
    windowsContext: browserContext.windowsContext,
    imageContextMode: 'browser-page',
    docLanguage: uiLanguage(settings),
  })
  // savePack normally treats temporal context as optional. For this bundle the
  // synthetic page surface is what makes the required DOM usable in the normal
  // editor, so its absence is a capture failure rather than a silent downgrade.
  await readFile(join(handle.dirPath, 'plugins', 'windows-context', 'timeline.json'), 'utf8')

  const payload: DomPluginPayload = {
    protocol: DOM_PROTOCOL_VERSION,
    extension_version: capture.extensionVersion,
    events: [domEventForPack(browserContext.event, 0, 0)],
  }
  // Unlike ambient browser context on a desktop capture, DOM is a required
  // half of this explicit toolbar bundle. A failed write must fail honestly;
  // reporting a PNG-only pack as a successful full-page capture would lie.
  await writeDomPlugin(handle.dirPath, payload)
  await addManifestPlugin(handle, domPluginDeclaration(), uiLanguage(settings))
  logInfo(
    `[chrome] full-page CapturePack saved: ${assembled.width}x${assembled.height}, ` +
    `${capture.document.elements.length} DOM element(s), ${capture.tiles.length} tile(s)`,
  )
  return handle
}
