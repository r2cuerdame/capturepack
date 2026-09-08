# CapturePack #138 / PR #156 finalization result

## Outcome

- Canonical issue: https://github.com/r2cuerdame/capturepack/issues/138
- Existing PR: https://github.com/r2cuerdame/capturepack/pull/156
- Reused head branch: `herder/job_01M1W2VBD2VG6GDEJZJTJSF1QV`
- Continuation base: `43d404dc8ab407938d27e880d8758eead2e9deb5`
- Verified implementation commit: `089ed8a`
- Merge, release, deployment, publication, and physical field acceptance were
  not attempted.

The native ring now exports immutable, keyframe/configuration-safe recent
history as fragmented MP4 through Windows Media Foundation. A persistent,
bounded service reports fixed binary READY/SNAPSHOT/FATAL evidence. The
application selects it only behind the exact `--dxgi-native-replay` switch and
only after capability plus end-to-end health gates succeed. Any unavailable,
locked-session, missing-helper, encoder, protocol, export, validation, timeout,
or process failure retains or returns to the existing shipping replay path.
The normal screenshot/still path is unchanged.

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
  - Preserves fail-closed `E_ACCESSDENIED` handling for locked/LogonUI sessions.
- `core/src/main/dxgiReplayRuntime.ts`
  - Strictly parses the 256-byte service evidence, owns bounded service and temp
    file lifecycles, validates AVC configuration/fragment/sample timelines, and
    demotes immediately on any contradiction or failure.
- `core/src/main/capture.ts`
  - Adds per-display, background-warmed native candidates behind the explicit
    switch. Shipping recorder windows remain live and all misses fall through
    to the unchanged replay request path. Health probes continue to exercise
    shipping replay; still capture code is untouched.
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

Build identity: implementation commit `089ed8a`, Windows x64, Node `v24.13.1`,
MSVC Build Tools 2022.

- PASS — `npm ci`; 367 packages installed from the lockfile.
- PASS — `npm run typecheck`.
- PASS — `node scripts/build-dxgi-timing-helper.mjs --required`; both required
  native helpers compiled.
- PASS — `dist\\scripts\\dxgi-replay-ring.exe --self-test`; all nine named
  native markers passed, including snapshot/config boundaries, timestamp and
  duration rebasing, MP4 structure, protocol bounds, and bounded storage.
- PASS — `npm run check:dxgi-replay-runtime`; 21 runtime checks plus 8
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
  C:\\Users\\recue\\AppData\\Local\\Temp\\capturepack-qa-pr156-final-pass`;
  typecheck plus all 88 discovered checks passed (89 executed steps) in
  78.09 s. Evidence:
  - `C:\\Users\\recue\\AppData\\Local\\Temp\\capturepack-qa-pr156-final-pass\\qa-report.json`
  - `C:\\Users\\recue\\AppData\\Local\\Temp\\capturepack-qa-pr156-final-pass\\qa-junit.xml`
- PASS — `npm run build -- --require-dxgi-helper`; the application and both
  required native helpers built successfully.
- PASS — `git diff --check` (line-ending conversion warnings only).

## DevHotel and the one remaining acceptance

- DevHotel managed Windows room/session was unavailable for this job. No room
  was created, there is no room/session ID to record, and there was no room to
  sleep. No local browser, Orca, or other UI fallback was used.
- The 2026-09-08 physical Windows observation remains valid: LogonUI was active
  and Desktop Duplication returned `E_ACCESSDENIED`. This implementation keeps
  that result fail-closed and selects shipping replay.
- The only remaining acceptance is an unlocked physical Windows run of the
  exact committed build proving real DXGI acquisition -> D3D11 NV12 -> hardware
  H.264 -> Media Foundation MP4 mux -> Media Foundation decode -> guarded app
  selection/export, including playable duration/timestamps and the unchanged
  still flow. Record the managed room/session if one is available, then sleep
  it after the run.

PR #156 remains a draft and must not be merged, released, deployed, or treated
as field-accepted until that single unlocked-Windows acceptance passes.
