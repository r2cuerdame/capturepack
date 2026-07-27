# CapturePack

> **Capture context, not screenshots.**
>
> **Better input. Better answers.**

## Essence

두 문장이 프로젝트의 본질이다. README에 크게 써놓는다.

> **Can you explain a bug in under 5 seconds?**
>
> **The fastest way to explain something to an LLM.**

- **Repository Type:** Open Source
- **License:** MIT

---

## Vision

CapturePack is a local-first context capture toolkit designed for humans and AI.

It captures not only pixels but also user intent, interaction, and application context.

Instead of sending screenshots or videos, people send CapturePacks.

A CapturePack should contain enough information that another human or any LLM can immediately understand the situation.

---

## Mission

Build the fastest possible workflow for explaining visual problems.

**Target workflow:**

```
Ctrl+Alt+C
    ↓
Capture current context
    ↓
5-second annotation
    ↓
Export CapturePack
    ↓
Drop into ChatGPT / Claude / Codex / Cursor / Gemini
or send to another developer.
```

The workflow should feel instantaneous.

---

## Philosophy

**CapturePack is NOT**

- Screen Recorder
- Bug Tracker
- Issue Manager
- Cloud Service
- AI Product

**CapturePack IS**

A universal context package.

- Screenshots preserve pixels.
- Videos preserve motion.
- CapturePack preserves context.

**Context means**

- Time
- Space
- Intent
- Environment
- Optional Metadata

Video is evidence.
Annotations describe intent.
Metadata provides understanding.

---

## Core Principles

- Local First
- Offline First
- Open Format
- Open Source
- Plugin Based
- No Cloud
- No Login
- No Database
- No AI Dependency
- No Vendor Lock-In

Generated CapturePacks should remain readable forever.

---

## Success Criteria

| KPI | Criteria |
| --- | --- |
| Primary | The creator naturally uses CapturePack every day. |
| Secondary | Developers begin attaching CapturePack files instead of screenshots. |
| Operational | Install once from a GitHub Release, then keep using it for a month without any manual reinstall. |
| Long-term | CapturePack becomes an open specification adopted by other tools. |

---

## Landing Page (GitHub Pages)

The goal of the page is not to explain the product — it is to drive the Download click.

- Domain: **https://capturepack.dev** — the one and only official domain; every document,
  README link, and download link uses it. A one-line `CNAME` file (exactly `capturepack.dev`)
  lives at the repo root AND in `site/` so every Pages deployment carries the domain; it must
  always match the Pages custom-domain setting. DNS: apex A records 185.199.108–111.153,
  `www` CNAME → `r2cuerdame.github.io`. Enforce HTTPS as soon as the certificate is issued.
- Static site served by GitHub Pages from `site/` in this repository (no separate repo).
- One page, minimal scroll, no signup/server/database, no flashy animation.
- A visitor must understand the product within 5 seconds; the only action is **Download**.

Structure:

- **Hero** — "Capture context, not screenshots." / "The fastest way to explain something
  to humans and AI." Exactly three buttons: **Download**, **GitHub**, **♥ Sponsor**
  (GitHub Sponsors).
- **Demo** — one ~10s GIF below the hero: Ctrl+Alt+C → capture freezes → mouse wheel moves
  through time → click object → write annotation → CapturePack exported.
- **Output preview** — the generated pack tree (manifest.json, snapshot.png, annotations.json,
  timeline.json, report.md, replay video).
- **Footer** — MIT License · Open Source · "Made because explaining bugs to AI was taking
  too much time."

Download always points at the latest GitHub Release; release info is auto-reflected
(client-side fetch of the latest release, falling back to the releases page).
Deployment: `.github/workflows/pages.yml` publishes `site/` on push to main.

---

## Development Practice: Usage Journal

Open GitHub Issues from day one — and don't use them only for feature requests.
Keep a daily usage journal:

```
Used Today

Today I used CapturePack 7 times.

Pain

- Annotation took too long.

Idea

- Need object picker.
```

After a month, the journal itself becomes the best roadmap.

---

## MVP

**Capture**

- 30-second replay buffer
- Screenshot

**Annotation**

- Pin
- Arrow
- Rectangle
- Blur
- Text

**Export**

A `.capturepack` file (a standard ZIP) contains:

- `manifest.json`
- `replay.webm` (or `replay.mp4`)
- `snapshot.png`
- `annotations.json`
- `report.md`

No plugins required. Everything works locally.

**Save-first capture** — the moment Ctrl+Alt+C is pressed, the raw capture (snapshot +
replay + manifest) is saved to disk immediately, BEFORE the editor opens. Annotating then
updates the same pack in place; **Save** (Enter) finalizes it. Cancelling the editor keeps
the raw capture; a crash can never lose one. The UI verb is **Save**, not Export —
"export" survives only as the SPEC's internal event name (`core.export.created`).

**Output layout — Folder First.** The primary save unit is always a **folder**; ZIP is not
the original, only an optional distribution package created when the user clicks
[ Create ZIP ]. (This supersedes the earlier date-folder + automatic zip layout — the date
lives in the folder name now.)

```
CapturePack_2026-07-27_143052/
├── replay.webm              ← original evidence, never modified
├── replay_annotated.webm    ← annotations rendered in; plays in any player
├── snapshot.png
├── annotations.json         ← the true source: annotations, lifetime, DOM,
│                              tracking, style, bounds — replay_annotated is
│                              always regenerable from it
├── timeline.json            ← all time info: window, DOM, focus, mouse,
│                              keyboard, plugin metadata
├── report.md                ← the user's own description
├── manifest.json            ← format version, file inventory, plugins, created
├── README.md                ← the FIRST document a human reads
├── skills/                  ← context structured for LLMs, readable without MCP
│   ├── overview.md          ← whole-pack summary
│   ├── timeline.md          ├── annotation.md
│   ├── dom.md               └── project.md
└── plugins/
```

**README.md (human-first)** — Created, Application, Duration, Description, Files,
How to use (1. open replay_annotated 2. read report.md 3. open via CapturePack MCP).
Reading README alone must be enough for a person to understand the whole pack.

**skills/ (AI-first)** — structured so an LLM understands the pack immediately even
without the MCP server.

**Save pipeline** — Save → create folder → metadata → original replay →
annotated-replay render (may run in the background).

**Save-complete UI**

```
Saved  CapturePack_2026-07-27_143052
[ Open Folder ] [ Copy Folder Path ] [ Create ZIP ] [ Copy Prompt ]
```

**Principles** — the folder is the source; ZIP is distribution. replay is evidence;
replay_annotated is the instantly-understandable result; annotations.json is the true
original. A person should understand from replay_annotated alone; an AI should
understand from README.md + skills/ alone. One CapturePack must carry complete context
for both.

---

## V1 Release & Auto-Update (Required)

Auto-update is **required in V1** — not a nice-to-have. The creator uses CapturePack daily while
fixing it frequently; downloading a ZIP from GitHub and replacing files by hand breaks the usage
habit. Auto-update is the deployment infrastructure that turns CapturePack from a development
experiment into a real resident tool.

**Update flow (Windows)**

```
GitHub Release
    ↓
Check latest version on app start
    ↓
Notify if a new version exists
    ↓
Background download
    ↓
Replace on app exit
    ↓
Relaunch
```

**Auto-update principles**

- GitHub Releases only — no separate update server.
- No forced restart while in use.
- If an update fails, keep the existing version.
- Hash verification (SHA-256) of update files.
- Auto-check can be disabled in settings.
- Stable / Preview channels can be separated.

**Update UX**

Fully unattended updates are not the starting point. The safe initial UX:

```
CapturePack 0.1.4 available

[Restart and update]  [Later]
```

Download ahead of time; let the user restart after finishing their work. CapturePack holds a live
screen replay buffer — force-killing it is not acceptable.

**Release pipeline**

```
Git tag: v0.1.4
    ↓
GitHub Actions
    ↓
Build + Test
    ↓
Code sign
    ↓
Generate SHA-256
    ↓
Upload GitHub Release
    ↓
Update latest.json
```

Example `latest.json`:

```json
{
  "version": "0.1.4",
  "channel": "stable",
  "url": "GitHub Release asset URL",
  "sha256": "...",
  "minimum_supported_version": "0.1.0",
  "release_notes": "..."
}
```

**Update security**

CapturePack runs continuously and handles screen content, so update security matters more than
usual. Minimum requirements:

- HTTPS only.
- SHA-256 verification.
- Windows code signing when possible.
- Signature verification of the update executable.
- Never update from arbitrary URLs.

**V1 completion criteria**

- Installable Windows release
- GitHub Releases-based updater
- Update notification and restart-to-update
- Rollback-safe installation
- Automatic build and release workflow

---

## Future Versions

### V2

**Timeline Events**

- Mouse
- Keyboard
- Window
- Application Focus
- Window Resize

**Plugin API**

- Browser DOM
- Windows UI Automation
- Unreal
- Unity
- Git
- Console

### V3

**Semantic Object Picking**

Instead of drawing rectangles manually, users click actual UI objects.

Supported targets:

- DOM Elements
- Windows UI Automation
- Application Objects
- Future Engine Plugins

**AI-assisted annotation**

- Prompt Builder

---

## Plugin Architecture

- Core owns nothing except capture.
- Plugins only append metadata.
- Plugins cannot modify the capture process.
- Plugin interface must remain stable.

**Examples**

- Browser Plugin
- Window Plugin
- Mouse Plugin
- Keyboard Plugin
- Git Plugin
- Unreal Plugin
- Unity Plugin

Plugins generate structured events.

---

## Chrome Extension

CapturePack is not a single Windows application. An official Chrome Extension is developed
alongside it to obtain DOM information. The extension is part of CapturePack, not a separate
product.

**Purpose** — deliver real DOM objects, not screen pixels. The user clicks a button on the
replay; CapturePack stores the button's meaning: selector, id, role, text, bounds, url.
This information is linked to annotations.

**Structure** — managed inside this repository:

```
extensions/
└── chrome/
    ├── manifest.json
    ├── background.js
    ├── content-script.js
    └── native-host/
shared/
└── protocol/
```

**Extension role (minimum only)** — current URL, tab title, DOM element under the mouse,
user-selected element, CSS selector generation, element bounds, tab/URL change events.
The DOM is never streamed continuously; information is sent only at the moment it is needed.

**Application role** — replay buffer, timeline, annotation, export, UI, package creation.
The extension handles DOM metadata only.

**Communication**

```
Chrome Extension
      │  Native Messaging
      ▼
CapturePack Native Host
      │  IPC
      ▼
CapturePack Application
```

The extension talks only to CapturePack. No cloud servers.

**Shared protocol** — application and extension speak the same protocol, managed in
`shared/protocol/`. Example:

```json
{
  "type": "dom.element.selected",
  "timestamp": 18420,
  "tab": { "url": "...", "title": "..." },
  "element": {
    "tag": "button", "id": "save", "role": "button", "text": "Save",
    "selector": "#save",
    "bounds": { "x": 100, "y": 200, "width": 120, "height": 40 }
  }
}
```

**Phases** — Phase 1: URL, tab title, DOM element selection, selector, bounds.
Phase 2: DOM snapshot, Shadow DOM, iframes, SPA route-change detection.

**Distribution** — app, extension, and protocol share one version (CapturePack 0.1.0 =
Chrome Extension 0.1.0 = Protocol v1). Initially loaded unpacked in developer mode;
Chrome Web Store distribution comes after stabilization.

**Philosophy** — the extension's purpose is not to store the DOM. It is to make CapturePack
understand meaningful objects (context) instead of screen pixels.

### Extension Install & Management UX

The extension is part of CapturePack. Users must never hunt through browser settings or
developer mode — every install and status check starts and ends inside the CapturePack app.
The user presses one button: **Install**. CapturePack handles the rest.

**Settings UI** — add an Integrations menu:

```
Settings
└── Integrations
    └── Chrome DOM Capture
```

- Not installed: status "Not Installed" + [ Install Chrome Extension ].
- Installed: Extension Connected · Native Host Installed · Protocol v1 · Version, plus
  [ Open Extension Settings ] [ Reinstall ] [ Uninstall ]. Status visible at a glance.

**Install flow** — starts from CapturePack: Install button → open Chrome Web Store → user
clicks "Add to Chrome" → CapturePack installs the Native Messaging host → connection
verified → Connected.

**Developer mode** (before Web Store listing): [ Open chrome://extensions ]
[ Open Extension Folder ] [ Copy Extension Path ] — CapturePack opens the needed pages
and folders automatically.

**Native Messaging (installer responsibilities)** — the CapturePack installer automatically:
installs the native host, generates the native messaging manifest, registers the Windows
Registry key, registers the extension ID, links the CapturePack executable, and cleans up
registry + manifest on uninstall. No manual setup, ever.

**Diagnostics** — CapturePack always knows the extension state:
"✔ Extension Installed / ✔ Native Host Installed / ✔ Connected / ✔ Protocol Compatible",
"✖ Extension Missing [ Install ]", or "⚠ Version Mismatch (Extension 0.1.0, CapturePack
0.2.0) [ Update ]".

**First run** — if the extension is absent: "Chrome context capture is unavailable.
[ Install ] [ Not now ]". Never force the install; always available later in Settings.

### Integration Operations (post-install experience)

What matters most is the experience after installation:

1. **Auto-update (most important)** — a version gap between app and extension breaks UX.
   The app always checks the protocol version:
   "CapturePack 0.3.0 / Chrome Extension 0.2.0 → Update available [ Update Extension ]".
2. **Browser support structure** — extensible from day one, not Chrome-hardcoded:
   ✓ Chrome; Coming soon: Edge, Brave, Arc, Firefox. (Chromium-family browsers can reuse
   the extension almost as-is.)
3. **Health check** — six-point diagnostics, invaluable for bug reports:
   ✔ Extension Installed · ✔ Native Host Installed · ✔ IPC Connected ·
   ✔ Protocol Compatible · ✔ Permissions Granted · ✔ Content Script Running.
4. **[Test Connection] button** — one click shows: current tab URL, DOM count,
   element under mouse, round-trip latency. Solves most install problems alone.
5. **Permission display** — explain why the extension is needed:
   ✓ Read current page · ✓ Read selected DOM element · ✗ No browsing history ·
   ✗ No passwords · ✗ No cloud upload. Open source makes this credible.
6. **Privacy (near-mandatory)** — "Everything stays on your PC. No cloud. No telemetry.
   No page data leaves your computer."
7. **Plugin structure** — future integrations (Chrome, Windows UI Automation, Unity,
   Unreal, VS Code, JetBrains, Terminal, Git) all Enable/Disable from the same UI.
8. **Status icons** — on the main surface, not only Settings:
   🟢 Chrome Connected · 🟢 Replay Running · ⚪ UI Automation Disabled.

### Plugin Manager

Settings is a **Plugin Manager**. The Chrome extension gets no special treatment — it is
one plugin among equals, sharing the exact structure future integrations will use:

```
Plugins
🟢 Chrome DOM
🟢 Windows Window Tracking
⚪ UI Automation
⚪ Unreal
⚪ Unity
⚪ VSCode
⚪ Git
```

With this design CapturePack naturally grows into a plugin-based context platform.

---

## Settings GUI

Settings are edited in a GUI window — never by opening settings.json in an editor
(the JSON file remains the storage; no database).

- Opened from the tray ("Settings…"). One compact dark window consistent with the editor's
  minimal design; keyboard accessible; instant apply where possible, an inline "restart to
  apply" hint where not (e.g. MCP port).
- Grouped sections:
  - **General** — output folder (picker + open button), copy exported pack to clipboard,
    auto-update check.
  - **Capture** — replay length (seconds), capture FPS.
  - **Annotation** — default manual duration, show duration label, scrub wheel invert,
    scrub sensitivity (ms per notch).
  - **MCP** — enable, start automatically, port, watch export folder, log requests;
    read-only badge and connection URL shown for copy-paste.
  - **Plugins** — the Plugin Manager surface (GOAL "Plugin Manager"): each integration with
    status icon and Enable/Disable; Chrome DOM appears first (install/health-check UX per
    "Extension Install & Management UX"); others listed as coming soon.
- Settings values validate on input; invalid values never write to settings.json.

---

## Multi-Monitor Support

Dual (and more) monitor setups are fully supported.

- **Capture display** is selectable in Settings: a list of connected displays with
  resolution/position labels. Modes:
  - **Cursor display (default)** — at Ctrl+Alt+C, the capture follows the display the mouse
    cursor is on. The replay buffer records every connected display so the last 30 seconds
    exist for whichever display the trigger picks; the export contains the triggered
    display's replay + snapshot.
  - **Fixed display** — record only the chosen display (lower CPU; the buffer runs on one
    display only).
- The annotation editor always opens fullscreen on the captured display.
- `manifest.environment.screens` continues to list every connected display; the captured
  one is the snapshot's coordinate space.
- Display hotplug (connect/disconnect, resolution change) restarts the affected recorders
  without losing the app.

---

## Annotation Timeline & Lifetime

Annotations are not drawings on a screen — CapturePack is a program that creates
**Context with time**. Every annotation has a start time and an end time.

**Two kinds of annotations**

1. **Tracked Element** — automatically selected objects (Chrome DOM, Windows UI Automation;
   later Unity objects, Unreal widgets/actors, HTML elements). Selecting one stores the
   OBJECT, not coordinates: selector, AutomationId, role, text, bounds.
2. **Manual Annotation** — user-drawn rectangle, arrow, circle, highlight, pin (and text/blur).

**Tracked Element lifetime** — alive for as long as the object exists. CapturePack tracks
the same object frame by frame; when its bounding box moves, the annotation moves with it.
Tracking ends automatically when the element is removed from the DOM / UI Automation tree,
the window closes, or the capture ends. The user never manages duration.
UI: an × button always at the top-right — clicking it (or Delete) removes the annotation,
its tracking, and the linked context; restorable with Ctrl+Z.

**Manual Annotation lifetime** — default duration **1.0 s**, centered on the current time
(−0.5 s → +0.5 s), auto-clamped at the capture edges. When selected, the duration label
("1.0s") shows at the top-left; clicking it opens the editor (duration or start/end offsets)
with quick presets: 0.5s · 1s · 2s · 5s · 10s · Until End · Entire Capture.

**Timeline visualization** — the timeline shows every annotation's lifetime as bars;
tracked elements' bars grow automatically to the object's lifespan:

```
Rectangle       ███████
Arrow           ██
Tracked Button  ██████████████████
```

**UI summary** — top-left: duration (manual only) · top-right: × delete.

**Settings**

```
Settings └── Annotation
  Default Manual Duration: 1.0 s
  Manual Duration Presets: 0.5 / 1 / 2 / 5 / 10
  Auto Track Elements: ✓
  Delete Key Removes Annotation: ✓
  Show Duration Label: ✓
```

**UX principles** — selecting an object starts tracking automatically; users never manage
tracked lifetimes; only manual annotations have editable durations; duration is always one
click away at the top-left; delete via × and Delete key; the timeline visualizes every
lifetime.

**Core philosophy** — a Tracked Element is "an annotation that lives while the object
exists". A Manual Annotation is "an annotation that exists for the time the user chose".

### Static object picking (v0 — before full tracking)

Automatic window/control selection ships in a static form first:

1. **At capture** (alongside save-first) a Windows UI Automation helper dumps the window
   list + the foreground window's control tree (Name, ControlType, AutomationId, Bounds)
   into `plugins/windows-uia/` — budgeted (sub-second, async), never delaying the editor.
2. **In the editor**, the object tool (O / left click) highlights the UIA element under the
   cursor from that dump; clicking selects the element's exact bounds and pre-fills its
   name as the label — stored as the `"element"` annotation type with the object metadata.
3. In Chrome, the extension's DOM picker plays the same role (protocol v1).
4. Frame-by-frame tracking (bounds following the object through the replay) remains V3.

---

## Always-On MCP Server

CapturePack is not only a program that creates .capturepack files — it ships an official,
always-running **MCP (Model Context Protocol) server** so any AI can read CapturePacks in a
standard way. The MCP server never creates captures; it reads, explores, and analyzes them.

**Core goal** — after saving a CapturePack the user does nothing. The workflow is
Capture → Annotate → Save → done. Any AI finds and analyzes the latest CapturePack through
MCP on its own. The user never explains the file structure, never unzips, never pastes
report.md.

**Philosophy**

```
CapturePack        → creates Context
CapturePack Format → stores Context      (a data format, AI-independent)
CapturePack MCP    → serves Context      (the standard read interface)
Any AI             → consumes Context    (ChatGPT, Claude, Gemini, Cursor, VSCode, Codex, …)
```

**Always-on** — the MCP server starts automatically with the app and stays resident:

```
CapturePack.exe
├── Replay Buffer
├── Editor
├── Export
└── MCP Server   (port 39393, localhost only)
```

**Index & discovery** — MCP watches the export folder and keeps a recent-packs index
updated automatically (no manual refresh). `latest()`, `list()`, `open()` all use this index.

**Tools (initial, read-only)**

| Tool | Purpose |
| --- | --- |
| `capturepack.latest()` | The most recent pack — most LLM sessions need only this |
| `capturepack.list()` | Recent packs ("1 Chrome Login Bug / 2 Unreal Crash / …") |
| `capturepack.open(id \| path)` | Open a pack — folder and ZIP both supported |
| `capturepack.summary()` | App, window, URL, capture time, duration, annotation count, timeline length |
| `capturepack.manifest()` / `report()` | Raw manifest.json / report.md |
| `capturepack.timeline(from?, to?)` | Full timeline or a time slice |
| `capturepack.annotations()` / `findAnnotations(keyword)` | Annotation list / keyword search |
| `capturepack.frame(time)` | Frame at a given time (e.g. 12.4s) |
| `capturepack.replay()` | Replay metadata (segments on demand) |
| `capturepack.dom()` / `findDOM(selector)` | DOM metadata when the Chrome extension contributed it |
| `capturepack.windows()` | Window focus timeline |
| `capturepack.search(keyword)` | Search across report, annotations, timeline, DOM, window, plugin metadata |
| `capturepack.exportMarkdown()` | Convert a pack to Markdown (HTML/Issue export later) |

Plugin metadata is exposed generically — MCP never needs to know plugin kinds.

**Read-only rule** — initial version supports Read / Search / Summary / Export only.
No edit, no delete, no annotation modification, no capture creation (capture always
belongs to the application).

**Settings**

```
Settings └── MCP
  [✓] Enable MCP Server      [✓] Start Automatically   [✓] Always Running
  [✓] Read Only              [✓] Auto Discover Latest  [✓] Watch Export Folder
  Port: 39393                [ ] Log Requests
```

**Usage** — the user says only "방금 캡처한 거 분석해줘" / "Analyze the latest CapturePack."
The AI chains `latest() → summary() → timeline() → annotations() → report() → dom()` itself.

**Future tools (not in the initial version)** — compare, merge, diff, statistics,
exportPDF/HTML/Issue, findByApplication, findByURL, findByWindowTitle,
latestFromApplication, latestFromBrowser.

---

## CapturePack Specification

```
CapturePack/
├── manifest.json
├── timeline.json
├── annotations.json
├── report.md
├── snapshot.png
├── replay.webm
└── plugins/
```

Specification is more important than implementation.

Any language should be able to generate CapturePack files.

The specification must remain versioned. Backward compatibility is important.

---

## Annotation Philosophy

Annotation speed is everything.

- **Target:** less than 5 seconds.
- Keyboard shortcuts preferred.
- No complex UI.
- Undo must be instant.
- Annotation should remain editable.
- Never burn annotations permanently into videos.

---

## Editor Input System

The editor is not a static screenshot viewer — it scrubs the frozen replay in time.
The user should finish **time selection → object selection → description** with the mouse alone.

**Final UX**

```
Ctrl+Alt+C
→ Freeze the last 30 seconds
→ Open the editor on the last frame

Wheel up        → toward the past
Wheel down      → toward the present

Left click      → semantic object auto-selection → type description immediately (V3;
                  MVP falls back to manual selection)

Right-click drag → manual rectangle → type description immediately

Space + drag    → pan the zoomed view
Ctrl + wheel    → zoom in/out
Timeline drag   → coarse navigation across the buffer
```

**Wheel time navigation**

Time-based movement, independent of the video's FPS:

| Input | Movement |
| --- | --- |
| Wheel | ±100 ms |
| Shift + wheel | ±1 s |
| Alt + wheel | ±1 frame |
| Ctrl + wheel | zoom |

- Sensitivity is configurable in settings.
- Wheel direction: up = past, down = future — with an **invert option** for users with
  video-editor habits.
- Scrubbing while playing: pause instantly and scrub to that point.

---

## Object Model

Future versions should understand actual interface objects.

**Examples**

- DOM: Button, Input, Panel, Window
- Windows UI: AutomationId, ControlType, Name, Bounds
- Future: Unreal Widgets, Unity UI, Custom Plugin Objects

CapturePack should remember objects instead of pixels whenever possible.

---

## Event Timeline

Events should be machine-readable.

**Examples**

- Mouse Click
- Keyboard
- Window Focus
- DOM Click
- Object Selection
- Annotation Added
- Plugin Event

Timeline should be replayable.

---

## Coding Guidelines

- Readable code over clever code.
- Composition over inheritance.
- Small modules.
- Plugin-first architecture.
- Avoid overengineering.
- Keep dependencies minimal.
- Public APIs should remain stable.

---

## Open Source Goals

- MIT License
- Contributor Friendly
- Clear Documentation
- SPEC before Code

Every public change updates the specification.

README should explain the project in under one minute.

---

## Repository Structure

```
capturepack/
├── README.md
├── LICENSE
├── SPEC.md
├── ROADMAP.md
├── ARCHITECTURE.md
├── CONTRIBUTING.md
├── docs/
├── core/
├── plugins/
├── examples/
├── tools/
├── site/
└── tests/
```

---

## Non Goals

Do not build:

- Cloud
- Accounts
- Sync
- Subscriptions
- Analytics
- Collaboration
- Marketing Features
- Issue Tracker
- AI API Integration

CapturePack should remain a focused tool.

---

## First Development Order

1. Write SPEC.md
2. Define CapturePack Format
3. Build Replay Buffer
4. Screenshot
5. Annotation Editor
6. Export CapturePack
7. Plugin API
8. Browser Plugin
9. Windows Plugin
10. Public Release

Always prefer simplicity over features.

Never sacrifice the 5-second workflow.

---

## Naming & README Notes

README 첫 문장 추천:

> CapturePack is an open-source context capture format and toolkit that helps humans and AI understand visual problems beyond screenshots and screen recordings.

이 문장 하나만 읽어도 프로젝트의 방향이 명확해진다.

GitHub 저장소 이름은 `CapturePack`보다 `capturepack`으로 하고, 확장자도 `.capturepack`으로 통일한다. 저장소 이름, 파일 포맷, 프로젝트 이름이 모두 일치하면 사용자가 기억하기 쉽고, 장기적으로 하나의 포맷으로 자리 잡기에도 유리하다.
