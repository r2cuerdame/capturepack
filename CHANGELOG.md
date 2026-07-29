# Changelog

All notable changes to CapturePack. Format follows [Keep a Changelog](https://keepachangelog.com/);
this project uses [semantic versioning](https://semver.org/) for the app, and the pack
format carries its own `format_version` (see [SPEC.md](SPEC.md) §13.1).

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
