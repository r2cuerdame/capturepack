// The Chrome native messaging host (GOAL "Chrome Extension", Phase 1).
//
// WHY THIS IS THE SAME EXECUTABLE. Chrome starts a native messaging host as a
// child process of the BROWSER, not of CapturePack — one per extension port,
// killed when the port closes. So the host cannot be the app: the app is a
// single-instance tray process that outlives every browser, holds the replay
// buffer, and must not be started or stopped by a page navigation.
//
// Shipping a second binary to bridge them would mean a second thing to build,
// sign, version and keep in step with the protocol. Instead the app IS the
// host, in a mode: `capturepack.exe --native-host` reads Chrome's frames on
// stdin and relays them down a named pipe to the running app. One executable,
// one version number, and a host that cannot drift from the app it speaks for.
//
// A NAMED PIPE, NOT A PORT. The other end is local by construction — no port
// to collide with (the MCP server already lost that argument once), no
// firewall prompt, and nothing reachable from the network. On Windows a pipe
// path is also namespaced per user, so two accounts on one machine do not
// share a channel.
//
// This mode NEVER opens a window, takes the single-instance lock, or touches
// settings. Chrome may run several of them at once, and an app that fought its
// own host processes for the lock would deadlock the browser.
import * as fs from 'node:fs'
import * as net from 'node:net'

/** The pipe the running app listens on; the host dials it. */
export function domPipePath(): string {
  // The user name keeps two accounts on one machine off each other's channel.
  const who = process.env['USERNAME'] ?? process.env['USER'] ?? 'user'
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\capturepack-dom-${who}`
    : `/tmp/capturepack-dom-${who}.sock`
}

/** One frame out, whole, on the descriptor Chrome is reading. */
function writeFrame(buffer: Buffer): void {
  let written = 0
  while (written < buffer.length) {
    written += fs.writeSync(1, buffer, written, buffer.length - written)
  }
}

/** Chrome's framing: a 32-bit little-endian length, then that many UTF-8 bytes. */
function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length, 0)
  return Buffer.concat([head, body])
}

/**
 * Chrome caps a host message at 64 MB; a DOM element report is a few hundred
 * bytes. Anything approaching this is not a message from our extension, and
 * reading it would mean allocating on a stranger's say-so.
 */
const MAX_FRAME_BYTES = 1024 * 1024

/**
 * Runs the process as Chrome's native messaging host until stdin closes.
 *
 * Returns a promise that settles when the browser hangs up, so the caller can
 * exit with the process having done exactly one job.
 */
export function runNativeHostMode(): Promise<void> {
  return new Promise<void>((resolve) => {
    let pending = Buffer.alloc(0)
    let pipe: net.Socket | null = null
    let queued: string[] = []
    let done = false

    const finish = (): void => {
      if (done) return
      done = true
      pipe?.end()
      resolve()
    }

    // The app may not be running, or may start later. A host that failed hard
    // would make Chrome show the extension as broken for the rest of the
    // session; instead the messages queue, and a dial is retried on the next
    // one. Nothing is lost that the browser would have kept anyway.
    const send = (line: string): void => {
      if (pipe !== null && !pipe.destroyed) {
        pipe.write(`${line}\n`)
        return
      }
      queued.push(line)
      if (queued.length > 200) queued.shift()
      dial()
    }

    let dialling = false
    const dial = (): void => {
      if (dialling || done) return
      dialling = true
      const socket = net.connect(domPipePath())
      socket.on('connect', () => {
        dialling = false
        pipe = socket
        const backlog = queued
        queued = []
        for (const line of backlog) socket.write(`${line}\n`)
      })
      socket.on('error', () => {
        dialling = false
        pipe = null
        socket.destroy()
      })
      socket.on('close', () => {
        if (pipe === socket) pipe = null
      })
      // Anything the app says goes back to the extension, framed.
      let inbound = ''
      socket.on('data', (chunk: Buffer) => {
        inbound += chunk.toString('utf8')
        let cut = inbound.indexOf('\n')
        while (cut !== -1) {
          const line = inbound.slice(0, cut)
          inbound = inbound.slice(cut + 1)
          if (line.trim() !== '') {
            try {
              writeFrame(frame(JSON.parse(line)))
            } catch {
              // A line the app did not mean as JSON is not worth relaying.
            }
          }
          cut = inbound.indexOf('\n')
        }
      })
    }

    // FILE DESCRIPTORS, NOT process.stdin/stdout.
    //
    // In an Electron main process on Windows `process.stdin` is already ended
    // when the app starts — measured: the host exited 0 within a second of
    // launch, having read nothing, because 'end' fired immediately. Chrome
    // would have seen a host that starts and dies, which is indistinguishable
    // from a host that is not installed. Reading fd 0 directly gives the pipe
    // the browser actually handed us, and writing fd 1 synchronously keeps
    // frames whole and in order on the way back.
    const stdin = fs.createReadStream('', { fd: 0 })

    stdin.on('data', (chunk: string | Buffer) => {
      onChunk(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk)
    })
    stdin.on('end', finish)
    stdin.on('error', finish)

    function onChunk(chunk: Buffer): void {
      pending = Buffer.concat([pending, chunk])
      for (;;) {
        if (pending.length < 4) return
        const length = pending.readUInt32LE(0)
        if (length > MAX_FRAME_BYTES) {
          // Not our extension. Hanging up is the only safe answer.
          finish()
          return
        }
        if (pending.length < 4 + length) return
        const body = pending.subarray(4, 4 + length).toString('utf8')
        pending = pending.subarray(4 + length)
        send(body)
      }
    }

    dial()
  })
}
