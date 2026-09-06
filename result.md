# PM_AUTO_REFILL_V1 result

## Outcome

- Canonical issue: https://github.com/r2cuerdame/capturepack/issues/138
- Issue state at start and immediately before PR creation: OPEN
- GitHub dependency summary: 0 blocked-by issues, 0 blocking issues, 0 sub-issues
- Related work: no linked or search-matching PR; open draft PR #155 is the
  independent #139 corpus lane and has no material file overlap
- Base updated to `origin/main` at `8e21c14`
- Implementation commit: `a318337`
- Draft PR: https://github.com/r2cuerdame/capturepack/pull/156
- Merge/deploy/publish: not attempted

This job implements a safe partial foundation for #138. It does not close the
issue and does not change the shipping replay backend.

## Exact changes

- Added `core/scripts/dxgi-replay-ring.cpp`:
  - fixed-byte/fixed-time encoded access-unit ring
  - keyframe-safe retention/export cuts
  - deterministic native `--self-test`, including byte pressure, time pressure,
    GOP cuts, undecodable prefixes, monotonic timestamps, and conflicting
    output selectors
  - exact-output DXGI selection; D3D11 video device on the same adapter;
    Desktop Duplication availability; GPU BGRA-input/NV12-output capability;
    adapter-LUID-scoped hardware H.264 MFT enumeration; D3D11-aware encoder and
    `IMFDXGIDeviceManager` handshake
  - explicit unavailable reasons and balanced COM/MF/MFT cleanup
- Added `core/src/main/dxgiReplayRing.ts`:
  - strict 256-byte versioned packet parser
  - fixed stdout/stderr and process-time bounds
  - exact display arguments and Windows `LONG` validation
  - explicit unsupported/missing/timeout/process/malformed outcomes
- Added deterministic and field harnesses:
  - `check:dxgi-replay-ring`
  - `qa:dxgi-replay-ring`
- Extended the existing MSVC/vswhere build path to produce
  `dist/scripts/dxgi-replay-ring.exe`; required distribution builds fail if it
  cannot be built. Existing `dist/scripts/**` unpacking includes it.
- Registered the deterministic check in the full gate and video profile.
- Added `docs/DXGI_REPLAY_RING.md` and updated the documentation index and gate
  counts.
- The existing Chromium/MediaRecorder replay flow, IPC capture integration,
  screenshot path, and fallback selection were not changed.

## Verification

Build identity: commit `a318337`, Windows x64, Node `v24.13.1`, MSVC Build
Tools 2022 discovered through vswhere.

- PASS — `npm run typecheck`
- PASS — `npm run build -- --require-dxgi-helper`
- PASS — `npm run check:dxgi-replay-ring`; native self-test OK, 14 parser and
  wrapper contract checks passed
- PASS — `npm run check:dxgi-timing-reference`; 20 passed
- PASS — `npm run check:recorder-ring`; 117 passed, 0 failed
- PASS — `npm run check:recorder-retention`; recorder ring plus focused
  retention/stop/ingest suites passed, 0 failed
- PASS — `npm run check:source-latency-calibration`; 66 passed
- PASS — `npm run check:replay-pixel-clock`; 19 passed
- PASS — `npm run check:replay-clock-map`; 20 passed
- PASS — `npm run check:docs`; 10 passed
- PASS — `npm run qa:checks -- --artifacts
  C:\Users\recue\AppData\Local\Temp\capturepack-qa-issue-138`; typecheck and
  all 87 discovered checks passed in 83.29 s. JSON and JUnit reports are in that
  artifact directory.

## DevHotel and remaining blockers

- DevHotel Windows room/session: unavailable; no room or session could be
  created, so there is no room ID to record and no room to sleep.
- NOT RUN — `npm run qa:dxgi-replay-ring`; policy forbids substituting an
  ad-hoc local UI/browser/Orca acceptance route.
- NOT MEASURED — current MediaRecorder CPU/GPU/private-bytes/working-set/latency
  baseline and native before/after comparison.
- NOT IMPLEMENTED/VERIFIED — continuous DXGI frame acquisition, actual NV12
  surface conversion, encoded H.264 samples, timestamped rotation, MP4 recent
  history export/decode, runtime fallback/disable selection, and screenshot
  non-regression in a managed Windows acceptance room.

These are required before #138 can be closed or a native backend can be enabled,
deployed, or published. No external approval, credentials, SSH trust, security
decision, physical-device gate, self-approval, or automatic retry was attempted.
