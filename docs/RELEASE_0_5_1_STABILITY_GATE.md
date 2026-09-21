# Release 0.5.1 stability gate audit (#245)

This document records the formal stability gate evaluation and acceptance audit for CapturePack **0.5.1**, satisfying the release criteria established in Issue [#245](https://github.com/r2cuerdame/capturepack/issues/245).

## Release context and decision

- **Release line:** CapturePack stable `0.5.1` (tagged `v0.5.1`).
- **Triage baseline:** `v0.5.0` (`3508f9d`), where long-run field evidence identified two critical stability blockers (#240, #243).
- **Scope decision (2026-09-14):** Formalized 0.5.1 as a **narrow stability release** focused on:
  1. Resolving the P0 long-run whole-system slowdown ([#240](https://github.com/r2cuerdame/capturepack/issues/240)).
  2. Resolving the P0 recorder renderer `STATUS_BREAKPOINT` crashes ([#243](https://github.com/r2cuerdame/capturepack/issues/243)) and establishing a viable supported exit path in the product.
  3. Proving the native DXGI/D3D11/H.264 replay pipeline ([#138](https://github.com/r2cuerdame/capturepack/issues/138)) functions in the field.
  4. Explicitly deferring broad P1/P2 backlog items that do not block narrow stability.
  5. Applying small, low-risk stability fixes (telemetry isolation, zero-audit dependency updates, bounded Windows resource sampling).
- **Release review verdict:** Fable's independent release review verdict `DEFER_DXGI_AND_SHIP` approved stable `0.5.1`. The default shipping MediaRecorder behavior is preserved as default, while the native DXGI pipeline is established behind an explicit opt-in switch (`--dxgi-native-replay`).

---

## P0 Hard blockers evaluation

### 1. Issue #240: Long-run whole-system slowdown

- **Symptom:** After extended execution (40+ hours), the entire Windows host experienced progressive slowdown, which resolved immediately upon terminating CapturePack.
- **Root causes identified & fixed:**
  1. **Retired UIA control history:** PR [#241](https://github.com/r2cuerdame/capturepack/pull/241) (`74f96f7`) bounded control history for closed windows, preventing unbounded retention of retired HWNDs.
  2. **WebM dual-slot ring conversion stall:** PR [#246](https://github.com/r2cuerdame/capturepack/pull/246) / PR [#250](https://github.com/r2cuerdame/capturepack/pull/250) (`d0f9b4e`) decoupled Blob conversion from the slot lifecycle queue. Stopping and replacing slots now completes immediately in the lifecycle queue, converting immutable stopped-session Blobs asynchronously outside it. In a 60-second accelerated fixture, active-session bytes were bounded to 86,920 bytes (down from 4,920,200 bytes in the unpatched queue stall).
  3. **Windows resource sampler race:** PR [#246](https://github.com/r2cuerdame/capturepack/pull/246) (`68c573a`) implemented an exact-PID 3-sample readiness handshake, preventing premature exit and ensuring steady-state sampling.
- **Measured resource bounds (120-minute simulated soak):**
  - **HWNDs / controls:** Steady at 6 HWNDs / 384 controls (0/0 retained upon window retirement; unpatched baseline retained 722 HWNDs / 46,208 controls).
  - **Memory:** Private bytes peaked at 31,907,840 bytes (baseline: 200,273,920 bytes); working set peaked at 63,516,672 bytes (baseline: 227,606,528 bytes).
  - **CPU:** Single-core CPU peaked at 2.60% (baseline: 39.62%).
  - **OS handles / threads:** Constant at 168 handles and 12 threads.
- **Status:** Resolved and closed by Technical Chief in backlog hygiene.

### 2. Issue #243: Recorder renderer STATUS_BREAKPOINT crashes

- **Symptom:** Installed v0.5.0 sessions exhibited renderer crashes with exit code `0x80000003` (`STATUS_BREAKPOINT`) on active displays after ~38h and ~40h of continuous capture.
- **Root cause:** Chromium MediaRecorder MP4 muxer (`OutputPositionTracker::WriteSpan`) increments a 32-bit unsigned position counter (`uint32_t current_pos_`). Emitting more than 2^32 bytes (4 GiB cumulative output across the entire lifetime of a single MediaRecorder instance) triggers a checked-add overflow breakpoint. This is cumulative byte emission across time, not retained memory or JS heap exhaustion.
- **Product-level exit path (Native DXGI replay pipeline):**
  - Built under [#138](https://github.com/r2cuerdame/capturepack/issues/138) and stabilized across PR [#250](https://github.com/r2cuerdame/capturepack/pull/250) and PR [#252](https://github.com/r2cuerdame/capturepack/pull/252).
  - Operates completely outside Chromium's MediaRecorder and MP4 muxer:
    `DXGI Desktop Duplication -> D3D11 BGRA surface -> D3D11 Video Processor NV12 -> Media Foundation Hardware H.264 MFT -> Bounded native access-unit ring`
  - Eliminates the 4 GiB cumulative muxer limitation by using a bounded native access-unit ring with strict keyframe-aligned retention.
- **Critical pointer-plane field resolution (PR #252):**
  - In earlier field trials, Desktop Duplication reported `LastMouseUpdateTime == 0` when software cursors were present or the pointer was on another monitor. The helper stalled waiting for a separate pointer plane, causing native initialization to time out.
  - Commit `76edf64` / PR [#252](https://github.com/r2cuerdame/capturepack/pull/252) resolved this: an unreported plane is treated as an already-complete desktop image, allowing immediate frame submission.
- **Measured field performance ([evidence/issue138/before-after.json](evidence/issue138/before-after.json)):**
  - Tested on Windows 11 medium-integrity (`S-1-16-8192`) launch (primary display 3840x2160 scaled to 1920x1080 @ 15 fps, 30 s retention, NVIDIA H.264 Encoder MFT).
  - Reached native `READY` 2.3 s after launch; shipping recorders suspended.
  - Produced a 29,520 ms / 442-sample / 30-keyframe snapshot (14.97 achieved fps, max PTS gap 113 ms), validated by production fMP4 and ffmpeg decoders.
  - Lower system overhead: mean CPU **32.6% vs 37.7%** (p95: 38.0% vs 47.5%), working set peak **1,121 MB vs 1,139 MB**, GPU total engine **4.19% vs 4.59%**, video encode **2.37% vs 2.83%**.
  - Injected post-save helper failure verified automatic, clean failback to shipping MediaRecorder.
- **Status:** Resolved and closed by Technical Chief in backlog hygiene.

---

## Scope audit: P1 and P2 disposition

Pursuant to the 2026-09-14 Scope Decision, all 34 P1 and 28 P2 backlog items listed in the triage were formally audited and deferred beyond stable 0.5.1:

1. **P1 Backlog (34 items) — Explicitly deferred to v0.5.2+:**
   - Cadence and format: [#239](https://github.com/r2cuerdame/capturepack/issues/239), [#232](https://github.com/r2cuerdame/capturepack/issues/232), [#222](https://github.com/r2cuerdame/capturepack/issues/222), [#218](https://github.com/r2cuerdame/capturepack/issues/218), [#217](https://github.com/r2cuerdame/capturepack/issues/217), [#214](https://github.com/r2cuerdame/capturepack/issues/214), [#213](https://github.com/r2cuerdame/capturepack/issues/213), [#208](https://github.com/r2cuerdame/capturepack/issues/208), [#204](https://github.com/r2cuerdame/capturepack/issues/204), [#194](https://github.com/r2cuerdame/capturepack/issues/194), [#179](https://github.com/r2cuerdame/capturepack/issues/179).
   - Omitted optional properties: [#207](https://github.com/r2cuerdame/capturepack/issues/207), [#202](https://github.com/r2cuerdame/capturepack/issues/202), [#201](https://github.com/r2cuerdame/capturepack/issues/201), [#200](https://github.com/r2cuerdame/capturepack/issues/200), [#199](https://github.com/r2cuerdame/capturepack/issues/199), [#198](https://github.com/r2cuerdame/capturepack/issues/198), [#192](https://github.com/r2cuerdame/capturepack/issues/192), [#187](https://github.com/r2cuerdame/capturepack/issues/187), [#183](https://github.com/r2cuerdame/capturepack/issues/183).
   - Lifecycle, atomicity, and recovery: [#223](https://github.com/r2cuerdame/capturepack/issues/223), [#216](https://github.com/r2cuerdame/capturepack/issues/216), [#196](https://github.com/r2cuerdame/capturepack/issues/196), [#193](https://github.com/r2cuerdame/capturepack/issues/193), [#191](https://github.com/r2cuerdame/capturepack/issues/191), [#177](https://github.com/r2cuerdame/capturepack/issues/177), [#175](https://github.com/r2cuerdame/capturepack/issues/175).
   - Plugins and actions: [#170](https://github.com/r2cuerdame/capturepack/issues/170), [#169](https://github.com/r2cuerdame/capturepack/issues/169), [#165](https://github.com/r2cuerdame/capturepack/issues/165), [#160](https://github.com/r2cuerdame/capturepack/issues/160), [#159](https://github.com/r2cuerdame/capturepack/issues/159).
   - MCP protocol bounds: [#195](https://github.com/r2cuerdame/capturepack/issues/195), [#188](https://github.com/r2cuerdame/capturepack/issues/188).
2. **P2 Backlog (28 items) — Follow-up backlog:**
   - All 28 items ([#237](https://github.com/r2cuerdame/capturepack/issues/237), [#236](https://github.com/r2cuerdame/capturepack/issues/236), [#235](https://github.com/r2cuerdame/capturepack/issues/235), [#234](https://github.com/r2cuerdame/capturepack/issues/234), [#231](https://github.com/r2cuerdame/capturepack/issues/231), [#230](https://github.com/r2cuerdame/capturepack/issues/230), [#229](https://github.com/r2cuerdame/capturepack/issues/229), [#226](https://github.com/r2cuerdame/capturepack/issues/226), [#225](https://github.com/r2cuerdame/capturepack/issues/225), [#220](https://github.com/r2cuerdame/capturepack/issues/220), [#219](https://github.com/r2cuerdame/capturepack/issues/219), [#215](https://github.com/r2cuerdame/capturepack/issues/215), [#212](https://github.com/r2cuerdame/capturepack/issues/212), [#211](https://github.com/r2cuerdame/capturepack/issues/211), [#210](https://github.com/r2cuerdame/capturepack/issues/210), [#209](https://github.com/r2cuerdame/capturepack/issues/209), [#206](https://github.com/r2cuerdame/capturepack/issues/206), [#205](https://github.com/r2cuerdame/capturepack/issues/205), [#203](https://github.com/r2cuerdame/capturepack/issues/203), [#197](https://github.com/r2cuerdame/capturepack/issues/197), [#190](https://github.com/r2cuerdame/capturepack/issues/190), [#189](https://github.com/r2cuerdame/capturepack/issues/189), [#186](https://github.com/r2cuerdame/capturepack/issues/186), [#185](https://github.com/r2cuerdame/capturepack/issues/185), [#184](https://github.com/r2cuerdame/capturepack/issues/184), [#182](https://github.com/r2cuerdame/capturepack/issues/182), [#181](https://github.com/r2cuerdame/capturepack/issues/181), [#178](https://github.com/r2cuerdame/capturepack/issues/178)) are non-blocking cosmetic, edge-case, or secondary display refinements.

---

## Local automated verification evidence

Environment: Windows x64, Node `v24.13.1`, MSVC Build Tools 2022.

| Verification suite | Command | Result | Scope / assertions |
|---|---|---|---|
| **DXGI native helpers compilation** | `npm run build -- --require-dxgi-helper` | **PASS** | Compiles `dxgi-timing-reference.exe` and `dxgi-replay-ring.exe` |
| **Typecheck** | `npm run typecheck` | **PASS** | Zero TypeScript compiler diagnostics (`tsc --noEmit`) |
| **DXGI replay ring contracts** | `npm run check:dxgi-replay-ring` | **PASS** | 37 native self-tests + 20 parser/protocol checks |
| **DXGI replay runtime contracts** | `npm run check:dxgi-replay-runtime` | **PASS** | 47 runtime checks + 24 ownership behavior + 12 app integration |
| **Native fallback contracts** | `npm run check:native-replay-fallback` | **PASS** | 34 checks (routing, frame protocol, races, circuit breaker) |
| **Recorder retention & lifecycle** | `npm run check:recorder-retention` | **PASS** | 123 checks (maintenance, stop deadlines, bounded Blob ingest) |
| **UIA control lifecycle** | `npm run check:controls` | **PASS** | Control tracking, memory bounds, bounded restart, OFF/ON |
| **Pack readback** | `npm run check:pack-readback` | **PASS** | Zero-leak PNG probe (24 bytes) and complete element recovery |
| **DXGI A/B thresholds** | `npm run check:dxgi-replay-ab` | **PASS** | 16 deterministic checks (thresholds, cleanup, failure modes) |
| **fMP4 sample timeline** | `npm run check:fmp4-sample-timeline` | **PASS** | 10 sample timeline decoding contracts |
| **Windows replay field fixture** | `npm run check:windows-replay-field-fixture` | **PASS** | 34 checks (clock strictness, display ordering, duration verdicts) |
| **Documentation contract** | `npm run check:docs` | **PASS** | 16 checks (54 documents, zero broken links/anchors, script sync) |
| **Open pack specification** | `npm run check:spec` | **PASS** | 21 checks on minimal reference pack against SPEC 0.8.0 |
| **Pack validator regressions** | `npm run check:validator` | **PASS** | 43 checks across all validator assertions |
| **Site & telemetry contract** | `npm run check:site` | **PASS** | 75 checks (9 landing locales, telemetry allowlist, demo contract) |

---

## Verifier guide for 품질검수실 (수아)

To independently audit and verify CapturePack stable `0.5.1` against this gate:

### 1. Verification of default shipping behavior
1. Run `npm run typecheck` and `npm run build` in `core/`.
2. Launch the application: `npm run dev` in `core/`.
3. Verify that continuous capture initializes using the shipping MediaRecorder pipeline.
4. Perform a 30-second replay capture and verify that the saved pack opens in the editor and contains valid replay media.
5. Verify in Task Manager or performance monitors that memory and CPU remain bounded in steady state.

### 2. Verification of native DXGI opt-in pipeline (#138 / #243 exit path)
1. Ensure the DXGI helper is compiled: `npm run build -- --require-dxgi-helper` in `core/`.
2. Launch with the explicit native switch: `npm run dev -- --dxgi-native-replay` in `core/`.
3. Inspect `main.log` or console output for:
   `DXGI native replay READY (<width>x<height> @ 15fps, <Hardware Encoder MFT>)`
4. Confirm that shipping encoders are suspended after native READY.
5. Trigger a capture and confirm snapshot generation:
   - Output `.mp4` video in the pack directory.
   - Validation passes without errors.
6. Terminate the helper process or trigger display change to confirm automatic, transparent fallback to the shipping MediaRecorder without data loss.

### 3. Review of archived field evidence
- Review [evidence/issue138/before-after.json](evidence/issue138/before-after.json) for hardware MFT encoder benchmarks, CPU/GPU comparisons, and post-save fallback logs.
- Review [evidence/issue138/native-trial-summary.json](evidence/issue138/native-trial-summary.json) and [evidence/issue138/shipping-trial-summary.json](evidence/issue138/shipping-trial-summary.json).

---

## Stability gate sign-off verdict

All hard blockers for Issue #245 are resolved:
- **#240:** Resolved by PR #241 and PR #246 (merged via #250).
- **#243:** Addressed with root-cause identification and a proven product exit path in the native DXGI pipeline (PR #250, PR #252).
- **Scope disposition:** All 34 P1s and 28 P2s formally audited and deferred to v0.5.2+ pursuant to the narrow stability release mandate.
- **Automated test suite:** 100% PASS locally on Windows 11 MSVC environment.
- **Verdict:** **PASS** — Ready for independent review and verification by 품질검수실.
