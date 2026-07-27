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

- Static site served by GitHub Pages from `site/` in this repository (no separate repo).
- One page, minimal scroll, no signup/server/database, no flashy animation.
- A visitor must understand the product within 5 seconds; the only action is **Download**.

Structure:

- **Hero** — "Capture context, not screenshots." / "The fastest way to explain something
  to humans and AI." Exactly three buttons: **Download**, **GitHub**, **☕ Buy me a coffee**.
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

`CapturePack.zip` contains:

- `manifest.json`
- `replay.mp4`
- `snapshot.png`
- `annotations.json`
- `report.md`

No plugins required. Everything works locally.

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

## CapturePack Specification

```
CapturePack/
├── manifest.json
├── timeline.json
├── annotations.json
├── report.md
├── snapshot.png
├── replay.mp4
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
