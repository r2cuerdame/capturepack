# Handoff prompt — paste this to the next agent

You are taking over CapturePack at `C:\_Project\capturepack`.

Read these before changing anything:

1. `docs/HANDOFF.md`
2. `docs/README.md`
3. `GOAL.md`
4. `SPEC.md`
5. `ARCHITECTURE.md`
6. `docs/QA.md`
7. the current files and `git diff`

The current public Windows release is stable `v0.4.4`, published through the
guarded Release workflow and verified against its downloaded assets. Treat the
immutable `v0.4.4` tag and its four verified assets as the release authority: do
not move the tag or replace those assets. Work happens on `main`; there is no
in-flight release branch after publication, and `main` may carry commits after
the tag. Start with
`git status --short --branch` and `git fetch`, and never reset or clean away an
active worktree.

Application version and pack format version are different contracts. The pack
format is **0.7.0**, or **0.8.0** for a capture that actually carries an input
event. The `windows-uia` plugin payload is **0.5.0**.

## What the product is, in the five sentences newcomers get wrong

**For video captures, N screens is the normal case, not one screen plus
others.** `media.displays` is REQUIRED and always present — a single-monitor
video capture writes an array of one — and `media.snapshot`/`media.replay` are
defined as *aliases for the focused entry*, not as "the capture". A reader that
follows the obvious field
gets half the desk with no signal that the rest exists, which is exactly the
defect the requirement closed. Each entry states its own snapshot frame as
measured, because recomputing it from `bounds` × `scale` is off by a pixel at
1.25x and 1.5x — the scale factors this exists to get right.

**Object picking is a still-image affordance, and a video builds no object index
at all.** `objectPickingApplies()` in the editor is the whole rule. This is not
an unfinished feature waiting to be extended back into video: picking in a
replay could only ever be done in half, because lane A paces itself to a 3% duty
and skips Chromium windows, so a scrubbed frame offered the window and never the
thing inside it while the same click at the capture instant offered both. A
video keeps its replay, its timeline, its keyframes, the window and control
geometry recorded through time, and hand-drawn boxes with lifetimes. Lane A
still RECORDS; only the affordance is gone.

**The timeline carries mouse and window events, and never keystrokes.**
`input.mouse.move`, `input.mouse.click`, `input.window.focus`,
`input.window.move`, `input.window.resize` — derived from samples lane S already
takes plus one cursor read inside a dump the host already performs, twice
bounded (pruned to the surface ring's retention, capped at 4096 events). A trim
DROPS events outside the kept range rather than clamping them, which would stack
hundreds of cursor positions onto instant zero. `input.key.*` stays reserved and
unemitted, and that is a decision with a reason: the licence for recording
anything here is that the picture already contains it, and a keystroke is not
among those pixels because a password field renders dots. Do not add a keyboard
hook, a key event type, or a keyboard virtual-key read. `check:input-events`
hunts for all three across the source that runs and the format that is written,
and the validator fails a pack carrying `input.key.*` at any version.

**A saved pack's browser page can be read back.** It could not until 0.4.1, and
the failure was silent for as long as it existed: the extension speaks camelCase
on the wire, packs are written in snake_case like every other persisted field,
and the reader only knew the wire spelling — so the viewport guard correctly
refused every document it was handed. Both spellings are accepted on read now
and **the writer was deliberately not touched**, because SPEC and every pack in
the field agree with it. `windows[].client_bounds` is the other half: a DOM
element is measured in viewport CSS pixels and only the window's drawable
rectangle turns those into snapshot pixels, so the payload carries one now.

**A Share Copy is a reviewed, still-only distribution, not a CapturePack.** History
can create a `capturepack-share` `.share.zip` whose only media are the declared
annotated PNG stills; its other entries are a generated README, offline viewer
and minimal inventory. The writer decodes and deterministically
re-encodes the image pixels and excludes originals, every video container and
structured pack context, but that is visual risk reduction rather than proof an
image is secret-free. Every thumbnail comes from the exact canonical outbound
PNG and opens lazily at full-resolution 1:1; malformed/partial display lanes and
raced destination names fail closed. Review every included still and visible
label before sending; use the Full ZIP only when the originals-included
CapturePack is intended.

## What is open

Open, and only these:

- **[#76](https://github.com/r2cuerdame/capturepack/issues/76) — three real
  screens.** Its acceptance test (one portrait, one scaled, focus on the third)
  is UNRUN and cannot be run on a two-monitor machine. Four of its five risks are
  covered synthetically in `check:n-display-format` on a desk built to break
  them, and every assertion there was proven to catch its regression by
  sabotaging the production rule it guards rather than the fixture's expected
  value. The fifth — three hardware encoders and three UIA temporal buffers on
  one machine — is a measurement on real hardware, not a property, and nothing
  simulates it. A fixture is not a desk; do not close this on fixture evidence.
- **[#137](https://github.com/r2cuerdame/capturepack/issues/137) — display loss
  notifications name failed screens across all nine locales.** Resolved: both
  toast and tray identify the dead screen as "Display {index}" (or
  "Display {index} (focused)") rather than dropping identity or reporting a bare
  count, with coverage across all nine supported languages.
- **[#138](https://github.com/r2cuerdame/capturepack/issues/138) — replace the
  always-on Windows replay path.** The target is DXGI Desktop Duplication →
  D3D11 surfaces → hardware H.264 → a bounded native ring, with measured
  CPU/GPU/memory/latency improvements, correct timestamps and rotation, and an
  explicit fallback when the native path is unavailable. The fast still-image
  workflow must not regress.
- **[#139](https://github.com/r2cuerdame/capturepack/issues/139) — maintain a
  privacy-safe real-pack regression corpus.** It must cover representative hard
  cases and put explicit capture-to-candidate latency and pick-quality thresholds
  in the release gate while distinguishing expected visual change from a broken
  selection or capture.
- **[#69](https://github.com/r2cuerdame/capturepack/issues/69)** and
  **[#68](https://github.com/r2cuerdame/capturepack/issues/68)** — the plugin
  platform.
- **[#21](https://github.com/r2cuerdame/capturepack/issues/21)** — code signing.
- **[#1](https://github.com/r2cuerdame/capturepack/issues/1)** — the usage
  journal.

The open issue list on GitHub is a backlog, not a map of what has landed. Read
the current code, the check that guards it, and the issue's acceptance criteria
together before changing any issue state.

## Do not reopen the video/context alignment problem

[#89](https://github.com/r2cuerdame/capturepack/issues/89) — overlays leading
encoded video by a display-specific amount — was not patched. It was designed
out, and understanding why is the difference between maintaining this product
and undoing a release. Every hard defect of that fortnight lived in one join:
moving geometry against a video frame. Desktop pixel exposure measured 118–127
ms on the one desk where it could be measured at all. A second display's replay
clock had no observable origin. One display recorded 17.6 s of wall time into
5.29 s of media with its 903 ms stall silently collapsed — time compressed
non-linearly, so no single offset can repair it. And the cost of watching
closely enough to try was reachable only by excluding Chromium windows, which
are what users most want to select.

None of those exist for a single instant. So the still became the thing that
carries context, the video stopped following objects through frames, and the
whole class went with it. The measurement machinery is retained as evidence, not
as unfinished work: `check:exposure-alignment` is the moving fixture,
`npm run qa:exposure-field -- --pack <dir>` is the read-only field harness, and
`src/shared/exposureAlignment.ts` records the rules that make the number hard to
fake. If a change you are considering makes a box follow a window through a
replay again, it has reintroduced all of it — including the parts that were
never fixable.

Two standing rules survive from that work and are not negotiable: observed
object tracks use observed samples and are never interpolated, and nothing may
guess object state, bounds, or a time that was not observed. Human-authored
manual-box keyframes may interpolate, because they are explicit author input and
live in a separate field.

## Before claiming a change works

```powershell
cd C:\_Project\capturepack\core
npm ci
npm run qa:rc
npm audit --omit=dev
```

The gate discovers every `check:*` script in `core/package.json` — currently
**84** — and runs them with type checking, the production build and the built
app's Electron smoke: **87 steps**, or 85 with `--skip-build`. Count it yourself
rather than trusting this sentence:

```powershell
node -e "const s=require('./core/package.json').scripts;console.log(Object.keys(s).filter(k=>k.startsWith('check:')).length)"
```

Run it as `npm run qa:rc`. Invoked as `node scripts/qa-gate.mjs` it loses
`npm_execpath` and has to fall back to spawning `npm.cmd`.

The gate does not replace the physical Windows matrix in `docs/QA.md`. A real
Desktop Duplication fallback, sustained FPS and gap measurements, three physical
displays, CPU and memory over repeated cycles, installer handoff, and a full
hotkey-to-pack run on the owner's desk all remain field work unless you produce
new evidence.

A check that needs hardware the gate cannot promise belongs under a `qa:` script
that says what it needs, not in the gate. `npm run qa:chrome-bridge` is the
browser-to-pack end-to-end run and records the desktop for twelve seconds; the
gate runs its wire half and prints the skip out loud rather than quietly running
less. That harness spent a release cycle wired to nothing and failing, so
**confirm a check is actually discovered by `qa-gate.mjs` and passes standalone
before trusting a green gate** — and if you add one to the video profile's list
in `qa-gate.mjs`, remember that list is maintained by hand and the gate throws
when a name in it resolves to nothing.

## Safety and product boundaries

- Run `git status` and inspect current diffs before editing; preserve concurrent
  changes and never reset or clean them away.
- Never synthesize the owner's global capture hotkeys or mouse input.
- Do not modify the installed app, live `%APPDATA%\CapturePack` state, or packs
  under `C:\_CapturePack`. The capture root is evidence: read it, never write it.
- Use isolated user-data/output directories, `--no-global-shortcut` and
  `--no-login-item` for headed QA, and stop only PIDs belonging to that instance.
- Preserve original media, unknown pack files, local/offline behavior, and the
  read-only saved-pack MCP boundary.
- Never invent unobserved object state or call a failed capture successful.
- Plugin and derived-render failure must not block the source pack save.
- Do not commit installers, release directories, logs, backups, or private
  CapturePacks.
- Do not publish, retag, or change external services without explicit owner
  authorization. Publication is a manual `workflow_dispatch`, never a tag push.

Report to the owner in Korean, lead with the measured result, and list anything
that remains unverified.
