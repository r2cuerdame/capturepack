# capturepack

## Can you explain a bug in under 5 seconds?

**CapturePack is the fastest way to explain something to an LLM.**

> Capture context, not screenshots.

CapturePack is an open-source context capture format and toolkit that helps humans and AI understand visual problems beyond screenshots and screen recordings.

A `.capturepack` file bundles what a screenshot cannot: the last 30 seconds of replay, a snapshot, editable annotations, a machine-readable event timeline, and a human-readable report — everything another developer or any LLM needs to immediately understand the situation.

## The 5-second workflow

```
Ctrl+Alt+C  →  capture  →  5-second annotation  →  export  →  drop into
                                                              ChatGPT / Claude / Codex / Cursor / Gemini
                                                              or send to another developer
```

## Why

- **Screenshots preserve pixels.** You lose what happened before the frame.
- **Videos preserve motion.** You lose intent and structure.
- **CapturePack preserves context.** Time, space, intent, environment.

## Principles

Local first · Offline first · Open format · Plugin based · No cloud · No login · No database · No AI dependency · No vendor lock-in.

Generated CapturePacks should remain readable forever.

## What's inside a `.capturepack`

```
CapturePack/
├── manifest.json       # format version, capture metadata
├── timeline.json       # machine-readable events
├── annotations.json    # editable annotations (never burned into video)
├── report.md           # human/LLM-readable summary
├── snapshot.png        # the captured frame
├── replay.mp4          # last 30 seconds
└── plugins/            # structured metadata from plugins
```

The specification matters more than any implementation — any language can generate CapturePack files. See [SPEC.md](SPEC.md).

## Status

Early development. See [GOAL.md](GOAL.md) for the project vision and [ROADMAP.md](ROADMAP.md) for what's next.

## License

[MIT](LICENSE)
