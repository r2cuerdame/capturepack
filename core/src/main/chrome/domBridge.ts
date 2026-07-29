// What the browser told us, kept until a capture asks for it (GOAL "Chrome
// Extension", Phase 1).
//
// THE DOM IS NEVER STREAMED. The extension sends a message when the user picks
// an element or the tab changes, and nothing in between — so this is a short
// list of moments, not a feed. That is the whole design: a pack should say
// "the Save button, #save, at these coordinates, on this URL", which is a
// sentence, where a DOM dump is a filing cabinet nobody opens.
//
// Events are held on the REPLAY CLOCK, the same one the surface ring and the
// video agree on (SPEC §10.1), so a DOM element and a window rectangle
// recorded at the same instant carry the same number. An event older than the
// replay is dropped on arrival rather than at freeze: the buffer should cost
// what the replay costs, not what the browsing session does.
import * as fs from 'node:fs'
import * as net from 'node:net'
import { domPipePath } from './nativeHost'
import { logError, logInfo, logWarn } from '../log'

/** The protocol both halves speak (shared/protocol/protocol-v1.schema.json). */
export const DOM_PROTOCOL_VERSION = 1

export interface DomElement {
  tag: string
  selector: string
  /** The element's rectangle in VIEWPORT CSS PIXELS, as the page measures it. */
  bounds: { x: number; y: number; width: number; height: number }
  id?: string
  role?: string
  text?: string
}

/**
 * WHERE THE PAGE'S COORDINATES ARE ON THE SCREEN.
 *
 * `DomElement.bounds` is viewport CSS pixels — the only space a page can
 * measure itself in, and one that says nothing about where the browser window
 * is. Without this, a picked element could not be placed on a snapshot at all,
 * and the editor fell through to the WINDOW rung: picking a button in Chrome
 * drew a box around the whole browser. Sent by the extension since 0.1.4.
 *
 * The app supplies the other half from the surface ring, which records the
 * browser window's CLIENT rectangle. Given the viewport's size in CSS px and
 * the device pixel ratio, its physical size is known — and a viewport is
 * anchored to the BOTTOM of the client area (tab strip and omnibox sit above
 * it), so the vertical offset falls out of the two heights without anyone
 * having to guess at browser chrome.
 */
export interface DomViewport {
  width: number
  height: number
  dpr: number
  /**
   * The window's own screen position as the page sees it, CSS px. A FALLBACK
   * only: on a scaled display Chrome reports these in the OS's scaled space,
   * which is not the snapshot's space, so it is used only when the ring holds
   * no sample of this window. Null when the browser did not report it.
   */
  screenX: number | null
  screenY: number | null
  outerWidth: number | null
  outerHeight: number | null
}

export interface DomEvent {
  /** Milliseconds on the replay clock, at arrival. */
  tMs: number
  type: 'dom.element.selected' | 'tab.updated' | 'url.changed'
  tab: { url: string; title: string }
  element?: DomElement
  /** Present on an element pick from extension 0.1.4 or newer. */
  viewport?: DomViewport
}

/** What Settings > Integrations shows, and what a bug report should quote. */
export interface DomBridgeStatus {
  listening: boolean
  /** A host process has connected at least once this run. */
  hostSeen: boolean
  /** The extension completed a hello handshake. */
  extensionConnected: boolean
  extensionVersion: string | null
  protocolVersion: number | null
  protocolCompatible: boolean
  events: number
  lastEventAtMs: number | null
}

let server: net.Server | null = null
let events: DomEvent[] = []
let retentionMs = 30_000
let hostSeen = false
let extensionVersion: string | null = null
let extensionProtocol: number | null = null
let lastEventAtMs: number | null = null
/** Supplied by the context runtime: "now" on the replay clock. */
let clockNowMs: () => number = () => Date.now()

export function setDomClock(now: () => number): void {
  clockNowMs = now
}

export function setDomRetention(ms: number): void {
  retentionMs = Math.max(1_000, ms)
  prune()
}

function prune(): void {
  const cutoff = clockNowMs() - retentionMs
  if (events.length === 0 || events[0]!.tMs >= cutoff) return
  events = events.filter((e) => e.tMs >= cutoff)
}

/** Every event inside `[startMs, endMs]`, for the pack being written. */
export function domEventsBetween(startMs: number, endMs: number): readonly DomEvent[] {
  return events.filter((e) => e.tMs >= startMs && e.tMs <= endMs)
}

export function domBridgeStatus(): DomBridgeStatus {
  return {
    listening: server !== null,
    hostSeen,
    extensionConnected: extensionVersion !== null,
    extensionVersion,
    protocolVersion: extensionProtocol,
    protocolCompatible: extensionProtocol === DOM_PROTOCOL_VERSION,
    events: events.length,
    lastEventAtMs,
  }
}

/**
 * Reads one protocol message, or null when it is not one.
 *
 * VALIDATED, NOT TRUSTED. This arrives from a browser extension through a pipe
 * any local process can dial. Everything that reaches the pack is checked for
 * shape and clamped for size here, so a malformed or hostile message costs a
 * dropped event rather than a corrupt pack.
 */
function parse(raw: unknown): DomEvent | 'hello' | null {
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  const type = m['type']
  if (m['protocol'] !== DOM_PROTOCOL_VERSION) {
    if (typeof m['protocol'] === 'number') extensionProtocol = m['protocol']
    return null
  }
  if (type === 'host.hello') {
    extensionProtocol = DOM_PROTOCOL_VERSION
    extensionVersion = typeof m['version'] === 'string' ? m['version'].slice(0, 32) : 'unknown'
    return 'hello'
  }
  if (type !== 'dom.element.selected' && type !== 'tab.updated' && type !== 'url.changed') {
    return null
  }
  const tab = m['tab']
  if (typeof tab !== 'object' || tab === null) return null
  const t = tab as Record<string, unknown>
  if (typeof t['url'] !== 'string' || typeof t['title'] !== 'string') return null
  const event: DomEvent = {
    tMs: Math.round(clockNowMs()),
    type,
    // Bounded because a page controls both of these.
    tab: { url: t['url'].slice(0, 2048), title: t['title'].slice(0, 512) },
  }
  const el = m['element']
  if (typeof el === 'object' && el !== null) {
    const e = el as Record<string, unknown>
    const b = e['bounds']
    if (
      typeof e['tag'] === 'string' &&
      typeof e['selector'] === 'string' &&
      typeof b === 'object' &&
      b !== null
    ) {
      const r = b as Record<string, unknown>
      const num = (v: unknown): number | null =>
        typeof v === 'number' && Number.isFinite(v) ? v : null
      const x = num(r['x'])
      const y = num(r['y'])
      const w = num(r['width'])
      const h = num(r['height'])
      if (x !== null && y !== null && w !== null && h !== null) {
        event.element = {
          tag: e['tag'].slice(0, 64),
          selector: e['selector'].slice(0, 512),
          bounds: { x, y, width: w, height: h },
          ...(typeof e['id'] === 'string' ? { id: e['id'].slice(0, 256) } : {}),
          ...(typeof e['role'] === 'string' ? { role: e['role'].slice(0, 64) } : {}),
          ...(typeof e['text'] === 'string' ? { text: e['text'].slice(0, 200) } : {}),
        }
      }
    }
  }
  // The screen anchor, validated exactly as strictly as everything else here:
  // a viewport with a nonsensical size or ratio is DROPPED rather than
  // defaulted, because a default would place the element somewhere plausible
  // and wrong. An event without it still records the pick — it simply cannot
  // be turned into a candidate, which is the pre-0.1.4 behaviour.
  const vp = m['viewport']
  if (typeof vp === 'object' && vp !== null) {
    const v = vp as Record<string, unknown>
    const pos = (k: string): number | null => {
      const n = v[k]
      return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null
    }
    const opt = (k: string): number | null => {
      const n = v[k]
      return typeof n === 'number' && Number.isFinite(n) ? n : null
    }
    const width = pos('width')
    const height = pos('height')
    const dpr = pos('dpr')
    if (width !== null && height !== null && dpr !== null && dpr <= 16) {
      event.viewport = {
        width,
        height,
        dpr,
        screenX: opt('screenX'),
        screenY: opt('screenY'),
        outerWidth: opt('outerWidth'),
        outerHeight: opt('outerHeight'),
      }
    }
  }
  if (type === 'dom.element.selected' && event.element === undefined) return null
  return event
}

/**
 * A pack's `plugins/chrome-dom/elements.json`, read back as events (GAP 9).
 *
 * Re-editing must offer the same document rung the original session did, and
 * the payload on disk is the same vocabulary with one difference: times are
 * `t_ms` on the PACK clock, which is already the clock an editor session runs
 * on, so nothing is rebased.
 *
 * VALIDATED, NOT TRUSTED — a pack is a file a user can edit, move between
 * machines, or receive from someone else. It goes through the SAME `parse()`
 * the wire uses, which is what stops the two paths from drifting into two
 * different ideas of what a valid pick is; a pick that cannot be placed is
 * dropped here rather than allowed to become a rectangle somewhere plausible
 * and wrong.
 */
export function parseDomPayload(text: string | null): DomEvent[] {
  if (text === null) return []
  let raw: unknown
  try {
    raw = JSON.parse(text) as unknown
  } catch {
    return []
  }
  if (typeof raw !== 'object' || raw === null) return []
  const list = (raw as Record<string, unknown>)['events']
  if (!Array.isArray(list)) return []
  const out: DomEvent[] = []
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    const tMs = e['t_ms']
    if (typeof tMs !== 'number' || !Number.isFinite(tMs)) continue
    const parsed = parse({ ...e, protocol: DOM_PROTOCOL_VERSION })
    if (parsed === null || parsed === 'hello') continue
    out.push({ ...parsed, tMs: Math.max(0, Math.round(tMs)) })
  }
  return out
}

/**
 * Starts listening for native hosts.
 *
 * Rule 1 of context data applies here too: a browser that cannot be reached is
 * a pack without DOM context, never an app that failed to start. Every failure
 * below is logged and swallowed.
 */
export function startDomBridge(): void {
  if (server !== null) return
  const pipe = domPipePath()
  // A pipe left behind by a process that died (POSIX only; Windows pipes are
  // kernel objects and vanish with their owner).
  if (process.platform !== 'win32') {
    try {
      fs.unlinkSync(pipe)
    } catch {
      // Nothing to clear.
    }
  }
  const srv = net.createServer((socket) => {
    hostSeen = true
    let buffer = ''
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      // A host that never sends a newline must not grow this without bound.
      if (buffer.length > 4 * 1024 * 1024) {
        socket.destroy()
        return
      }
      let cut = buffer.indexOf('\n')
      while (cut !== -1) {
        const line = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 1)
        if (line.trim() !== '') {
          let parsed: unknown
          try {
            parsed = JSON.parse(line)
          } catch {
            parsed = null
          }
          const result = parse(parsed)
          if (result === 'hello') {
            logInfo(
              `[chrome] extension ${extensionVersion ?? 'unknown'} connected, protocol v${String(extensionProtocol)}`,
            )
            socket.write(
              `${JSON.stringify({ type: 'host.hello', protocol: DOM_PROTOCOL_VERSION, app: 'capturepack' })}\n`,
            )
          } else if (result !== null) {
            events.push(result)
            lastEventAtMs = result.tMs
            prune()
          }
        }
        cut = buffer.indexOf('\n')
      }
    })
    socket.on('error', () => socket.destroy())
  })
  srv.on('error', (err) => {
    // EADDRINUSE means another CapturePack owns the channel — the single
    // instance lock should have prevented that, so it is worth saying.
    logWarn(`[chrome] DOM bridge could not listen: ${err.message}`)
    server = null
  })
  try {
    srv.listen(pipe, () => {
      logInfo('[chrome] DOM bridge listening for the browser extension')
    })
    server = srv
  } catch (err) {
    logError('[chrome] DOM bridge failed to start:', err)
    server = null
  }
}

export function stopDomBridge(): void {
  server?.close()
  server = null
  events = []
  extensionVersion = null
  extensionProtocol = null
  hostSeen = false
  lastEventAtMs = null
}
