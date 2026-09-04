# CapturePack Architecture

> Capture context, not screenshots.

CapturePack has two architectures, and they matter unequally:

1. **The format architecture** — permanent. The `.capturepack` format defined in
   [SPEC.md](SPEC.md) is the product. It must outlive every app in this repository.
2. **The MVP app architecture** — replaceable. The reference implementation in [`core/`](core/)
   is one writer of the format: the fastest path from `Ctrl+Alt+C` to a `.capturepack` file.
   It could be rewritten in another stack tomorrow without changing a single pack already on disk.

Everything below follows the principles in [GOAL.md](GOAL.md): local-first, offline, open format,
plugin-based, no cloud, no login, no database, no AI dependency, minimal dependencies — and never
sacrifice the 5-second workflow.

---

## Current implementation baseline — 0.4.5

The current Electron reference app has moved beyond the original MVP design
record preserved later in this document:

- **CapturePack is one process.** A detached watchdog and the supervisor half
  that started it shipped, and were removed in 0.3.5
  ([#80](https://github.com/r2cuerdame/capturepack/issues/80), closing
  [#78](https://github.com/r2cuerdame/capturepack/issues/78)). They were reasoned
  onto a single observed death whose cause was unknown — there were no logs at
  the time, which the same release fixed — and the reasoning did not hold. A second
  `CapturePack.exe` in Task Manager wearing the product's own name is
  indistinguishable from a leak, and underneath the cost sat the thing a
  supervisor cannot do: an app that died from a bug in the app was brought back
  into the same bug. The symptom it was reasoned onto — press the hotkey, get
  silence — is answered now by things that cost no process: the app logs its own
  death with a crash dump, the next start says it stopped unexpectedly and that
  nothing was recorded in between, and the Windows login item brings it back.
  Treat any second process as a regression, not an implementation detail.
- Main owns one hidden capture window per recorded display. MP4/AVC uses one
  active `MediaRecorder` and a bounded fragmented-MP4 ring; runtimes without
  legal MP4 support use an explicitly different dual-slot WebM fallback.
- Recovery state is isolated per display: Chromium stream reacquisition and
  alternate constraints can be attempted without discarding healthy display
  rings. A native Windows fallback may be declared only when it is actually
  producing frames, with its degraded backend and quality recorded honestly.
  Issue #62 closed on that path existing, engaging on confirmed primary failure
  and being held by the gate (`check:native-replay-fallback`,
  `check:replay-health`) — not on anyone watching it take over on a wedged
  machine in the field, which has still not happened. If duplication wedges and
  the fallback does not engage, that is a new and far more specific bug.
- **A stopped recorder is a state to leave, not a schedule to wait out.** A
  display recorder killed by `DXGI_ERROR_ACCESS_LOST` at the lock screen, or by
  system sleep, clears its backoff and rebuilds on the `powerMonitor` unlock and
  resume edges rather than serving out the retry interval it happened to be in.
  The desk coming back is the event; the timer was only ever a guess about it.
- **The native fallback blits from a device-specific DC.** A display whose
  virtual-desktop origin is negative — the monitor placed left of or above the
  primary — is not addressable from a virtual-desktop DC the way a positive
  origin is, and the difference surfaced as an unhandled CLR exception rather
  than a degraded capture. `SRCCOPY` is preferred over `CAPTUREBLT`, which
  toggles the DWM hardware cursor plane and made the pointer flicker in every
  fallback capture; `CAPTUREBLT` remains available as the second attempt.
- Video capture and explicit region/full-virtual-desktop image capture are
  distinct contracts. Multi-display pixels, scale, negative origins and
  measured replay-clock evidence remain explicit through save and reopen.
- **`media.displays` is always written for a video capture**, a single-monitor
  capture included, which writes an array of one. Nothing should have to know to
  look in an optional field to find out the rest of the desk exists.
  `media.snapshot` and `media.replay` are named aliases for the focused entry,
  never a second copy of the bytes. Each entry states its own `snapshot_width` /
  `snapshot_height`, read back out of the raster that was actually written:
  `bounds.width × scale` rounds differently from the capture path at 1.25x and
  1.5x, which is where most mixed-DPI desks live, so a derivable number is not
  the same as a stated one. That contract is pack format 0.7.0; an image pack
  declares no displays at all.
- **The timeline carries what the user did**, on the replay clock:
  `input.mouse.move`, `input.mouse.click`, `input.window.focus`,
  `input.window.move` and `input.window.resize` (pack format 0.8.0, declared
  only when a capture actually carries one). No boundary was added to get them.
  The window events are differences between two surface samples lane S already
  takes for the whole retention, and the cursor is one extra read inside the
  dump the capture host was already taking — no hook, no thread, no second
  loop. Every event is a difference between two readings that really happened;
  nothing is interpolated or smoothed. `input.key.*` stays **reserved and is
  never emitted**: the licence for recording the rest is that `snapshot.png`
  already contains those pixels, and a keystroke is not among them — a password
  field renders dots, which is the exact case the DOM walker already refuses
  `type="password"` for. A global low-level keyboard hook in a screen-capture
  tool is the shape of a keylogger; `check:input-events` is what stops that from
  quietly becoming untrue.
- The editor authors unified boxes. In a STILL capture it can also bind a box to
  the captured UIA, Chrome DOM or HWND evidence under the cursor; a video offers
  no object picking at any frame — the captured instant included — and takes
  hand-drawn boxes with lifetimes, while the same control evidence keeps being
  recorded into the pack. Observed object tracks, in the packs that carry them,
  use the nearest real sample and are never interpolated; authored manual-box
  keyframes may interpolate.
- **Picking is no longer a live-renderer-only capability.**
  `ObjectIndex.forDisplay` builds one display's index from a resolved
  `ContextFrame`, and `context/packObjects.ts` opens a saved pack folder as the
  same `ContextSession` the re-edit flow builds — real parsers, real providers,
  the filesystem as the only dependency, no Electron. Both seams exist for one
  reason: until they did, the only way to ask "what would picking offer here?"
  was to open a renderer and hover, so a pack with picking data and a pack with
  *useful* picking data were indistinguishable to anything that only read the
  file. A measurement or an outside reader now sees the same ladder the editor
  sees — Core's window floor, the UIA control rung, the browser's document rung
  — rather than a reimplementation free to drift from it.
- The browser integration is explicit-pick only and crosses three processes:
  page → extension service worker → native messaging host → a per-user named
  pipe the running application listens on. The DOM is never streamed. A pick
  made inside an iframe is carried up the frame chain and therefore passes
  through the ancestor pages that already host it — an accepted exposure, and
  the reason a pick is only ever accepted from a frame the receiving document
  actually hosts, and only while the user has armed the picker. Nothing on this
  path may cost a capture: every failure is logged and swallowed.
- **What the browser returns cannot be placed without a rectangle the page does
  not have.** A document measures itself in viewport CSS pixels, and the only
  thing that converts them to snapshot pixels is the browser window's drawable
  area. That rectangle is persisted as `client_bounds` on a window in the
  `windows-uia` payload (payload 0.5.0, additive under SPEC §11.1, so the pack
  format itself does not move). It lives there rather than in `chrome-dom`
  because it is a fact about a WINDOW, observed in the same pass and the same
  space as the frame rectangle it sits beside — a window rectangle and its
  client rectangle must be comparable without leaving the record they are in.
  It is OPTIONAL and absent from every payload written earlier; a reader meeting
  a window without one recovers the document and **declines to place it** rather
  than deriving a rectangle from the frame and putting boxes somewhere plausible
  and wrong.
- Export is source-first. Original snapshot/replay media are never modified;
  blur is applied only to declared derived views. `viewer.html`, pack
  documents and rendered media are regenerated atomically without being
  authoritative over the source JSON.
- The optional MCP server is loopback-only and read-only. It reads saved packs
  and cannot initiate capture or modify evidence.
- **A captured web page layout container is distinguished from an explicit pick.**
  `ContextCandidate.explicit` distinguishes `dom.element.selected` (an element
  a user pointed at) from `dom.document.captured` (elements enumerated from the
  visible document). Enumerated containers (`section`, `nav`, log `div`) are
  judged by the container area filter and offered one rung back on hover probes,
  preventing large layout wrappers from dominating candidate selection while
  retaining full document recovery. The 5-second workflow latency is instrumented
  from the monotonic trigger timestamp (`check:capture-latency`), and `capture-e2e`
  is a required CI gate.
- **History provides a reviewed, still-only Share Copy (`.share.zip`).**
  The `capturepack-share` package uses a `reviewed-stills-only` profile with a
  closed media allowlist containing only manifest-declared annotated keyframe PNGs.
  Every PNG is decoded to raw pixels and deterministically re-encoded with only
  `IHDR`, `IDAT`, and `IEND` (expanding `tRNS` transparency to canonical RGBA)
  to eliminate ancillary metadata and trailing payload. Every review thumbnail is
  derived from those exact canonical bytes, and full-resolution stills open
  lazily at 1:1. Share Copy excludes original media, all video containers
  (including annotated replays), manifest, timeline, plugins, notes, and
  reports. Display lanes without declared stills fail closed, labeled blur boxes
  are blocked, and Windows atomic no-replace moves (`moveNoReplace.ts`) prevent
  race-condition overwrites during publication and rename under a shared
  per-pack operation lock.

The detailed MVP rationale in §§2–3 is retained as an **original 0.1.x design
record**. Its present-tense implementation details (dual recorders, WebM-only
output, destructive blur and an unfinished editor) are historical and are not
the current runtime contract. The baseline above, [SPEC.md](SPEC.md), and the
current source take precedence.

---

## 1. Format architecture

### 1.1 Specification over implementation

SPEC.md is the source of truth. The app conforms to the spec; the spec never conforms to the app.

- Any language must be able to produce and consume a valid pack from SPEC.md alone. A five-line
  script that writes `manifest.json` + `snapshot.png` is a first-class citizen of the format.
- Every public change to what the app writes updates SPEC.md **first** (SPEC before code).
- The JSON Schemas in [`docs/schemas/`](docs/schemas/) are documentation-grade validators for
  what 0.1.0 defines; where prose and schema disagree, SPEC.md prose wins.
- The app's format types ([`core/src/shared/types.ts`](core/src/shared/types.ts)) mirror the spec
  and are kept in sync with it — they are a convenience, not a definition.

### 1.2 Core owns nothing except capture

Core's whole job is the capture pipeline: replay buffer → snapshot → annotation → export. That is
the entire surface it owns, and it owns it completely:

- Core writes every core file: `manifest.json`, `snapshot.png`, the replay video,
  `annotations.json`, `timeline.json`, `report.md`.
- Nothing else — no plugin, no setting, no future feature — may alter what core captures or how
  the core files are produced.
- Core stays deliberately small so the 5-second workflow stays fast. Anything that is not
  capture belongs in a plugin or does not belong at all (see Non-Goals in GOAL.md).

### 1.3 Plugins append, never modify

Plugins are the only extension mechanism, and they have exactly one power: **appending metadata**.

- A plugin owns exactly one directory, `plugins/<name>/`, with a required `meta.json`
  (SPEC §11). It writes arbitrary structured files there — git state, DOM snapshots, window
  trees, console logs — and nowhere else.
- A plugin **cannot modify the capture process**: it cannot delay the hotkey, transform the
  snapshot, filter the replay, edit annotations, or touch any core file.
- The one channel into core data is the timeline: a plugin may emit `plugin.<name>.*` events,
  which core appends to `timeline.json` on the plugin's behalf (SPEC §10.2).
- A missing, broken, or unknown plugin never makes a pack unreadable. Readers ignore plugin
  directories they don't recognize; a pack with zero plugins is complete.

This asymmetry is the design: core capture stays trustworthy and fast no matter how many plugins
exist, and plugin authors can never be blamed for a bad capture.

### 1.4 The plugin interface must remain stable

The plugin contract is small on purpose, because small contracts are the ones that survive:

- **On disk (defined in SPEC 0.1.0, already frozen):** one directory per plugin, `meta.json`
  with `name` + `version`, a matching entry in `manifest.plugins`, optional `plugin.<name>.*`
  timeline events.
- **In process (V2, per GOAL.md):** the runtime Plugin API will be additive over this shape —
  a plugin is notified that a capture happened and returns files for `plugins/<name>/` plus
  optional timeline events. Nothing more.

Once published, the plugin interface only grows additively. A plugin written against V2 must
keep working, unchanged, in every later version. When in doubt, keep a capability out of the
interface — it is far easier to add a stable method later than to remove a mistake.

---

## 2. Historical MVP app architecture (`core/`, original 0.1.x design)

### 2.1 Why Electron + TypeScript

The stack was chosen by working backwards from the four hard requirements of the MVP, not by
preference. Each requirement maps to something Electron gives us without native code:

| Requirement | What Electron provides |
|---|---|
| 30-second replay ring buffer, always on, low overhead | `MediaRecorder` over `desktopCapturer` + `getUserMedia` — hardware-accelerated VP8/VP9 encoding in Chromium's media pipeline, zero native code, produces the WebM the spec recommends. |
| Annotation editor that feels instant | A `<canvas>` overlay is the fastest annotation surface available: immediate-mode drawing, sub-pixel geometry, and `getImageData`/`putImageData` for destructive blur — no UI framework needed. |
| Global hotkey (`Ctrl+Alt+C` by default) | `globalShortcut` — one call, works while any app has focus, and re-registering is how the settings GUI applies a new accelerator instantly. |
| GOAL.md's exact auto-update flow | `electron-updater` + `electron-builder`: GitHub Releases only, check on start, background download, install on quit, rollback-safe, hash-verified (sha512 in `latest.yml`), no update server. This flow is required for V1, not optional. |

Runtime dependencies are exactly two: `electron-updater` and `adm-zip` (ZIP writing). Everything
else — capture, encoding, drawing, hotkeys — is platform capability, not a library. That is the
minimal-dependencies principle applied: Electron is one large dependency traded for zero native
modules, no ffmpeg, and no GPU/encoder code of our own.

The original tradeoff record is in [§3](#3-historical-mvp-tradeoffs).

### 2.2 Component diagram

```
   Ctrl+Alt+C            tray icon                     GitHub Releases
       │                     │                               │
┌──────▼─────────────────────▼───────────────────────────────▼──────┐
│                        Electron main process                      │
│                                                                   │
│  hotkey ──► capture orchestrator           updater (electron-     │
│                 │       │                 updater: check on start,│
│  settings.json  │       │                 download in background, │
│  (userData)     │       │                 install on quit)        │
└─────────────────┼───────┼─────────────────────────────────────────┘
        IPC — every channel declared in src/shared/ipc.ts
   ┌─────────────┴─────────┐    ┌──────────┴──────────────────┐
   │ hidden capture window │    │ annotation editor window    │
   │                       │    │ (frameless, over snapshot)  │
   │ desktopCapturer       │    │                             │
   │  + getUserMedia       │    │ snapshot.png + canvas       │
   │  + 2 × MediaRecorder  │    │ V P A R B T · instant undo  │
   │  (staggered 30 s)     │    │ Enter = export, Esc = cancel│
   └───────────┬───────────┘    └──────────────┬──────────────┘
        replay blob (webm)          annotations + redacted png
               └──────────────┬────────────────┘
                              ▼
                    export writer (main process)
             manifest · annotations · timeline · report.md
                              ▼
                    2026-07-27-1403-title.capturepack
```

### 2.3 Main process

The main process is a **tray app** — no dock/taskbar presence, no main window. It owns:

- **Tray.** The only permanent UI: capture now, open output folder, settings, update status,
  quit. Quitting the tray is the only way to stop the replay buffer.
- **Global hotkey.** Registers `settings.captureHotkey` (default `Ctrl+Alt+C`) via
  `globalShortcut` at startup; unregisters on quit. One module owns registration, so changing
  the accelerator in Settings releases the old one before claiming the new one — and puts the
  old one back when the new one is refused. The handler does one thing: tell the capture
  orchestrator to trigger.
- **Capture orchestration.** Creates the hidden capture window at startup and keeps it
  recording. On trigger: grab the snapshot, request the replay blob from the capture window,
  open the editor window, and hold both until the editor resolves (export or cancel). Records
  timeline events (`core.capture.triggered`, `core.annotation.added`, `core.export.created`)
  as they happen.
- **Export writer.** Assembles and zips the pack (see [§2.7](#27-export-writer)).
- **Updater** ([`src/main/updater.ts`](core/src/main/updater.ts)). Wraps `electron-updater`:
  check on app start and every 4 hours, download in background, verify sha512 from
  `latest.yml`, install **only on quit** or via the explicit "Restart and update" action —
  never from under the user, because a live replay buffer would be lost. A failed check or
  download leaves the running version untouched. Disabled in dev runs and by the
  `autoUpdateCheck` setting. Release mechanics live in [docs/RELEASING.md](docs/RELEASING.md).
- **Settings.** A plain JSON file in Electron's `userData` directory (`autoUpdateCheck`,
  `outputDir`, `copyToClipboard`, `replaySeconds`, `fps`). Read at startup, written on change.
  No database — a settings file you can open in a text editor, same philosophy as the format.

### 2.4 Hidden capture window: the replay ring buffer

The capture window is a hidden renderer whose only job is keeping the last ~30 seconds of screen
footage ready. It captures the screen with `desktopCapturer` + `getUserMedia` and encodes with
`MediaRecorder`.

**Why two recorders.** `MediaRecorder` cannot drop old data from an ongoing recording, and the
chunks it emits mid-recording are not independently decodable (only the stream start carries the
container header, and chunk boundaries don't align with keyframes). A true ring buffer would
require WebM container surgery — exactly the kind of native/parsing code this stack was chosen to
avoid. Instead:

- Two `MediaRecorder` sessions, **A** and **B**, run on the same `MediaStream`, staggered by
  30 seconds (`segmentSeconds` in the IPC contract; `replaySeconds` in settings).
- Each recorder runs for at most 60 seconds, then stops and immediately restarts. A restarts at
  t = 60, 120, …; B starts at t = 30 and restarts at t = 90, 150, …
- Invariant: at any moment, the **older** recorder has been running between 30 and 60 seconds.

**On trigger:** stop the older recorder. Its complete recording — from its own start to now — is
a single, fully decodable WebM blob covering the last 30–60 seconds. That blob is the replay,
sent to main with its measured duration (`MediaRecorder` WebM famously lacks a duration header,
so the window times the session itself and reports `durationMs`, which becomes
`manifest.media.replay_duration_ms`). The stopped recorder restarts immediately, so the buffer
keeps running while the user annotates and is warm for the next capture.

Within the first 30 seconds after app start the buffer simply holds less footage — the replay is
whatever exists, which the manifest reports truthfully via `replay_duration_ms`.

If recording fails (denied capture permission, encoder error), the window reports the error and
capture degrades to **screenshot-only** packs (`"replay": null`) — a fully valid pack per
SPEC §14. The replay buffer is evidence, never a gate on the workflow.

### 2.5 Snapshot

On trigger, main takes the snapshot via `desktopCapturer` with `thumbnailSize` set to the
display's native pixel resolution (width × height × scale factor) — the "thumbnail" at full size
is the frame. This is synchronous-fast, needs no extra window, and yields the PNG whose pixel
dimensions define the annotation coordinate space (SPEC §6, §8.2). The snapshot is taken
immediately on the hotkey — before any UI appears — so the captured frame shows what the user
saw, not our editor.

### 2.6 Annotation editor

A frameless, full-screen window displaying the snapshot 1:1 with a canvas overlay on top.
It exists for one purpose: **five seconds from open to export.**

- **Keyboard-first tools:** `V` select, `P` pin, `A` arrow, `R` rect, `B` blur, `T` text.
  One keypress arms a tool; drag (or click, for pin/text) places the annotation.
- **Instant undo:** `Ctrl+Z` pops the last annotation. Undo is an array pop, not a command
  framework — annotations are plain data objects in creation order, which is exactly the
  reading order SPEC §8.1 wants.
- **`Enter` exports, `Esc` cancels.** Optional title and note fields are one `Tab` away but
  never block export (SPEC §5.1: the 5-second workflow wins).
- **Annotations are data.** The canvas is only a view. What leaves the editor is the
  `Annotation[]` — never pixels with drawings burned in, and never anything burned into the
  replay video.
- **Blur is the one exception, per SPEC §9.** On export, the editor applies every blur region
  destructively to the snapshot bitmap — strong pixelation (large blocks), not weak Gaussian —
  and sends only the redacted PNG to main. The unredacted frame exists solely in the editor's
  memory and dies with the window; the export writer never sees it, so it cannot leak into the
  pack. The blur annotations still ship as data in `annotations.json`.
- **The replay gap, surfaced honestly:** the replay is always kept when one was recorded
  (GOAL "No include-replay toggle" — save-first; what leaves the machine is decided at share
  time). Where blur annotations exist, the save-complete toast shows the SPEC §9.4 warning —
  the original replay is not redacted, share `replay_annotated.webm` or a sanitized ZIP.

### 2.7 Export writer

A main-process module that turns the editor's result into a `.capturepack`, exactly per SPEC:

1. **`manifest.json`** — format marker, `format_version` 0.1.0, UUID, `created_at` with
   timezone offset, generator name/version, title and note verbatim, environment (`os`,
   `os_version`, `screens` from Electron's `screen` module, focused `app` best-effort), and
   `media` with the actual replay filename and measured `replay_duration_ms` (or `null`s).
2. **`snapshot.png`** — the (possibly redacted) PNG from the editor, byte-for-byte.
3. **`replay.webm`** — the blob from the capture window, when included.
4. **`annotations.json`** — `reference_width`/`reference_height` = snapshot pixel dimensions,
   annotations in creation order.
5. **`timeline.json`** — `t0` = the replay's first frame instant (trigger time minus
   `replay_duration_ms`, per SPEC §10.1, so `t_ms` doubles as a video seek position), plus the
   `core.*` events collected during the session.
6. **`report.md`** — generated from the data above using the SPEC §12.1 template; duplicates
   the JSON in prose so any LLM understands the pack from `report.md` + `snapshot.png` +
   `annotations.json` alone.
7. **Zip** — `adm-zip`, entries at the archive root (no wrapping folder), store/deflate only,
   named `YYYY-MM-DD-HHMM-title-slug.capturepack` in the configured output folder. Optionally
   copies the file to the clipboard so "export → drop into a chat" is literal.

The writer is pure assembly: data in, files out. It performs no capture, no editing, no network.

### 2.8 IPC contract

All three processes communicate over channels declared in one file:
[`core/src/shared/ipc.ts`](core/src/shared/ipc.ts). **No module may invent a channel outside
this file.** Each channel has a typed payload interface next to it. This keeps the process
boundary — the most bug-prone seam in any Electron app — small, visible, and reviewable in one
screen.

### 2.9 Module map

```
core/
├── package.json             two runtime deps: electron-updater, adm-zip
├── electron-builder.yml     NSIS installer + GitHub Releases publish config
├── scripts/build.mjs        esbuild bundling (main + preload + renderers)
└── src/
    ├── main/                Electron main process
    │   ├── index.ts         lifecycle, tray + hotkey wiring — composition root
    │   ├── tray.ts          tray menu
    │   ├── capture.ts       display-media routing, hidden capture window, snapshot
    │   ├── session.ts       capture flow orchestration + timeline event collection
    │   ├── context/         Surface Timeline, Surface Resolver, provider host —
    │   │                    Core platform infrastructure, NOT providers (#65/#66)
    │   ├── exporter.ts      pack writer (§2.7)
    │   ├── report.ts        report.md generation
    │   ├── settings.ts      settings.json load/save
    │   └── updater.ts       GitHub Releases auto-update (§2.3)
    ├── preload/             preload bridges for the renderer windows
    ├── renderer/
    │   ├── capture/         hidden capture window renderer — replay ring buffer (§2.4)
    │   └── editor/          annotation editor renderer — canvas + tools (§2.6)
    └── shared/
        ├── ipc.ts           the entire IPC contract (§2.8)
        ├── context/         the Temporal Context Provider protocol — documented
        │                    and explicitly UNSTABLE (#64); Windows UI Automation
        │                    is its reference implementation, with no private path
        └── types.ts         SPEC 0.1.0 format types + Settings
```

That map is the 0.1.x tree, and it is now a shape rather than a listing: the editor renderer it
described as missing shipped with V1, and `src/main/context/` alone has grown the session
clock, the surface and control lanes, the input-event ring and the pack readers described in the
baseline above. Read the current `core/src/` for what exists; read this map for what the app was
originally decomposed into, which has not changed.

Conventions, from GOAL.md's coding guidelines:

- **Small modules, one job each.** A module that needs a table of contents is two modules.
- **Composition over inheritance.** `index.ts` is a composition root that wires plain functions
  and objects together; there are no class hierarchies to extend, only functions to compose.
- **Readable over clever.** The capture path especially: it runs on every `Ctrl+Alt+C` and must
  be boring enough that a contributor can audit it in minutes.
- **The spec types are the boundary.** Everything the app writes into a pack passes through the
  types in `shared/types.ts`, which mirror SPEC.md — drift between app and spec becomes a type
  error or a one-file diff.

---

## 3. Historical MVP tradeoffs

Deliberate MVP compromises, stated plainly so nobody has to discover them:

- **Replay is WebM, not MP4.** `MediaRecorder` produces WebM; producing MP4 would require
  bundling ffmpeg or native encoders — deferred. SPEC §7 recommends WebM for exactly this
  reason, and every modern browser and LLM-adjacent tool plays it. An optional MP4 path can
  come later without a format change (`replay.mp4` is already valid).
- **Replay length is 30–60 seconds, not exactly 30.** The staggered-recorder design trades
  precision for a single decodable blob with zero container surgery. The manifest always tells
  the truth via `replay_duration_ms`; readers should trust it, not assume 30 000. (And in the
  first 30 seconds after launch, the buffer holds less than 30 seconds.)
- **Two encoders cost some CPU.** Both recorders encode simultaneously, so the resident buffer
  costs roughly 2× one encode. Chromium's hardware-accelerated encoding keeps this modest, and
  capped fps/resolution settings bound it — but it is not free, and it is the price of avoiding
  native ring-buffer code.
- **Blur does not apply to the replay video in MVP.** Redacting video frames means re-encoding —
  the same ffmpeg-shaped problem, deferred the same way. Per SPEC §9.4 the exporter surfaces
  this whenever blur + replay coexist and offers one-step replay exclusion, so the user decides
  with eyes open. A future format version will specify replay redaction.

Each of these is a scoped compromise inside one implementation. None of them is in the format:
a future exporter can ship exact 30-second MP4 replays with redacted video, and every pack it
writes will still be a plain, valid `.capturepack`.
