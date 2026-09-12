# PR #156 stabilization evidence — 2026-09-12

## Scope and preservation

This continuation used the existing `fix/pr156-nvenc-bpicture` worktree, starting at `fb982677c96d6d365ea06bd1d1a2d430b09873dc`. GitHub is canonical. The merge base with main is `44231a22667965113b509f54e2898eb73ca79975`, including merged #241 and #242. #240 and #243 remain open; #244 remains draft diagnostics only. Chromium/Electron source-build work remains **HOLD**.

At entry there were no tracked dirty files. The sole untracked file was the continuation request, preserved in `.review-archive/stabilization-final-20260912/resume-request.txt`. All 11 original files in `.review-archive/pr156-dirty-audit-20260912/files/` still match their original SHA-256 manifest. The original patch and field artifacts were not reset, discarded, or overwritten.

The prior corrections are committed in `39870fe` through `fb98267`. They retain strict requested-context-clock field acceptance, independent pixel-clock calibration, native READY/teardown ownership, H.264 zero-reordering verification, native exposure anchors, and absolute-boundary mux timing (including empty single-frame seek indexes). Geometry-derived matching remains diagnostic; it cannot move acceptance picks to a better matching context timestamp. The application structural MP4 validator is not represented as a decoder. No periodic restart, forced GC, acceptance threshold increase, or arbitrary codec/quality downgrade is introduced.

## Preserved non-field verification

All checks below passed on the source at `fb982677c96d6d365ea06bd1d1a2d430b09873dc`. The continuation evidence commit changes documentation/evidence only. Its exact SHA, hosted CI, and independent exact-head review are recorded on PR #156 when available. No prior CI result is attributed to the new evidence head.

| Gate | Result |
| --- | --- |
| Focused field clock RED/GREEN | Archived geometry-adjusting runner fails the 700 ms wrong-time regression (exit 1); current runner passes (exit 0), 4 assertions |
| Focused native mux RED/GREEN | Isolated per-duration-rounding mutant fails `mux-absolute-boundaries-no-cumulative-rounding`; unchanged current native source passes all self-tests |
| `npm run build -- --require-dxgi-helper` | PASS, required native helpers built |
| `npm run typecheck` | PASS |
| `npm run check:dxgi-replay-ring` | PASS, native self-tests plus 20 parser/capability checks |
| `npm run check:dxgi-replay-runtime` | PASS, runtime and application integration |
| `npm run check:dxgi-replay-ab` | PASS, 16 deterministic checks; no field capture |
| `npm run check:fmp4-sample-timeline` | PASS, 10 checks |
| `npm run check:windows-replay-field-fixture` | PASS, 29 fixture checks plus strict clock regression |
| Standalone ownership / lifecycle scripts | PASS, 22 / 9 behavior checks |
| `npm run qa:video` | PASS, 62/62, 50.84 seconds |
| `npm run check:docs` | PASS, 10 checks |
| `git diff --check` | PASS |

The non-field runs set `CAPTUREPACK_DESKTOP_INTERACTIVE=0`; native compilation/self-tests and deterministic runtime fixtures are not live desktop acceptance or a two-hour soak. Fresh logs, executable RED/GREEN drivers, QA JSON/JUnit and token proof remain in `.review-archive/stabilization-final-20260912/`. The versioned [validation record](evidence/pr156-stabilization/validation.json) records results and evidence hashes. No historical field run is used to establish the above results.

## Explorer medium-token launch proved; field acceptance failed

The worktree was externally moved from the user profile archive to the current archive path. This was not a code change. Source remained exactly `fb982677c96d6d365ea06bd1d1a2d430b09873dc`; no product source, installed CapturePack, security setting, policy, credential, service, firewall, or registry permission was changed. No prohibited orchestration was used. No usable DevHotel tool was exposed.

The previous HIGH-token proof remains historical diagnostic evidence. On this continuation, existing Explorer PID 7240 / HWND 36706892 exposed its interactive `Document.Application.ShellExecute` COM broker. A one-shot hidden PowerShell launcher (70196) and waiting Node child (22064) were independently inspected from external HIGH PowerShell PID 66592 at 13:29:06Z: **both MEDIUM S-1-16-8192**, with Explorer -> launcher -> Node ancestry. See [probe proof](evidence/pr156-stabilization/broker/external-token-proof.json).

The same broker then launched the field launcher (24420) and actual waiting A/B Node (37816). External inspector 70696 directly queried both process tokens before releasing the capture gate at 13:32:22Z: **both MEDIUM S-1-16-8192**. See [field token proof](evidence/pr156-stabilization/field/external-token-proof.json). An earlier waiting-only attempt was stopped by a local PowerShell array-wrapper counting error; its tokens were also medium, and it launched no A/B. Those local records remain archived.

The gated Node imported the unchanged package script behind `qa:dxgi-replay-ab` with exactly `--trials=3 --fps=15 --duration-seconds=30 --target=primary`. [Invocation](evidence/pr156-stabilization/field/invocation.json) and [launcher](evidence/pr156-stabilization/field/launcher.ps1) are versioned. The existing build was used without rebuilding: main/helper modification times match the preserved 12:23:34?12:23:42 build interval; [binary hashes](evidence/pr156-stabilization/field/existing-build.json) match all six reports. These hashes were recorded on resumption, not claimed as a preexisting binary-hash manifest. The report's `source_dirty=true` reflects documentation and local prompt files; `git diff HEAD -- core` was empty. Every run used new app-data, packs and fixture directories. The installed v0.5.0 executable was not launched (the source package still identifies itself as version 0.5.0).

## Exact-source field result

The 13:32:22?13:37:53Z run completed all three paired trials in the required order: shipping/native, native/shipping, shipping/native. **A/B FAIL; all six reports BROKEN.** Every run saved and fully decoded a replay, but none establishes the required complete acceptance chain. See [A/B report](evidence/pr156-stabilization/field/ab-report.json) and [per-trial summary](evidence/pr156-stabilization/field/summary.json).

- Shipping: strict persisted past object picking fails in all three runs. In shipping-1, only 2/15 point picks pass and three independent motion-clock samples place replay pixels about 167?169 ms behind context. Its startup PTS gap is 205.533 ms against the unchanged 200 ms bound; steady-state cadence passes. Shipping-2 passes media/cadence but again only 2/15 point picks. Direct DXGI-to-rVFC pixel calibration is ambiguous; a composed processor latency is not a proven same-frame source timestamp and must not be substituted or used to move requested acceptance picks.
- Native: trials 1 and 3 reach READY and shipping suspension, then fail the H.264 no-B/order contract before a qualifying native SNAPSHOT and return to shipping. Trial 2 does not establish native READY in the saved interval. Post-save helper failure/teardown plus fresh shipping fallback proof does not pass the required lifecycle gate. Saved fallback fMP4 decoding does not prove native export. The rejected native access unit is not preserved, so the existing log cannot distinguish a parser defect from a legitimate ordering violation; no speculative parser relaxation is justified.
- Resources: raw CPU/GPU/video-encode/working-set samples and capture/export latency are preserved. Native-requested trials observed shipping or mixed/unverified backends; their aggregate numbers are **not native performance acceptance**, regardless of individual numeric pass flags.
- Cleanup: each runner reported cleanup. An external PID-plus-creation-time inventory found **zero surviving owned processes**, cross-checking 140 observed identities and 290 raw sampled product rows. Stale parent-PID reuse initially included unrelated browser processes older than this run; those were excluded by creation time and were never terminated. See [independent cleanup](evidence/pr156-stabilization/field/independent-cleanup.json). The PowerShell wrapper's exit-code field is null; the authoritative field verdict is the emitted A/B FAIL report, not an inferred wrapper exit code.

All 16 previously hashed non-field files still matched and were reused, with readable copies under [non-field evidence](evidence/pr156-stabilization/non-field/results.json). No source change occurred and no local green non-field suite was rerun. Versioned field evidence contains reports, raw process samples, app logs, ffprobe/frame timestamps, full-decode frame hashes, token/build proof, and a [494-file SHA-256 manifest](evidence/pr156-stabilization/field/artifact-manifest.json) covering original local field artifacts. Captured image/video payloads remain in the same local archive; no prompt file is included in the commit.

## Remaining gates and issue scope

PR #156 remains **draft**. Valid field acceptance is **failed**, not blocked by medium launch anymore. Exact-head hosted CI and independent review cannot override these field failures. No merge, release, deployment or install is authorized by this evidence. Chromium/Electron source-build remains **HOLD**.

#243 remains open: the native path is still opt-in and the default shipping path still uses the long-lived Chromium MediaRecorder/muxer. This run does not prove product-level elimination of the historical STATUS_BREAKPOINT defect. #241's retired-UIA fix does not close that separate recorder issue.

#240 remains open. The shortest bounded integrated verification performed here is the six-run application A/B with post-run process cleanup. It fails prerequisites for broader integration. A two-hour installed-build soak, multi-display/display-churn bounds and product-level long-run reliability remain unproved; no installed-app run was started. Further product changes require causal RED/GREEN evidence and a new valid exact-source field result, followed by hosted CI and independent review. No fixed latency, periodic restart, forced GC, threshold relaxation, or codec/quality downgrade is introduced.
