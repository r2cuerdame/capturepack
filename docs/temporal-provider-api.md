# Temporal Context Provider API — reference

**Protocol version `1`. Status: documented and explicitly UNSTABLE.**

This is the reference for *implementing* a provider. The reasoning behind it —
the measurements, the storage arithmetic, the seventeen corrections the design
walkthrough produced — is in [`temporal-protocol.md`](temporal-protocol.md); the
authoritative product statement is `GOAL.md` > "Plugin Architecture" > "Plugin
System, redesigned (v0.2.0)". The types themselves are
`core/src/shared/context/protocol.ts` and `core/src/shared/context/manifest.ts`,
and they are the contract: everything below is those files in prose.

> **The API will change.** `protocol_version` is checked strictly and an
> incompatible plugin is refused with a message rather than half-working. It goes
> to v1 with a compatibility promise at whichever comes first: a provider we did
> not write running in the wild, or the first serious external request to build
> one (issue #64). Someone who wants to write one today hears *"yes, and the API
> will change"* — never *"no"*.
>
> The other plugin API — **After Save Actions** — is the one that is public and
> stable. If what you want is "when a pack is saved, send it somewhere", that is
> the API to use, and we will not break it.

---

## 1. What a provider is

> **Provider** — observes, records, restores.
> **Core** — chooses the time and the screen position.

CapturePack keeps a rolling replay buffer of the screen. A provider keeps a
rolling buffer of *meaning* on the same clock, so that when the user scrubs to
second 7 of a thirty-second replay and hovers a pixel, something can say what
object was under that pixel **at that moment** — not at the moment the hotkey was
pressed.

Two rules the type signatures do not carry, and both are prohibitions:

1. **`onTick` is not an order to snapshot.** It hands you the current monotonic
   time. *You* decide whether that instant is worth sampling. Core will never
   require a full tree per tick, and a provider that produces one per tick will
   cost more than the video encoder — measured: one full Windows UI Automation
   desktop checkpoint is 183.8 ms, so sampling it at 10 Hz would be 184% of a CPU
   core.
2. **`materialize()` prepares state at a time. It does not ship the structure to
   the UI.** Selection goes through `hitTest()` (a point) and `frame()` (a
   rectangle).

And one obligation:

3. **Never claim precision you do not have.** Every temporal answer carries
   `TemporalAccuracy`. If you cannot produce the exact requested instant, return
   your nearest sample *together with the error*. An answer 80 ms off is useful;
   an answer 80 ms off that claims to be exact is the same class of lie as a tray
   icon that says "recording".

---

## 2. The manifest

```json
{
  "id": "chrome-dom",
  "name": "Chrome DOM",
  "version": "0.1.0",
  "type": "temporal-context-provider",
  "protocol_version": "1",
  "entry": "dist/index.js",
  "permissions": ["native-messaging", "read-browser-context", "write-plugin-files"]
}
```

| Field | Rule |
|---|---|
| `id` | `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`. It is also your directory name inside a pack (`plugins/<id>/`), so the identifier rule and the path-safety rule are the same rule. |
| `type` | Must be `temporal-context-provider`. |
| `protocol_version` | Must be `"1"`. Anything else is refused, by design. |
| `entry` | Node module, relative to the plugin directory. Empty only for a provider built into Core. |
| `permissions` | From the fixed set below. An unknown permission is a refusal, not a warning. |

**The fixed permission set.** `read-pack`, `write-plugin-files`, `network`,
`run-process`, `read-browser-context`, `read-active-window`, `native-messaging`,
`create-zip`, `open-browser`. The user sees these before enabling your plugin,
and anything that sends pack data off the machine says so in those words. The set
is closed so that the list a user reads is the whole truth.

Core also checks the *object* you register: `provider.id`, `provider.type` and
`provider.protocolVersion` must match the manifest. A manifest is a text file
that can be edited to say anything; the code is what actually speaks the
protocol, so both are checked.

---

## 3. The clock

Core hands out one **monotonic session clock**:

```ts
interface CaptureClock { sessionId: string; nowMs: number; bufferStartMs: number; bufferEndMs: number }
```

`nowMs` counts from session start. It is not a wall clock, and it is not an
epoch: an NTP step or a DST change must not be able to reorder a sample against
the video it describes.

**Timestamp everything against this clock.** If you use your own, the semantic
timeline drifts off the visual one and every answer becomes subtly wrong.

**If you live in another process** (a `utilityProcess`, a Chrome extension over
native messaging, an engine talking over a socket), your clock is your own and
nothing synchronises it by itself. That is what `TickAck` is for:

```ts
// Core sends
{ sessionId, timeMs, bufferStartMs, bufferEndMs, sentAtMs }
// You reply
{ state, receivedAtLocalMs, providerLocalMs, bufferedFromMs, bufferedToMs,
  resolutionMs, samples, dropped, bytes }
```

Core computes an NTP-style offset and a round-trip bound from
(`sentAtMs`, `receivedAtLocalMs`, `providerLocalMs`, reply arrival), keeps a
rolling median, and folds the residual into every `TemporalAccuracy.errorMs` it
publishes for you. **A provider that never acks is treated as having an unbounded
clock error and its answers are marked approximate.** Measured for the built-in
Context Host over stdio: round trip 0.28 ms, error bound ±0.14 ms.

**Pack time is not your problem.** Providers never see it. Core converts:
`sessionMs = freeze.range.startMs + packTMs`, where `packTMs ∈ [0,
replayDurationMs]` and the capture instant is `replayDurationMs`. A trim moves
the saved range, not the clock.

---

## 4. Lifecycle

| Call | When | Budget |
|---|---|---|
| `onBufferStart({ sessionId, startedAtMs, retentionMs, memoryBudgetBytes })` | Session start, or after being re-enabled. Allocate your ring. | 1 s |
| `onTick({ …, sentAtMs }) → TickAck` | **1 Hz.** Not a sampling order — see §1. | 1 s |
| `onPrune({ sessionId, beforeTimeMs })` | Retention moved. Drop what is older, **keeping the last checkpoint still needed to restore what remains**. | 1 s |
| `onFreeze({ sessionId, freezeId, range })` | A capture happened; pin that range until released. Freezes are **ref-counted** — several editors can hold overlapping ranges. | 1 s |
| `onRelease({ sessionId, freezeId })` | That editor closed or that pack was saved. | 1 s |

All five are optional. A provider that implements none of them still works; it
just never buffers, and its coverage says so.

**Retention can change mid-session.** `bufferStartMs`/`bufferEndMs` on every tick
are the contract — honour a change without waiting for a session restart.

---

## 5. Queries

| Call | What it must answer | Budget |
|---|---|---|
| `getSurfaceClaims({ sessionId, timeMs, surfaces })` | Which regions of which surfaces you own **at that time**. Claims are time-varying: a window did not exist 20 s ago. | 250 ms |
| `hitTest({ sessionId, timeMs, point, surface })` | The candidates at one point. The authoritative path for a click. | 300 ms |
| `frame({ sessionId, timeMs, region, surfaceIds?, maxCandidates })` | Every candidate inside a rectangle, so Core can index them locally and hover is a local lookup. Decline (`declined: true`) if you cannot. | 300 ms |
| `materialize({ sessionId, timeMs, surfaceIds?, regions? })` | Prepare/cache your state at that time. Return surfaces + accuracy, **not** the structure. | 500 ms |
| `track({ sessionId, surfaceId, objectId, range, intervalMs })` | One object's bounds over a range, with `gaps` where you lost it. | 3 s |
| `export({ …packPath, outputDir, selectedTimeMs, range, targets, displays })` | The files you want written into `plugins/<your-id>/`. **Core writes them**; you return bytes. | 5 s |

**Timeouts are budgets, not suggestions — and they do not cancel.** JavaScript
cannot abort a promise, so a call that overruns is *abandoned*: Core answers
without you on time and discards whatever you return afterwards. A slow provider
must never hold the editor shut; late results update the candidate list
asynchronously.

**Failure isolation.** Every call is wrapped. A throw, a rejection or a timeout
returns "this provider has nothing for you" and the fallback ladder continues
below you. Five consecutive failures disables you **by name, with the reason**,
visible in Settings > Plugins. No plugin failure may ever cost a capture.

---

## 6. Coordinates, candidates and ordering

**All protocol rectangles are virtual-desktop physical pixels.** Not DIP, not CSS
pixels, not whatever DPI virtualization handed your process. Convert before you
answer. (Chrome reports CSS/DIP; the Windows Surface Timeline reports physical;
one of them had to be normative, and it is the one produced by a deliberately
per-monitor-DPI-aware process.) Core maps from this space into a display's
snapshot pixels when a pack is written.

A `ContextCandidate` carries two ordering fields that are easy to get wrong:

- **`depth` is semantic specificity, monotone along containment — computed from
  geometry, not from tree-walk depth.** A candidate must carry a strictly greater
  `depth` than anything that encloses it. This is not pedantry: ordering by UI
  Automation walk depth was measured against containment on 5184 probe points and
  never once beat it, losing on 31.9% of contested points (issue #58).
- **`paintOrder`** — within one surface, higher is drawn later, i.e. in front.
  29% of contested points have two candidates where neither encloses the other,
  and only paint order resolves them.

`objectId` is opaque to Core. It must be unique within
`(providerId, sessionId, surfaceId)` at any instant and must denote the same
object over time **for as long as you can prove continuity**. Where you cannot,
mint a new id: an honest discontinuity beats a silent identity swap. (Measured on
real captures: 17–24 of ~450 UI Automation elements share their entire natural
key, so the obvious key is not unique.)

Authority is **specificity, not rank**, and the ladder is fixed:

```
application-native  →  document-native  →  accessibility  →  window  →  manual rectangle
   (Unreal widget)      (DOM element)       (UIA element)     (HWND)
```

---

## 7. Accuracy and coverage

```ts
interface TemporalAccuracy {
  requestedTimeMs: number
  materializedTimeMs: number
  errorMs: number      // absolute, including measured cross-process clock error
  exact: boolean
  coverage: 'covered' | 'before-start' | 'pruned' | 'degraded' | 'single-instant' | 'none'
}
```

`errorMs` alone cannot tell "80 ms off" from "25 seconds off because this pack
only ever recorded one moment", and those deserve opposite treatment in the UI.
`coverage` is the verdict. Core additionally enforces a **staleness ceiling**
(default 3 s) and simply does not offer a candidate beyond it.

---

## 8. Memory

`onBufferStart` hands you `memoryBudgetBytes` (default 8 MB). Over budget you
must **drop resolution, never range**, and mark the affected intervals
`degraded`. Core measures what you actually hold — you report it in every
`TickAck` as `bytes` — and disables a provider that ignores its budget, by name.

`onPrune` is a *time* bound and cannot stop a page doing 10,000 mutations a
second from blowing memory inside the retained window. The budget is what does.

The expected storage shape is **periodic checkpoints + change deltas + geometry
samples**, so that t = 0.7 s is checkpoint 0.0 replayed forward. For reference,
Core's own Surface Timeline stores 72 bytes per window per sample, takes a
checkpoint every second, and measured **76 KB for a 30-second ring at 10 Hz** on
a 21-window desktop.

---

## 9. What Core provides: the Platform Surface Timeline

Core keeps its own record of the desktop's surface stack on the same clock, and
resolves it **before asking any provider**:

```
1. restore the surface stack at T
2. topmost visible surface at the point
3. providers holding a claim there
4. hitTest each, in parallel, each with its own timeout
5. drop candidates that are not visible, or are occluded
6. sort: surface visibility/z → claim → authority → specificity → confidence → user preference
7. offer the first; keep the rest as the candidate stack
8. no candidate → the window level; no window → manual rectangle
```

That is why a numeric `pluginPriority` is not offered and never will be: a
Notepad window in front of a windowed Unreal game, one screen point — both
providers legitimately claim an object there, and the user is looking at Notepad.
The surface stack answers that; a priority number cannot.

`SurfaceInfo` gives you `surfaceId` (Core-minted, stable across the session,
recycle-proof), `hwnd`, `processId`, `bounds` (the DWM extended frame, not
`GetWindowRect`), `clientBounds`, `zOrder`, `visible`, `minimized`,
`foreground`, `cloaked`, `ownerSurfaceId` and a computed `visibleRegion`.

**Claim by `surfaceId` when you can.** If you cannot know an HWND — a browser
extension cannot — claim by `region` plus `executableHint`, and Core attributes
it to the topmost visible surface at the region's centre whose executable matches,
clipped to that surface's visible region. A claim matching no surface is dropped,
and the drop is logged rather than silently ignored.

---

## 10. A minimal provider

```ts
import type {
  BufferStartContext, BufferTickContext, ContextCandidate, HitTestContext,
  MaterializeContext, ProviderExportContext, ProviderExportResult, ProviderState,
  ProviderSurfaceClaim, SurfaceClaimContext, TemporalContextProvider, TickAck,
  ObjectTrack, TrackContext,
} from 'capturepack/context'

const SAMPLE_INTERVAL_MS = 100

export class MyProvider implements TemporalContextProvider {
  readonly id = 'my-engine'
  readonly name = 'My Engine'
  readonly version = '0.1.0'
  readonly protocolVersion = '1'
  readonly type = 'temporal-context-provider' as const

  private readonly ring: Array<{ tMs: number; objects: MyObject[] }> = []
  private retentionMs = 30_000
  private budgetBytes = 8 * 1024 * 1024
  private timer: ReturnType<typeof setInterval> | undefined
  private samples = 0

  async onBufferStart(c: BufferStartContext): Promise<void> {
    this.retentionMs = c.retentionMs
    this.budgetBytes = c.memoryBudgetBytes
    // MY OWN timer, at MY OWN rate. Core's tick is not a sampling driver.
    this.timer = setInterval(() => this.sample(), SAMPLE_INTERVAL_MS)
  }

  async onTick(c: BufferTickContext): Promise<TickAck> {
    const receivedAtLocalMs = performance.now()
    this.retentionMs = c.bufferEndMs - c.bufferStartMs   // may have changed
    return {
      state: 'running',
      receivedAtLocalMs,
      providerLocalMs: performance.now(),
      bufferedFromMs: this.ring[0]?.tMs ?? c.timeMs,
      bufferedToMs: this.ring[this.ring.length - 1]?.tMs ?? c.timeMs,
      resolutionMs: SAMPLE_INTERVAL_MS,
      samples: this.samples,
      dropped: 0,
      bytes: this.bytes(),
    }
  }

  async onPrune(c: { beforeTimeMs: number }): Promise<void> {
    while (this.ring.length > 1 && (this.ring[1]?.tMs ?? Infinity) <= c.beforeTimeMs) this.ring.shift()
  }

  async hitTest(c: HitTestContext): Promise<ContextCandidate[]> {
    const at = this.nearest(c.timeMs)
    if (at === null) return []
    return at.objects
      .filter((o) => contains(o.bounds, c.point))
      .map((o, i) => ({
        providerId: this.id,
        surfaceId: c.surface.surfaceId,
        objectId: o.stableId,
        objectType: o.kind,
        name: o.label,
        bounds: o.bounds,                 // physical pixels, see §6
        depth: o.containmentDepth,        // geometry, not tree walk
        paintOrder: i,                    // drawn later = in front
        authority: 'application-native',
        confidence: 1,
        visible: o.visible,
        occluded: false,
      }))
  }

  // materialize / getSurfaceClaims / track / export omitted for brevity —
  // every one of them returns TemporalAccuracy describing what it actually had.
}
```

The pattern that matters is in `onBufferStart` and `onTick`: **your own timer at
your own rate**, and the tick used only to receive the clock and to report.

---

## 11. What goes into a pack

Your whole temporal buffer is working data and does **not** go into the pack.
Saving exports only what the chosen range and the chosen object need — provider
metadata, the context at the selected time, the selected object, its track,
temporal accuracy, warnings and gaps.

You return bytes from `export()`; **Core writes them**, into `plugins/<your-id>/`
and nowhere else, and Core writes the `manifest.plugins[]` declaration. A file
name must match `^[a-z0-9][a-z0-9._-]*\.json$`, and the total is capped. That is
what makes `write-plugin-files` a fact rather than a promise, and what makes
"plugins own nothing except their directory" true by construction.

---

## 12. Explicitly not how this works

Calling a provider once at the capture instant. Asking every provider about every
point. Settling conflicts with a global priority number. Letting a provider write
Core's files. Failing a capture or a save because a plugin failed. Forcing a full
DOM/UI tree copy per frame.

> CapturePack records the visual timeline.
> Temporal Context Providers preserve the semantic timeline.
> The user chooses the time and target.
> After Save Actions decide where the resulting context goes.
