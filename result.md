# CapturePack #138 / PR #156 continuation result

## Outcome

- Canonical issue: https://github.com/r2cuerdame/capturepack/issues/138
- Existing PR: https://github.com/r2cuerdame/capturepack/pull/156
- Existing PR head branch: `herder/job_01M1W2VBD2VG6GDEJZJTJSF1QV`
- Continuation base: `3ad11fd`
- Production-slice implementation commit: `2b5982a`
- Issue and PR context, comments, reviews, and current code were re-read before
  editing. PR #156 had no review or issue/PR comments requiring a different
  implementation direction.
- Merge, release, deployment, publication, and field-acceptance claims: not
  attempted.

This continuation implements bounded real frame acquisition, hardware sample
production, and native ring retention inside the opt-in native helper. The
shipping replay route and normal screenshot/still-image route are unchanged.

## Exact files changed

- `core/scripts/dxgi-replay-ring.cpp`
  - Added bounded `--capture-ms 100..30000` continuous Desktop Duplication.
  - Copies each acquired desktop frame to an owned D3D11 BGRA surface before
    `ReleaseFrame`; captured pixels are never mapped to CPU memory.
  - Uses the D3D11 video processor for rotation/scaling and BGRA-to-NV12 on a
    GPU NV12 surface.
  - Selects only an adapter-LUID-scoped, hardware, D3D11-aware, asynchronous
    Media Foundation H.264 MFT and feeds it DXGI surface samples.
  - Produces real timestamped H.264 access units with sequence configuration,
    clean-point metadata, and pipeline generation into the bounded native ring.
  - Adds bounded device/access-loss reinitialization and terminal fail-closed
    behavior for unsupported conversion, encoder faults, malformed output,
    unexpected stream-format changes, identity mismatch, and retry exhaustion.
  - Adds a fixed 256-byte `CPNRUN01` evidence packet while preserving the
    original fixed 256-byte `CPNRCP01` capability packet.
  - Adds nine deterministic native self-tests covering timestamp mapping,
    duplicate/regressing timestamps, rotation/topology geometry, byte/time/unit
    retention bounds, keyframe/configuration-safe cuts, encoder transitions,
    and device-loss retry/generation boundaries.
- `core/src/main/dxgiReplayRing.ts`
  - Added strict parsing and validation for `CPNRUN01`, including stage flags,
    unavailable reasons, counters, QPC/100 ns timing, encoded samples,
    keyframes, codec configuration, and bounded ring evidence.
- `core/scripts/dxgi-replay-ring-check.ts`
  - Added deterministic run-summary contract fixtures for successful hardware
    output, configuration-byte accounting, early capability failure, encoder
    failure, impossible completion evidence, and malformed packets.
- `core/scripts/dxgi-replay-ring-check.mjs`
  - Requires every named native self-test marker in exact order, plus the final
    aggregate success marker.
- `core/scripts/dxgi-replay-ring-field-check.ts`
  - Changed the managed-field harness from capability probing to bounded real
    capture and strict completed-run evidence, with configurable capture time.
- `docs/DXGI_REPLAY_RING.md`
  - Documented the implemented GPU pipeline, wire contracts, retention and
    reinitialization semantics, fail-closed boundaries, and the unrun managed
    Windows acceptance gate.
- `result.md`
  - Records this continuation's build identity, checks, constraints, and next
    slice.

No application capture IPC, Chromium/MediaRecorder replay routing, GDI fallback
routing, normal screenshot/still-image implementation, package registration,
or installer path was changed in this continuation.

## Verification

Build identity: implementation commit `2b5982a`, Windows x64, Node `v24.13.1`,
MSVC Build Tools 2022.

- PASS — `npm ci`; 367 packages installed from the lockfile.
- PASS — `npm run typecheck`.
- PASS — `node scripts/build-dxgi-timing-helper.mjs --required`; the native
  helper compiled with the required Windows SDK and Media Foundation libraries.
- PASS — `dist\\scripts\\dxgi-replay-ring.exe --self-test`; all nine named
  native tests passed.
- PASS — `npm run build -- --require-dxgi-helper`; required native helper and
  application build completed.
- PASS — `npm run check:dxgi-replay-ring`; nine native markers and 19 strict
  TypeScript capability/run contract checks passed.
- PASS — `npm run check:docs`; 10 passed, 0 failed.
- PASS — `npm run qa:checks -- --artifacts
  C:\\Users\\recue\\AppData\\Local\\Temp\\capturepack-qa-pr156-continuation`;
  typecheck plus all 87 discovered checks passed (88 executed gate steps) in
  84.80 s. The run includes recorder ring/retention, replay clocks, native
  fallback contracts, and image/still-flow checks. Evidence:
  - `C:\\Users\\recue\\AppData\\Local\\Temp\\capturepack-qa-pr156-continuation\\qa-report.json`
  - `C:\\Users\\recue\\AppData\\Local\\Temp\\capturepack-qa-pr156-continuation\\qa-junit.xml`

The first sandboxed build/check attempts were blocked when `esbuild` tried to
access a managed ancestor path. Re-running the same repository commands with
the approved build permission passed; this was an execution-sandbox boundary,
not a product test failure.

## Performance-relevant observations

- The new helper's hot path has no CPU pixel readback or software encoder
  fallback. Per submitted frame it performs one GPU desktop copy and one D3D11
  video-processor blit into an encoder-compatible NV12 allocation.
- Work is explicitly bounded: 15 fps pacing, 20 ms frame-acquire and GPU-wait
  intervals, four NV12 allocator surfaces, 64 MiB / 512 access units / 30 s ring
  caps, three reinitialization attempts, a 100 ms initial input wait, and a
  500 ms drain limit.
- No CPU, GPU, private-bytes, working-set, latency, long-soak, or before/after
  measurement is reported. Those values require the managed Windows field
  environment and representative displays/codecs.

## DevHotel and remaining gates

- DevHotel managed Windows room/session: unavailable for this job. No room was
  created, there is no room/session ID to record, and there was no room to
  sleep.
- NOT RUN — `npm run qa:dxgi-replay-ring`; the real capture/encode field harness
  is reserved for a DevHotel managed Windows room. No local desktop, browser,
  Orca, or physical-device substitute was used.
- NOT VERIFIED — real host acquisition/NV12/H.264 summary evidence, multi-monitor
  rotation/topology transitions, device-loss recovery on hardware, and sustained
  performance.
- NOT IMPLEMENTED — MP4 mux/export/decode and application runtime selection of
  the native ring.
- NOT VERIFIED — managed application-flow screenshot/still-image acceptance;
  repository contracts passed and the shipping still path was not edited.

These remain blocking gates before enabling, merging for release, deploying,
or publishing the native backend. Issue #138 remains open and PR #156 must not
be treated as field accepted.

## Next bounded slice

1. Add a codec-configuration/keyframe-safe ring snapshot protocol and MP4 mux/
   recent-history export with decode validation.
2. Integrate an explicit guarded runtime switch whose capability and health
   checks fail closed without introducing a CPU conversion or software-encode
   fallback.
3. When a DevHotel managed Windows room exists, run the capture harness and the
   application acceptance/performance matrix, record the room/session and build
   identity, then sleep the room.
