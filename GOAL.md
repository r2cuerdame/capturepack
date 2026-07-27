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
| Long-term | CapturePack becomes an open specification adopted by other tools. |

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
