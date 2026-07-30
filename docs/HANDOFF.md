# CapturePack handoff — after v0.3.3

Last verified: 2026-07-30 (Asia/Seoul)

This is the current baton-pass document. Read it before changing capture,
timeline, object-picking, multi-display, viewer, packaging, or release code.
Historical handoffs are retained separately and are not current instructions.

## Read first

1. [GOAL.md](../GOAL.md) — product intent and measured decisions.
2. [SPEC.md](../SPEC.md) — open pack format and compatibility contract.
3. [ARCHITECTURE.md](../ARCHITECTURE.md) — current process and data boundaries.
4. [QA.md](QA.md) — automated gates and the manual Windows matrix.
5. [MCP.md](MCP.md) — loopback, read-only access to saved packs.
6. [RELEASING.md](RELEASING.md) — the only supported publication path.

Use [docs/README.md](README.md) as the documentation index. The older
[v0.2.0 handoff](HANDOFF-v0.2.0.md) is evidence and history only.

## Public state

CapturePack **0.3.3** is the current stable Windows release.

| Item | Verified state |
|---|---|
| Public release | [v0.3.3](https://github.com/r2cuerdame/capturepack/releases/tag/v0.3.3), stable (`draft=false`, `prerelease=false`) |
| Release source | `b7e0c695d5f2c018e2c10fcf83936d1d42f7a0d4` |
| Release workflow | [passed](https://github.com/r2cuerdame/capturepack/actions/runs/30553084001) |
| Main CI | [passed on retry](https://github.com/r2cuerdame/capturepack/actions/runs/30553473638) |
| Pages deployment | [passed](https://github.com/r2cuerdame/capturepack/actions/runs/30553473663) |
| Website | [capturepack.dev](https://capturepack.dev/), serving 0.3.3 |
| Public installer SHA-256 | `cdf1da6fee39eb28e82749b9183cdd3c347f26b31e68e0db25a6be5400ebcf3c` |

The binaries were built from the tagged release source above. `main` may
contain documentation-only follow-up commits after that tag. Do not move or
replace the public `v0.3.3` tag or its assets.

The locally built installer in `core/release-0.3.3-final` has a different hash
because it is a separate unsigned build. Use the public release's
`SHA256SUMS.txt`, not a local build hash, when verifying a downloaded installer.

At the time this handoff was written, the working checkout was
`C:\_Project\capturepack` on `agent/rc-0.3.3-rc.1`. Its local `main` ref was
older than `origin/main`. Always begin with `git status --short --branch`,
`git fetch`, and a non-destructive comparison before choosing a branch. Never
reset or clean away an active worktree.

## What 0.3.3 contains

- A script-free, offline `viewer.html` generated inside a CapturePack. It uses
  only declared relative media and remains an optional generated view.
- Bounded recorder ownership and replay retention, with an MP4 fragment ring
  where supported and an honest WebM dual-slot fallback where safe splicing is
  not available.
- Explicit replay cadence, health, clock, backend, and ambiguity evidence
  instead of treating an unmeasured capture as successful.
- One N-display geometry model across negative origins, portrait displays,
  mixed DPI, capture, editing, rendering, save/reopen, and generated documents.
- Past-frame and reopened Windows UI Automation / Chrome DOM evidence used by
  Object Pick without inventing unobserved object state.
- Separate image-region and image-fullscreen pack contracts, including
  cross-monitor region composition and image-aware MCP output.
- Source-first atomic save: annotations, timeline, manifest, report, README,
  skills, plugins, and viewer are written before optional derived rendering.
- Serialized background media work so save/render jobs do not multiply
  decoders or encoders.
- Editor, trim, keyframe, selection-header, native-caption, clipboard, History,
  hotkey, and multi-monitor regressions reported during the 0.3.x cycle.
- Chrome native-messaging disconnect handling now consumes expected
  `runtime.lastError` values while bounded reconnect remains active.

Application version and pack format version are different contracts.
`core/package.json` is application version `0.3.3`; packs containing the
optional viewer declare a compatible format version of at least `0.5.0`.

## Known problem: video/context alignment

[Issue #89](https://github.com/r2cuerdame/capturepack/issues/89) remains open:
object/context overlays can lead recorded video by a display-specific amount.
Do not describe it as fixed.

Measured evidence from
`C:\_CapturePack\CapturePack_2026-07-30_230217`:

- focused-display motion correlation was about **−125 ms**;
- sampled spatial errors included **526 px, 178 px, and 776 px**;
- the **non-focused** display retained about **140–165 ms** of error after the
  51 ms duration-derived shift;
- startup calibration reported `insufficient-motion-transitions`;
- replay pixel matching reported `weak-pixel-match`;
- the pack clock therefore fell back to wall-clock evidence.

**Which display is which, because the numbering has already been mixed up
once.** Read it from that pack's `manifest.json` rather than from prose:

| `index` | replay | `replay_duration_ms` | `replay_clock_offset_ms` | `focused` | bounds |
|---|---|---|---|---|---|
| 1 | `replay-d1.mp4` | 12418 | *(absent)* | false | 1200×1920 at −1200,0 |
| 2 | `replay.mp4` | 12367 | 0 | true | 2560×1440 at 0,0 |

So the 51 ms is `12418 − 12367` and belongs to **index 1**, the non-focused
portrait display; index 2 is the focused display and its offset is `0` by
definition. Any sentence of the form "display 2 needs another 140 ms after the
51 ms shift" is mixing the owner's informal "the other screen" with the pack's
`index`, and will validate a fix against the wrong replay.

Do not hard-code 125 ms or any other global correction. The acceptance boundary
is a measured source-to-encoded-PTS mapping per display, recalibration when
useful motion evidence appears, and a moving fixture that fails when correlation
is more than one frame out.

`CapturePack_2026-07-30_232429` is only a 403 ms stationary-control sample and
cannot validate dynamic sync. It does show a 25.592 s focused replay versus a
29.721 s display-2 replay, no display-2 replay offset, focused cadence of
12.5/15 fps, and a 1217 ms worst stall. Treat those as evidence, not as a
derived correction.

## Still unverified in the field

The deterministic gate is broad, but it is not physical Windows proof. Do not
claim these complete without new measurements:

- a working replay after a real Desktop Duplication failure
  ([#62](https://github.com/r2cuerdame/capturepack/issues/62));
- sustained 1/15/30 fps behavior and worst gaps on moving content
  ([#82](https://github.com/r2cuerdame/capturepack/issues/82));
- the complete five-minute CPU, private-bytes, working-set, JS-heap, recorder,
  retained-chunk, and stall matrix on one and two physical displays;
- a physical three-display setup with negative origin, portrait, mixed DPI,
  cross-display manual/semantic objects, save/reopen, and rendered output;
- a full real-app E2E flow from hotkey through rewind, Object Pick, save, pack
  validation, and failure artifacts
  ([#63](https://github.com/r2cuerdame/capturepack/issues/63)).

The open issue list is a backlog, not a reliable map of what has or has not
partially landed. Read the current code, regression, issue acceptance criteria,
and release notes together before changing an issue state.

## CI observation

The first `main` CI attempt for the release source timed out only the hidden
editor's two-`requestAnimationFrame` probe after a cold Electron download. The
same SHA passed the release runner, passed ten consecutive local probes, and
passed the unchanged `main` CI retry.

This proves the release source passed the gate; it does **not** prove the
two-second probe can never flake on a cold Windows compositor. If it recurs,
measure startup timing and align the probe with the product's bounded 10-second
editor-startup contract. Do not change product paint ordering merely to silence
one arbitrary test deadline.

## Verification floor

Use Node.js 22.12 or newer.

```powershell
cd C:\_Project\capturepack\core
npm ci
npm run qa:rc
npm audit --omit=dev
```

`qa:rc` currently runs 65 discovered `check:*` regressions plus type checking,
the production build, and isolated Electron smoke: **68 gate steps** (66 with
`--skip-build`). Reports
are written under `%TEMP%\capturepack-qa` unless an artifact directory is
provided.

Useful focused runs:

```powershell
# Regression checks without the production build.
npm run qa:checks

# Video/context checks only.
npm run qa:video

# The browser-to-pack end-to-end run. NOT in the gate: it records the desktop
# for twelve seconds, so it needs a real display. The gate runs its wire half
# (`check:chrome-bridge`, --wire-only) and says so out loud when it skips.
npm run qa:chrome-bridge

# Audit a real pack without mutating it.
npm run qa:rc -- --pack C:\_CapturePack\CapturePack_YYYY-MM-DD_HHMMSS

# Gate a pack produced by the candidate under the strict current contract.
npm run qa:rc -- --pack C:\_CapturePack\CapturePack_YYYY-MM-DD_HHMMSS --pack-strict
```

Before a release claim, complete the manual matrix in [QA.md](QA.md). Report
hardware that is unavailable as unverified, never as passed.

## Pack-analysis contract

When a CapturePack MCP server is connected, prefer its read-only pack listing
and `capturepack_latest` tools. The default loopback URL is
`http://127.0.0.1:39393/mcp`.

For a folder:

1. read its `README.md`;
2. read relevant `skills/` guidance;
3. read `report.md`;
4. treat `annotations.json` as the machine-readable annotation source;
5. inspect manifest/timeline/plugin/media evidence without rewriting the pack.

The owner's capture root `C:\_CapturePack` is evidence. Do not write, move,
rename, or delete packs there.

## Non-negotiable product boundaries

- Capture context, not screenshots.
- Local-first, offline-first, open format.
- No cloud, login, telemetry, or AI dependency.
- Original media is not destructively rewritten.
- Observed object tracks use observed samples and are never interpolated.
- Human-authored manual-box keyframes may interpolate because they are explicit
  author input and live in a separate field.
- Never guess object state, bounds, or time that was not observed.
- A capture failure must not be presented as success.
- Plugin failure must not prevent the source pack from being saved.
- MCP is loopback, read-only, and limited to already-saved packs.
- Unknown files in an existing pack survive a rewrite.

## Machine safety

- Never synthesize the owner's global capture hotkeys or mouse input.
- Do not modify, stop, uninstall, or reconfigure the installed application at
  `%LOCALAPPDATA%\Programs\capturepack`.
- Do not write to `%APPDATA%\CapturePack` unless the owner explicitly places
  that live state in scope. Reading logs for diagnosis is acceptable.
- Headed test instances must use isolated user-data/output directories,
  `--no-global-shortcut`, and `--no-login-item`. Track and stop only PIDs that
  belong to the test instance.
- Do not change displays, drivers, startup tasks, or browser policy as a hidden
  test setup step.
- Do not commit `core/release-*`, `core/rc*`, installers, logs, backups, or
  private CapturePacks.

## Release discipline

A push or tag push does not publish CapturePack. Publication is a manual
`workflow_dispatch` that runs the full QA/build/package/remote-byte-verification
sequence described in [RELEASING.md](RELEASING.md).

Never overwrite a public version. A product hotfix after 0.3.3 must use a higher
version and fix forward. Documentation-only commits may follow the release on
`main`, but they do not alter the binaries identified by the `v0.3.3` tag.

## 0.3.4 in progress

Work on `agent/0.3.4`, not released. See [GOAL.md](../GOAL.md) for the design
record and [#104](https://github.com/r2cuerdame/capturepack/issues/104) /
[#89](https://github.com/r2cuerdame/capturepack/issues/89) for the evidence.

- Element picking now reports itself end to end: the picker's arming, failure
  and disarming, every pick that arrives, every message refused with the rule
  that refused it, and every placement refused with its reason. Settings >
  Plugins > Chrome DOM shows the last state.
- The picker runs in every frame; a pick inside an iframe is carried up the
  frame chain with a measured scale, and refused rather than guessed when the
  measurements disagree.
- An explicitly picked document element is no longer filtered by the threshold
  measured for UI Automation enumerations. It is judged at a viewport-like
  threshold and is never deleted.
- The gate is **66 steps**: `check:frame-geometry` and `check:dom-pick` are new,
  and `check:chrome-bridge` — an end-to-end harness that existed, had never been
  wired in, and was failing — now runs.
- The lane cost line now prints `frame->core`, dropped samples and stride.
  First measurement on the reporting machine: **`frame->core +4.1 ms`,
  1 dropped, stride 1**, with **160 of 170 samples converted rather than
  frame-stamped**. IPC transport and the memory governor are therefore ruled
  out as causes of #89, and the age term — which the converted majority does not
  carry at all — becomes a 53-125 ms error the moment a real exposure latency is
  fed into it.

Not proved, and it needs the machine: one run with the element picker
deliberately armed on an ordinary `https://` page, so `main.log` says whether it
armed, could not arm, or armed and the click went elsewhere.

## Suggested next order

1. Carry the frame-age term onto the converted and held sample paths. This is
   invisible today (age reads 1 ms) and must land BEFORE anything makes that
   term carry a real exposure latency, or #89 gets visibly worse for 95% of
   samples.
2. Build a deterministic moving visual/context fixture for #89 and make the
   current display-specific drift fail quantitatively.
3. Measure the source-frame clock and encoded PTS per display; do not infer the
   mapping from flush completion, IPC response, or a stationary frame. Publish
   it as its own per-display quantity — never by overloading
   `replay_clock_offset_ms`, whose `focused => 0` is correct by definition — and
   apply it at exactly one place, or it double-corrects.
3. Exercise #62 on a genuinely failing backend and require a decodable replay,
   not a screenshot-only result or a recreated recorder on the same dead stream.
4. Add the real Electron/Windows E2E layer tracked by #63 while preserving the
   existing 65-step deterministic gate.
5. Re-run the manual matrix in `docs/QA.md` and record actual hardware, duration,
   FPS, gaps, CPU, memory, process, and media-decode evidence.

Lead reports to the owner with the measured outcome in Korean. If something
remains unverified, say so plainly.
