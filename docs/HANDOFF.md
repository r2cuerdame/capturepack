# HANDOFF — CapturePack, current through 0.3.2

## Current state — 2026-07-30

The public 0.3.2 release was published from commit
`3aa8b36148da8e1af8c353c6b16b0380f4a15ff5`. The release workflow, remote
asset verification, main-branch CI and Pages deployment all completed
successfully.

0.3.2 is a focused Windows editor correctness patch:

1. Every native image-selector window must exactly cover its display before and
   after activation, including a portrait tail below the primary work area.
2. The selected region's largest display overlap owns editor placement.
3. Preload buffers the one-shot editor initialization message; Main reveals the
   editor only after renderer decode, a paint boundary and success
   acknowledgement, so a still editor cannot open as an uninitialized dark shell.
4. Manual boxes are red and author-keyframeable; semantic UIA/DOM boxes are blue,
   geometry-owned, and retain provider target identity after save/reopen.

0.3.1 remains the dependency and post-0.3.0 hotfix baseline with three product invariants:

1. Chrome DOM bounds are projected through the browser window and the display
   that owns each observation. A 2x-to-1x monitor move must stay correct at past
   frames and after save/reopen.
2. Late UIA/DOM/plugin context regenerates README, report and skills from the
   completed manifest instead of leaving the save-first documents stale.
3. Generated guidance names annotated replay/keyframe files only when the final
   manifest declares them.

The production dependency boundary is also refreshed: `adm-zip` 0.6.0 addresses
CVE-2026-39244; `@modelcontextprotocol/sdk` 1.30.0 plus
`@hono/node-server` 2.0.12 addresses GHSA-frvp-7c67-39w9; Electron is 43.2.0,
electron-builder 26.15.3 and esbuild 0.28.1. `npm audit --omit=dev` must report
zero. The remaining 16 high advisories are confined to electron-builder's
development-only transitive tree, with no fixed upgrade in the current release
line at this writing (npm suggests the older 25.1.8); keep them visible in
[DEPENDENCY-AUDIT-0.3.1.md](DEPENDENCY-AUDIT-0.3.1.md).

### Current release gate

From `C:\_Project\capturepack\core`:

```powershell
npm ci
npm run qa:rc
npm audit --omit=dev
```

`qa:rc` discovers every `check:*` regression (including `check:site`), runs
type checking, builds production code and runs the isolated Electron smoke.
Physical Windows QA is still required for a mixed-DPI cross-monitor recording
and image drag, past-frame/reopened sibling-control picks, Chrome reconnection,
process/CPU baseline, and installer close/restore behavior; see
[QA.md](QA.md).

The only publishing path is manual `workflow_dispatch`. It verifies the version
and full QA, packages locally, validates the exact installer/updater contract,
creates or verifies the tag only after QA, stages the EXE, blockmap,
`latest.yml` and `SHA256SUMS.txt` in a draft, downloads and byte-verifies all
four, then publishes the verified draft. Branch and tag pushes do not publish.
See [RELEASING.md](RELEASING.md).

### Historical record below

Everything after this point is the original rc.35 handoff. It is preserved
because its measurements, safety incidents and rejected hypotheses remain
valuable. Its version status, open-task order, verification list and release
instructions are superseded by the current section above; do not execute them
as a current checklist.

Written while there was still room to write it properly. Read this top to bottom
before touching anything; the last section is the one that matters most.

## Historical rc.35 snapshot — where things stood

`main` is at **rc.35**, 140-odd commits ahead of `origin/main`.
**Nothing has been pushed since v0.1.7.** The remote's newest tag is v0.1.7; the
local `v0.2.0` tag was never pushed, and its code is already merged into main.

The plan the owner stated: **fix everything, test it bundled, then release
0.3.0 — on their acceptance, not before.** Do not push or tag without an
explicit go-ahead. Pushing a `v*` tag triggers `.github/workflows/release.yml`,
which publishes an installer.

`CHANGELOG.md` already carries a drafted `## 0.3.0` entry. Update it as things
land; do not date-stamp a release that has not happened.

### Verification floor

Nine checks, all green as of rc.35. Run every one of them before claiming
anything works:

```
cd core
npx tsc --noEmit
npm run check:sync        surface ring vs a synthetic host, red/green proven
npm run check:delta       the host's delta protocol rebuilds the whole desk
npm run check:dom         the Chrome DOM rung lands on the element
npm run check:controls    lane A tracks, versions, and admits death
npm run check:identity    a pack is a pack, not any folder with a manifest.json
npm run check:keyframes   every annotation keeps at least one still
npm run check:pick        a probe gets an object that contains the probe point
npm run check:numbering   creation order decides the number; pins claim theirs
npm run check:motion      an authored keyframe moves the box from there on
```

Builds go to a fresh output dir so electron-builder cannot fight a file lock:
`npx electron-builder --win "-c.directories.output=dist-rcNN"`. Every `dist-rc*`
is gitignored.

## Landed since this was first written

All three feature branches are MERGED into main:

- **manual-box authored keyframes** (#97) — a new `keyframes[]`, deliberately
  NOT `tracking.samples`, because the pack has to preserve what kind of claim a
  rectangle is. Authored keyframes interpolate; observed samples still never do,
  and `check:motion` proves interpolation did not leak across.
- **box numbering** (#98) — `created_at` decides the order, `number_pin` lets a
  box claim 1-9, first-created wins a conflict. `format_version` 0.2.0 -> 0.2.1;
  a pack using keyframes declares 0.3.0.
- **control-pick investigation** (#99) — the geometry is EXACT: 219 probes, 219
  contained the point, 137 sub-32px controls all pickable. See the open finding
  below; it is not a coordinate bug.

An adversarial sweep of `2221328..HEAD` (6 dimensions x 3 refutation lenses) was
still running and its results were never collected. Re-run it or read
`.claude/projects/.../workflows/` for the script.

### The strongest open lead — control level goes silent, not misplaced

`claimsOf` emits a region claim only for a window whose UIA tree status is
`'collected'` or `'truncated'`; `resolveCandidates` then drops every
control-level candidate no claim covers. So a window lane A has BLOCKED (or
never walked) contributes zero controls at every time — pinned by the check:
the provider offers 230 candidates, `claimsOf` emits 0, `pick()` returns null.
From the outside that is indistinguishable from "this app has no controls".

`main.log` shows lane A blocking windows with **"it took 0 ms a pass"**, which
is not slow. The log lie is fixed (`Untrack()` destroyed the record before the
cost was read), but whether the block itself is firing correctly is untested.
Start here: a window whose controls the DUMP collected should keep its claim
even when lane A is not tracking it.

Also unverified: the pack carries ONE dump instant (`captured_at`, a flat
`elements` array, no per-time series), so lane A's live re-reads reach the
editor through `frozenRingObservations` but not the saved pack. A page that
SCROLLED between the dump and the frame being viewed would show a control
faithfully at where it WAS — right name, rectangle over blank space, which is
exactly the reported screenshot.

## What is NOT done

### 1. Seven fixes recovered but not applied

`.review-archive/codex-review-0.3.0.patch` (committed, 77 KB, 25 files) is the
**only surviving copy** of an independent review's work. Its worktree's git
index was locked, so it was never committed there; a checkout or cleanup in
`C:\Users\recue\orca\workspaces\capturepack\penguin` destroys it.

Applied to main already: the `ft` round-trip format, the missing `</div>`, and
`lifetimeFrom` keeping its anchor. **Not applied, verified still open:**

- **Fixed-display mode gives lane S no tick source at all.** `focused` is
  computed per recorder from *the display under the cursor right now*
  (`core/src/main/capture.ts` `focusedDisplayIdForTicks`), so in fixed mode with
  the cursor elsewhere, no renderer ever ticks. Unplugging the owning monitor
  has the same effect for the rest of the session, because ownership is not part
  of `recorderSignature`.
- **The pack clock and the ring are on two different renderers' `performance.now()`.**
  Each recorder is its own process with its own `timeOrigin`. Fix is four edits
  that must land together (normalise with `performance.timeOrigin` in the
  renderer, convert through `SessionClock.fromWallClockMs` in
  `context/runtime.ts`); half of it is worse than none. **Depends on the `ft`
  round-trip fix already on main — do not revert that.**
- **The extension treats its own outbound write as a completed handshake.**
  `extensions/chrome/background.js` sets `handshakeAt` right after
  `port.postMessage`, which proves only that Chrome queued bytes. That makes the
  one-minute liveness alarm's `handshakeAt === null` branch dead code — the
  other half of "재설치할때마다 리로드 안하면 연결이 안돼". Set it only inside an
  `onMessage` handler that validates the app's hello.
- **Settings says Chrome "connected" forever after the first handshake of the
  run.** `domBridge.ts` clears `extensionVersion` only at app quit and has no
  `socket.on('close')`. Track live handshaken sockets in a Set instead.
- Purge counts one scan and deletes another (a capture finishing during the
  confirm dialog is deleted although the user never saw it), and the IPC accepts
  any age rather than the four the panel offers.
- Enter right after a scrub can export the previous frame's pixels under the new
  `snapshot_t_ms`: `whenSettled()` resolves on `seeked`, but a frame-driven
  renderer has not drawn yet.
- A negative `NativeWindowHandle` (HWND bit 31) makes `uia-dump.ps1`'s
  visible-window filter miss, silently dropping every control in that window.
- Plus: DWM insets learned after a drag, DOM/UIA racing whole-manifest writes,
  DOM retention not following a live replay-length change, history archive
  twins, aggregate render state going terminal early, a clipboard failure
  reported as a failed save, and the updater's "no published versions" state.

Suggested order: the purge/identity pair first (destructive), then the two clock
changes as one unit gated on `check:sync`, then the independent single-file ones.

### 2. Blocked on the owner

The Chrome extension card shows a red **오류** in `chrome://extensions`. Nobody
has read the error text — it needs a human at that screen. Extension 0.1.6 added
an armed badge and `picker.failed` diagnostics; suspect those first.

### 3. Designed, measured, not built

Per-app control ledger plus a pool of 2-3 tracker processes with a quarantine
for slow offenders. The measurements that shape it are in GOAL.md: threads give
1.26x, separate processes 1.43x, and a PowerShell tracker costs 92-123 MB, so
1:1 per app needs a lighter host before it is affordable.

## How this project works

**GOAL.md is the living spec.** Designs and decisions go there with the
measurements behind them, in prose, before or with the code. It is long on
purpose. Read the sections numbered `#110` and `#111` before touching the
context lane — they are the record of a week-long bug and four withdrawn
claims.

**Measure before you claim.** This is enforced, repeatedly and unhappily. Today
alone: "25% of samples collide" was an artifact of counting across coordinate
spaces; a p90 was reported from a median that hid the failure; a jitter that
could not invert passed its own red test; three agents' plausible findings were
refuted on verification. If a number cannot be produced, say the claim is
unverified.

**A red test that passes proves nothing.** Every regression check here was made
to fail against the old code before it was trusted.

**The record shows what was observed, never what was inferred.** Interpolation
between samples shipped for one release candidate, measured worse, and was
removed by the owner's explicit decision. Do not reintroduce it for observed
data. Authored positions (a human placing a manual box) are a different
category and may interpolate — that distinction is live work.

**Comments explain WHY, with the evidence.** Match the density of what is
already there. A comment that says what the next line does is noise; one that
records the measurement that forced the line is the point.

**Replies to the owner are in Korean**, lead with the outcome, and always give
the absolute installer path.

## Safety rules — absolute, and one of these was violated once

- **NEVER synthesize keyboard or mouse input.** Never press Ctrl+Alt+C: the
  installed CapturePack owns that accelerator and an agent once fired a real
  capture on the owner's desktop.
- **NEVER run, stop, kill, modify or reconfigure the INSTALLED app** at
  `C:/Users/recue/AppData/Local/Programs/capturepack`, and **never write to**
  `%APPDATA%/CapturePack` (reading it and its logs is fine and often necessary).
- **`C:/Users/recue/OneDrive/Desktop/CapturePack` is READ ONLY.** It is the
  owner's captures.
- **Do not push, tag, or open PRs** without explicit instruction.
- `Add-Type -MemberDefinition` is forbidden in the PowerShell hosts — it invokes
  the C# compiler per call. Use `-TypeDefinition`.
- Headed testing only as a detached run with your own `--user-data-dir`,
  `--output-dir`, `--no-global-shortcut`, `--no-login-item`. Kill only PIDs you
  have verified as yours. `chrome-bridge-check` spawns Electron twice and will
  fight the installed app for the `capturepack-dom-<user>` named pipe — its
  EADDRINUSE here is environmental.

## The numbers worth not re-deriving

All measured on this machine, today. GOAL.md carries the reasoning.

- Window observation during a drag: **~10 ms** (100/s), event-driven off
  `SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE)`. The OS itself publishes
  `GetWindowRect` changes every 4 ms.
- Host cost: **1.11% of a core**, via delta sampling — 0.111 ms per delta
  against 0.451 ms for a full dump. Before deltas it was 13.5% and the governor
  was demoting the lane mid-capture.
- Box against window in the annotated replay: **p10 −10 ms / p50 −5 ms /
  p90 +1 ms**. Every clock leg is at or under 1 ms.
- Recorder: **14.8 fps against a 15 fps target** on one display, 13.9 on the
  other (one 762 ms stall, not a shortfall). 15 is not the ceiling; whether 30
  works is a question about the encoder alone and is unmeasured.
- UIA: a full desktop walk is 1580 ms; refreshing **held element references** is
  227 ms (7x), and 17.6 vs 482.8 ms for one window (27x). `FindAllBuildCache` is
  a **4.3-4.5x net loss** — the tree walk is 96% of the cost, not the property
  fetch. Held references rot: 4.4% dead within 50 s with no input at all.
  One provider (Docker Desktop) answers for ten elements in ~2050 ms.

## The one thing to get right

The owner tests every build on their own desktop and reports what breaks, in
Korean, often mid-turn while you are still working. They are right more often
than the code is. When they say something is off, it is off — the job is to find
the measurement that shows it, not to explain why it should be fine.
