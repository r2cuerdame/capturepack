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
the explicit still image, annotations and object context. It stays a local, open
folder that works without an AI, account, or cloud service.

🌐 **[capturepack.dev](https://capturepack.dev)** · [Download](https://github.com/r2cuerdame/capturepack/releases/latest)

Current public Windows release: **CapturePack 0.3.0**. The source and release
candidate baseline is **0.3.1**; it corrects Chrome DOM geometry across
mixed-DPI displays and keeps generated pack documents in sync with the final
manifest and the artifacts that actually exist.

<p align="center">
  <!-- Absolute raw URL with a version query: GitHub proxies README images through
       camo, which caches by source URL — without the bump a fixed demo keeps
       rendering the stale copy for hours. Bump ?v= whenever demo.svg changes. -->
  <img src="https://raw.githubusercontent.com/r2cuerdame/capturepack/main/site/assets/demo.svg?v=4" alt="CapturePack rewinds to a past frame, selects a child UI control, shows its captured name and control type, follows its owner window, and exports structured evidence for AI." width="760">
</p>

The animation shows **Object Pick in the current editor**: rewind to a captured
frame, hover and click a child UI Automation control, inspect the identity
captured at that instant, then scrub while its outline follows the observed
owner-window movement. The same evidence is saved as structured data for AI.

## The workflow

1. **Rewind** — while Live recording is on (the default), press `Ctrl+Alt+C`
   after the bug, then scrub through the frozen replay to the frame where the UI
   was wrong. Replay length is configurable from 1–60 seconds.
2. **Pick** — Object Pick highlights captured UI controls under the cursor. Click
   once to record the real target, observed bounds, accessible name, control
   type, and captured instant; a window remains the fallback when control data
   is unavailable.
3. **Track the window** — CapturePack records window geometry on the replay clock.
   A picked control follows the observed translation of its owner window. Richer
   per-control movement is used only when it was actually captured; otherwise
   CapturePack does not invent it. Each observation names its display, so saved
   and reopened multi-monitor packs keep their timing and coordinates when an
   object crosses screens.
4. **Hand off structured context** — save the folder for another developer, drop
   it into ChatGPT, Claude, Codex, Cursor, or Gemini, or let a connected AI read
   it through the built-in, read-only MCP server.

### Where object context comes from

- **Windows UI Automation (built in):** accessible control name, semantic type,
  AutomationId, process/window identity, and observed bounds when the app exposes
  them.
- **Chrome DOM (optional preview extension):** selector, role, text and URL for
  the element you explicitly pick. The extension reads the page for that pick;
  it does not stream the DOM.
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
- **Captured state in time:** the picked instant, display, observed bounds, and —
  when tracking is available — observed movement samples.
- **Visual and narrative evidence:** original media, editable annotations,
  generated views and reports; video packs also carry keyframes and a timeline.

That context can be read from the plain folder. A connected AI can also use the
app's **read-only MCP server** and start with: *"Analyze the latest CapturePack."*

## 🌍 Languages

CapturePack speaks **9 languages**: English · 한국어 · 日本語 · 中文 · Español · Français · Deutsch · Português · Русский

- The app follows your **system language** automatically — change it any time in Settings → General.
- Generated pack documents (`README.md`, `report.md`, `skills/`) can follow their own language setting; your own descriptions are never translated.
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
├── report.md · README.md
├── manifest.json            # capture_kind: image
├── skills/                  # image-specific context; no timeline skill
└── plugins/                 # optional object metadata
```

An image pack records `capture_kind: "image"` and either a region or full-screen
scope. It has no replay and no `timeline.json`. A region image also records where
the crop came from without storing pixels outside the crop.
Object metadata and movement tracks are also optional evidence: if an application
does not expose a usable UI object or no track was observed, the pack says so
instead of fabricating context.

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
  (`Ctrl+Alt+S`) shortcuts, replay length and 1–30 fps capture rate.
- About / Information → **Open logs folder** opens the local, size-capped run
  diagnostics. Logs are never uploaded automatically.

## Status

**0.3.0 remains the public Windows download.** 0.3.1 is a release candidate,
not a public release until it appears on GitHub Releases. CapturePack remains
an early-stage project, so keep the original pack when reporting a problem and
see [GOAL.md](GOAL.md) for the product vision and [ROADMAP.md](ROADMAP.md) for
what comes next.

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
