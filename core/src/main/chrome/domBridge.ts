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
import { bundledExtensionVersion } from './install'
import { ExtensionConnectionLedger } from './lifecycle'
import { domPipePath } from './nativeHost'
import { logError, logInfo, logWarn } from '../log'

/** The protocol both halves speak (shared/protocol/protocol-v1.schema.json). */
export const DOM_PROTOCOL_VERSION = 1
const MAX_DOM_COORDINATE = 10_000_000

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

/**
 * THE INTERFACE THE PICKED ELEMENT SAT IN (GOAL "The still carries the context").
 *
 * Everything the user could see in the top document at the instant they picked:
 * what each element is, where it sat, and what it said. It arrives on the pick
 * because the pick is the gesture Chrome grants `activeTab` for — the app's own
 * capture hotkey is not a gesture the browser can see, and asking for
 * `<all_urls>` would buy a standing right to read every page in order to avoid a
 * click the user has already made.
 *
 * `omitted` is not documentation, it is part of the record: a reader of the pack
 * learns what is missing without reading our source. The extension refuses the
 * value of every field, everything but the presence of a password box, the text
 * of anything the user could not see, and any attribute outside its allowlist —
 * because the licence for writing down visible text is that `snapshot.png`
 * already contains those pixels, and that argument covers nothing else.
 */
/** What the host will accept from one document, however much is offered. */
const DOM_SNAPSHOT_MAX_ELEMENTS = 4000

export interface DomDocumentSnapshot {
  viewport: {
    width: number
    height: number
    devicePixelRatio: number
    scrollX: number
    scrollY: number
  }
  url: string
  title: string
  elements: Array<{
    i: number
    tag: string
    role: string
    bounds: { x: number; y: number; width: number; height: number }
    id?: string
    class?: string
    name?: string
    type?: string
    placeholder?: string
    alt?: string
    title?: string
    href?: string
    text?: string
    /** A field held something. Never what it held. */
    filled?: boolean
    /** A password box was here. Nothing else about it is recorded. */
    secret?: boolean
  }>
  /** The walk hit its element cap; what is here is a prefix, not the page. */
  truncated: boolean
  visitedCount: number
  elapsedMs: number
  omitted: string[]
}

export interface DomEvent {
  /** Milliseconds on the replay clock, at arrival. */
  tMs: number
  // `dom.document.captured` is written by the APP, not the browser: the page
  // as it was at the instant of a capture, fetched because the user pressed
  // CapturePack's own hotkey and the browser had been granted once (#125).
  type: 'dom.element.selected' | 'tab.updated' | 'url.changed' | 'dom.document.captured'
  tab: { url: string; title: string }
  element?: DomElement
  /** Present on an element pick from extension 0.1.4 or newer. */
  viewport?: DomViewport
  /**
   * Present on a pick made in the TOP document by extension 0.2.0 or newer.
   * Absent from an older extension, and from a pick made inside an iframe —
   * that element still reports itself, but the document it names is the frame's
   * and not the one whose client rectangle the app can translate.
   */
  document?: DomDocumentSnapshot
}

/**
 * WHAT THE ELEMENT PICKER LAST DID, AS THE APP SAW IT (#104).
 *
 * The extension has reported arming, disarming and failing to arm since 0.1.5,
 * on the same wire the picks travel — and this file threw all three away,
 * because `parse()` only recognised the three event types that belong in a
 * pack. The comment in `background.js` promising they "land in main.log" was
 * simply not true, so the one question a stuck pick asks — did the picker ever
 * arm? — had no answer anywhere on the machine.
 *
 * Measured before the fix: across every pack in the owner's capture root and
 * the whole of `main.log`, `tab.updated` and `url.changed` arrive normally and
 * `dom.element.selected` appears ZERO times. The app half is proved by
 * `chrome-bridge-check`, so the break is upstream in the browser — exactly what
 * these three signals describe, and exactly what was being discarded.
 */
export type DomPickerPhase = 'armed' | 'disarmed' | 'failed'

export interface DomPickerState {
  phase: DomPickerPhase
  /** Milliseconds on the replay clock, at arrival. */
  atMs: number
  /** Why arming failed — a restricted page, no tab, an injection error. */
  reason: string | null
  tab: { url: string; title: string } | null
}

/** What Settings > Integrations shows, and what a bug report should quote. */
export interface DomBridgeStatus {
  listening: boolean
  /** A host process has connected at least once this run. */
  hostSeen: boolean
  /** The extension completed a hello handshake. */
  extensionConnected: boolean
  browserGranted: boolean
  extensionVersion: string | null
  protocolVersion: number | null
  protocolCompatible: boolean
  events: number
  lastEventAtMs: number | null
  /** Element picks accepted this run, retained or already pruned. */
  elementPicks: number
  /** Messages that looked like a pick and were refused, with the last reason. */
  rejected: number
  lastRejection: string | null
  /** The picker's last reported lifecycle signal, or null if it never armed. */
  picker: DomPickerState | null
}

let server: net.Server | null = null
let closingServer: net.Server | null = null
let bridgeWanted = false
let events: DomEvent[] = []
let retentionMs = 30_000
let hostSeen = false
const extensionConnections = new ExtensionConnectionLedger<net.Socket>()
const hostSockets = new Set<net.Socket>()
let lastEventAtMs: number | null = null
let elementPicks = 0
let rejected = 0
let lastRejection: string | null = null
let pickerState: DomPickerState | null = null
/** Supplied by the context runtime: "now" on the replay clock. */
let clockNowMs: () => number = () => Date.now()

/** Whether the user has allowed the browser (extension 0.3.0's optional grant). */
let browserGranted = false
/** Whether the extension has ever told us; distinguishes "never" from "withdrawn". */
let browserGrantReported = false
/** In-flight capture-time fetches, by request id. */
const domRequests = new Map<string, (answer: DomResponseMessage) => void>()
let domRequestSeq = 0

export function browserGrantState(): boolean {
  return browserGranted
}

/**
 * ASK THE BROWSER FOR THE VISIBLE PAGE, AT THE MOMENT OF A CAPTURE.
 *
 * This is what makes CapturePack's own global hotkey enough. Chrome will not
 * hand a page to an extension for a request that did not start in Chrome, so
 * this only ever succeeds when the user has granted the browser once — see the
 * extension's own note. Without the grant the extension refuses immediately and
 * says `not-granted`, which is a different answer from "the page was empty" and
 * has to stay different (SPEC §11.4).
 *
 * Bounded: a capture may never wait on a browser. On timeout the pack is written
 * without a page, exactly as it was before this existed.
 */
export function requestDomForCapture(timeoutMs: number): Promise<DomResponseMessage | null> {
  const sockets = extensionConnections.keys()
  // ASK. DO NOT CONSULT A CACHE.
  //
  // The first version returned early when `browserGranted` was false, and that
  // flag is only ever set by a message from the extension — so an app that
  // started after the user granted, or whose extension worker had been recycled
  // (MV3 does that constantly), believed there was no grant and never asked.
  // Silently, with nothing in the log and nothing in the pack: the invisible
  // failure this codebase keeps having to relearn.
  //
  // The extension is the authority on its own permissions, and refusing costs it
  // one message. So the cached flag is now only for REPORTING — Settings, and
  // the line below — and never for deciding.
  if (sockets.length === 0) {
    logInfo('[chrome] no browser connected — pack written without a page')
    return Promise.resolve(null)
  }
  domRequestSeq += 1
  const requestId = `r${String(domRequestSeq)}`
  return new Promise<DomResponseMessage | null>((resolve) => {
    const timer = setTimeout(() => {
      domRequests.delete(requestId)
      logWarn(`[chrome] the browser did not answer within ${String(timeoutMs)} ms — pack written without a page`)
      resolve(null)
    }, timeoutMs)
    domRequests.set(requestId, (answer) => {
      clearTimeout(timer)
      // EVERY OUTCOME SAYS SOMETHING. A pack with no page must never be the only
      // evidence that something did not happen.
      if (answer.ok) {
        logInfo(`[chrome] the browser answered with the visible page${answer.tab === null ? '' : ` on ${answer.tab.url.slice(0, 120)}`}`)
      } else if (answer.reason === 'not-granted') {
        logInfo(
          '[chrome] the browser has not been allowed yet — click the CapturePack icon in Chrome once; '
          + 'until then a capture carries no page',
        )
      } else {
        logWarn(`[chrome] the browser refused the page: ${answer.reason ?? 'unknown'}`)
      }
      resolve(answer)
    })
    let sent = 0
    for (const socket of sockets) {
      try {
        socket.write(
          `${JSON.stringify({ type: 'dom.request', protocol: DOM_PROTOCOL_VERSION, request_id: requestId })}
`,
        )
        sent += 1
      } catch {
        // A dead socket is one fewer browser to ask, never a failed capture.
      }
    }
    if (sent === 0) {
      clearTimeout(timer)
      domRequests.delete(requestId)
      resolve(null)
    }
  })
}

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
  const extension = extensionConnections.latest()
  return {
    listening: server !== null,
    hostSeen,
    extensionConnected: extension !== null,
    browserGranted,
    extensionVersion: extension?.version ?? null,
    protocolVersion: extension?.protocol ?? null,
    protocolCompatible: extension?.protocol === DOM_PROTOCOL_VERSION,
    events: events.length,
    lastEventAtMs,
    elementPicks,
    rejected,
    lastRejection,
    picker: pickerState === null ? null : { ...pickerState },
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
interface DomHello {
  kind: 'hello'
  protocol: number
  version: string
}

interface DomPickerMessage {
  kind: 'picker'
  phase: DomPickerPhase
  reason: string | null
  tab: { url: string; title: string } | null
}

/**
 * A REFUSAL IS AN ANSWER, AND IT HAS TO BE SAYABLE (#104).
 *
 * This used to be `DomEvent | DomHello | null`, and every one of the dozen ways
 * a message can be wrong collapsed into that single `null` — dropped on a
 * socket, in a `while` loop, with nothing written down. A pick refused for a
 * zero-height rectangle and a pick that never happened looked identical from
 * outside the process, which is the whole reason #104 stayed open for two
 * release cycles.
 */
interface DomGrantMessage {
  kind: 'grant'
  granted: boolean
}

interface DomResponseMessage {
  kind: 'domResponse'
  requestId: string
  ok: boolean
  reason: string | null
  tab: { url: string; title: string } | null
  document: unknown
  viewport: unknown
}

type ParseOutcome =
  | { ok: true; value: DomEvent | DomHello | DomPickerMessage | DomGrantMessage | DomResponseMessage }
  | { ok: false; reason: string }

function refuse(reason: string): ParseOutcome {
  return { ok: false, reason }
}

/** The tab a browser message names, bounded because a page controls both. */
function parseTab(raw: unknown): { url: string; title: string } | null {
  if (typeof raw !== 'object' || raw === null) return null
  const t = raw as Record<string, unknown>
  if (typeof t['url'] !== 'string' || typeof t['title'] !== 'string') return null
  return { url: t['url'].slice(0, 2048), title: t['title'].slice(0, 512) }
}

/**
 * A DOCUMENT SNAPSHOT, PARSED RATHER THAN BELIEVED.
 *
 * Extracted from `parse()` so a document that arrives as the ANSWER to a
 * capture-time fetch is checked by the same rules as one riding on a pick
 * (#125). A second copy of these bounds would be a second definition of what a
 * pack may contain, and the one a reader can check is the one in the file.
 */
export function parseDomDocument(doc: unknown): DomDocumentSnapshot | null {
  const event: { document?: DomDocumentSnapshot } = {}
  if (typeof doc === 'object' && doc !== null) {
    const d = doc as Record<string, unknown>
    const dv = d['viewport']
    const rawElements = d['elements']
    if (typeof dv === 'object' && dv !== null && Array.isArray(rawElements)) {
      const v = dv as Record<string, unknown>
      const num = (source: Record<string, unknown>, k: string): number | null => {
        const n = source[k]
        return typeof n === 'number' && Number.isFinite(n) ? n : null
      }
      const width = num(v, 'width')
      const height = num(v, 'height')
      const dpr = num(v, 'devicePixelRatio')
      if (width !== null && width > 0 && height !== null && height > 0
        && dpr !== null && dpr > 0 && dpr <= 16) {
        const elements: NonNullable<DomEvent['document']>['elements'] = []
        for (const entry of rawElements.slice(0, DOM_SNAPSHOT_MAX_ELEMENTS)) {
          if (typeof entry !== 'object' || entry === null) continue
          const el = entry as Record<string, unknown>
          const b = el['bounds']
          if (typeof el['tag'] !== 'string' || typeof b !== 'object' || b === null) continue
          const bb = b as Record<string, unknown>
          const x = num(bb, 'x')
          const y = num(bb, 'y')
          const w = num(bb, 'width')
          const h = num(bb, 'height')
          if (x === null || y === null || w === null || h === null) continue
          const text = (k: string, max: number): Record<string, string> =>
            typeof el[k] === 'string' && el[k] !== ''
              ? { [k]: (el[k] as string).slice(0, max) }
              : {}
          elements.push({
            i: elements.length,
            tag: el['tag'].slice(0, 64),
            role: typeof el['role'] === 'string' ? el['role'].slice(0, 64) : '',
            bounds: { x, y, width: w, height: h },
            ...text('id', 256),
            ...text('class', 256),
            ...text('name', 256),
            ...text('type', 64),
            ...text('placeholder', 200),
            ...text('alt', 200),
            ...text('title', 200),
            ...text('href', 2048),
            ...text('text', 200),
            ...(el['filled'] === true ? { filled: true } : {}),
            ...(el['filled'] === false ? { filled: false } : {}),
            ...(el['secret'] === true ? { secret: true } : {}),
          })
        }
        const omitted = Array.isArray(d['omitted'])
          ? d['omitted'].filter((o): o is string => typeof o === 'string').map((o) => o.slice(0, 200))
          : []
        event.document = {
          viewport: {
            width,
            height,
            devicePixelRatio: dpr,
            scrollX: num(v, 'scrollX') ?? 0,
            scrollY: num(v, 'scrollY') ?? 0,
          },
          url: typeof d['url'] === 'string' ? d['url'].slice(0, 2048) : '',
          title: typeof d['title'] === 'string' ? d['title'].slice(0, 512) : '',
          elements,
          // The extension's own cap, or ours: either way the pack says the list
          // is a prefix rather than the page.
          truncated: d['truncated'] === true
            || rawElements.length > DOM_SNAPSHOT_MAX_ELEMENTS,
          visitedCount: num(d, 'visitedCount') ?? elements.length,
          elapsedMs: num(d, 'elapsedMs') ?? 0,
          omitted,
        }
      }
    }
  }
  // The screen anchor, validated exactly as strictly as everything else here:
  // a viewport with a nonsensical size or ratio is DROPPED rather than
  // defaulted, because a default would place the element somewhere plausible
  // and wrong. An event without it still records the pick — it simply cannot
  // be turned into a candidate, which is the pre-0.1.4 behaviour.
  return event.document ?? null
}

/**
 * WHERE THE VIEWPORT WAS, WITHOUT WHICH NOTHING IN IT CAN BE PLACED.
 *
 * Every rectangle a page reports — a picked element's bounds, every entry in a
 * document snapshot — is in viewport CSS pixels. This is the only thing that
 * says where that viewport sat on the screen, so a payload carrying one without
 * the other is data with no position (#129: a capture-time document arrived with
 * 343 elements and no anchor, and not one of them could be drawn).
 *
 * Extracted so the pick and the capture-time fetch are anchored by the same
 * rules rather than two copies that can disagree.
 */
export function parseDomViewport(raw: unknown): DomEvent['viewport'] | null {
  if (typeof raw !== 'object' || raw === null) return null
  const v = raw as Record<string, unknown>
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
  // A viewport with a nonsensical size or ratio is DROPPED rather than
  // defaulted: a default would place the element somewhere plausible and wrong.
  if (width === null || height === null || dpr === null || dpr > 16) return null
  return {
    width,
    height,
    dpr,
    screenX: opt('screenX'),
    screenY: opt('screenY'),
    outerWidth: opt('outerWidth'),
    outerHeight: opt('outerHeight'),
  }
}

function parse(raw: unknown): ParseOutcome {
  if (typeof raw !== 'object' || raw === null) return refuse('not-an-object')
  const m = raw as Record<string, unknown>
  const type = m['type']
  if (type === 'host.hello') {
    if (typeof m['protocol'] !== 'number' || !Number.isFinite(m['protocol'])) {
      return refuse('hello-without-protocol')
    }
    return {
      ok: true,
      value: {
        kind: 'hello',
        protocol: m['protocol'],
        version: typeof m['version'] === 'string' ? m['version'].slice(0, 32) : 'unknown',
      },
    }
  }
  if (m['protocol'] !== DOM_PROTOCOL_VERSION) {
    return refuse(`protocol-mismatch:${String(m['protocol'])}`)
  }
  // THE PICKER'S OWN LIFECYCLE. Not pack content — a pack records what the
  // browser showed, not which buttons the user pressed in it — but the only
  // evidence that says whether a missing pick is a picker that never armed, a
  // page the extension may not touch, or a click that went somewhere else.
  // THE BROWSER GRANT (extension 0.3.0). Not pack content — it is the reason a
  // pack has no chrome-dom payload, which Settings > Plugins has to be able to
  // say out loud instead of showing an empty row.
  if (type === 'browser.grant') {
    return { ok: true, value: { kind: 'grant', granted: m['granted'] === true } }
  }
  // The answer to a capture-time fetch. Correlated by `request_id` because a
  // capture that has already given up must not adopt a late reply.
  if (type === 'dom.response') {
    return {
      ok: true,
      value: {
        kind: 'domResponse',
        requestId: typeof m['request_id'] === 'string' ? m['request_id'] : '',
        ok: m['ok'] === true,
        reason: typeof m['reason'] === 'string' ? m['reason'].slice(0, 200) : null,
        tab: parseTab(m['tab']),
        document: m['document'],
        viewport: m['viewport'],
      },
    }
  }
  if (type === 'picker.armed' || type === 'picker.disarmed' || type === 'picker.failed') {
    const reason = m['reason']
    return {
      ok: true,
      value: {
        kind: 'picker',
        phase: type === 'picker.armed'
          ? 'armed'
          : type === 'picker.disarmed'
            ? 'disarmed'
            : 'failed',
        reason: typeof reason === 'string' ? reason.slice(0, 200) : null,
        tab: parseTab(m['tab']),
      },
    }
  }
  if (type !== 'dom.element.selected' && type !== 'tab.updated' && type !== 'url.changed') {
    return refuse(`unknown-type:${typeof type === 'string' ? type.slice(0, 64) : typeof type}`)
  }
  const tabValue = parseTab(m['tab'])
  if (tabValue === null) return refuse('missing-or-malformed-tab')
  const event: DomEvent = {
    tMs: Math.round(clockNowMs()),
    type,
    tab: tabValue,
  }
  // Why an element was not taken, kept so a refused pick can say which of the
  // half-dozen validation rules it broke instead of vanishing.
  let elementRefusal = 'element-absent'
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
        typeof v === 'number'
        && Number.isFinite(v)
        && Math.abs(v) <= MAX_DOM_COORDINATE
          ? v
          : null
      const x = num(r['x'])
      const y = num(r['y'])
      const w = num(r['width'])
      const h = num(r['height'])
      if (x === null || y === null || w === null || h === null) {
        elementRefusal = 'element-bounds-not-finite'
      } else if (w <= 0 || h <= 0) {
        // A collapsed element measures 0 in one axis. Real, and unplaceable —
        // an invisible box is not an annotation target, so it is refused out
        // loud rather than silently.
        elementRefusal = `element-zero-size:${String(w)}x${String(h)}`
      } else {
        event.element = {
          tag: e['tag'].slice(0, 64),
          selector: e['selector'].slice(0, 512),
          bounds: { x, y, width: w, height: h },
          ...(typeof e['id'] === 'string' ? { id: e['id'].slice(0, 256) } : {}),
          ...(typeof e['role'] === 'string' ? { role: e['role'].slice(0, 64) } : {}),
          ...(typeof e['text'] === 'string' ? { text: e['text'].slice(0, 200) } : {}),
        }
      }
    } else {
      elementRefusal = 'element-missing-tag-selector-or-bounds'
    }
  }
  // THE DOCUMENT THE PICK CAME FROM, VALIDATED LIKE EVERYTHING ELSE HERE.
  //
  // This is untrusted input from a browser extension, so nothing is trusted
  // into the pack: unknown keys are dropped rather than carried, every string
  // is clipped, and an element without a usable rectangle is refused instead of
  // defaulted. A malformed document costs the pack its document, never its pick.
  //
  // `omitted` is carried through verbatim because it is the extension's own
  // statement of what it refused to record, and a pack that quietly lost that
  // line would be claiming more completeness than it has.
  const parsedDocument = parseDomDocument(m['document'])
  if (parsedDocument !== null) event.document = parsedDocument
  const parsedViewport = parseDomViewport(m['viewport'])
  if (parsedViewport !== null) event.viewport = parsedViewport
  if (type === 'dom.element.selected' && event.element === undefined) {
    return refuse(elementRefusal)
  }
  return { ok: true, value: event }
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
    if (!parsed.ok || 'kind' in parsed.value) continue
    out.push({ ...parsed.value, tMs: Math.max(0, Math.round(tMs)) })
  }
  // Temporal readers keep the earlier observation on an exact distance tie.
  // A pack is untrusted input and may reorder otherwise valid events, so make
  // that rule independent of JSON array order. Modern JS sort is stable: two
  // events at the same instant retain their persisted ordinal identity.
  out.sort((left, right) => left.tMs - right.tMs)
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
  bridgeWanted = true
  // stopDomBridge closes asynchronously. A rapid OFF → ON must wait for that
  // exact named pipe to be released or the replacement can lose EADDRINUSE and
  // remain off until the whole app restarts.
  if (server !== null || closingServer !== null) return
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
    hostSockets.add(socket)
    let buffer = ''
    const disconnect = (): void => {
      hostSockets.delete(socket)
      extensionConnections.remove(socket)
    }
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
          if (!result.ok) {
            // EVERY REFUSAL SAYS SO (#104). One line per refused message, and
            // the reason kept for Settings, so a pick that never became a box
            // can be told from a pick that never happened.
            rejected += 1
            lastRejection = result.reason
            logWarn(`[chrome] refused a browser message: ${result.reason}`)
          } else if ('kind' in result.value && result.value.kind === 'hello') {
            const hello = result.value
            extensionConnections.upsert(socket, {
              version: hello.version,
              protocol: hello.protocol,
            })
            logInfo(
              `[chrome] extension ${hello.version} connected, protocol v${String(hello.protocol)}`,
            )
            socket.write(
              `${JSON.stringify({
                type: 'host.hello',
                protocol: DOM_PROTOCOL_VERSION,
                app: 'capturepack',
                extensionVersion: bundledExtensionVersion(),
              })}\n`,
            )
          } else if ('kind' in result.value && result.value.kind === 'grant') {
            const was = browserGranted
            const seen = browserGrantReported
            browserGranted = result.value.granted
            browserGrantReported = true
            // A first report and a withdrawal are different facts. Saying
            // "withdrawn" to someone who never granted it sends them looking for
            // something they did not do.
            if (browserGranted && !was) {
              logInfo('[chrome] the browser is allowed — a capture carries the page, with nothing to press in Chrome')
            } else if (!browserGranted && was && seen) {
              logInfo('[chrome] the browser grant was withdrawn — captures carry no page until it is given again')
            } else if (!browserGranted) {
              logInfo(
                '[chrome] the browser has not been allowed — click the CapturePack icon in Chrome once to allow it',
              )
            }
          } else if ('kind' in result.value && result.value.kind === 'domResponse') {
            const answer = result.value
            const pending = domRequests.get(answer.requestId)
            if (pending !== undefined) {
              domRequests.delete(answer.requestId)
              pending(answer)
            }
          } else if ('kind' in result.value && result.value.kind === 'picker') {
            const signal = result.value
            pickerState = {
              phase: signal.phase,
              atMs: Math.round(clockNowMs()),
              reason: signal.reason,
              tab: signal.tab,
            }
            const where = signal.tab === null ? '' : ` on ${signal.tab.url.slice(0, 200)}`
            if (signal.phase === 'failed') {
              logWarn(
                `[chrome] element picker could not arm: ${signal.reason ?? 'unknown'}${where}`,
              )
            } else {
              logInfo(`[chrome] element picker ${signal.phase}${where}`)
            }
          } else {
            const event = result.value
            events.push(event)
            lastEventAtMs = event.tMs
            if (event.type === 'dom.element.selected') {
              elementPicks += 1
              const element = event.element
              logInfo(
                `[chrome] element pick at ${String(event.tMs)}ms: `
                + `${element?.selector ?? '?'} `
                + `${String(element?.bounds.width ?? 0)}x${String(element?.bounds.height ?? 0)}`
                + `${event.viewport === undefined ? ' WITHOUT a viewport (unplaceable)' : ''}`,
              )
            }
            prune()
          }
        }
        cut = buffer.indexOf('\n')
      }
    })
    socket.on('error', () => socket.destroy())
    socket.on('close', disconnect)
  })
  srv.on('error', (err) => {
    // EADDRINUSE means another CapturePack owns the channel — the single
    // instance lock should have prevented that, so it is worth saying.
    logWarn(`[chrome] DOM bridge could not listen: ${err.message}`)
    if (server === srv) server = null
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
  bridgeWanted = false
  // Includes hosts that connected but never completed hello; server.close()
  // waits for every accepted socket, so omitting those would make rapid ON
  // wait forever behind a half-open native host.
  for (const socket of hostSockets) socket.destroy()
  hostSockets.clear()
  extensionConnections.clear()
  const active = server
  server = null
  if (active !== null) {
    closingServer = active
    active.close(() => {
      if (closingServer === active) closingServer = null
      if (bridgeWanted) startDomBridge()
    })
  }
  events = []
  hostSeen = false
  lastEventAtMs = null
  elementPicks = 0
  rejected = 0
  lastRejection = null
  pickerState = null
}
