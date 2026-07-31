# capturepack

**English** · [한국어](README.ko.md) · [日本語](README.ja.md) · [中文](README.zh.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md)

[![Release](https://img.shields.io/github/v/release/r2cuerdame/capturepack?color=7c5cff&label=release)](https://github.com/r2cuerdame/capturepack/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/r2cuerdame/capturepack/total?color=7c5cff)](https://github.com/r2cuerdame/capturepack/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Sponsor](https://img.shields.io/badge/%E2%99%A5_Sponsor-ea4aaa)](https://github.com/sponsors/r2cuerdame)

## Rewind the bug. Pick the object. Give AI the state.

**CapturePack turns a rolling replay — 30 seconds by default — into structured
evidence for humans and AI.**

Press the hotkey after something goes wrong, rewind to the frame where it happened,
and use Object Pick to select the captured control or window under the cursor.
CapturePack preserves the target's identity and observed movement instead of
leaving an AI to infer everything from pixels.

The saved pack matches what the user captured: a video pack combines replay,
frames, annotations, object context and an event timeline; an image pack contains
the explicit still image, annotations and object context. Double-click
`viewer.html` to inspect either kind offline, without installing CapturePack or
starting a server. It stays a local, open folder that works without an AI,
account, or cloud service.

🌐 **[capturepack.dev](https://capturepack.dev)** · [Download](https://github.com/r2cuerdame/capturepack/releases/latest)

Current public Windows release: **CapturePack 0.3.3**. It adds the offline pack
viewer and improves replay reliability, past-object picking and multi-display
context capture.

<p align="center">
  <a href="https://capturepack.dev/">
    <img src="https://raw.githubusercontent.com/r2cuerdame/capturepack/main/site/assets/motion/en/capturepack-time-machine-poster.webp" alt="CapturePack starts at NOW on the right, moves the playhead left to 5 seconds ago, restores and selects the child UI control that existed in that historical frame, and exports structured evidence for AI." width="760">
  </a>
</p>

Watch the direction: the playhead starts at **NOW on the right**, travels
**left to 5 seconds ago**, and only then does the missing **Save changes**
control return and become selectable. Object Pick records the identity captured
at that past instant; later scrubbing can follow observed owner-window movement.
The same evidence is saved as structured data for AI.

## The workflow

1. **Rewind** — while Live recording is on (the default), press `Ctrl+Alt+C`
   after the bug, then scrub through the frozen replay to the frame where the UI
   was wrong. Replay length is configurable from 1–60 seconds.
2. **Pick** — Object Pick highlights the UI controls that were on screen in the
   frame you scrubbed to. Click once to record the real target, observed bounds,
   accessible name, control type, and that instant; a window remains the
   fallback when control data is unavailable.
3. **Keep what the frame contained** — the pack records the controls that were on
   screen at that instant, including inside applications built on Chromium, and
   every rectangle names the display it belongs to. A box marks the moment it was
   picked at; it does not follow the object afterwards, because a replay cannot
   show a moment finer than a frame.
4. **Hand off structured context** — save the folder for another developer, drop
   it into ChatGPT, Claude, Codex, Cursor, or Gemini, or let a connected AI read
   it through the built-in, read-only MCP server.

### Where object context comes from

- **Windows UI Automation (built in):** accessible control name, semantic type,
  AutomationId, process/window identity, and observed bounds when the app exposes
  them.
- **Chrome DOM (optional preview extension):** selector, role, text and URL for
  the element you explicitly pick — click the CapturePack toolbar icon, then
  click the element. It works inside iframes, reads the page only for that pick,
  and does not stream the DOM. Settings › Plugins › Chrome DOM reports what the
  picker last did, so a pick that does not arrive says why.
- **HWND window fallback:** when no child control is available, CapturePack still
  records the real window and its observed geometry instead of inventing a
  control.

### Need one frame instead?

Press `Ctrl+Alt+S` to open region capture. Dragging a region is the default; the
top **Full screen capture** button explicitly captures the complete virtual
desktop — every monitor in one image. The result opens in the same context
editor at native 100% (or the closest supported scale for an exceptionally
large desktop) and is pannable, but the pack is declared as an image and
contains no replay file. A region pack stores only the selected pixels plus crop
placement metadata — it does not keep a hidden full-screen or second-monitor
image.

## Why

- **Screenshots preserve pixels.** You lose what happened before the frame.
- **Videos preserve motion.** You lose intent and structure.
- **CapturePack preserves context.** The replay, the picked UI object, observed
  movement, annotations, and the state that was actually captured.

## Rewind first

The bug already happened? If Live recording is on (the default), CapturePack has
the recent replay ready in memory. Press `Ctrl+Alt+C` *after* something goes
wrong, then use the mouse wheel to scroll **back through time** to the frame where
it broke. Turning Live recording off records nothing, and the hotkey tells you
that recording is off.

## What the structured context says

A semantic annotation can identify more than a rectangle:

- **Target identity:** UIA name, control type (the control's semantic role),
  AutomationId, process or window identity when the application exposes them;
  an optional Chrome DOM pick can instead carry selector, role, text and URL.
- **Captured state in time:** the picked instant, the display it was on, and the
  bounds observed at that instant.
- **Visual and narrative evidence:** original media, editable annotations,
  generated views and reports; video packs also carry keyframes and a timeline.

That context can be read from the plain folder. A connected AI can also use the
app's **read-only MCP server** and start with: *"Analyze the latest CapturePack."*

## 🌍 Languages

CapturePack speaks **9 languages**: English · 한국어 · 日本語 · 中文 · Español · Français · Deutsch · Português · Русский

- The app follows your **system language** automatically — change it any time in Settings → General.
- Generated pack documents (`viewer.html`, `README.md`, `report.md`, `skills/`) can follow their own language setting; your own descriptions are never translated.
- [capturepack.dev](https://capturepack.dev) auto-detects your browser language too.

## Principles

Local first · Offline first · Open format · Plugin based · No cloud · No login · No database · No AI dependency · No vendor lock-in.

Generated CapturePacks should remain readable forever.

## What's inside a CapturePack

The pack is a plain **folder** — browsable, editable, honest. ZIP (`.capturepack`)
is created only when you want to share.

Video packs may contain:

```
CapturePack_2026-07-27_143052/
├── replay.mp4               # original evidence (or replay.webm fallback)
├── replay_annotated.webm    # optional derived view; only when manifest-declared
├── snapshot.png             # the captured frame (original)
├── annotations.json         # the true source: boxes, lifetimes, numbers, blur
├── timeline.json            # video packs: machine-readable event log
├── viewer.html              # double-clickable offline view; no server
├── report.md                # your description, LLM-ready
├── manifest.json            # format version, inventory
├── README.md                # the first document a human reads
├── skills/                  # context structured for AI (works without MCP)
└── plugins/                 # captured UI-object metadata, when available
```

Image packs are deliberately different:

```
CapturePack_2026-07-27_143052/
├── snapshot.png             # the explicit region or full virtual desktop
├── annotations.json         # image annotations
├── viewer.html              # double-clickable offline view; no server
├── report.md · README.md
├── manifest.json            # capture_kind: image
├── skills/                  # image-specific context; no timeline skill
└── plugins/                 # optional object metadata
```

An image pack records `capture_kind: "image"` and either a region or full-screen
scope. It has no replay and no `timeline.json`. A region image also records where
the crop came from without storing pixels outside the crop.
Object metadata is also optional evidence: if an application does not expose a
usable UI object, the pack says so instead of fabricating context.

The specification matters more than any implementation — any language can generate CapturePack files. See [SPEC.md](SPEC.md).

## MCP — talk to your captures

The app includes an optional, read-only [MCP](https://modelcontextprotocol.io)
server, enabled and started automatically by default at
`http://127.0.0.1:39393/mcp` (localhost only). Settings → MCP can stop it
immediately or disable automatic start. It reads only CapturePacks the user
already saved and cannot start an image or video capture.

An AI can call `capturepack_history` to browse/search image and video records,
then `capturepack_open` with the selected id; `capturepack_latest` remains the
shortcut for the newest pack.

```
claude mcp add --transport http capturepack http://127.0.0.1:39393/mcp
```

Tools, client setup, and settings: [docs/MCP.md](docs/MCP.md).

## Settings and diagnostics

- Settings → Capture independently configures the video (`Ctrl+Alt+C`) and image
  (`Ctrl+Alt+S`) shortcuts, replay length and 5–30 fps capture rate.
- About / Information → **Open logs folder** opens the local, size-capped run
  diagnostics. Logs are never uploaded automatically.

## Status

**0.3.3 is the current public Windows download.** CapturePack remains an
early-stage project, so keep the original pack when reporting a problem and see
[GOAL.md](GOAL.md) for the product vision and [ROADMAP.md](ROADMAP.md) for what
comes next.

Known limitation: per-display video/context PTS alignment remains under
measurement in [issue #89](https://github.com/r2cuerdame/capturepack/issues/89).
CapturePack records ambiguous timing evidence instead of hiding it behind a
hard-coded global offset.

## Documentation

- [Documentation index](docs/README.md) — the best entry point for engineering,
  integrations, QA, releases, schemas, and historical material.
- [Pack specification](SPEC.md) and [architecture](ARCHITECTURE.md) — the open
  format contract and current implementation boundaries.
- [Release QA](docs/QA.md), [current handoff](docs/HANDOFF.md), and
  [release process](docs/RELEASING.md) — how changes are verified, handed over,
  and published.
- [MCP](docs/MCP.md) and [temporal provider API](docs/temporal-provider-api.md)
  — read-only saved-pack access and context-provider integration.

CapturePack `0.3.3` is the application version. Pack `format_version` evolves
independently through additive format changes; readers must follow
[SPEC.md](SPEC.md) rather than infer format support from the app version.

## Security &amp; signing

Windows builds are currently unsigned (SmartScreen will warn — *More info → Run anyway*);
every release ships `SHA256SUMS.txt` for verification, and an OSS code-signing application
is pending. Details, team roles, and privacy practices: [docs/CODE_SIGNING.md](docs/CODE_SIGNING.md).

## Privacy before sharing

Screen pixels, window titles and accessibility names — plus selector, role, text
and URL when Chrome DOM is used — can be sensitive. CapturePack keeps captures
and object context on this machine and uploads no captures, telemetry or crash
reports. Its only outbound app request is the optional GitHub Releases update
check, which can be disabled in Settings → General.

Blur is non-destructive: it protects generated annotated views, but
`snapshot.png` and the original replay inside the full pack remain unredacted.
Review a pack before sharing it, and do not share the full pack when its original
media contains information that must stay private.

## ♥ Support

CapturePack is free, open source, and cloud-free — no accounts, no telemetry, nothing to sell.
If it saves you time, [**sponsoring on GitHub**](https://github.com/sponsors/r2cuerdame) keeps it moving.

## License

[MIT](LICENSE)
