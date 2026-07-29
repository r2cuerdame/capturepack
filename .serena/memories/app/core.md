# The app (`core/`)

Standard Electron split: `src/main`, `src/preload`, `src/renderer`, `src/shared`, plus
`src/watchdog` (a plain Node process that restarts a vanished app — it knows nothing about
Electron's asar, so `dist/scripts/**` is unpacked in the builder config).

`src/shared/ipc.ts` is the single IPC contract: channel names in `IPC`, payload types beside them.
Every channel is documented there with who talks and what a failure costs.

## Main modules worth knowing

| Path | Role |
|---|---|
| `main/index.ts` | Entry. Mode branches (`--native-host`, `--smoke`) run **before** the single-instance lock. |
| `main/session.ts` | The capture flow: freeze, save-first folder, editor window, plugin payloads. |
| `main/capture.ts` + `renderer/capture/` | Recorder slots, per-display MediaRecorders, cadence self-measurement. |
| `main/context/` | The surface ring and its providers — see below. |
| `main/chrome/` | Native messaging host, DOM bridge, browser registration. |
| `renderer/editor/` | The toolless editor: board, scrub, timebar, objects, lifetime. |
| `main/exporter.ts` | Writes the pack; one `write*Plugin` + `*PluginDeclaration` pair per plugin. |

## The clock model — the hardest part of this codebase

Everything drawn over a picture must be resolved on **the picture's clock**, not the playhead's.
A seek to T shows the last frame at or before T; the ring answers T exactly; drawing one over the
other puts the box beside the window.

- The surface ring (`main/context/timeline.ts`, `surfaceLane.ts`) is **driven by captured frames**,
  not a timer: one observation per frame, filed under that frame's time.
- The ring must hold **one** clock. Samples that arrive before ticking starts are held until a tick
  establishes the mapping, then converted — never appended in another timebase.
- The editor draws the base image **from the video-frame callback**, so the pixels and their time
  leave one event together (`renderer/editor/scrub.ts`, `trackPresentedFrames`).
- A picked box records `tracking.picked_at_ms` — the frame it was picked on — because the lifetime
  midpoint moves when the lifetime is edited and a picked box must not change meaning.

**Known open defect**: `frameClockOffsetMs` is re-derived on every tick from the tick's *arrival*
time in main, which makes the interval between a frame being captured and the UIA host reading the
desktop invisible (it always reports 0). Measured against real pixels, the track leads the picture;
the reported `tick lag` and `frame age` numbers do not measure it. Fixing this means relating the
renderer, main and host clocks by round trip instead of assuming simultaneity.

## Plugins in a pack

`plugins/windows-uia/` (capture-instant control tree) and `plugins/chrome-dom/` (what was clicked
in a browser). Both are optional and additive; both are declared in `manifest.json` only when a
payload was actually written.
