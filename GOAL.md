# CapturePack

> **Capture context, not screenshots.**

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
