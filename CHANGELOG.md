# Changelog

All notable changes to CapturePack. Format follows [Keep a Changelog](https://keepachangelog.com/);
this project uses [semantic versioning](https://semver.org/) for the app, and the pack
format carries its own `format_version` (see [SPEC.md](SPEC.md) §13.1).

## Unreleased

Nothing yet.

## 0.3.0 — 2026-07-30

Pack format **0.3.0**. This release is about one promise: **a box is where the
thing is**, at every frame — including a past frame, a reopened pack, and a
different monitor — and everything the app claims about that is measured rather
than asserted.

### Added

- **The OS says when a window moved.** The context host subscribes to
  `EVENT_OBJECT_LOCATIONCHANGE` instead of guessing when to look, so a dragged
  window is observed roughly every 10 ms — 100 observations a second. On the
  measured 52-second drag trace documented in `GOAL.md`, `GetWindowRect` changed
  every 4 ms at the median. Polling remains the fallback where a hook cannot be
  installed, and the log says which regime a session ran under.
- **Only what moved goes on the wire.** A move-driven sample now carries just the
  windows whose geometry, z or flags changed, with vanished handles named and a
  delta marker; scheduled samples stay full and resync the shared picture. In
  the checked-in benchmark described in `GOAL.md`, host cost fell from 13.5% of
  one core to 1.11%, which is why the observation rate survives a whole capture
  instead of being throttled halfway through.
- **Controls are tracked, not frozen.** A second resident lane holds UI
  Automation element references and re-reads their rectangles. The foreground
  400-control benchmark in `GOAL.md` measured that path at 30.2x less work than
  re-walking the window's tree, so a control that scrolls inside a window that
  never moved is still in the right place. Dead references remove their control
  rather than freezing it, and a provider that hangs is timed out and blocked
  rather than allowed to define the app's latency.
- **The browser gets a rung.** Picking an element in Chrome now produces a box
  around *that element*, not around the browser window. The extension sends the
  viewport anchor and the app maps it onto the browser window's recorded client
  rectangle, deriving display scale, device pixel ratio and zoom as one measured
  number. A pick it cannot place confidently is refused rather than placed
  plausibly and wrongly.
- **Past frames keep their object context.** The Windows surface/control timeline
  is frozen with the replay and restored from the pack, so Object Pick can resolve
  the window or child control that occupied an early frame instead of consulting
  only the live desktop or the final frame.
- **Still-image capture uses the same context editor.** `Ctrl+Alt+S` opens region
  selection by default, with an explicit full-screen action. Image packs contain
  no replay; a region pack stores only the selected pixels and crop placement,
  never a hidden full-screen or second-monitor raster.
- **Manual boxes have authored keyframes.** Their geometry interpolates between
  the positions the user placed, in virtual-desktop space, including movement
  from one monitor to another. Observed UI-object tracks remain observations and
  are never interpolated.
- **Every recorded display can declare its measured replay-clock offset.** Saved,
  cut, reopened, and rendered multi-monitor packs therefore resolve the same pack
  time to the same frame on each display; older packs keep the duration-based
  fallback.
- **Live recording is a switch.** Settings → Capture and the tray menu both carry
  it. Off records nothing at all, and the hotkey answers with a notification
  instead of silence.
- **Delete everything**, alongside the 1 / 7 / 30-day options in Settings →
  Capture, with the same counted confirmation and the same Recycle Bin.
- **Replay length 1–60 s and capture 1–30 fps.**
- **Settings warns when the loaded extension is older than the one this build
  ships**, because nothing updates an unpacked extension when the app updates.
- **The editor has a first-run guided tour.** It explains rewind, object
  picking, annotation, and export with keyboard navigation, a persistent
  “do not show again” choice, and a Settings action that opens it again in all
  nine supported languages.

### Fixed

- **The box lagged the window, and the cause was a rounded query.** Ring sample
  times are fractional; the save path rounded them to whole milliseconds *before
  using them as lookups*, and the lookup answers with the newest sample at or
  before the asked time — so half the queries returned the previous frame's
  rectangle. One mechanism produced both reported symptoms: rectangles repeating
  during a drag, and apparent speeds no hand could produce.
- **A frame's timestamp was rounded on the way back from the host**, and it is
  the exact key that pairs a reply with the tick that asked for it. Anything with
  more than three decimals matched nothing, silently, and the sample was filed
  with no lag and no pixel-age correction at all.
- **The hover outline and the box disagreed by the invisible resize border.**
  They now come from one rectangle by construction.
- **A control was offered on the wrong screen.** Snapshot coordinates are
  per-display and a UI Automation dump's elements carry no display, so the same
  numbers were valid on two screens; a control now inherits its window's.
- **Picking an element in the browser could arm once and never again**, silently,
  with no error anywhere. Re-arming re-arms, the toolbar icon shows when the
  picker is armed, and a page the extension may not touch says so.
- **The Chrome native host died about two seconds after every connection.** The
  Electron binary writes a line break to stdout before any script runs, which
  corrupts the length-prefixed framing Chrome parses from byte zero. The host now
  runs as plain Node, and an existing registration is refreshed at app start
  instead of describing the build that wrote it forever.
- **A box created near the end of the replay moved backwards** to preserve its
  nominal duration, and **making a box longer grew it in both directions**. A box
  starts when the thing it names happens; the duration is what changes.
- **The trim handle stranded the playhead outside the trimmed range**, and the
  chip that describes the trim competed for width with the slider it describes.
- **Moving either trim boundary moved editor state that did not belong to it.**
  The playhead and selected box now stay where they are; only the retained range
  changes, with the playhead clamped only when it would otherwise be outside it.
- **The box header flipped below the box** when there was no room above, taking
  that box's own controls a window away from the corner the eye is on. It sits
  inside the box's top-left instead.
- **Clicking a control inside a just-picked window did nothing**, because the
  selected box swallowed the click.
- **A window on two monitors gave two rectangles for one instant**, and array
  order decided which screen's coordinates a tracked box was drawn in.
- **Editor popovers could cover each other or fall behind a box header.** Opening
  one now closes the other, both clamp inside the stage, and the unsaved-changes
  decision is a centered modal that stays legible on a dark desktop.
- **Changing one capture shortcut could unregister the other.** Video and image
  hotkeys now have independent registration and rollback.
- **History could appear to ignore Edit.** Pack I/O is detached from the click
  handler, replay bytes are resolved from the manifest, and the editor is shown
  only after its captured context is ready.
- **Launching the installed app could appear to do nothing.** A manual second
  launch now opens Information (or the explicitly requested window), waits
  until that window's IPC is ready during startup, and recovers cleanly if its
  HTML fails to load instead of keeping an invisible dead window.
- **An update could report that CapturePack could not be closed, then leave the
  app or Chrome integration disabled.** Installer stand-down now begins only
  after the single-installer mutex, covers the real close and old-uninstaller
  gates, snapshots per-user native-host/login state, and restores it on cancel,
  update, extraction failure, or a locked-file failure.

### Changed

- **Drawn rectangles are observations only.** Interpolating between samples
  shipped for one release candidate and was removed: at the sample spacing this
  app records, it measured *worse* than showing the nearest observation, and a
  rectangle nobody measured is a claim the pack cannot back.
- **Diagnostics moved out of the capture menu.** “Open logs folder” now lives in
  About / Information, where run and version diagnostics belong.
- **UI Automation change detection no longer subscribes to the crashing managed
  structure event.** A rooted out-of-context WinEvent hook marks only affected
  windows dirty; wrapper release and helper replacement are bounded so repeated
  capture cycles do not grow without limit.
- **The normal MP4 replay path now uses one encoder per display and a bounded
  fragmented-media ring.** Runtimes without legal MP4/AVC support fall back to
  complete staggered VP8/VP9 WebM sessions instead of silently losing video.
  Stop deadlines, generation ownership, and queue detachment prevent an old or
  hung recorder from retaining blobs or stopping its replacement.
- **A failed focused recorder can no longer leave an orphaned secondary
  replay.** Because the focused display owns the pack clock and scrubber, an
  all-displays capture now degrades every display to its frozen frame when that
  clock master is unavailable, instead of saving an untrimmable secondary ring.
- **Product documentation now describes the privacy boundary directly.** Live
  recording is conditional and records nothing when switched off; the optional
  localhost MCP server can be stopped and reads only packs the user already
  saved; image packs contain no replay or timeline; and blur protects derived
  annotated views without redacting the original media inside a full pack.

### Format

`format_version` **0.2.0 → 0.3.0**. New writers declare whether the user asked
for an image or video with `capture_kind`; image packs declare `image_scope` and
region crops declare `crop_bounds`. Per-display media may declare
`replay_clock_offset_ms`, and manually positioned boxes may carry authored
`keyframes`. Readers still accept legacy packs that omit these additive fields.

## 0.2.0 — 2026-07-29

Pack format **0.2.0**. A box now names an **object**, not a rectangle — and everything
that claim depends on travels in the pack, where a reader can check it.

### Added

- **Boxes follow what they point at.** Pick a window or a control and the box tracks it
  across the whole replay, on its own `tracking.samples` path.
- **Every rectangle in a track was observed.** Nothing is interpolated or averaged, so a
  pack can never show a position the object did not occupy. `accuracy` says how far the
  answer is from the requested time.
- **`tracking.picked_at_ms`** — the frame a picked box was picked in. `bounds` is the
  observed rectangle at that instant, so the two can be checked against each other.
- **Per-display media.** Each captured screen gets its own `snapshot-dN.png` and
  `replay-dN.webm`, at that screen's own resolution and scale.
- **A track says which screen each rectangle was measured on**, so a window dragged
  between monitors keeps meaning the right pixels of the right image.
- **`cadence`** — every display reports the frame rate its recorder achieved, its worst
  stall, and how many frames were discarded, so a reader knows whether an annotated
  moment is actually in the file.
- **Plugin API**, shipping with its first plugin: `plugins/windows-uia/` records the UI
  Automation tree at the capture instant.
- **Annotated stills** at every annotation change, in `frames/`.
- **A progress bar while the annotated replay renders.**

### Fixed

- **The box sat beside the window it named.** A video cannot be seeked to an arbitrary
  moment — it shows the last frame at or before the one you ask for. Anything drawn over
  the picture now asks on the picture's clock.
- **A picked box locked onto a moment before the click.** The anchor was computed from
  the lifetime, drifted outside a one-second track, and clamped to that track's first
  sample. It is now read from the frame on screen, from the screen the click landed on.
- **A window straddling two monitors is observed once per screen** — two rectangles at
  one instant, in two coordinate spaces. Which one a box used was decided by array order.
- **The surface ring held two clocks at once.** Ticked samples were stamped by the
  renderer, free-running ones by main; a single sample in the wrong space moved the
  ring's earliest time. One clock now, with the pre-tick samples converted, not dropped.
- **A leaked frame-tick chain.** Every recorder restart added another callback chain and
  another 4K video sink; measured at 100 ticks a second where 15 were asked for, which
  starved the recorder and coarsened the ring until the replay came out PARTIAL.
- **A still screen was reported as a stall.** A screen capture makes a frame when the
  screen changes, so an untouched monitor delivers almost nothing and has lost nothing.
- **One failed read could take the capture hotkey away.**
- **The pack clock started at the hotkey press** rather than where the replay starts.
- **Re-picking the same window made a second box** instead of selecting the first.
- **A box could be dragged off the object it was measured from**, silently keeping the
  claim. A tracked box is locked; moving it by hand ends the tracking, deliberately.

### Improved

- Boxes that follow an object are drawn green, and say so in the pack rather than
  relying on a reader's default.
- The recorder no longer competes with the observer that times it: sampling is driven by
  captured frames, so there is no clock arithmetic left to be wrong about.
- The validator checks the new claims — that every tracking sample is on its own
  display's snapshot, and that a picked box's `bounds` is the sample nearest its
  `picked_at_ms`.
- Release notes are a list you can scan.

### Format

`format_version` **0.1.0 → 0.2.0**. Additive: every 0.1.0 pack is still valid, and a
0.1.0 reader renders a 0.2.0 pack from `bounds` as it always did, ignoring what it does
not know. See SPEC.md §13.1.

## 0.1.1 — 2026-07-27

### Fixed

- Auto-update delivered end-to-end from GitHub Releases.

## 0.1.0 — 2026-07-26

First release. Press the hotkey after a bug happens, scrub back through the replay
buffer, annotate, and save a folder any human or LLM can read.
