# capturepack

[![Release](https://img.shields.io/github/v/release/r2cuerdame/capturepack?color=7c5cff&label=release)](https://github.com/r2cuerdame/capturepack/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/r2cuerdame/capturepack/total?color=7c5cff)](https://github.com/r2cuerdame/capturepack/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Sponsor](https://img.shields.io/badge/%E2%99%A5_Sponsor-ea4aaa)](https://github.com/sponsors/r2cuerdame)

## Can you explain a bug in under 5 seconds?

**CapturePack is the fastest way to explain something to an LLM.**

> Capture context, not screenshots.
>
> Better input. Better answers.

CapturePack is an open-source context capture format and toolkit that helps humans and AI understand visual problems beyond screenshots and screen recordings.

🌐 **[capturepack.dev](https://capturepack.dev)** · [Download](https://github.com/r2cuerdame/capturepack/releases/latest)

<p align="center">
  <img src="site/assets/demo.svg" alt="Demo: press Ctrl+Alt+C, the last 30 seconds freeze, the mouse wheel scrubs through time, drag to select the object, write the annotation, and issue.capturepack is exported." width="760">
</p>

A CapturePack **folder** bundles what a screenshot cannot: the last 30 seconds of replay, a snapshot, editable annotations, a machine-readable event timeline, and human- and AI-readable reports — everything another developer or any LLM needs to immediately understand the situation. When you need to share it, package the folder as a single `.capturepack` file.

## The 5-second workflow

```
Ctrl+Alt+C  →  capture  →  5-second annotation  →  save  →  drop into
                                                              ChatGPT / Claude / Codex / Cursor / Gemini
                                                              or send to another developer
```

## Why

- **Screenshots preserve pixels.** You lose what happened before the frame.
- **Videos preserve motion.** You lose intent and structure.
- **CapturePack preserves context.** Time, space, intent, environment.

## 🕰 It's a time machine

The bug already happened? CapturePack was **already recording**. Press `Ctrl+Alt+C`
*after* something goes wrong — the last 30 seconds are frozen, and the mouse wheel
scrolls you **back through time** to the exact frame where it broke. Annotate that
moment, not a re-enactment.

## 🤖 Built for LLMs

A CapturePack is input an AI actually understands:

- Drop the pack into **ChatGPT, Claude, Codex, Cursor, Gemini** — the generated
  report and context files explain the situation with zero extra prompting.
- Or don't even attach anything: the app runs an **MCP server**, so a connected AI
  just hears *"Analyze the latest CapturePack."* and reads it by itself.

Better input. Better answers.

## 🌍 Languages

CapturePack speaks **9 languages**: English · 한국어 · 日本語 · 中文 · Español · Français · Deutsch · Português · Русский

- The app follows your **system language** automatically — change it any time in Settings → General.
- Generated pack documents (`README.md`, `report.md`, `skills/`) can follow their own language setting; your own descriptions are never translated.
- [capturepack.dev](https://capturepack.dev) auto-detects your browser language too.

## Principles

Local first · Offline first · Open format · Plugin based · No cloud · No login · No database · No AI dependency · No vendor lock-in.

Generated CapturePacks should remain readable forever.

## What's inside a CapturePack

The pack is a plain **folder** — browsable, editable, honest. ZIP (`.capturepack`) is
created only when you want to share.

```
CapturePack_2026-07-27_143052/
├── replay.webm              # original evidence — never modified
├── replay_annotated.webm    # annotations rendered in; plays in any player
├── snapshot.png             # the captured frame (original)
├── annotations.json         # the true source: boxes, lifetimes, numbers, blur
├── timeline.json            # machine-readable event log
├── report.md                # your description, LLM-ready
├── manifest.json            # format version, inventory
├── README.md                # the first document a human reads
├── skills/                  # context structured for AI (works without MCP)
└── plugins/                 # structured metadata from integrations
```

A screenshot-only pack — `manifest.json` + `snapshot.png`, nothing else — is fully valid.

The specification matters more than any implementation — any language can generate CapturePack files. See [SPEC.md](SPEC.md).

## MCP — talk to your captures

The app ships an always-on, read-only [MCP](https://modelcontextprotocol.io) server at `http://127.0.0.1:39393/mcp` (localhost only), so any AI can find and analyze your latest pack by itself — "Analyze the latest CapturePack." is the whole prompt.

```
claude mcp add --transport http capturepack http://127.0.0.1:39393/mcp
```

Tools, client setup, and settings: [docs/MCP.md](docs/MCP.md).

## Status

Early development. See [GOAL.md](GOAL.md) for the project vision and [ROADMAP.md](ROADMAP.md) for what's next.

## Security &amp; signing

Windows builds are currently unsigned (SmartScreen will warn — *More info → Run anyway*);
every release ships `SHA256SUMS.txt` for verification, and an OSS code-signing application
is pending. Details, team roles, and privacy practices: [docs/CODE_SIGNING.md](docs/CODE_SIGNING.md).

## ♥ Support

CapturePack is free, open source, and cloud-free — no accounts, no telemetry, nothing to sell.
If it saves you time, [**sponsoring on GitHub**](https://github.com/sponsors/r2cuerdame) keeps it moving.

## License

[MIT](LICENSE)
