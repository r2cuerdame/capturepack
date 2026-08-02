# CapturePack handoff — after v0.4.0

Last verified: 2026-08-02 (Asia/Seoul)

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

CapturePack **0.3.5** is the current stable Windows release.

| Item | Verified state |
|---|---|
| Public release | [v0.3.5](https://github.com/r2cuerdame/capturepack/releases/tag/v0.3.5), stable (`draft=false`, `prerelease=false`), published 2026-08-02T06:01:53Z |
| Release source | `e6b1cdc248c17283a067fb15b8f7c148e62a4eea` |
| Release workflow | [passed](https://github.com/r2cuerdame/capturepack/actions/runs/30735015301) |
| Main CI | [passed](https://github.com/r2cuerdame/capturepack/actions/runs/30734934137) — including the first green `capture-e2e` |
| Pages deployment | [passed](https://github.com/r2cuerdame/capturepack/actions/runs/30734934082) |
| Website | [capturepack.dev](https://capturepack.dev/), serving 0.3.5 |
| Public installer SHA-256 | `058d3f8be37808eb2460d393f8598278c924063e64971b20a06f049f19686344` |
| Installer size | 104,198,110 bytes |

Verified after publication by downloading the released asset and hashing it, not
by reading the workflow log: SHA-256 matches `SHA256SUMS.txt`, and the SHA-512
matches `latest.yml` byte for byte, so electron-updater will accept it.

The installer was also unpacked and checked to contain the claim this release is
actually making. `watchdog.js` is not in `dist/scripts/`, and `supervision.json`,
`startSupervision` and `armShortcutNow` are absent from `app.asar`. The string
`superviseProcess` does survive, in exactly one place and inside a comment — the
note in the settings loader explaining why the removed key needs no migration.
No code path references it: `settings.superviseProcess`, `superviseProcess:`,
`'superviseProcess'` and `"superviseProcess"` all return nothing.

Earlier public releases stay exactly where they are:
[v0.3.4](https://github.com/r2cuerdame/capturepack/releases/tag/v0.3.4)
(`525ea4968987a0e4445232d1bba71db0c03703c6`, SHA-256
`a989eb2fd623da4ce88cb4284766bf51b98887715225d986676a151fe0c2f434`) and
[v0.3.3](https://github.com/r2cuerdame/capturepack/releases/tag/v0.3.3)
(`b7e0c695d5f2c018e2c10fcf83936d1d42f7a0d4`, SHA-256
`cdf1da6fee39eb28e82749b9183cdd3c347f26b31e68e0db25a6be5400ebcf3c`).

The binaries were built from the tagged release source above. `main` may
contain documentation-only follow-up commits after that tag. Do not move or
replace a public tag or its assets.

A locally built RC installer under `core/release-rcNN/` has a different hash
because it is a separate unsigned build. Use the public release's
`SHA256SUMS.txt`, not a local build hash, when verifying a downloaded installer.

At the time this handoff was written, the working checkout was
`C:\_Project\capturepack` on `main`, fast-forwarded from `agent/0.3.5` and
pushed. Always begin with `git status --short --branch`, `git fetch`, and a
non-destructive comparison before choosing a branch. Never reset or clean away
an active worktree.

## What 0.4.0 contains

**N screens is the normal case** ([#75](https://github.com/r2cuerdame/capturepack/issues/75),
pack format **0.7.0**). `media.displays` is REQUIRED and always present — a single-display
capture writes an array of one — and `media.snapshot`/`media.replay` are defined as
aliases for the focused entry rather than as the capture. Old readers are unaffected;
what binds is writers, and §13.1 now says a 0.7.0 reader MUST still accept a pack that
predates the requirement.

Two things in there are worth not re-litigating:

- **Each entry states its own snapshot frame, MEASURED.** This looks redundant with
  `bounds` × `scale` and is not: capture rounds with `Math.max(1, Math.round(...))`, so
  the recomputation is off by a pixel at 1.25x and 1.5x — the scale factors this change
  exists to get right, and the reason the pack-assertion cross-check already tolerated
  ±1. A writer MUST populate these from the raster it actually wrote.
- **The validator refuses a box that leaves the frame of the display it names**, even
  when it fits `reference_*`. That was #74's remaining half, and it is checked from the
  DECLARED frame so it still fails when that display's PNG cannot be read.

**The timeline records what moved** ([#12](https://github.com/r2cuerdame/capturepack/issues/12),
pack format **0.8.0**, declared only when a capture actually carries an input event).
`input.mouse.move`, `input.mouse.click`, `input.window.focus`, `input.window.move`,
`input.window.resize`. Derived from samples lane S already takes plus one cursor read
inside the dump the host already performs — no new hook, no new thread, no measurable
cost. Twice bounded: pruned to the surface ring's retention, capped at 4096 events. A
trim DROPS events outside the kept range rather than clamping them, which would stack
hundreds of cursor positions onto instant zero.

**`input.key.*` stays reserved, and that is a decision with a reason.** GOAL.md's rule
for the browser payload is the test: a screenshot contains every pixel the user could
see, so recording those adds no exposure the pack did not already have — and a keystroke
is not among them, because a password field renders dots. Recording it in `timeline.json`
would take back what §11.4 refuses on identical grounds. It is checked from five
directions rather than asserted: the ring emits only the five defined types whatever it
is fed, `INPUT_EVENT_TYPES` holds no key type, no source file names one, the host has no
keyboard hook and reads only the three mouse virtual-keys, and the validator FAILS a pack
carrying one at any version. Every pack says so in its own generated docs.

**Not closed, and do not close them on this work.**
[#76](https://github.com/r2cuerdame/capturepack/issues/76) wants three REAL screens, one
portrait, one scaled, focus on the third; this machine has two, so the case is covered
synthetically in `check:n-display-format` and a fixture is not a desk. Everything that
issue lists as likely to break on a third screen — board layout, the three numberings
agreeing, a focused display that is neither index 1 nor 2, partial recorder failure,
three encoders on one machine — is exactly what a fixture cannot prove.
[#134](https://github.com/r2cuerdame/capturepack/issues/134) needs a picking-quality
threshold argued from measurement; one chosen to make today's build pass measures nothing.

## What 0.3.5 contained

**One process.** The watchdog is gone, and with it the Start Menu fallback shortcut,
the `superviseProcess` setting and the three tray announcements only supervision could
produce ([#80](https://github.com/r2cuerdame/capturepack/issues/80),
[#78](https://github.com/r2cuerdame/capturepack/issues/78) — 1,681 lines removed). It
was built on one observed death whose cause was unknown, because there were no logs
yet. What replaced it costs no process: the app logs its own death with a crash dump,
the next start reports the unclean shutdown, and the login item brings it back.

Read `supervision-standdown` before you touch it. Despite the name it is NOT
supervision: the installer writes that flag before closing the running app and the
Chrome native host exits while it exists, which is how setup replaces the executable
without a native host holding it open. Clearing it lives in app startup now.

- Retention that runs itself — a policy in Settings, a sweep at launch and once a day,
  a storage bar filled against a budget rather than against the disk, and the budget as
  a second cleanup trigger ([#47](https://github.com/r2cuerdame/capturepack/issues/47),
  [#48](https://github.com/r2cuerdame/capturepack/issues/48)).
- Pin numbering by ASSIGNMENT order, with a number the user can type
  ([#51](https://github.com/r2cuerdame/capturepack/issues/51)). Numbering allocates
  SLOTS: N numbered boxes get exactly 1..N, so contiguity is structural rather than a
  rule. Three stale copies of the old rule were found on the way — the annotations
  schema, the skills paragraph generated into every pack, and a SECOND display-number
  implementation inside `tools/validate-capturepack.mjs` that already disagreed with
  core. One rule, one implementation, seven consumers; keep it that way.
- CI records a capture with nobody at the machine and asserts on the pack
  ([#63](https://github.com/r2cuerdame/capturepack/issues/63)). `--save-now` is what
  makes it possible. The job is `continue-on-error` on purpose — the first headed
  Electron capture on a hosted runner — and should be made required once it has been
  green across a run of merges.
- A keyframe declares its own `width`/`height`
  ([#133](https://github.com/r2cuerdame/capturepack/issues/133)). It is taller than the
  frame it shows, deliberately, to hold the labels of bottom-edge boxes; the source
  frame stays at (0,0) at original scale, so annotation coordinates apply unchanged and
  a reader must never scale a keyframe to `reference_height`.

Still open and deliberately not attempted:
[#134](https://github.com/r2cuerdame/capturepack/issues/134), asserting on picking
QUALITY rather than presence. It needs the editor's `ObjectIndex` rebuilt outside the
editor process and a threshold argued from measurement; a threshold chosen to make
today's build pass measures nothing.

## What 0.3.4 contained

**Object Pick moved to the still image, and a video no longer offers it at
all.** Not because picking in a replay was hard, but because it could only be
done in half: window geometry is sampled about a hundred times a second, while
walking a window's controls costs 326 ms against 13.9 ms for everything else on
a normal desk, so the recording-time tracker paced itself to a 3% duty and
skipped Chromium entirely. A still is one instant, the full walk runs at it, and
everything the precision was costing now goes there. A video keeps the replay,
the timeline, keyframes, the window and control geometry recorded through time,
and hand-drawn boxes with lifetimes. One gate enforces it:
`objectPickingApplies()` in the editor.

- A screenshot carries the page of **every visible browser window**, not just the
  one Chrome last focused ([#132](https://github.com/r2cuerdame/capturepack/issues/132)).
  The extension had asked for the active tab of a single window — right for a
  pick, wrong for a capture that photographs the whole desk.
- A still collects the browser's half at the capture instant, over a bounded
  lookback, and records how old each pick was. This needed a one-time browser
  grant: Chrome never sees a global hotkey, so it hands a page to an extension
  only for a click made inside Chrome or for a browser the user has allowed.
- A still layers UIA controls onto lane-S rectangles so a DOM element has a
  client rectangle to be placed against — UIA reports a window rect and never a
  client one.
- After an image capture the clipboard carries the LLM prompt with the pack's
  path rather than the flattened image; the image is still one dropdown away.
- Replay duration, pauses, trim out-points and source latency are measured from
  the instants they describe rather than from when their bytes arrived
  ([#115](https://github.com/r2cuerdame/capturepack/issues/115),
  [#116](https://github.com/r2cuerdame/capturepack/issues/116)).
- Electron windows are no longer skipped wholesale by a frame-rate budget that
  had no business reaching a once-per-capture walk
  ([#117](https://github.com/r2cuerdame/capturepack/issues/117)).
- Every documentation surface — README in nine languages, the site in nine, the
  Remotion films, GOAL/ROADMAP/ARCHITECTURE/SPEC — now says the still-only rule
  instead of contradicting it.

Known and open: [#133](https://github.com/r2cuerdame/capturepack/issues/133),
the annotated keyframe is written 116 px taller than the snapshot it declares
itself derived from. No pixels are lost — the extra band is editor background —
but `annotations.json` declares the snapshot's extent, so a reader overlaying
coordinates on the keyframe is off by that ratio. A gate check asserting every
declared keyframe matches the pack's own `reference_width x reference_height`
would have caught it the day it appeared.

## What 0.3.3 contained

- A script-free, offline `viewer.html` generated inside a CapturePack. It uses
  only declared relative media and remains an optional generated view.
- Bounded recorder ownership and replay retention, with an MP4 fragment ring
  where supported and an honest WebM dual-slot fallback where safe splicing is
  not available.
- Explicit replay cadence, health, clock, backend, and ambiguity evidence
  instead of treating an unmeasured capture as successful.
- One N-display geometry model across negative origins, portrait displays,
  mixed DPI, capture, editing, rendering, save/reopen, and generated documents.
- Capture-instant and reopened Windows UI Automation / Chrome DOM evidence used
  by Object Pick — a still-image affordance; a video carries the geometry it
  observed but offers no picking — without inventing unobserved object state.
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
`core/package.json` is application version `0.4.0`; packs containing the
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

**Why the existing measurements never saw it.** Everything the product compares
is a *timestamp*, and on this failure the timestamps agree. `check:exposure-alignment`
builds a landmark moving at 2 px/ms whose pixels are exposed 60 ms late and puts
it through both measurements: the existing clock comparison calls it aligned to
**2.0 ms**, while correlating position names **60.0 ms ± 2.0**. The disagreement
does not live on the time axis. Any future claim that #89 is fixed has to move
that second number, not the first.

**The measured number.** `npm run qa:exposure-field -- --pack <dir>` reads a
saved pack, recovers the landmark's rectangle over time from the windows-context
timeline, decodes the replay with ffmpeg, and inverts each frame against the
rectangles that were *observed*. On the pack above:

| display | segment | frames identified | exposure latency | positional error |
|---|---|---|---|---|
| 2 (focused) | 7110–9365 ms | 18/34 | **127.0 ms ± 5.5** | 551 px → 97 px |
| 2 (focused) | 9916–12367 ms | 11/36 | **118.0 ms ± 5.5** | 518 px → 19 px |
| 1 | 6555–7257 ms | 1/11 | *refused* | — |
| 1 | 9228–10126 ms | 1/13 | *refused* | — |

Two independent drags in one capture differ by 9 ms and overlap inside their
stated resolution. Display 1 refuses on `insufficient-samples` rather than
guessing from one frame. The harness is read-only and needs ffmpeg on PATH, so
it is a `qa:` script, not a gate step.

**Read the ± as a floor, not a plateau.** These numbers were first published as
`± 0.5 ms`, which was an overclaim: on real evidence noise makes exactly one
grid point win by a hair, the argmin plateau collapses to a single step, and half
a step is all the plateau can say — while the harness's own two segments differ
by 9 ms. Nearest-observation inversion cannot beat half the interval those
observations arrive at, so the reported resolution is now the wider of the
plateau and that floor, and `check:exposure-alignment` fails if a coarser ring
ever reports a finer answer.

**The number is not an artefact of the gate that produced it.** Every run
re-measures at half and double its own identification margin and fails if the
answers disagree by more than one frame; both segments hold their value exactly.
A manual sweep over `--margin 4..40` and `--window 250..500` — twelve runs,
identified frames varying from 24 down to 8 — moves the first segment only
between **125.0 and 129.5 ms** and does not move the second from **118.0 ms**
at all.

It is also confirmed by a method that shares no code with the harness. Reading
one decoded frame by hand: at PTS 6585 ms the window's left edge is at physical
x=1736, and the context track says it was at x=1736 at about 6446 ms — **139 ms**.
The next frame, PTS 6650 ms at x=980 against 6513 ms, gives **137 ms**. That is
a third motion segment, measured with nothing but ffprobe and arithmetic.

**Only one capture in the whole capture root can be measured at all.** Of the
five packs that carry a windows-context timeline and two replays, four report
that no window moved far enough to time anything. The field procedure needs a
capture that contains a deliberate drag; ordinary captures do not.

**Display 1 therefore has no measured latency yet, and that is the gap that
matters**, because "display-specific" is #89's central claim and only display 2
has a number. Closing it needs one capture recorded while a window is dragged
across display 1 — the owner's action, not an agent's: nothing here may
synthesize the capture hotkey or mouse input.

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
- a full real-app E2E flow from hotkey through save, pack validation, and
  failure artifacts — a video rewound and annotated with drawn boxes, and a
  still capture's Object Pick, which is the only capture kind that has one
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

`qa:rc` currently runs 80 discovered `check:*` regressions plus type checking,
the production build, and isolated Electron smoke: **83 gate steps** (81 with
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

# Measure desktop pixel exposure (#89) from a saved pack. NOT in the gate: it
# needs ffmpeg/ffprobe on PATH and a pack containing a dragged window. Read-only
# — it opens the pack, decodes its replay and writes nothing back.
npm run qa:exposure-field -- --pack C:\_CapturePack\CapturePack_YYYY-MM-DD_HHMMSS

# Capture a pack with nobody at the machine and assert on it (#63) — what the
# `capture-e2e` CI job runs, in the same order. NOT in the gate: it records the
# desktop, so it needs a real display. `--save-now` exits 0 when the pack's
# sources are durable, 20 when the flow saved nothing, 21 when it never
# finished. Use your own directories: a shared profile takes the
# single-instance lock and kills your instance.
$work = "$env:TEMP\capturepack-e2e"
.\node_modules\.bin\electron.cmd . --user-data-dir="$work\userdata" `
  --output-dir="$work\packs" --no-global-shortcut --capture-now=6 --save-now
node scripts\assert-capturepack.mjs (Get-ChildItem -Directory "$work\packs")[0].FullName `
  --expect-replay --log "$work\userdata\logs\main.log"

# The same run with the recorder starved. The pack must STATE that the replay
# is unavailable; add --simulate-no-frames and swap --expect-replay for
# --expect-no-replay.

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

## 0.3.4 being published

`core/package.json` is **`0.3.4`** and the documentation, site and motion assets
in this commit describe it. The tag and the public binary are produced by the
`Release` workflow, which is dispatched by hand — so until that run finishes,
`v0.3.3` above is still the public release and this section is the record of
what is going out. Fill in the Public state table from the finished run, and do
not move or replace `v0.3.3`. See [GOAL.md](../GOAL.md) for the design record
and [#104](https://github.com/r2cuerdame/capturepack/issues/104) /
[#89](https://github.com/r2cuerdame/capturepack/issues/89) for the evidence.

During the cycle an RC installer is built with `npm run dist` and appears at
`core/release-rcNN/CapturePack-Setup-0.3.4-rc.NN.exe`. It is unsigned and gitignored:
builds are artifacts of a commit, never part of one. (`release/` can hold a lock
from an earlier build; `npx --% electron-builder --win --publish never
-c.directories.output=release-rcNN` builds beside it. The `--%` matters —
PowerShell otherwise eats `-c.directories...` as an argument to `-c`.)

- **Picking is a still-image feature** ([#119](https://github.com/r2cuerdame/capturepack/issues/119)).
  A video builds no object index at all: one gate, `objectPickingApplies()` in
  the editor. Not because picking in a replay was hard, but because it was only
  half true — lane A skips Chromium windows to hold its 3% duty, so a scrubbed
  frame offered the window and never the thing in it. Lane A still RECORDS into
  the pack's windows-context timeline; only the affordance is gone. Pinned by
  `check:video-no-picking`.
- **A control rectangle is checked before it is offered**
  ([#118](https://github.com/r2cuerdame/capturepack/issues/118)). Chromium
  answers with the old display's scale for a while after a window is dragged
  across a DPI boundary, so a web-content root that no longer covers the surface
  it was drawn into is refused, subtree and all. Measured 0.67 and 0.50 against
  a healthy 1.00. `windows-uia` payload 0.4.0 reports `geometry_refused`.
- **...and it is checked on the coordinates the pack will actually carry**
  ([#120](https://github.com/r2cuerdame/capturepack/issues/120)). rc.19 shipped
  the test in the WALK and in `parseDump`, both of which see the helper's raw
  numbers — and rc.19 still wrote a 0.497 document while reporting nothing
  refused. The mapping is ratio-preserving, so a parent and child mapped through
  the same display cannot disagree; those two were mapped through DIFFERENT
  ones, because `coveringSpace` picks per rectangle and a stale one lands in the
  neighbouring display's space. The test now also runs after
  `mapUiaToSnapshot`, and `composeUiaForImageDesktop` / `mergeImageWindowFloor`
  stopped rebuilding `geometry_refused` away.
- **...and it is checked ONE more time, at the write itself**
  ([#121](https://github.com/r2cuerdame/capturepack/issues/121)). rc.20 leaked
  too. Neither the walk nor the mapper is the end of the pipeline:
  `composeUiaForImageDesktop` drops elements outside a display's placement and
  `mergeImageWindowFloor` drops elements that clip away against the window
  floor, so an element that was somebody's PARENT when the test ran can be gone
  by the time the file is written. The survivor inherits a parent it never had.
  `writeUiaPlugin` now runs the test against the exact array it serializes, and
  every writer — video included — reaches disk through it.
- **...and the EDITOR does not read the file**
  ([#122](https://github.com/r2cuerdame/capturepack/issues/122)). rc.21's guard
  lived inside `writeUiaPlugin`, so the pack came out clean and the owner still
  picked two displaced rectangles — the editor takes the payload straight off
  the promise. A pack can therefore record a `target` whose bounds that same
  pack refuses to list. `sealUiaPayload()` is now applied once in each flow
  where assembly ends and consumption begins, before the editor/writer split.
  `writeUiaPlugin` seals again (it is idempotent) so a future writer that
  forgets cannot put a displaced rectangle on disk.
  **The lesson, four times over: place the check where the value stops changing
  and before anyone reads it — and remember the file is not the only reader.**
  Upstream copies are optimisations only.
- **A still now carries the browser's half too**
  ([#123](https://github.com/r2cuerdame/capturepack/issues/123)). `runImageFlow`
  passed `domEvents: []` and wrote no `plugins/chrome-dom` at all — so the ONE
  capture kind this cycle promised the most context to was collecting none of
  the page, while GOAL, SPEC, the README in nine languages and the site all said
  otherwise. It now reads the bridge over a bounded 10 s lookback
  (`STILL_DOM_LOOKBACK_MS`), hands the same array to the editor, and writes the
  payload through `domEventForPack()` — one mapping shared with the replay.
  chrome-dom payload **0.3.0** adds `age_ms`, because a still stamps every event
  `t_ms: 0` and the distance from the shutter is the reader's to weigh. Pinned by
  `check:still-dom`. **The documentation shipped before the feature; that is its
  own lesson.**
- **The gate is 83 steps.** `npm run qa:rc` — NOT `node scripts/qa-gate.mjs`,
  which loses `npm_execpath` and then cannot spawn `npm.cmd` under Node 24.

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
- The gate discovers **68 checks**: `check:frame-geometry`, `check:dom-pick`,
  `check:docs` and `check:exposure-alignment` are new, and
  `check:chrome-bridge` — an end-to-end harness that existed, had never been
  wired in, and was failing — now runs.
- The lane cost line now prints `frame->core`, dropped samples and stride.
  First measurement on the reporting machine: **`frame->core +4.1 ms`,
  1 dropped, stride 1**, with **160 of 170 samples converted rather than
  frame-stamped**. IPC transport and the memory governor are therefore ruled
  out as causes of #89. The age term, which the converted majority did NOT carry
  at all, now applies on every path: at today's 1 ms age that changes nothing
  visible, and it is what stops the majority population from moving the wrong
  way by 53-125 ms the moment a real exposure latency reaches that term.
  `check:sync` drives a deliberately large age and fails by exactly one age
  without it.
- **#89 has a number.** `qa:exposure-field` measures desktop pixel exposure from
  a saved pack: **127.0 ms and 118.0 ms** on the focused display of the pack that
  opened the issue, from two independent drags, collapsing the overlay's
  positional error from about 550 px to 19–97 px. The non-focused display
  refuses on thin evidence. Where the correction is applied is now an owner
  decision — see the next order.
- `check:exposure-alignment` is the moving fixture #89 was missing. It measures
  desktop pixel exposure by correlating *position* rather than time, recovers an
  injected 60 ms to **60.0 ms ± 2.0**, keeps two displays on 60 ms and 95 ms
  independently, and shows one global constant failing on both at once by about
  17 ms. It refuses on stationary evidence, on evidence that travels too little
  to time anything, and on a replay whose declared PTS regresses. Applying the
  correction twice is measured to be exactly as wrong as not applying it, and
  applying it backwards twice as wrong; the check counts the application sites
  in `src/` and fails above one.

Two things need the machine and the owner, not an agent:

1. One capture recorded while a window is dragged **across display 1**, so #89's
   central claim — that the latency is display-specific — can be measured
   instead of asserted. Four of the five packs that could be measured contain no
   drag at all, and the fifth measures only display 2.
2. One run with the element picker deliberately armed on an ordinary `https://`
   page (below).

Not proved, and it needs the machine: one run with the element picker
deliberately armed on an ordinary `https://` page, so `main.log` says whether it
armed, could not arm, or armed and the click went elsewhere.

## Suggested next order

1. **Ask the owner where the correction goes.** This is not a measurement
   question any more and it should not be decided by an agent:
   - The only single save-side funnel is `frozenRingObservations`
     (`core/src/main/context/ringObservations.ts:441`), where one `t` is both the
     ring query (`surfacesAt(t)`) and the published label (`Math.round(t)`).
     Relabelling there reaches the persisted timeline, the live editor ring,
     every track sample, every drawn box and the burned-in annotated video with
     one call, and is correct for MCP and third-party SPEC readers with no
     changes at all.
   - Correcting on the read side needs at least two sites — `frameAt` for
     picking and `trackOf` for drawing (`core/src/main/context/session.ts:715`
     and `:651`) — which `check:exposure-alignment` already forbids, and it still
     leaves `replay_annotated` uncorrected because that renders in a separate
     process off `metadata.mediaTime`.
   - Save-time correction is **irreversible per pack**: the residual the
     measurement needs is gone, so a pack written with a wrong number cannot be
     re-measured.
   - One `ContextObservation` at one `tMs` carries entries for **every** display
     it overlaps, while the latency is per-display: 127 ms on display 2 and
     unmeasurable on display 1 in the same capture. There is no per-display time
     field in an observation or in a track sample.
2. Whatever is chosen, apply it through `exposureCorrectedContextTimeMs` at
   exactly one place and publish the measured value as its own per-display
   manifest quantity — never by overloading `replay_clock_offset_ms`, whose
   `focused => 0` is correct by definition.
3. Do not add the measured latency on top of the age term without subtracting
   what is already there. `surfaceLane.ts:895` files every ticked observation at
   `frameMs + delayMs + lag + (ageMs ?? 0)`, and the converted and held paths add
   `frameAgeShiftMs`. That leg is about 1 ms today and would be counted twice.
4. Make the one-shot startup calibration retry when motion evidence appears. It
   runs once against a still desktop today, which is why both displays reported
   `insufficient-motion-transitions`.
5. Exercise #62 on a genuinely failing backend and require a decodable replay,
   not a screenshot-only result or a recreated recorder on the same dead stream.
6. Add the real Electron/Windows E2E layer tracked by #63 while preserving the
   existing deterministic gate.
7. Re-run the manual matrix in `docs/QA.md` and record actual hardware, duration,
   FPS, gaps, CPU, memory, process, and media-decode evidence.

Lead reports to the owner with the measured outcome in Korean. If something
remains unverified, say so plainly.
