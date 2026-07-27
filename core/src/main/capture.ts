// Main-process side of capture: display-media source selection, the hidden
// recorder window, screenshots, and the replay request/response bridge.
import path from 'node:path'
import { BrowserWindow, desktopCapturer, ipcMain, screen, session } from 'electron'
import type { IpcMainEvent } from 'electron'
import { IPC } from '../shared/ipc'
import type { CaptureReplayResultPayload, CaptureStartPayload } from '../shared/ipc'

// Routes the renderer's getDisplayMedia call to the primary display without a picker.
export function setupDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer
      .getSources({ types: ['screen'] })
      .then((sources) => {
        const primaryId = String(screen.getPrimaryDisplay().id)
        const source = sources.find((s) => s.display_id === primaryId) ?? sources[0]
        callback(source ? { video: source } : {})
      })
      .catch(() => callback({}))
  })
}

export async function createCaptureWindow(opts: {
  fps: number
  segmentSeconds: number
}): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    width: 320,
    height: 240,
    webPreferences: {
      preload: path.join(__dirname, '../preload/capture.js'),
      // Hidden windows get Chromium's intensive timer throttling, which would
      // stall the recorder rotation timers. Keep timers accurate.
      backgroundThrottling: false,
    },
  })

  const onError = (event: IpcMainEvent, message: unknown): void => {
    if (event.sender === win.webContents) {
      console.error(`[capture] recorder failed, continuing screenshot-only: ${String(message)}`)
    }
  }
  ipcMain.on(IPC.captureError, onError)
  win.on('closed', () => ipcMain.removeListener(IPC.captureError, onError))

  await win.loadFile(path.join(__dirname, '../renderer/capture/capture.html'))

  const payload: CaptureStartPayload = {
    sourceId: 'primary',
    fps: opts.fps,
    segmentSeconds: opts.segmentSeconds,
  }
  win.webContents.send(IPC.captureStart, payload)
  return win
}

export async function takeSnapshot(): Promise<{ png: Buffer; width: number; height: number }> {
  const display = screen.getPrimaryDisplay()
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor),
    },
  })
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
  if (!source) throw new Error('no screen source available for snapshot')
  const size = source.thumbnail.getSize()
  return { png: source.thumbnail.toPNG(), width: size.width, height: size.height }
}

// Asks the capture window for the current replay blob. Resolves null on
// timeout or when the renderer reports no footage (empty buffer).
export function requestReplay(
  win: BrowserWindow,
  requestId: string,
  timeoutMs: number,
): Promise<{ buffer: Buffer; durationMs: number } | null> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined

    const onResult = (_event: IpcMainEvent, payload: CaptureReplayResultPayload): void => {
      if (payload.requestId !== requestId) return
      cleanup()
      if (payload.buffer.byteLength === 0) resolve(null)
      else resolve({ buffer: Buffer.from(payload.buffer), durationMs: payload.durationMs })
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      ipcMain.removeListener(IPC.captureReplayResult, onResult)
    }

    if (win.isDestroyed()) {
      resolve(null)
      return
    }
    ipcMain.on(IPC.captureReplayResult, onResult)
    timer = setTimeout(() => {
      cleanup()
      resolve(null)
    }, timeoutMs)
    win.webContents.send(IPC.captureRequestReplay, requestId)
  })
}
