# Release 0.5.1 stability gate audit (#245)

This document records the formal stability gate audit for CapturePack **0.5.1** pursuant to Issue [#245](https://github.com/r2cuerdame/capturepack/issues/245) and incorporates the findings and rejection reasons from the independent Quality Audit (품질검수실 검수 회차 1, 2026-09-21T02:29:41.844Z).

---

## Executive summary and gate verdict

- **Release line:** CapturePack `0.5.1` (tagged `v0.5.1`, commit `06bba52b`, published 2026-09-15T16:37Z).
- **Stability gate verdict:** **NOT SATISFIED / BLOCKED as a #240/#243 resolution gate**.
- **Shipped product scope:** CapturePack 0.5.1 shipped as an interim maintenance release pursuant to Fable's independent release review decision `DEFER_DXGI_AND_SHIP`. It delivered five targeted maintenance and stability fixes (WebM conversion queue decoupling, display-media callback safety, packaged test telemetry isolation, zero-audit runtime parser dependencies, and bounded Windows performance sampling).
- **P0 Blockers disposition:**
  - **#240 (Long-run whole-system slowdown):** **OPEN / REOPENED**. Bounded UIA control retention (PR [#241](https://github.com/r2cuerdame/capturepack/pull/241)) and WebM rotation queue decoupling (PR [#250](https://github.com/r2cuerdame/capturepack/pull/250)) landed in 0.5.1. However, the mandatory installed-build 2-hour steady-state soak on Windows with CPU/RAM/handles/threads bounds and off/on/exit recovery was not executed on the shipped 0.5.1 binary (an accelerated 120-simulated-minute synthetic harness was substituted). Issue #240 remains P0 and has been reopened on GitHub for milestone **v0.5.2**.
  - **#243 (Recorder renderer STATUS_BREAKPOINT crashes):** **OPEN / REOPENED**. The default continuous capture pipeline in 0.5.1 remains Chromium MediaRecorder, where the 32-bit `OutputPositionTracker::WriteSpan` cumulative overflow (>4 GiB cumulative output lifetime) is unchanged. Deployed v0.5.1 predates PR [#252](https://github.com/r2cuerdame/capturepack/pull/252) (`6f8ad2a` / pointer-plane fix `76edf64`), so the native DXGI helper in shipped 0.5.1 lacks the pointer-plane fix and fails to reach `READY` when Desktop Duplication reports `LastMouseUpdateTime == 0`. Native DXGI is opt-in only (`--dxgi-native-replay`), leaving #243 unmitigated on the default shipping path. Field crashes continue to recur in installed logs. Issue #243 remains P0 and has been reopened on GitHub for milestone **v0.5.2**.
- **Scope disposition:** All 34 P1 backlog items and 28 P2 backlog items remain formally deferred to v0.5.2+. Draft PR [#246](https://github.com/r2cuerdame/capturepack/pull/246) was closed as superseded by PR #250.
- **GitHub release notes:** Updated on 2026-09-21 via GitHub CLI to accurately state the shipped 0.5.1 maintenance scope, clarify that native DXGI is opt-in only, and document that #240 and #243 remain under active tracking for v0.5.2.

---

## Release context and history

1. **Baseline and triage:** CapturePack `v0.5.0` (`3508f9d`) exhibited two critical stability issues in extended field sessions:
   - [#240](https://github.com/r2cuerdame/capturepack/issues/240): Long-run system-wide degradation resolving only upon terminating CapturePack.
   - [#243](https://github.com/r2cuerdame/capturepack/issues/243): Recorder renderer process terminating with exit code `0x80000003` (`STATUS_BREAKPOINT`) after ~38–40h of continuous capture.
2. **Release 0.5.1 publication (2026-09-15):** PR [#250](https://github.com/r2cuerdame/capturepack/pull/250) merged commit `06bba52b` and published stable `v0.5.1`. Fable's independent release review verdict was `DEFER_DXGI_AND_SHIP`:
   - Native DXGI replay remained experimental and behind an explicit `--dxgi-native-replay` flag.
   - The default 0.5.0 MediaRecorder pipeline was preserved as the shipping default.
   - The release notes on GitHub were initially blank at publish time.
3. **Premature issue closures (2026-09-19):** Issues #240 and #243 were closed under "backlog hygiene" comments citing merged code. However, neither issue's completion criteria had been satisfied on the shipping path:
   - #240 lacked installed 2-hour soak verification on the release head.
   - #243 lacked elimination or a viable supported exit path on the default shipping capture path.
4. **Independent Quality Audit rejection (2026-09-21):** 품질검수실 (수아) audited PR [#254](https://github.com/r2cuerdame/capturepack/pull/254) and the deployed `0.5.1` installer (`CapturePack-Setup-0.5.1.exe`, SHA256 `7f87a5e4...22ce`). The audit issued a formal **REJECT** because:
   - Deployed 0.5.1 predates PR #252; its helper binary only runs 36 self-tests (missing `cursor-unreported-plane-submits-desktop-image`) and stalls in field use.
   - #243 is not eliminated from the shipping owner path.
   - Installed 2h steady-state acceptance on Windows was never run.
   - Gate documentation misrepresented 0.5.1 as resolving #240/#243.
5. **Corrective audit action (Issue #245):** In accordance with the Quality Audit minimum fix conditions:
   - This gate document is corrected to state that 0.5.1 does not resolve #240 or #243.
   - Issues #240 and #243 are reopened on GitHub and assigned to milestone v0.5.2.
   - Release notes for GitHub release `v0.5.1` were populated with the true shipped scope.
   - Draft PR #246 was closed as superseded.

---

## Detailed evaluation of P0 blockers

### 1. Issue #240: Long-run whole-system slowdown

- **Symptom:** After 40+ hours of continuous execution, the host Windows system slowed down progressively, recovering immediately when CapturePack terminated.
- **Root causes and code changes present in 0.5.1:**
  1. *Retired UIA control history:* PR [#241](https://github.com/r2cuerdame/capturepack/pull/241) (`74f96f7`) bounds control history for closed windows, preventing retention of retired HWNDs.
  2. *WebM rotation queue decoupling:* PR [#250](https://github.com/r2cuerdame/capturepack/pull/250) (`d0f9b4e`) decoupled Blob conversion from the slot lifecycle queue. Stopping and replacing slots completes immediately, converting immutable stopped Blobs outside the queue.
  3. *Windows performance sampler readiness:* PR [#250](https://github.com/r2cuerdame/capturepack/pull/250) (`68c573a`) implemented an exact-PID 3-sample readiness handshake in the measurement watchdog.
- **Why #240 is NOT closed for 0.5.1:**
  - Issue #240 criterion 7 and completion criteria require: *"실제 설치 빌드에서 2h soak PASS / 종료 전후 자원 변화와 steady-state 상한 기록"* (2-hour soak PASS on the actual installed build, with resource bounds and exit recovery documented).
  - The previous gate document cited a synthetic 120-simulated-minute fixture (`scripts/longrun-resources.mjs`), which simulates UIA events and WebM rotation in an accelerated loop. This is regression test coverage, not the required physical 2-hour soak on an installed binary.
  - Furthermore, #240 is inextricably linked to continuous capture stability (#243). Because #243 remains active on the default path, long-run capture remains susceptible to recorder crashes and recovery churn.
- **Current status:** **REOPENED (P0)** on GitHub. Retargeted for milestone **v0.5.2**.

---

### 2. Issue #243: Recorder renderer STATUS_BREAKPOINT crashes

- **Symptom:** In continuous capture sessions on installed v0.5.0, the recorder renderer process crashes with exit code `-2147483645` (`0x80000003`, `STATUS_BREAKPOINT`) after ~38h and ~40h. Field logs on the local QA host recorded five STATUS_BREAKPOINT crashes between 2026-09-19 and 2026-09-20.
- **Root cause:** Chromium's MediaRecorder MP4 muxer (`OutputPositionTracker::WriteSpan`) checked-adds chunk lengths into a 32-bit unsigned position counter (`uint32_t current_pos_`). Emitting more than 2^32 bytes (4 GiB cumulative output across the entire lifetime of a single MediaRecorder instance) triggers an intentional checked-add overflow breakpoint. This is cumulative byte emission across time, not instantaneous memory leakage.
- **Status in shipped 0.5.1:**
  1. *Default shipping path unchanged:* The default capture pipeline in CapturePack 0.5.1 remains Chromium MediaRecorder emitting MP4 chunks. The single MediaRecorder instance persists across continuous capture, so the 4 GiB cumulative threshold remains fully reachable and unfixed.
  2. *Native DXGI exit path was not shipped as default:* The native replay pipeline (Issue [#138](https://github.com/r2cuerdame/capturepack/issues/138)) was not promoted to default in 0.5.1 due to Fable's `DEFER_DXGI_AND_SHIP` review verdict. It is accessible only when explicitly passing `--dxgi-native-replay`.
  3. *Shipped 0.5.1 native helper is non-functional in field:* Deployed `v0.5.1` was built from commit `06bba52b` (2026-09-15). PR [#252](https://github.com/r2cuerdame/capturepack/pull/252) (`6f8ad2a`, pointer-plane fix `76edf64`) was merged on 2026-09-19, four days *after* 0.5.1 was published.
     - As verified by 품질검수실, running `--self-test` on the deployed helper (`resources/app.asar.unpacked/dist/scripts/dxgi-replay-ring.exe`) runs only 36 tests and lacks `cursor-unreported-plane-submits-desktop-image`.
     - In field conditions where Desktop Duplication reports `LastMouseUpdateTime == 0` (such as when cursors are software-rendered or on a secondary display), the shipped helper stalls waiting for a pointer plane and times out before reaching `READY`.
     - Thus, the native exit path does not function in the shipped 0.5.1 build.
- **Current status:** **REOPENED (P0)** on GitHub. Retargeted for milestone **v0.5.2**.

---

## Scope audit: P1 and P2 disposition

Pursuant to the narrow scope established for maintenance work, all 34 P1 and 28 P2 backlog items remain deferred beyond stable 0.5.1:

1. **P1 Backlog (34 items) — Formally deferred to v0.5.2+:**
   - Cadence and format: [#239](https://github.com/r2cuerdame/capturepack/issues/239), [#232](https://github.com/r2cuerdame/capturepack/issues/232), [#222](https://github.com/r2cuerdame/capturepack/issues/222), [#218](https://github.com/r2cuerdame/capturepack/issues/218), [#217](https://github.com/r2cuerdame/capturepack/issues/217), [#214](https://github.com/r2cuerdame/capturepack/issues/214), [#213](https://github.com/r2cuerdame/capturepack/issues/213), [#208](https://github.com/r2cuerdame/capturepack/issues/208), [#204](https://github.com/r2cuerdame/capturepack/issues/204), [#194](https://github.com/r2cuerdame/capturepack/issues/194), [#179](https://github.com/r2cuerdame/capturepack/issues/179).
   - Omitted optional properties: [#207](https://github.com/r2cuerdame/capturepack/issues/207), [#202](https://github.com/r2cuerdame/capturepack/issues/202), [#201](https://github.com/r2cuerdame/capturepack/issues/201), [#200](https://github.com/r2cuerdame/capturepack/issues/200), [#199](https://github.com/r2cuerdame/capturepack/issues/199), [#198](https://github.com/r2cuerdame/capturepack/issues/198), [#192](https://github.com/r2cuerdame/capturepack/issues/192), [#187](https://github.com/r2cuerdame/capturepack/issues/187), [#183](https://github.com/r2cuerdame/capturepack/issues/183).
   - Lifecycle, atomicity, and recovery: [#223](https://github.com/r2cuerdame/capturepack/issues/223), [#216](https://github.com/r2cuerdame/capturepack/issues/216), [#196](https://github.com/r2cuerdame/capturepack/issues/196), [#193](https://github.com/r2cuerdame/capturepack/issues/193), [#191](https://github.com/r2cuerdame/capturepack/issues/191), [#177](https://github.com/r2cuerdame/capturepack/issues/177), [#175](https://github.com/r2cuerdame/capturepack/issues/175).
   - Plugins and actions: [#170](https://github.com/r2cuerdame/capturepack/issues/170), [#169](https://github.com/r2cuerdame/capturepack/issues/169), [#165](https://github.com/r2cuerdame/capturepack/issues/165), [#160](https://github.com/r2cuerdame/capturepack/issues/160), [#159](https://github.com/r2cuerdame/capturepack/issues/159).
   - MCP protocol bounds: [#195](https://github.com/r2cuerdame/capturepack/issues/195), [#188](https://github.com/r2cuerdame/capturepack/issues/188).
2. **P2 Backlog (28 items) — Formally deferred:**
   - [#237](https://github.com/r2cuerdame/capturepack/issues/237), [#236](https://github.com/r2cuerdame/capturepack/issues/236), [#235](https://github.com/r2cuerdame/capturepack/issues/235), [#234](https://github.com/r2cuerdame/capturepack/issues/234), [#231](https://github.com/r2cuerdame/capturepack/issues/231), [#230](https://github.com/r2cuerdame/capturepack/issues/230), [#229](https://github.com/r2cuerdame/capturepack/issues/229), [#226](https://github.com/r2cuerdame/capturepack/issues/226), [#225](https://github.com/r2cuerdame/capturepack/issues/225), [#220](https://github.com/r2cuerdame/capturepack/issues/220), [#219](https://github.com/r2cuerdame/capturepack/issues/219), [#215](https://github.com/r2cuerdame/capturepack/issues/215), [#212](https://github.com/r2cuerdame/capturepack/issues/212), [#211](https://github.com/r2cuerdame/capturepack/issues/211), [#210](https://github.com/r2cuerdame/capturepack/issues/210), [#209](https://github.com/r2cuerdame/capturepack/issues/209), [#206](https://github.com/r2cuerdame/capturepack/issues/206), [#205](https://github.com/r2cuerdame/capturepack/issues/205), [#203](https://github.com/r2cuerdame/capturepack/issues/203), [#197](https://github.com/r2cuerdame/capturepack/issues/197), [#190](https://github.com/r2cuerdame/capturepack/issues/190), [#189](https://github.com/r2cuerdame/capturepack/issues/189), [#186](https://github.com/r2cuerdame/capturepack/issues/186), [#185](https://github.com/r2cuerdame/capturepack/issues/185), [#184](https://github.com/r2cuerdame/capturepack/issues/184), [#182](https://github.com/r2cuerdame/capturepack/issues/182), [#181](https://github.com/r2cuerdame/capturepack/issues/181), [#178](https://github.com/r2cuerdame/capturepack/issues/178).
3. **Draft PR housekeeping:**
   - PR [#246](https://github.com/r2cuerdame/capturepack/pull/246) was closed as superseded on 2026-09-21; its commits were merged into `main` via PR #250.

---

## Actual shipped scope in CapturePack 0.5.1

As recorded in [CHANGELOG.md](../CHANGELOG.md) and published in the GitHub release notes:

1. **WebM replay rotation queue isolation:** WebM replay rotation no longer awaits a stalled Blob conversion, ensuring one conversion cannot block later recorder epochs or retention.
2. **Display-media request safety:** Display-media requests complete exactly once even when the callback throws, and missing, empty, or invalid exact-display images fail closed before reaching the editor.
3. **Packaged QA telemetry isolation:** Packaged QA telemetry is isolated as `environment=test` with separate daily identity state, preserving production telemetry integrity.
4. **Parser dependencies update:** Runtime and packaging parser dependencies were updated to eliminate all audit findings.
5. **Windows performance sampler readiness:** Windows release evidence sampling reuses bounded process/GPU queries with exact-PID readiness gating.

---

## Automated verification evidence

The repository test suite executes and passes 100% on Windows x64 (MSVC 2022, Node v24.13.1):

| Suite | Command | Result | Summary |
|---|---|---|---|
| **DXGI native helpers compilation** | `npm run build -- --require-dxgi-helper` | **PASS** | Compiles `dxgi-timing-reference.exe` and `dxgi-replay-ring.exe` |
| **Typecheck** | `npm run typecheck` | **PASS** | Zero TypeScript compiler diagnostics (`tsc --noEmit`) |
| **Documentation contract** | `npm run check:docs` | **PASS** | 55 documents verified; zero broken relative links or anchors |
| **Site & telemetry contract** | `npm run check:site` | **PASS** | 75 checks (locales, PurplePulse allowlist, release metadata) |
| **Recorder retention & lifecycle** | `npm run check:recorder-retention` | **PASS** | 123 checks (maintenance, stop deadlines, bounded Blob ingest) |
| **UIA control lifecycle** | `npm run check:controls` | **PASS** | Control tracking, memory bounds, bounded restart, OFF/ON |
| **Native fallback contracts** | `npm run check:native-replay-fallback` | **PASS** | 34 checks (routing, frame protocol, races, circuit breaker) |
| **DXGI replay ring contracts** | `npm run check:dxgi-replay-ring` | **PASS** | 37 native self-tests + 20 parser/protocol checks |
| **DXGI replay runtime contracts** | `npm run check:dxgi-replay-runtime` | **PASS** | 47 runtime + 24 ownership behavior + 12 app integration checks |
| **Pack readback** | `npm run check:pack-readback` | **PASS** | Header probe and element recovery |
| **DXGI A/B thresholds** | `npm run check:dxgi-replay-ab` | **PASS** | 16 deterministic checks |
| **fMP4 sample timeline** | `npm run check:fmp4-sample-timeline` | **PASS** | 10 sample timeline decoding contracts |
| **Open pack specification** | `npm run check:spec` | **PASS** | 21 checks on minimal reference pack against SPEC 0.8.0 |
| **Pack validator regressions** | `npm run check:validator` | **PASS** | 43 checks across all validator assertions |

---

## Path to resolution and criteria for v0.5.2 stability gate

To satisfy the stability gate and achieve an independent **PASS** from 품질검수실 in **v0.5.2**:

1. **Eliminate #243 on the shipping owner path:**
   - Either promote the native DXGI pipeline (including PR [#252](https://github.com/r2cuerdame/capturepack/pull/252) pointer-plane fix and field verification) to the default capture path so continuous capture is no longer owned by Chromium's MediaRecorder MP4 muxer;
   - OR implement a supported periodic recorder replacement / muxer boundary that resets the cumulative 4 GiB `current_pos_` tracker without frame gaps or format violations.
2. **Execute exact-release-head installed 2-hour soak for #240:**
   - Install the exact release candidate binary on Windows 11.
   - Run 2 continuous hours on an active, interactive, unlocked desktop.
   - Measure and document that CPU, working set, private bytes, OS handles, and thread counts remain strictly bounded at steady state.
   - Execute and verify capture OFF/ON cycling and clean exit resource recovery.
3. **Verify field telemetry and logs:**
   - Confirm zero recurrence of `STATUS_BREAKPOINT` (-2147483645) crashes across multi-day continuous sessions.
