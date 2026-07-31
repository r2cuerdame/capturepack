# Changelog

All notable changes to CapturePack. Format follows [Keep a Changelog](https://keepachangelog.com/);
this project uses [semantic versioning](https://semver.org/) for the app, and the pack
format carries its own `format_version` (see [SPEC.md](SPEC.md) §13.1).

## Unreleased

### Fixed

- A trim whose out-point lands inside a held frame cuts where it was asked to.
  The render only tested the out-point when a new frame was presented, so
  across a frame the replay holds — up to 197 ms in a measured capture, and far
  longer across a recorder restart — the cut was noticed only on the far side
  and overshot by that much
  ([#116](https://github.com/r2cuerdame/capturepack/issues/116)).
- A measured source latency outlives the capture that found it. The calibration
  succeeds only when the desk happens to move during the two seconds after a
  recorder starts, and every capture in this machine's log before one on
  2026-07-31 reported no motion to measure against; the one that succeeded
  measured 37.7 ms and the number was then discarded. The last **measured**
  value is now kept per display. A later "could not measure it this time" no
  longer reads as "there is nothing to say" — it reports what is remembered and
  how old it is — while a backend change, which is a different path to the
  glass, voids it. Calibration itself runs exactly when it did, at exactly the
  same cost to the recorder
  ([#115](https://github.com/r2cuerdame/capturepack/issues/115)).
- Picking an element in a browser works on pages whose interface lives inside an
  iframe. The picker previously ran only in the top document, so a click inside
  a frame reached nothing and was swallowed without a message, a failure or any
  visible change ([#104](https://github.com/r2cuerdame/capturepack/issues/104)).
- An explicitly picked document element is no longer discarded by the filter
  written for enumerated window controls. A picked `<main>`, `<nav>` or content
  column covering more than a third of a browser window was dropped outright,
  leaving only the whole-window box.
- A routine "update ready" notification is held while the screen is locked and
  shown when the session returns. With lock-screen content set to private,
  Windows reduced it to the app name and a red badge, which reads as a recording
  failure ([#103](https://github.com/r2cuerdame/capturepack/issues/103)). A real
  capture failure still announces itself immediately.

### Added

- The capture log now says where a recording's time went: how many fragments
  arrived over how many deliveries, how many samples they carry, what the
  encoder's own clock spans, and the longest single frame the replay holds. A
  two-display capture reported a 903 millisecond stall and produced a replay
  whose longest held frame was 197 ms, 17.6 seconds of screen written as 5.3
  seconds of video, and there was no way to tell from the outside which layer
  had dropped the time. These numbers separate them
  ([#116](https://github.com/r2cuerdame/capturepack/issues/116)). They are
  recorded, never acted on.
- **Pack format 0.6.0**: a measured source latency travels with the evidence.
  `media.cadence.source_latency` says how far a recorder's pixels lagged the
  glass — `measured_ms` with the `reference` and `timing` it was matched
  against, and optionally the matcher's `confidence`, the reference's
  `uncertainty_ms`, and `age_ms` when the measurement was carried forward from
  an earlier capture of the same display. All three of the first are required
  inside the object, because the same number means different things against a
  pixel exposure and against an operation completion; a writer that cannot say
  which one it matched has not measured a source latency, and the pack stays
  silent rather than publishing one. Only a pack that emits the field declares
  0.6.0 ([#115](https://github.com/r2cuerdame/capturepack/issues/115)). This is
  the number [#89](https://github.com/r2cuerdame/capturepack/issues/89) needs:
  it can now be read straight out of a pack and set beside the 118–127 ms the
  offline harness measures, so the remaining difference belongs to a named leg
  instead of an estimate.
- The application records what the element picker did: arming, failing to arm
  with the browser's own reason, disarming, every pick that arrived, and every
  message it refused together with the rule that refused it. Settings ›
  Plugins › Chrome DOM shows the last state, and the log carries the rest.
- A pick that cannot be placed on a display now says why — no visible browser
  window, a window whose title does not match the tab, more than one candidate
  window, or a viewport that disagrees with the observed client rectangle.
- Deterministic checks for the cross-frame arithmetic (`check:frame-geometry`)
  and for a picked element surviving all the way into the editor's pick index
  (`check:dom-pick`). The end-to-end browser-to-pack harness
  (`check:chrome-bridge`) now runs as part of the release gate.
- A deterministic moving fixture for video/context alignment
  (`check:exposure-alignment`). It measures how late a display puts pixels on
  the glass by correlating a moving landmark's *position* between the recorded
  context and the decoded replay, rather than comparing timestamps that already
  agree. It refuses to produce a number from a stationary or barely-moving
  capture, keeps each display's latency separate, and fails if the correction is
  ever applied in more than one place
  ([#89](https://github.com/r2cuerdame/capturepack/issues/89)).
- `npm run qa:exposure-field -- --pack <dir>` measures that latency from a saved
  CapturePack: it recovers the landmark's rectangle over time from the recorded
  window context, decodes the replay, and matches each frame against the
  rectangles that were actually observed. It reads the pack and writes nothing
  back, and it refuses rather than reporting a number when too few frames can be
  identified.

- Trimming a capture now moves the whole annotation onto the trimmed clock, not
  just its lifetime. Observed samples, the pick instant and authored keyframes
  kept their old times: on a tail cut that left a couple of samples past the end
  of the replay, and on a cut from the front it put every sample out by the
  in-point, so a box followed its object at a constant offset
  ([#114](https://github.com/r2cuerdame/capturepack/issues/114)).
- Trimming a capture no longer changes its codec. The exact cut re-encodes — the
  format permits that — but it asked its encoder for WebM whatever the recorder
  had produced, so cutting 310 ms off the end of an H.264 recording quietly
  turned it into VP8 and renamed the file. It now asks for the container the
  capture was recorded in and declares whatever actually came back
  ([#113](https://github.com/r2cuerdame/capturepack/issues/113)).
- A pack's recorded cadence describes the replay it contains again. On a
  multi-display capture the numbers were re-read after the editor closed and the
  trim finished, so a capture that ran at 14.5 fps with a 16 ms worst stall
  reached the pack as 14.2 fps and 1417 ms — measured 47 seconds later, while
  the recorder was still running behind the open editor
  ([#112](https://github.com/r2cuerdame/capturepack/issues/112)).
- A display whose screen barely changed now says that its replay is not on the
  capture's clock. Such a screen makes almost no frames and the ones it makes
  are laid end to end, so 18.7 s of capture came back as 3.7 s of media whose
  frames sit at a uniform interval — and no offset can stretch that back. The
  pack's own description and the capture log now name it, so a reader stops
  treating the two as the same clock
  ([#110](https://github.com/r2cuerdame/capturepack/issues/110)).
- Pressing Check for updates now says so when there is nothing to update, instead
  of changing a tray label for a few seconds and otherwise looking identical to a
  broken updater ([#111](https://github.com/r2cuerdame/capturepack/issues/111)).
  The four-hourly automatic check stays silent.
- Extending a box's lifetime to the end of the replay no longer drags its start
  backwards. A ten-second lifetime asked for on a box starting at 12.0 s of a
  14.7 s replay became 4.7 s–14.7 s, drawing the box over seven seconds in which
  the thing it names had not happened yet. There is less room than was asked
  for, and the box is now that much shorter instead
  ([#109](https://github.com/r2cuerdame/capturepack/issues/109)).
- Control geometry keeps up with the picture instead of being crowded out.
  Walking a Chromium window's accessibility tree cost 92% of everything the
  control lane did on the reporting machine — 1534 ms of a 1673 ms pass — and
  one of them stalling took the whole lane down for 20 s, so a capture could
  save with no control geometry at all, including for the cheap windows it never
  reached. Those windows are no longer walked: a real browser already reports its
  own document, and the lane says on its cost line how many it left alone and how
  many controls it could afford ([#108](https://github.com/r2cuerdame/capturepack/issues/108)).
- A picked object keeps its box when its window is dragged to another monitor.
  The box used to stop following at the seam and sit there for the rest of its
  lifetime while the video carried the window away, and the object could not be
  picked on the screen it had moved to. Windows applies a display's DPI to a
  window only when the drag ends, so mid-drag the window is seen on the new
  screen at the size it still physically is — which was read as a resize and
  ended the track ([#107](https://github.com/r2cuerdame/capturepack/issues/107)).
  A window that genuinely resizes still ends it, because its children may have
  been laid out again.
- Re-editing a saved CapturePack now records what the editor did. Both capture
  flows already forwarded the editor's own diagnostics to the log and the
  re-edit flow never did, so the one session a problem is usually reported from
  was the one session that could not be asked what happened
  ([#106](https://github.com/r2cuerdame/capturepack/issues/106)).
- A click on the canvas that could not be acted on now says which rule consumed
  it — the editor still loading, a point belonging to no display, a context
  frame that has not settled, or a deferred object answer discarded as stale.
  All four were previously indistinguishable from a box that refuses to move.

### Changed

- Every recorded context sample now carries the age of the picture it describes.
  The correction had only ever been applied to samples stamped directly by the
  frame clock, which is about 6% of them; the remaining majority was converted
  without it ([#89](https://github.com/r2cuerdame/capturepack/issues/89)). At the
  age this machine currently reports nothing moves, and it is what keeps the fix
  for #89 from pushing most samples the wrong way.

- Protocol v1 documents the picker lifecycle messages the extension has sent
  since 0.1.5 and the `viewport` block it has sent since 0.1.4, and corrects the
  advice to multiply element bounds by `devicePixelRatio`: the snapshot scale is
  measured from the window's observed client rectangle, and the device pixel
  ratio is the cross-check.
- Chrome extension 0.1.9.

## 0.3.3 — 2026-07-30

Replay reliability, past-object picking, multi-display capture and portable
offline pack viewing.

### Added

- CapturePack folders can include a generated, script-free `viewer.html` that
  opens directly from disk without a server, network, account or installation.
- Replay diagnostics now preserve measured cadence, source/backend health and
  per-display clock evidence instead of filling unknown values with guesses.
- Release QA covers bounded recorder retention, fallback health, temporal
  alignment, semantic objects crossing display boundaries and offline viewer
  safety.

### Changed

- Capture rate choices are bounded to 5–30 fps. Existing 1–4 fps settings
  migrate to 5 on load while historical pack provenance remains readable.
- Context collection prioritizes active and changed windows, contains slow
  providers, and keeps plugin failure from blocking source-first pack saves.
- Image and video editors preserve native media aspect, make oversized captures
  fit in one view, and retain annotation placement through save and reopen.

### Fixed

- Past and reopened frames retain available Windows UI Automation and Chrome
  DOM evidence instead of silently substituting the latest frame.
- Mixed-DPI, portrait, negative-origin and cross-monitor capture paths use the
  owning display geometry consistently.
- Replay rings are bounded, recorder/flush ownership is explicit, and failed
  displays can recover without discarding healthy display state.
- The Chrome extension consumes expected native-port disconnect errors before
  its bounded retry, so transient host startup no longer accumulates misleading
  `Unchecked runtime.lastError` entries.
- Generated documentation and the offline viewer are regenerated with late
  plugin and annotated-render revisions and name only manifest-declared media.

### Known issues

- [#89](https://github.com/r2cuerdame/capturepack/issues/89): when startup
  calibration has insufficient motion evidence, context overlays can still
  lead encoded video by a display-specific amount. CapturePack records the
  ambiguous state rather than applying a guessed fixed offset; measured
  per-display source-to-encoded-PTS alignment remains open.

## 0.3.3-rc.2 — 2026-07-30

External test candidate for measured replay timing and the offline pack viewer.

### Changed

- Capture rate choices are now bounded to 5–30 fps. Existing 1–4 fps settings
  migrate to 5 on load; historical pack provenance remains readable.
- CapturePack folders can include a generated, script-free `viewer.html` that
  opens directly from disk without a server, network, account or installation.

### Fixed

- Past object samples are aligned to the observed same-frame screen
  `captureTime`, with measured media-clock calibration as a fallback instead
  of a fixed timing correction.
- Replay clock mapping rejects sink resets and unstable or non-monotonic
  anchors rather than inventing object states between observations.

## 0.3.3-rc.1 — 2026-07-30

External test candidate for temporal object picking, still-image capture and
Windows context collection.

### Fixed

- Past and reopened frames retain selectable window, UI Automation and Chrome
  DOM objects instead of falling back to the last frame.
- Mixed-DPI and negative-origin monitor geometry is matched by physical display
  bounds for video, still images and cross-monitor region capture.
- Still images open at native 1:1 when they fit and contain the complete image
  when they are larger than the editor.
- UI Automation prioritizes changed and foreground windows, accounts for a 3%
  steady-state CPU budget, and quarantines a hanging or crashing provider per
  HWND without starving healthy applications.
- The landing page uses localized time-machine and still-context motion demos
  in all nine supported languages.

## 0.3.2 — 2026-07-30

Focused Windows editor and multi-monitor correctness patch.

### Fixed

- **The still-image selector could lose the lower 528 pixels of a left portrait
  monitor.** Electron was constraining a frameless, non-resizable overlay to
  the primary work area. Selector windows now keep native resize capability
  during construction without a native thick-frame hit zone, veto user
  resizing, reapply every display's exact bounds, and fail closed unless the
  actual HWND bounds match while hidden, after reveal and after focus
  activation.
- **A region selected on one monitor could open its editor on another.** The
  selected rectangle's largest display overlap now owns editor placement;
  shortcut focus is only the tie-breaker for an exact cross-monitor split.
- **A still-image editor could open as a blank dark page with Windows caption
  buttons covering the toolbar.** The preload now buffers the one-shot
  `editor:init` message before renderer subscription. Main now keeps the native
  editor hidden until the renderer has decoded its media, crossed a paint
  boundary and acknowledged success. Hidden-window throttling is disabled only
  for this bootstrap and restored before reveal; decode failure closes the
  hidden window instead of revealing a blank shell. The initial document also
  reserves native caption space before initialization.
- **Manual and semantic boxes no longer share an arbitrary colour picker.**
  New manual rectangles are red, picked objects are blue, all renderers use one
  colour rule, and stored legacy/custom colours remain unchanged. Semantic
  rectangles cannot be moved into manual keyframes. Chrome DOM picks persist
  provider target identity so that rule survives save and reopen. Selection
  handles and move cursors now follow the same ownership rule instead of
  advertising gestures that semantic boxes reject.
- **The landing demo could read as forward playback.** Its rail, playhead,
  labels and reduced-motion frame now explicitly start at `NOW` on the right,
  move left to the past, then reveal and select the historical child control.

### Verification

- The RC gate passes all 50 sequential checks, including actual hidden and
  activated Electron windows on every attached display, mixed-DPI/negative-origin
  region fixtures, a hidden two-frame paint probe, editor
  bootstrap/acknowledgement event-order tests, DOM target round trips, build,
  isolated Electron smoke, and strict forensic validation of the reported pack
  with zero errors and zero warnings.

## 0.3.1 — 2026-07-30

Post-release hotfixes found by adversarial QA against the public 0.3.0 build.

### Fixed

- **Chrome DOM boxes used the wrong size and position after crossing mixed-DPI
  displays.** Browser CSS bounds are now projected through the owner window and
  the scale of the display that actually owns that observation. The regression
  covers a 2x-to-1x move, past-frame picking and save/reopen. The expanded
  16-case gate separates DPI changes from simultaneous window resize, preserves
  resize semantics on same-scale monitor moves, fails closed when scale is
  missing, keeps same-millisecond same-selector picks uniquely identified,
  reports temporal accuracy per candidate, keeps spanning-window claims on the
  candidate's visible display slice, and rejects hostile negative geometry.
- **Late plugin context could leave generated pack documents stale.** When
  UIA/DOM/plugin data lands after the save-first folder exists, the final source
  publication regenerates README, report and skills from the completed manifest
  before the pack is presented as saved.
- **Generated guidance could point to an annotated replay that did not exist.**
  Pack documents now recommend derived replays/keyframes only when the final
  manifest declares them; otherwise they point readers to the source
  replay/snapshot and structured JSON that are actually present.
- **A clean dependency install could fail the final Electron smoke before the
  app started.** Electron 42+ downloads its development binary on first package
  resolution instead of `postinstall`; QA now uses that supported lazy path,
  pins Node 22.12+ in package and CI contracts, and retains a regression against
  the obsolete `node_modules/electron/dist` assumption.

### Release safety

- The manual release workflow stages the exact installer, blockmap,
  `latest.yml` and `SHA256SUMS.txt` in a draft, downloads all four assets again,
  byte/hash-verifies them, and only then makes the GitHub Release public.
  Packaging explicitly disables electron-builder's implicit CI publishing, so
  `npm run dist` cannot upload before the local contract passes.
- The installer persists its integration recovery snapshot immediately after a
  previous version is removed, before electron-builder's callback-free
  extraction exits can run. Its custom close gate also initializes builder
  26's bundled process detector before the first process lookup, so strict NSIS
  packaging cannot ship—or silently skip—a malformed handoff.

### Security

- Updated `adm-zip` to 0.6.0 for CVE-2026-39244 (crafted ZIP metadata could
  drive a multi-gigabyte allocation), and updated
  `@modelcontextprotocol/sdk` to 1.30.0 with `@hono/node-server` 2.0.12 for
  GHSA-frvp-7c67-39w9.
- Refreshed Electron to 43.2.0, electron-builder to 26.15.3 and esbuild to
  0.28.1. `npm audit --omit=dev` reports **0 production vulnerabilities**.
  The latest electron-builder dependency tree still reports 16 high-severity
  development-only advisories with no fixed upgrade in its current release
  line; npm's suggested 25.1.8 is a downgrade. They are retained in the
  [0.3.1 dependency audit](docs/DEPENDENCY-AUDIT-0.3.1.md) rather than
  misreported as product runtime exposure.

## 0.3.0 — 2026-07-30

Pack format **0.3.0**. This release makes recorded object evidence available at
past frames, after reopen and across displays. It preserves the bounds and
movement CapturePack actually observed; unavailable or single-instant provider
coverage stays explicit instead of being inferred.

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
  app or Chrome integration disabled.** Installer stand-down is now scoped to
  the active installer, covers the real close and old-uninstaller gates, and
  snapshots per-user native-host/login state for handled cancel/failure paths.
  Packaged update/cancel behavior remains part of the required manual Windows
  smoke in `docs/QA.md`.

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
