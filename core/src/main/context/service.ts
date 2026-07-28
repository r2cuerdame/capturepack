// The Electron shell around the context session: one session per editor window,
// the invoke handler the editor asks frames on, and the push for a frame Core
// produced on its own.
//
// WHY A FRAME AND NOT A HIT TEST PER POINTER MOVE. Hovering costs nothing per
// frame today (a couple of array scans in the renderer) and must keep costing
// nothing. A per-point IPC round trip would make it cost a message per pixel of
// pointer travel, so Core answers with the CANDIDATE SET at one time (design
// GAP 7) and the editor indexes it locally. The scrub position is what changes
// the answer, and the editor asks again when it settles.
import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { ContextFrameRequest } from '../../shared/ipc'
import type { ContextFrame } from '../../shared/context/protocol'
import { logError, logInfo, logWarn } from '../log'
import { ContextSession } from './session'
import type { ContextSessionOptions } from './session'

export { ContextSession } from './session'
export type { ContextDisplayTarget, ContextSessionOptions } from './session'

let sessionCounter = 0
let ipcReady = false
const sessions = new Map<number, ContextSession>()

/**
 * Opens the session for one editor window and wires its teardown. The invoke
 * handler is registered once, lazily: the context service only exists when an
 * editor does, and a permanent handler for a window that may never open is the
 * kind of listener that outlives its owner.
 */
export function openContextSession(
  win: BrowserWindow,
  options: Omit<ContextSessionOptions, 'onWarn'>,
): ContextSession {
  ensureIpc()
  sessionCounter += 1
  const session = new ContextSession(`ctx${sessionCounter}`, {
    ...options,
    onWarn: (message) => logWarn(`capturepack: ${message}`),
  })
  const id = win.webContents.id
  sessions.set(id, session)
  win.once('closed', () => {
    sessions.delete(id)
  })
  return session
}

/** Pushes a replacement frame at a time the editor is expected to be on. */
export function pushContextFrame(
  win: BrowserWindow,
  session: ContextSession,
  timeMs: number,
): void {
  void session
    .frameAt(timeMs)
    .then((frame) => {
      if (win.isDestroyed()) return
      win.webContents.send(IPC.contextFrame, frame)
    })
    // Rule 1: object data may never be able to fail a capture, and an unhandled
    // rejection in main is an uncaughtException.
    .catch((err: unknown) => {
      logError('capturepack: context: pushing a frame to the editor failed:', err)
    })
}

function ensureIpc(): void {
  if (ipcReady) return
  ipcReady = true
  ipcMain.handle(
    IPC.contextRequestFrame,
    async (event, raw: unknown): Promise<ContextFrame | null> => {
      const session = sessions.get(event.sender.id)
      if (session === undefined) return null
      // The renderer is untrusted input like any other IPC sender: a request
      // naming another session, or carrying a time that is not a number, is
      // refused rather than answered from whatever this window happens to own.
      const request = raw as Partial<ContextFrameRequest>
      if (typeof request.timeMs !== 'number' || !Number.isFinite(request.timeMs)) return null
      if (request.sessionId !== session.sessionId) return null
      try {
        return await session.frameAt(request.timeMs)
      } catch (err) {
        logError('capturepack: context: building a frame failed:', err)
        return null
      }
    },
  )
  logInfo('[context] surface resolver ready')
}
