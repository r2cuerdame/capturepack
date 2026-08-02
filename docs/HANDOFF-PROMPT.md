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

The current public Windows release is stable `v0.3.3`, built from
`b7e0c695d5f2c018e2c10fcf83936d1d42f7a0d4`. Do not move that tag or replace
its assets. `main` may contain documentation-only commits after the tag.

**Work in progress lives on `agent/0.3.4`
([PR #105](https://github.com/r2cuerdame/capturepack/pull/105)), not on `main`.**
It is not released: no version bump, no tag, no binaries. It contains element
picking that reports itself end to end
([#104](https://github.com/r2cuerdame/capturepack/issues/104)), cross-frame
element picking, the editor no longer deleting an explicitly picked document
element, the lock-screen update notice
([#103](https://github.com/r2cuerdame/capturepack/issues/103)), and the #89
measurement below. Read `GOAL.md`'s "0.3.4 in progress" section before touching
any of it.

The primary unresolved correctness problem is
[issue #89](https://github.com/r2cuerdame/capturepack/issues/89): object/context
overlays can lead encoded video by a display-specific amount. The measured
focused-display lead was about 125 ms in one moving capture, while the
non-focused display retained a different residual. Do not hard-code a global
offset, interpolate observed object tracks, or claim sync from a stationary
sample. Build a moving regression and measure source-frame time against encoded
PTS per display.

Three of its candidate causes are now measured rather than argued, from the lane
cost line (`frame->core +4.1 ms, 1 dropped, stride 1`, with
`10 frame-stamped / 0 clock-stamped / 160 converted`):

- renderer-to-main IPC transport is **4.1 ms** — real, uniform, not the cause;
- the memory governor never coarsened the ring and the lane is not thinning it —
  both ruled out;
- **95% of samples take the converted path, which did not carry the frame-age
  term at all** — invisible at a ~1 ms age, a 53–125 ms error on the majority
  population the moment a real exposure latency reached it. Fixed: every path
  now applies the same shift, and `check:sync` fails by exactly one age without
  it. Keep it that way; the next change to that term is the dangerous one.

What is left is the term nothing in the product represents: desktop pixel
exposure. `check:exposure-alignment` is the moving fixture that makes it a
number instead of an argument — one landmark at a known speed, its pixels
exposed a known amount late — and it shows why nothing caught this before: the
clock comparison the product already runs calls that fixture aligned to 2.0 ms
while correlating position names 60.0 ms. The disagreement is not on the time
axis.

`npm run qa:exposure-field -- --pack <dir>` then measured it on real evidence.
On the pack that opened the issue the focused display reads **127.0 ms ± 5.5**
and **118.0 ms ± 5.5** across two independent drags, and applying that collapses
the overlay's positional error from about **550 px to 19–97 px**. The
non-focused display refuses on `insufficient-samples` rather than guessing from
one identified frame. The harness is read-only and needs ffmpeg on PATH.

What is left is **not** a measurement question, and it should not be settled by
an agent. The only single save-side funnel is `frozenRingObservations`
(`core/src/main/context/ringObservations.ts:441`), where one `t` is both the ring
query and the published label; relabelling there reaches the pack, the live
editor, every drawn box and the burned-in video at once, and is correct for MCP
and third-party readers with no changes. But it is irreversible per pack, and
one observation record carries entries for every display it overlaps while the
latency is per-display. Read the next order in `docs/HANDOFF.md` and ask the
owner.

Whatever is chosen: publish the value as its own per-display quantity — never by
overloading `replay_clock_offset_ms`, whose `focused => 0` is correct by
definition — apply it through `exposureCorrectedContextTimeMs` at exactly one
place (the check counts sites and fails above one, because applying it twice is
measured to be exactly as wrong as not applying it), and do not add it on top of
the `frameAgeMs` leg already folded into every sample time at
`surfaceLane.ts:895`. A stationary or barely-moving capture must keep returning
`insufficient-motion` rather than 0 ms.

Before claiming a change works:

```powershell
cd C:\_Project\capturepack\core
npm ci
npm run qa:rc
npm audit --omit=dev
```

The automated gate has 81 steps (79 with `--skip-build`), but it does not replace
the physical Windows matrix in `docs/QA.md`. A real Desktop Duplication
fallback, sustained FPS/gap measurements, physical three-display behavior, and
full hotkey-to-pack E2E remain field work unless you produce new evidence.

A check that needs hardware the gate cannot promise belongs under a `qa:` script
that says what it needs, not in the gate. `npm run qa:chrome-bridge` is the
browser-to-pack end-to-end run and records the desktop for twelve seconds; the
gate runs its wire half and prints the skip. That harness spent a release cycle
wired to nothing and failing, so **confirm a check is actually discovered by
`qa-gate.mjs` and passes standalone before trusting a green gate.**

One thing is measured, fixed, and still unproved in the field: nothing shows
that an element pick now arrives from a real browser. One run with the picker
deliberately armed on an ordinary `https://` page produces one of
`[chrome] element picker armed on …`, `[chrome] element picker could not arm: …`
or `[chrome] element pick at …` and settles it.

Safety and product boundaries:

- Run `git status` and inspect current diffs before editing; preserve concurrent
  changes and never reset or clean them away.
- Never synthesize the owner's global capture hotkeys or mouse input.
- Do not modify the installed app, live `%APPDATA%\CapturePack` state, or packs
  under `C:\_CapturePack`.
- Use isolated profiles and disabled global shortcuts for headed QA.
- Preserve original media, unknown pack files, local/offline behavior, and the
  read-only saved-pack MCP boundary.
- Never invent unobserved object state or call a failed capture successful.
- Plugin and derived-render failure must not block the source pack save.
- Do not commit installers, release directories, logs, backups, or private
  CapturePacks.
- Do not publish, retag, or change external services without explicit owner
  authorization.

Report to the owner in Korean, lead with the measured result, and list anything
that remains unverified.
