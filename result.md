# CapturePack #138 / PR #156 finalization result

## Outcome

- Canonical issue: https://github.com/r2cuerdame/capturepack/issues/138
- Existing PR: https://github.com/r2cuerdame/capturepack/pull/156
- Reused head branch: `herder/job_01M1W2VBD2VG6GDEJZJTJSF1QV`
- Reviewed PR head: `16d65477edc5e09da30e0c191913516928868adf`
- Review-fix commit: `06687f72ef02bc0ed370bad7c6e03783d48be704`
- Merge, release, deployment, and publication were not attempted because the
  issue acceptance is not yet satisfied.

The native ring now exports immutable, keyframe/configuration-safe recent
history as fragmented MP4 through Windows Media Foundation. A persistent,
bounded service reports fixed binary READY/SNAPSHOT/FATAL evidence. The
application selects it only behind the exact `--dxgi-native-replay` switch and
only after capability plus end-to-end health gates succeed. Shipping covers
native warm-up, releases its MediaRecorder encoders/rings after native READY,
and restarts after any later native failure. The focused window retains only
its live presentation sink for the existing Lane-S context clock. A failure
after takeover can leave the triggering capture screenshot-only while that
fresh buffer warms. The normal screenshot/still path is unchanged.

Final review also found that Desktop Duplication can expose the hardware cursor
as a separate plane and the helper does not yet composite it. Native READY now
requires explicit cursor-composition evidence, so the current candidate fails
closed with `cursor-composition-unavailable` and the shipping recorder remains
selected. This prevents a cursor regression but intentionally means the native
path is not field-acceptable yet.

## Implementation

- `core/scripts/dxgi-replay-ring.cpp`
  - Deep-copies one-generation snapshots starting at an IDR with validated
    matching SPS/PPS, rejects codec changes, rebases PTS to zero, and preserves
    monotonic sample duration within byte/time/unit ring bounds.
  - Adds the bounded `CPNSRV01` service protocol and continuous capture/export
    mode.
  - Muxes retained hardware H.264 with the Media Foundation fragmented MP4 sink
    and sink writer while explicitly disabling converters.
  - Requires bounded `ftyp`/`moov`/`moof`/non-empty `mdat` structure and a full
    Media Foundation Source Reader decode with matching dimensions, sample
    count, monotonic timestamps, and duration before reporting success.
  - Sizes byte/unit bounds from the supported 1–60 second retention, waits for
    a clean point without fataling at short retention, exports immutable
    snapshots on a worker while acquisition continues, and retries bounded
    transient access/device loss after READY.
  - Requires B-frame disablement and the MFT's declared buffer alignment.
  - Preserves fail-closed `E_ACCESSDENIED` handling and requires an explicit
    GPU cursor-composition health bit before READY.
- `core/src/main/dxgiReplayRuntime.ts`
  - Strictly parses the 256-byte service evidence, owns bounded service and temp
    file lifecycles, validates AVC configuration/fragment/sample timelines, and
    demotes immediately on any contradiction or failure.
  - Rejects native retention above the 60-second memory envelope before spawn
    and rejects warmed snapshots that silently truncate requested history.
- `core/src/main/capture.ts`
  - Adds per-display, background-warmed native candidates behind the explicit
    switch. Shipping covers warm-up, then suspends its encoders/rings only after
    native READY; any native failure restarts shipping. The focused one-pixel
    presentation sink remains alive for Lane-S context ticks, passive displays
    release their full shipping stream, and still capture code is untouched.
- `core/scripts/dxgi-replay-runtime-check.ts` and
  `core/scripts/dxgi-replay-integration-check.mjs`
  - Cover switch default-off/fallback, helper missing, locked-session and
    encoder failure, READY health flags, packet/request bounds, one in-flight
    snapshot, cleanup, malformed MP4 rejection, duration/sample validation,
    lifecycle demotion, shipping fallback, and still-path separation.
- `core/scripts/build-dxgi-timing-helper.mjs`
  - Links the embedded Windows exporter through `mfreadwrite.lib`; no external
    ffmpeg executable or runtime dependency was added.
- `core/package.json`, `core/scripts/qa-gate.mjs`, and the QA/handoff docs
  register the new deterministic gate and its updated discovered-check count.

## Verification

Build identity: review-fix commit `06687f72ef02bc0ed370bad7c6e03783d48be704`,
Windows x64, Node `v24.13.1`,
MSVC Build Tools 2022.

- PASS — `npm ci`; 367 packages installed from the lockfile.
- PASS — `npm run typecheck`.
- PASS — `node scripts/build-dxgi-timing-helper.mjs --required`; both required
  native helpers compiled.
- PASS — `dist\\scripts\\dxgi-replay-ring.exe --self-test`; all 12 named
  native markers passed, including snapshot/config boundaries, timestamp and
  duration rebasing, MP4 structure, protocol bounds, retention sizing, bounded
  storage, device-loss boundaries, and cursor fail-closed behavior.
- PASS — `npm run check:dxgi-replay-runtime`; 25 runtime checks plus 10
  application-integration checks passed.
- PASS — `npm run check:dxgi-replay-ring`; 19 strict native capability/run
  contract checks passed in addition to the helper self-test.
- PASS — `npm run check:native-replay-fallback`; 35 passed, 0 failed.
- PASS — `npm run check:replay-health`; 50 passed, 0 failed.
- PASS — `npm run check:recorder-ring`; 117 passed, 0 failed.
- PASS — `npm run check:recorder-retention`; all ring/retention suites passed.
- PASS — `npm run check:fmp4-sample-timeline`; 9 passed, 0 failed.
- PASS — `npm run check:docs`; 10 passed, 0 failed.
- PASS — `npm run qa:checks -- --artifacts
  C:\\Users\\recue\\AppData\\Local\\Temp\\capturepack-qa-pr156-post-review-job_01M200ZJD1BCEVZWJJNX4F0KF0`;
  typecheck plus all 88 discovered checks passed (89 executed steps) in
  75.27 s. Evidence:
  - `C:\\Users\\recue\\AppData\\Local\\Temp\\capturepack-qa-pr156-post-review-job_01M200ZJD1BCEVZWJJNX4F0KF0\\qa-report.json`
  - `C:\\Users\\recue\\AppData\\Local\\Temp\\capturepack-qa-pr156-post-review-job_01M200ZJD1BCEVZWJJNX4F0KF0\\qa-junit.xml`
- PASS — `npm run build -- --require-dxgi-helper`; the application and both
  required native helpers built successfully.
- PASS — `git diff --check` (line-ending conversion warnings only).

## Remaining blockers and managed acceptance

- DevHotel managed Windows room/session was unavailable for this job. No room
  was created, there is no room/session ID to record, and there was no room to
  sleep. No local browser, Orca, or other UI fallback was used.
- The 2026-09-08 physical Windows observation remains valid: LogonUI was active
  and Desktop Duplication returned `E_ACCESSDENIED`. This implementation keeps
  that result fail-closed and selects shipping replay.
- GPU cursor composition must be implemented and proven before the native
  helper may set `cursor-composited`; until then native READY is deliberately
  unavailable and the shipping path remains active.
- After that code exists, an unlocked DevHotel managed Windows run of the exact
  committed build must prove real DXGI acquisition -> D3D11 NV12 -> hardware
  H.264 -> Media Foundation MP4 mux -> Media Foundation decode -> guarded app
  selection/export, playable duration/timestamps, visible cursor, and unchanged
  still/context flows. Record the room/session and sleep it after the run.
- The same managed workload must record before/after application CPU, GPU,
  working set, and capture/export latency. The current repository contains no
  measurement proving materially lower total overhead than shipping-only.

PR #156 remains a draft and must not be merged, released, deployed, or treated
as field-accepted until these blockers and the managed acceptance pass.
