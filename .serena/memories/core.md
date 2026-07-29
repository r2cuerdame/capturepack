# CapturePack — core

Local-first Windows context-capture tool. Thesis: **capture context, not screenshots.** The
hotkey is pressed *after* a bug happens; a rolling replay buffer is already recording. Output is
a **folder** (not an archive) that a human or an LLM can read.

## Source map

| Path | What |
|---|---|
| `GOAL.md` | **The living spec.** Designs are recorded here before being implemented. Read the relevant section before changing behaviour. |
| `SPEC.md` | The `.capturepack` **format** — normative, versioned separately from the app (`format_version`). |
| `ROADMAP.md` | V1 / V1.5 / V2 / V3 milestones. |
| `core/` | The Electron app. See `mem:app/core`. |
| `extensions/chrome/` | The browser extension (manifest v3). Ships packaged with the app. |
| `shared/protocol/` | The wire protocol both halves speak (`protocol-v1.schema.json`). |
| `tools/validate-capturepack.mjs` | Format validator — the executable half of SPEC.md. |
| `site/` | GitHub Pages landing page. |
| `examples/minimal/` | A valid reference pack; the validator's smoke target. |

## Project-wide invariants

- **Two version numbers.** The app is semver (`core/package.json`); the pack format has its own
  `format_version` (SPEC §13.1). Format changes are additive — an older reader must still render
  a newer pack from the fields it knows.
- **Every rectangle a pack reports was OBSERVED.** Nothing is interpolated, averaged, or
  estimated. An average is a position nobody saw, written in the same numbers as a measurement,
  and a reader cannot tell the two apart. Accuracy metadata says how far off an answer is instead.
- **Silence is not absence** (SPEC §11.3). "No data recorded" must never be written in a way that
  reads as "nothing was there". A plugin with nothing to say writes no directory at all.
- **Rule 1 of context data**: a subsystem that cannot answer costs a gap in the pack, never a
  failed capture. Context, UIA, browser and plugin failures are logged and swallowed.
- **Measure before claiming.** Behaviour claims in commits, issues and docs carry the number they
  were measured at and the pack/log they came from. See `mem:conventions`.

## Where to go next

- Building, running, and the check harnesses: `mem:suggested_commands`, `mem:task_completion`.
- Language, frameworks, and what is deliberately absent (no test framework, no runtime deps):
  `mem:tech_stack`.
- Comment style, commit format, i18n rules, and the anti-estimation discipline:
  `mem:conventions`.
- The app's own module layout, the clock model, and the surface ring: `mem:app/core`.
- Paths that must never be written to, and how to run a headed build safely: `mem:app/safety`.
