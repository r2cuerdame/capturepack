# CapturePack handoff — after v0.5.0

Last verified: 2026-09-05 (Asia/Seoul)

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

CapturePack **0.5.0** is the current stable Windows release.

| Item | Current state |
|---|---|
| Public release | [v0.5.0](https://github.com/r2cuerdame/capturepack/releases/tag/v0.5.0), stable (`draft=false`, `prerelease=false`) |
| Release source | Immutable `v0.5.0` tag; never move or replace it |
| Release verification | The guarded Release workflow reran all 89 RC steps on the tagged source, built the Windows artifacts, and byte-verified the exact four-file draft before publication |
| Delivery | The After Save Action host [#68](https://github.com/r2cuerdame/capturepack/issues/68) and the two-list plugin settings [#69](https://github.com/r2cuerdame/capturepack/issues/69), listed under "What 0.5.0 contains" |
| Website | [capturepack.dev](https://capturepack.dev/), with all nine languages kept on the application version |

The Release workflow and its remote byte verification are authoritative for the
published installer's hashes. Do not reuse a local RC hash or any older release's
values when checking 0.5.0.

### Historical 0.4.1 publication evidence

The following table and investigation record apply to **0.4.1 only**. They stay
here because they established the release-verification discipline; they are not
the current version or 0.5.0 asset metadata.

| Item | Verified state |
|---|---|
| Public release | [v0.4.1](https://github.com/r2cuerdame/capturepack/releases/tag/v0.4.1), stable (`draft=false`, `prerelease=false`), published 2026-08-02T12:14:11Z |
| Release source | `5b2b4debc03a6ed26f4a62d7640a77d00601c17c` |
| Release workflow | [passed](https://github.com/r2cuerdame/capturepack/actions/runs/30747260000) |
| Main CI | [passed](https://github.com/r2cuerdame/capturepack/actions/runs/30747137747) — build, spec-validate and `capture-e2e`, the last one asserting on a RENDERED pack for the first time |
| Website | [capturepack.dev](https://capturepack.dev/), serving 0.4.1 in all nine languages |
| Public installer SHA-256 | `43be44f5381c449fd0e6b7fed8c7536efdcefd63e3b71c40f6a4c1265d1a386d` |
| Installer size | 104,279,341 bytes |

The tag points at the CHECK FIX, not at the release-prep commit, and that is the
whole story of this release's last hour. `capture-e2e` went red on the 0.4.1
candidate over `media.cadence.backend is null` — a correct pack and a wrong
assertion. `backend` rides inside `media.cadence`, whose `achieved_fps` and
`worst_stall_ms` SPEC §5.3 makes REQUIRED, so a recorder that measured no rate
writes no cadence and has nowhere legal to put the backend it does know. The job
is `continue-on-error`, so the overall run was green and this could have shipped
unexamined. Do not let that happen: a non-blocking job that goes red on a change
you just made is the one you look at.

Verified after publication by downloading the released asset and hashing it, not
by reading the workflow log: SHA-256 matches `SHA256SUMS.txt`, and the SHA-512
matches `latest.yml` byte for byte, so electron-updater will accept it.

**The read-back fix was checked in the shipped binary, not the branch.** `app.asar`
carries `device_pixel_ratio` on both sides of the seam — `device_pixel_ratio")` where
the reader accepts it and `device_pixel_ratio: ...devicePixelRatio` where the writer
emits it — plus `client_bounds` and the windows-uia `0.5.0` constant.

**The no-keystrokes promise was checked in the shipped binary too.**
`SetWindowsHookEx` is absent from `app.asar`; the only virtual keys the shipped
capture host reads are `VK_LBUTTON`, `VK_RBUTTON` and `VK_MBUTTON`; and the only
input event strings it can emit are `input.mouse.click`, `input.mouse.move`,
`input.window.focus`, `input.window.move` and `input.window.resize`. `WH_KEYBOARD`
and `input.key.*` DO appear — both inside comments explaining why the hook will
never be installed, one of which is the sentence written into every pack's own
documents. Grep for either and read the surrounding line before concluding
anything.

Earlier public releases stay exactly where they are:
[v0.4.3](https://github.com/r2cuerdame/capturepack/releases/tag/v0.4.3),
[v0.4.2](https://github.com/r2cuerdame/capturepack/releases/tag/v0.4.2),
[v0.4.1](https://github.com/r2cuerdame/capturepack/releases/tag/v0.4.1)
(with its detailed publication evidence above),
[v0.4.0](https://github.com/r2cuerdame/capturepack/releases/tag/v0.4.0)
(`51865b73b52ec38a4712f9699669e45e2d02ba56`, SHA-256
`296c80935e8d8fc3df65a58f626886702ffaaba804e374f77416c45effdc5889`),
[v0.3.5](https://github.com/r2cuerdame/capturepack/releases/tag/v0.3.5)
(`e6b1cdc248c17283a067fb15b8f7c148e62a4eea`, SHA-256
`058d3f8be37808eb2460d393f8598278c924063e64971b20a06f049f19686344`),
[v0.3.4](https://github.com/r2cuerdame/capturepack/releases/tag/v0.3.4)
(`525ea4968987a0e4445232d1bba71db0c03703c6`, SHA-256
`a989eb2fd623da4ce88cb4284766bf51b98887715225d986676a151fe0c2f434`) and
[v0.3.3](https://github.com/r2cuerdame/capturepack/releases/tag/v0.3.3)
(`b7e0c695d5f2c018e2c10fcf83936d1d42f7a0d4`, SHA-256
`cdf1da6fee39eb28e82749b9183cdd3c347f26b31e68e0db25a6be5400ebcf3c`).

Release binaries are built from their tagged release source. `main` may
contain documentation-only follow-up commits after that tag. Do not move or
replace a public tag or its assets.

A locally built RC installer under `core/release-rcNN/` has a different hash
because it is a separate unsigned build. Use the public release's
`SHA256SUMS.txt`, not a local build hash, when verifying a downloaded installer.

0.5.0 was prepared on `feat/v0.5.0-action-host` and released from `main`.
Always begin with
`git status --short --branch`, `git fetch`, and a non-destructive comparison
before choosing a branch. Never reset or clean away an active worktree.

## What 0.5.0 contains

**The second plugin kind exists** ([#68](https://github.com/r2cuerdame/capturepack/issues/68),
[#69](https://github.com/r2cuerdame/capturepack/issues/69)). Temporal Context
Providers have shipped since 0.2.0; After Save Actions are the other half of the
plugin system GOAL.md describes, and they share nothing with providers but the
Settings section. A provider runs all day and keeps a temporal buffer; an action
never runs until a pack exists.

The rules live in two dependency-free modules — `core/src/shared/actions.ts` and
`core/src/shared/actionPipeline.ts`. That is deliberate and asserted:
`check:actions` imports the real production code with no Electron stub, so what
the gate holds cannot drift away from what the app follows.

The pipeline's invariant is that the save is already done. It never rejects,
every configured step produces exactly one result row, an action that throws a
non-Error still produces a readable failure, and an action that never returns is
abandoned rather than waited for. The timeout is a race and not an abort on
purpose: a third-party action cannot be made to stop, so the host stops
listening instead.

Firing happens at two moments in `session.ts`, both chosen because the pack
genuinely reaches that state there rather than because the call was convenient:
immediately after `notePackSaved()`, the line the save flow itself documents as
"everything above this is what saved means"; and when the derived render reports
`done`. Neither is awaited.

**Verified against a real receiver, not a mock.** An unattended capture posted
over a real socket to a local HTTP server: `builtin.webhook ok (1 attempt, 19
ms)` at source-ready, then `skipped — already completed for this pack` at
annotated-replay-ready, with exactly one delivery on the wire. That test is also
what found the summary reading `manifest.app_version`, a field the format does
not have — the version lives under `generator`. `check:actions` now holds every
field the summary reads against `docs/schemas/manifest.schema.json`.

## What 0.4.6 contains

**A downloaded update can no longer wait unnoticed forever**
([#147](https://github.com/r2cuerdame/capturepack/issues/147)). The update-ready
notice fired once per version per process run, which is right for the moment an
update arrives and wrong for every hour after it. Measured on the maintainer's own
machine: one process ran twenty hours with 0.4.5 downloaded and waiting, logged
"downloaded v0.4.5" six times, showed exactly one toast — at a moment the user was
away from the desk — and was then killed rather than quit, so
`autoInstallOnAppQuit` never ran. The app that exists to capture context sat a
release behind with the installer already on disk.

A version still downloaded and waiting is now announced again at most once a day.
A newer version arriving while an older one waits is announced at once rather than
serving out the old timer, and a clock that moves backwards is never read as a day
having passed. **This is not the routine update noise #103 removed**: nothing fires
on a schedule, nothing says "you are up to date", and #103's lock-screen hold still
defers a due notice to unlock instead of dropping it.

The rule lives alone in `core/src/main/updateNotice.ts` with no imports, precisely
so `check:update-notice` can hold both the policy and the app's use of it without
an Electron stub that could drift out from under it. Both halves were proven to
fail before being accepted: reverting the policy to once-per-version turns the
interval assertions red, and restoring the old `readyVersion === notifiedVersion`
short-circuit in `index.ts` turns the wiring assertion red.

**The documents that name the current version are now derived rather than typed**
([#148](https://github.com/r2cuerdame/capturepack/issues/148)). After 0.4.5 shipped,
this handoff still said "after v0.4.4" in its own title and stated outright that
`core/package.json` was 0.4.4; `ARCHITECTURE.md` never mentioned 0.4.5 at all.
Two gates were involved and only one was merely weak: `check:docs` asserted
`handoff.includes(version)` and nothing else, while `site/validate.mjs` pinned the
literal string `# CapturePack handoff — after v0.4.4` and therefore REQUIRED the
stale title. A pin that outlives its release stops being a check and becomes the
reason for the bug.

## What 0.4.5 contains

Five fixes, all of them found by running the product on a real desk rather than
by reading the code.

**A multi-display recording loss now names the screen that lost it**
([#137](https://github.com/r2cuerdame/capturepack/issues/137)). The payloads were
always right; the two renderers were not. The tray collapsed N recorders into one
pessimistic "not recording", and the toast reported a count -- or, when the focused
display was among the failures, discarded the count entirely and read identically to
a single-screen failure. Both now name the failed displays and say whether the
focused one is among them, in all nine locales. The pack's `report.md` already did.

**Native replay fallback survives a display at a negative origin.** A secondary
monitor placed left of or above the primary (DISPLAY1 at `rect=-1200,0`) threw an unhandled
CLR exception. The blit now runs from a device-specific DC with an automatic fallback
that drops `CAPTUREBLT`.

**Region crop pick quality is measured against the right frame.** Pick quality
normalizes the offered interactive control area against the source host display
resolution instead of treating a region crop as full-screen bounds.

**The mouse pointer no longer flickers during fallback capture.** `SRCCOPY` is
preferred over `CAPTUREBLT`, which was toggling the DWM hardware cursor plane.

**Capture recovers immediately on unlock and resume.** Recorders stopped by
`DXGI_ERROR_ACCESS_LOST` at the lock screen, or by system sleep, now clear their backoff and
rebuild on the `powerMonitor` unlock/resume edge instead of waiting out the retry
schedule.

## What 0.4.4 contains (historical)

History's primary sharing action is now a reviewed, still-only Share Copy
([#140](https://github.com/r2cuerdame/capturepack/issues/140),
[#141](https://github.com/r2cuerdame/capturepack/pull/141)). It is a separate
`capturepack-share` `.share.zip`, never a reduced CapturePack. Its closed
media allowlist includes only declared annotated keyframe PNGs, after decoding
and deterministically re-encoding their pixels. A generated README, offline
viewer and minimal inventory accompany that media. Originals, all video
containers, manifest, annotations, timeline, plugins, notes, reports, and
generated source documents do not cross that boundary.

The review is binding: every thumbnail is derived from the exact canonical PNG
bytes that creation writes, every still opens lazily at full-resolution 1:1, a
same-size/restored-mtime content change or annotation change refuses creation,
and a labeled blur box is blocked. Malformed display tables and annotation lanes
without a declared still fail closed instead of making a partial copy. Visual
redaction remains risk reduction rather than proof that an image contains no
secret. Atomic Windows no-replace moves, recoverable replacement, and a per-pack
operation lock cover creation and managed rename; trash and retention manage the
companion archive before the source folder.
Windows 8.3 short-path spelling is accepted without treating an ordinary path as
a link, while actual symlink/junction traversal is still refused component by
component. Full ZIP remains the explicit originals-included distribution path.

## What 0.4.1 contains (historical)

**A saved pack's browser page can be read back** ([#136](https://github.com/r2cuerdame/capturepack/issues/136)).
Measured before and after on the same corpus with the same instrument: 12 packs,
**6,092 rectangles on disk, 1 recovered → 6,092 recovered**. The single "1" was one
explicit element pick; every captured document was refused.

Two independent causes, either one fatal on its own:

- The writer persists the document viewport as `device_pixel_ratio` / `scroll_x` /
  `scroll_y`; the reader asked for `devicePixelRatio` / `scrollX` / `scrollY`. `dpr`
  came back null and the guard refused the whole document rather than defaulting a
  device pixel ratio — correct behaviour on wrong input. Both spellings are accepted
  now and **the writer was not touched**: SPEC and every pack in the field agree with
  it. `domProvider.ts`'s comment claiming #130 fixed read-back is corrected; it did,
  and this defeated it on the next line.
- No pack persisted a client rectangle. #131 solved that for the LIVE still by
  layering lane-S rectangles onto the observation; nothing wrote them to disk, so 0 of
  80 payloads carried one and every recovered element was declined. `windows[].client_bounds`
  is now OPTIONAL in the **windows-uia payload, which moves to 0.5.0** — a plugin
  payload is additive under SPEC §11.1, so the pack format itself does not move.

It lives in windows-uia rather than chrome-dom because it is a fact about a WINDOW,
observed in the same pass and the same space as the frame rectangle it qualifies.

**What picking offers is measured** ([#134](https://github.com/r2cuerdame/capturepack/issues/134)).
`ObjectIndex.forDisplay` lifts index construction out of the editor renderer and
`context/packObjects.ts` opens a saved pack as the same `ContextSession` the re-edit
flow does — real parser, real providers, no Electron. `check:pick-quality` sweeps on a
16 px grid and fails past a **15%** per-pack median. The verdict on current code was
FINE: median 0.37%, p90 3.27% across 41 real captures. The limit sits in a measured
gap — floor 11.4% (worst honest pack, finest grid), ceiling 37% (the #58 regression
reinstated). A "precise" column rides beside it so a fix that deletes every control
cannot pass by driving the median to nothing.

That threshold was **re-derived** after #136 landed rather than assumed still valid,
because #136 changes what the document rung can offer. It stays at 15%; the note in
the check carries the numbers, including the caveat that on a pack where the browser IS
the frame this check would fail — which is the right answer, not a false alarm.

**CI asserts on a rendered pack** ([#135](https://github.com/r2cuerdame/capturepack/issues/135)).
`--save-now` gained a bounded `--await-render`. Polling the manifest cannot work here:
it assumes the app is alive to finish the render, and `--save-now` quits at the source
boundary where `before-quit` shuts the render queue down.

**Three screens, synthetically** ([#76](https://github.com/r2cuerdame/capturepack/issues/76)).
Four of its five risks are covered on a desk built to break them — mixed scales,
vertical offsets, portrait in the middle, focus on index 3. Every assertion was proven
to catch its regression by sabotaging **the production rule it guards**, not the
fixture's expected value. The fifth — three encoders and three UIA buffers on one
machine — is a measurement on real hardware and is NOT covered.

**#76 stays open and its acceptance test is unrun.** The issue carries a seven-item
checklist for whoever has three monitors; read it before assuming anything about that
desk. [#137](https://github.com/r2cuerdame/capturepack/issues/137) resolved the
reporting gap: at three screens the tray and the toast now name the specific
display that lost its replay across all nine supported locales.

## What 0.4.0 contained

The release notes are in [CHANGELOG.md](../CHANGELOG.md). What follows is only the
part that still binds code written today.

**For video captures, N screens is the normal case**
([#75](https://github.com/r2cuerdame/capturepack/issues/75), pack format
**0.7.0**). `media.displays` is REQUIRED and always present — a single-display
video capture writes an array of one — and `media.snapshot`/`media.replay` are
defined as aliases for the focused entry rather than as the capture. Old readers are unaffected;
what binds is writers, and §13.1 says a 0.7.0 reader MUST still accept a pack that
predates the requirement. Two consequences that are easy to undo by accident:

- **Each entry states its own snapshot frame, MEASURED.** This looks redundant with
  `bounds` × `scale` and is not: capture rounds with `Math.max(1, Math.round(...))`, so
  the recomputation is off by a pixel at 1.25x and 1.5x — the scale factors this change
  exists to get right, and the reason the pack-assertion cross-check already tolerated
  ±1. A writer MUST populate these from the raster it actually wrote.
- **The validator refuses a box that leaves the frame of the display it names**, even
  when it fits `reference_*`, and it checks from the DECLARED frame so it still fails
  when that display's PNG cannot be read.

**`input.key.*` stays reserved, and that is a decision with a reason.** The timeline
records what moved ([#12](https://github.com/r2cuerdame/capturepack/issues/12), pack
format **0.8.0**, declared only when a capture actually carries an input event) and the
five defined types are the whole set: `input.mouse.move`, `input.mouse.click`,
`input.window.focus`, `input.window.move`, `input.window.resize`. GOAL.md's rule for the
browser payload is the test: a screenshot contains every pixel the user could see, so
recording those adds no exposure the pack did not already have — and a keystroke is not
among them, because a password field renders dots. Recording it in `timeline.json` would
take back what §11.4 refuses on identical grounds. It is checked from five directions
rather than asserted: the ring emits only the five defined types whatever it is fed,
`INPUT_EVENT_TYPES` holds no key type, no source file names one, the host has no keyboard
hook and reads only the three mouse virtual-keys, and the validator FAILS a pack carrying
one at any version. Every pack says so in its own generated docs.

Events are pruned to the surface ring's retention and capped at 4096. A trim DROPS
events outside the kept range rather than clamping them; clamping would stack hundreds
of cursor positions onto instant zero.

## What 0.3.5 contained

The release notes are in [CHANGELOG.md](../CHANGELOG.md). Three things in 0.3.5 are
still live rules, and the first one is a trap.

**Read `supervision-standdown` before you touch it. Despite the name it is NOT
supervision.** The watchdog is gone and so is everything around it — the Start Menu
fallback shortcut, the `superviseProcess` setting, the three tray announcements only
supervision could produce ([#80](https://github.com/r2cuerdame/capturepack/issues/80),
[#78](https://github.com/r2cuerdame/capturepack/issues/78), 1,681 lines removed). That
flag survived them because it does a different job: the installer writes it before
closing the running app and the Chrome native host exits while it exists, which is how
setup replaces the executable without a native host holding it open. Clearing it lives
in app startup.

**Numbering allocates SLOTS, and there is one implementation of it**
([#51](https://github.com/r2cuerdame/capturepack/issues/51)). N numbered boxes get
exactly 1..N, so contiguity is structural rather than a rule that something has to
enforce. Three stale copies of the old rule were found the last time this was touched —
the annotations schema, the skills paragraph generated into every pack, and a SECOND
display-number implementation inside `tools/validate-capturepack.mjs` that already
disagreed with core. One rule, one implementation, seven consumers; keep it that way.

**A keyframe declares its own `width`/`height`**
([#133](https://github.com/r2cuerdame/capturepack/issues/133)) and is deliberately
taller than the frame it shows, to hold the labels of bottom-edge boxes. The source
frame stays at (0,0) at original scale, so annotation coordinates apply unchanged and a
reader must never scale a keyframe to `reference_height`.

## What 0.3.4 contained

The release notes are in [CHANGELOG.md](../CHANGELOG.md). Two things in 0.3.4 are
rules the current code still runs on.

**Object Pick is a still-image feature, and one gate enforces it:**
`objectPickingApplies()` in the editor
([#119](https://github.com/r2cuerdame/capturepack/issues/119), pinned by
`check:video-no-picking`). Not because picking in a replay was hard, but because it
could only ever be done in half: window geometry is sampled about a hundred times a
second, while walking a window's controls costs 326 ms against 13.9 ms for everything
else on a normal desk, so the recording-time tracker paced itself to a 3% duty and
skipped Chromium entirely — a scrubbed frame offered the window and never the thing in
it. A still is one instant, the full walk runs at it, and everything the precision was
costing goes there instead. Lane A still RECORDS into the pack's windows-context
timeline; only the affordance is gone. GOAL.md's decision of 2026-08-01 ("The still
carries the context; the video carries the time") extends this to a video's captured
instant as well, so do not read "still-only" as "still, plus frame zero".

**A displaced control rectangle is refused at the WRITE, not upstream**
([#118](https://github.com/r2cuerdame/capturepack/issues/118) through
[#122](https://github.com/r2cuerdame/capturepack/issues/122) — four consecutive
escapes, each one a release candidate). Chromium answers with the old display's scale
for a while after a window is dragged across a DPI boundary, so a web-content root that
no longer covers the surface it was drawn into is refused, subtree and all, and
`windows-uia` reports `geometry_refused`. The check first ran in the walk and in
`parseDump`, which see the helper's raw numbers; then after `mapUiaToSnapshot`, because
`coveringSpace` picks a display per rectangle and a stale one lands in the neighbouring
display's space; then at the file, because `composeUiaForImageDesktop` and
`mergeImageWindowFloor` delete elements after the test ran, so a survivor inherits a
parent it never had; and finally it turned out the editor never reads the file at all —
it takes the payload straight off the promise. `sealUiaPayload()` is now applied once in
each flow where assembly ends and consumption begins, and again inside `writeUiaPlugin`,
which is idempotent. **The lesson, four times over: place the check where the value
stops changing and before anyone reads it — and remember the file is not the only
reader.** Upstream copies are optimisations only.

## What 0.3.3 contained

The release notes are in [CHANGELOG.md](../CHANGELOG.md). Almost everything 0.3.3
established has been restated by a later release; two habits it set are worth naming
because breaking them is quiet:

- **`viewer.html` is an OPTIONAL generated view.** Script-free, offline, and using only
  declared relative media. A pack without one is valid; a viewer that reaches outside
  the pack is not.
- **Save is source-first and atomic.** Annotations, timeline, manifest, report, README,
  skills and plugins are written before any derived rendering, so a render that fails
  cannot cost the sources. Background media work is serialized for the same reason: a
  save and a render must not multiply decoders or encoders.

Application version and pack format version are different contracts.
`core/package.json` is application version `0.5.0`; packs containing the
optional viewer declare a compatible format version of at least `0.5.0`.

## Measured characteristic: the picture lags its own timestamp

[Issue #89](https://github.com/r2cuerdame/capturepack/issues/89) is **CLOSED**
(2026-07-31). It was not closed by removing the lead. The lead is real, it was
measured, and **nothing in the product corrects it.** It was closed because the
correction was rejected as a product decision, recorded in GOAL.md as "The still
carries the context; the video carries the time" (2026-08-01): a box in a replay
no longer follows a moving object, so nothing is left that asks the picture to
be accurate to a fraction of a frame. `exposureCorrectedContextTimeMs` exists in
`core/src/shared/exposureAlignment.ts` and is called from nowhere in the
product — `check:exposure-alignment` permits at most one application site and
today counts zero.

So read this section as a property of the medium that someone may have to
explain, and as the standing argument against re-deriving it from scratch.

**The figure never settled, and that is why no constant ships.** The same
capture answered 51 ms scored against the annotation's own samples and 92 ms
against the context timeline; across captures the offline harness returned 92,
94, 109, 121 and 127 ms. Five confounds were found and fixed on the way to those
figures — a decoder inventing frames, a sweep clipped at its own boundary, a
display clock assumed to be zero where the app uses a fallback, stationary
frames averaged in, and two records of the same window disagreeing. Every fix
was correct and the answer moved each time (#89's closing comment; the same
account is in GOAL.md). Do not hard-code 125 ms, 100 ms, or any other global
correction.

**Where the instruments live.** `check:exposure-alignment`
(`core/scripts/exposure-alignment-check.ts`) is in the gate: it is arithmetic
and refusals over a synthetic fixture and needs no hardware.
`npm run qa:exposure-field -- --pack <dir>`
(`core/scripts/exposure-field-check.mjs`) measures a saved pack; it is read-only
and needs ffmpeg/ffprobe on PATH, so it is a `qa:` script and not a gate step.

The numbers below are the first ones the field harness published, on the capture
that opened the issue. They are kept because they are the most carefully
qualified measurement of this that exists — not because they are a constant.

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
does not live on the time axis. Any future claim to have changed this has to
move that second number, not the first — which is exactly why the fixture stayed
in the gate after the issue closed.

**How they were measured.** `qa:exposure-field` reads a saved pack, recovers the
landmark's rectangle over time from the windows-context timeline, decodes the
replay with ffmpeg, and inverts each frame against the rectangles that were
*observed*. On the pack above:

| display | segment | frames identified | exposure latency | positional error |
|---|---|---|---|---|
| 2 (focused) | 7110–9365 ms | 18/34 | **127.0 ms ± 5.5** | 551 px → 97 px |
| 2 (focused) | 9916–12367 ms | 11/36 | **118.0 ms ± 5.5** | 518 px → 19 px |
| 1 | 6555–7257 ms | 1/11 | *refused* | — |
| 1 | 9228–10126 ms | 1/13 | *refused* | — |

Two independent drags in one capture differ by 9 ms and overlap inside their
stated resolution. Display 1 refuses on `insufficient-samples` rather than
guessing from one frame — the refusal matters more than the number.

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

**Display 1 has no measured latency, and never got one.** "Display-specific" was
#89's central claim and only display 2 ever produced a number, which is part of
why a single global correction was never defensible. Getting one would need a
capture recorded while a window is dragged across display 1 — the owner's
action, not an agent's: nothing here may synthesize the capture hotkey or mouse
input. Nothing in the product waits on it any more.

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

If this is ever revisited, #89's closing comment names the only condition that
would justify it: a per-frame budget that buys a replay fast enough for a
fraction of a frame to be a meaningful unit. Short of that, the acceptance
boundary it never cleared still stands — a measured source-to-encoded-PTS
mapping per display, recalibrated when useful motion evidence appears, published
as its own per-display manifest quantity (never by overloading
`replay_clock_offset_ms`, whose `focused => 0` is correct by definition), and
applied at exactly one site.

The one-shot startup calibration still runs once against a still desktop and
still reports `insufficient-motion-transitions`. Making it retry when motion
arrives was proposed as part of the correction work, but it is not only #89's:
it also decides whether the pack clock uses a measured source latency or the
wall-clock fallback. Nobody has measured what that fallback costs, so this is
neither dead nor scheduled.

`CapturePack_2026-07-30_232429` is only a 403 ms stationary-control sample and
cannot validate dynamic sync. It does show a 25.592 s focused replay versus a
29.721 s display-2 replay, no display-2 replay offset, focused cadence of
12.5/15 fps, and a 1217 ms worst stall. Treat those as evidence, not as a
derived correction.

## Still unverified in the field

The deterministic gate is broad, but it is not physical Windows proof. Most of
the issues that first reported these are now closed, and that is not the
contradiction it looks like: closing an issue records what was measured and what
shipped, not that the hardware to prove it exists. Do not claim these complete
without new measurements.

- **A working replay after a real Desktop Duplication failure.**
  [#62](https://github.com/r2cuerdame/capturepack/issues/62) is closed because
  the fallback exists: on confirmed primary failure `NativeReplayFallbackManager`
  (`core/src/main/nativeReplayFallback.ts`) starts `native-replay-capture.exe`,
  an independent `windows-gdi-bitblt` source that does not go through DXGI, and
  the pack says which one it was in `cadence.backend` / `cadence.quality` —
  SPEC §5.6 forbids a fallback calling itself full quality.
  `check:native-replay-fallback` and `check:replay-health` gate it. What was
  never done is watching it take over on a genuinely wedged machine, and nobody
  knows yet what clears a wedged duplication or which application usually holds
  it.
- **Sustained cadence anywhere but the reporting machine.**
  [#82](https://github.com/r2cuerdame/capturepack/issues/82) is closed on
  measurement and the measurement is narrow: 14.2–14.8 fps of 15 requested on
  the busy display of one desk. Its more useful half is that the one-second
  holes were never dropped frames — a screen capture makes a frame when the
  screen *changes*, so an untouched display delivers almost nothing and has lost
  nothing, and `discarded_frames` is what tells a real loss from a still screen.
  Sustained 1 fps and 30 fps, and any other hardware, are unmeasured.
- the complete five-minute CPU, private-bytes, working-set, JS-heap, recorder,
  retained-chunk, and stall matrix on one and two physical displays;
- a physical three-display setup with negative origin, portrait, mixed DPI,
  cross-display manual/semantic objects, save/reopen, and rendered output —
  this one is still an open issue,
  [#76](https://github.com/r2cuerdame/capturepack/issues/76), and its acceptance
  test has never been run;
- **a full real-app flow driven by a person, from the global hotkey.**
  [#63](https://github.com/r2cuerdame/capturepack/issues/63) is closed and
  `capture-e2e` now records a pack on CI with nobody at the machine and asserts
  on a rendered one — but it starts at `--capture-now`, not at the hotkey, and
  it picks nothing. A video rewound and annotated with drawn boxes, and a still
  capture's Object Pick — the only capture kind that has one — remain owner-only,
  because nothing here may synthesize the capture hotkey.
- **One run with the Chrome element picker deliberately armed on an ordinary
  `https://` page**, so `main.log` says whether it armed, could not arm, or armed
  and the click went elsewhere. This has been outstanding since the 0.3.4 cycle.
  It may have been overtaken: the #136 corpus contained exactly one explicit
  element pick across 12 real packs, which is a picker that armed and delivered
  at least once. Nobody has recorded the deliberate run, so it stays here.

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

`qa:rc` currently runs 86 discovered `check:*` regressions plus type checking,
the production build, and isolated Electron smoke: **89 gate steps** — 87 with
`--skip-build`, which drops the build and the smoke that follows it. The gate
discovers its checks from `core/package.json`, so that number moves with every
release. Count it before quoting it, and trust the count over any document,
including this one:

```powershell
node -e "const s=require('./core/package.json').scripts;console.log(Object.keys(s).filter(k=>k.startsWith('check:')).length)"
```

Run it as `npm run qa:rc`, **not** as `node scripts/qa-gate.mjs`: invoked
directly it loses `npm_execpath`, falls back to spawning `npm.cmd`, and Node 24
will not do that. Reports are written under `%TEMP%\capturepack-qa` unless an
artifact directory is provided.

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

Building a release candidate during a cycle: `npm run dist` writes
`core/release-rcNN/CapturePack-Setup-<version>-rc.NN.exe`. It is unsigned and
gitignored — a build is an artifact of a commit, never part of one. If
`release/` still holds a lock from an earlier build, build beside it:

```powershell
npx --% electron-builder --win --publish never -c.directories.output=release-rcNN
```

The `--%` matters. Without it PowerShell eats `-c.directories...` as an argument
to `-c`.

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

Never overwrite a public version. A product hotfix after 0.5.0 must use a higher
version and fix forward. Documentation-only commits may follow the release on
`main`, but they do not alter the binaries identified by the `v0.5.0` tag.

## Suggested next order

**Nothing here asks anyone to apply the #89 exposure correction.** Earlier
revisions of this document opened with "ask the owner where the correction
goes", laid out the candidate sites, and read as a live instruction. It is not
one. The owner answered on 2026-08-01 and the answer was no: the only design
that survived the cost analysis measured one capture and corrected the next,
which means telling someone their first capture was a calibration run. That
rejection is the reason a video no longer tracks at all. Do not restart the
work, and do not treat the candidate-site analysis as a plan — it now exists
only as history in #89 and GOAL.md.

What the actually-open issues ask for, in the order they are worth doing:

1. **[#76](https://github.com/r2cuerdame/capturepack/issues/76) — three real
   screens.** The synthetic desk in `check:n-display-format` covers four of the
   five risks, and the fifth (three encoders and three UIA buffers on one
   machine) is a measurement no fixture can make. The issue carries a seven-item
   acceptance checklist that has never been run. It needs the owner's hardware,
   and nothing else in the backlog is waiting on it.
2. **[#137](https://github.com/r2cuerdame/capturepack/issues/137) — display loss
   notification naming.** Resolved: notifications identify dead screens as
   "Display {index}" (or "Display {index} (focused)") in both toast and tray
   surfaces across all nine supported locales, keeping count/total context when
   multiple screens fail.
3. **[#138](https://github.com/r2cuerdame/capturepack/issues/138) — replace the
   always-on Windows replay path.** Move toward DXGI Desktop Duplication, D3D11
   surfaces, hardware H.264 and a bounded native ring only with measured
   CPU/GPU/memory/latency gains, correct timestamps and rotation, an explicit
   fallback, and no regression to the fast still-image path.
4. **[#139](https://github.com/r2cuerdame/capturepack/issues/139) — maintain a
   privacy-safe real-pack regression corpus.** Keep representative hard cases
   and explicit capture-to-candidate latency and pick-quality thresholds in the
   release gate, while separating an expected visual change from a broken
   selection or capture.
5. **[#69](https://github.com/r2cuerdame/capturepack/issues/69) and
   [#68](https://github.com/r2cuerdame/capturepack/issues/68) — the plugin
   platform.** Settings > Plugins with real status and reorderable actions, and
   an after-save action host with pack states, pipelines, retry and
   idempotency. Read both issues before designing either; they share a surface.
6. **[#21](https://github.com/r2cuerdame/capturepack/issues/21) — Windows code
   signing** through the SignPath Foundation OSS programme. Still open, so the
   public installer is unsigned.
7. **[#1](https://github.com/r2cuerdame/capturepack/issues/1) — the usage
   journal.** The oldest issue and the least urgent.

Standing verification work that no issue tracks:

8. ~~Make `capture-e2e` a required CI job~~ — **done in 0.4.3.** The stated
   condition was met: twelve consecutive CI runs from 2026-08-02 to 2026-08-09
   were green on that job, so `continue-on-error` is gone. What it was
   protecting against remains on the record — on the 0.4.1 candidate it went red
   inside a run that stayed green, and could have shipped unexamined.
9. Re-run the manual matrix in [QA.md](QA.md) and record actual hardware,
   duration, FPS, gaps, CPU, memory, process, and media-decode evidence. Every
   item under "Still unverified in the field" above is settled there or nowhere.

Lead reports to the owner with the measured outcome in Korean. If something
remains unverified, say so plainly.
