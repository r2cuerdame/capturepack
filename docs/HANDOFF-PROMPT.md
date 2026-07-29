# Handoff prompt — paste this to the next agent

---

You are taking over CapturePack, an open-source Windows context-capture tool
(Electron + strict TypeScript + esbuild) at `C:\_Project\capturepack`. The
previous session ran out of context mid-flight.

**Read `docs/HANDOFF.md` first, completely, before touching anything.** It has
the state, the open leads with their evidence, the measured numbers you should
not re-derive, and the safety rules. What follows is only what to do next.

## Safety — absolute, and one of these was violated once

- **Never synthesize keyboard or mouse input.** Never press Ctrl+Alt+C: the
  installed app owns that accelerator and an agent once fired a real capture on
  the owner's desktop.
- **Never run, stop, kill or modify the INSTALLED app** at
  `C:/Users/recue/AppData/Local/Programs/capturepack`, and **never write to**
  `%APPDATA%/CapturePack`. Reading it and its logs is fine and often necessary.
- **`C:/Users/recue/OneDrive/Desktop/CapturePack` is READ ONLY** — the owner's
  captures. Analyse them; never write there.
- **Do not tag or publish a release.** `main` may be pushed freely now:
  `.github/workflows/release.yml` is `workflow_dispatch` only, so a push ships
  nothing. The 0.3.0 release happens when the owner accepts, by pressing Run
  workflow themselves.
- `Add-Type -MemberDefinition` is forbidden in the PowerShell hosts; use
  `-TypeDefinition`.

## How this project works

- **GOAL.md is the living spec.** Designs and decisions go there in prose, with
  the measurements behind them, before or with the code.
- **Measure before you claim.** This is enforced hard. In one day four separate
  claims had to be withdrawn — an aggregate computed across coordinate spaces, a
  median that hid the failure it was supposed to show, a red test that passed
  because its jitter could not invert, and a "root cause" the geometry later
  disproved. If you cannot produce a number, say the claim is unverified.
- **A red test that passes proves nothing.** Every regression check here was
  made to fail against the old code before it was trusted.
- **The record shows what was observed, never what was inferred.** Interpolation
  between *observed* samples is banned by decision. Authored positions (a human
  placing a manual box) are a different category and do interpolate — the two
  live in different fields precisely so the rules cannot leak.
- **Comments explain WHY, with the evidence.** Match the density already there.
- **Reply to the owner in Korean**, lead with the outcome, and always give the
  absolute installer path.

## Verification floor — run all of it before claiming anything works

```
cd core
npx tsc --noEmit
npm run check:sync check:delta check:dom check:controls
npm run check:identity check:keyframes check:pick check:numbering check:motion
```

Build to a fresh directory so electron-builder cannot fight a file lock:
`npx electron-builder --win "-c.directories.output=dist-rcNN"`.

## Your work, in order

### 1. Test rc.35 against real captures

`core/dist-rc35/CapturePack-Setup-0.3.0-rc.35.exe` is built and untested in the
field. Everything below landed today and has never been confirmed on a real
capture. Ask the owner to install it, use it normally, and hand you the pack
paths; then measure rather than eyeball.

- **Manual box keyframes** — draw a box, scrub forward, drag it. It must move
  from that frame on, not across its whole lifetime. `K` removes the keyframe
  under the playhead; the timebar draws a tick per keyframe.
- **Box numbers** — the last box created must get the last number. `Alt`+1…9
  pins, `Alt`+0 releases. Verify `Alt`+digit is not eaten by a Windows menu
  mnemonic in the packaged window.
- **Control picking** — the geometry was proved exact (219/219 probes contained
  their point, 137/137 sub-32px controls pickable), so if picking still fails it
  is the claim gate, not coordinates. See the open lead in `docs/HANDOFF.md`.
- **Box sync** — last measured p10 −10 / p50 −5 / p90 +1 ms, before today's
  delta and `ft` fixes. Re-measure: decode `replay_annotated.webm`, template
  match the window, divide the pixel error by the window's own velocity.

### 2. The strongest open bug — control level goes SILENT

`claimsOf` emits a region claim only for a window whose UIA tree status is
`collected` or `truncated`; `resolveCandidates` then drops every control-level
candidate no claim covers. A window lane A has **blocked** contributes zero
controls at every time — pinned by a check: provider offers 230 candidates,
`claimsOf` emits 0, `pick()` returns null. From outside that is
indistinguishable from "this app has no controls".

`main.log` shows lane A blocking windows with **"it took 0 ms a pass"**, which
is not slow. Start here: a window whose controls the DUMP collected must keep
its claim even when lane A is not tracking it.

### 3. Left monitor coordinates are off — reported, uninvestigated

The owner reports the coordinate axis being wrong on the left monitor. That
display is at a **negative X origin** (`-1200,0`, 1200x1920 portrait). A related
bug was fixed today (`3f24dda`, controls landing on the wrong display index).
Start at `toSnapshot` in `core/src/main/context/ringObservations.ts` and check
every place a virtual-desktop rectangle becomes snapshot pixels for a display
whose origin is negative.

### 4. Seven recovered fixes, not yet applied

`.review-archive/codex-review-0.3.0.patch` is the **only surviving copy** of an
independent review's work — its worktree's git index was locked so it was never
committed there. Each item is listed with its failure scenario in
`docs/HANDOFF.md`. Apply in this order: the purge/identity pair first (a
destructive path), then the two clock fixes as one unit gated on
`npm run check:sync`, then the independent single-file ones.

### 5. Collect the adversarial sweep

A 66-agent sweep of `2221328..HEAD` finished; only its first confirmed finding
was read and fixed (a move delta starving the FULL resync — measured at a 6.3
second gap). The rest is unread at
`C:\Users\recue\AppData\Local\Temp\claude\C---Project-capturepack\3b267ede-cf8c-46fb-8f9e-efd553b7a9c5\tasks\whjh8q3w9.output`
and in that workflow's `journal.jsonl`. Every finding there was already put
through three refutation lenses; take the confirmed ones, and re-verify each
yourself before applying.

### 6. Documentation

`GOAL.md` has grown all day and is now the longest artifact in the repo. Its
content is correct and hard-won — do not summarise it away — but it needs
structure: the `#110` / `#111` material is a chronological debugging narrative
that should become a readable account of what the surface lane is and why.
`SPEC.md`'s header still says `Version 0.1.0` while the code writes `0.2.1`.
`AnnotationTracking`'s doc comment in `core/src/shared/types.ts` still says a
reader interpolates between samples, which contradicts SPEC §8.3 and the
shipped `trackedSampleAt`.

### 7. GitHub

Issues #95–#101 track the open work. Close what today's push resolved (#95 is
done — the artifacts are out of history and `main` is pushed), open issues for
anything from the sweep, and keep them current as you go — the owner tracks
through them now.

## One last thing

The owner tests every build on their own machine and reports what breaks, in
Korean, often mid-turn while you are still working. They are right more often
than the code is. When they say something is off, it is off — your job is to
find the measurement that shows it, not to explain why it should be fine.
