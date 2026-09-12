# Long-run resource investigation (#240)

The isolated fix expires accessibility control history for windows absent from
Lane S's tracked set for more than the replay retention. Previously each HWND's
last tree survived forever, and the two-second prune copied every old tree's
elements again. Window churn therefore increased both retained objects and
main-process maintenance work for the lifetime of the app.

This is a reproduced defect, not an attribution of the reported Windows-wide
slowdown. Issue #240 remains open. No installed CapturePack was restarted or
profiled; no desktop soak, release, deployment, or system configuration change
was performed.

## Audit and scope

Baseline: `af30c383299eae470b55dfb2ab04b90054fa26c4`, branch
`fix/240-longrun-system-slowdown`. GitHub main matched the baseline when checked.

- Shipping replay is MediaRecorder with a GDI/JPEG emergency fallback. The DXGI
  timing helper is one-shot: `FrameLease` releases successful acquisitions;
  COM owners release the desktop resource, staging texture and event query.
  One RGB result is 27,648 bytes and the parent watchdog is at most one second.
- GDI source/DC, bitmap, Graphics and stream cleanup is present, including
  failure paths in recent commits `78e0507`, `36d9fac`, and `89b4c8c`.
  Production fallback is at most 1280 pixels on the long edge at 5 FPS;
  parser storage is bounded at 16,777,272 bytes. Delivery keeps one in-flight
  JPEG and the newest pending JPEG; presentation metadata is capped at 32.
- The NVIDIA hardware pipeline is in draft PR #156 for #138, head `cc2e161`;
  it is absent from this baseline. Its RAII/COM cleanup, four input samples,
  encoder shutdown and native ring byte/time/count limits were inspected.
  Recorded RTX 5080 evidence is only three seconds (two frames acquired, one
  encoded, 135,018 ring bytes), not a long-run app test. The A/B harness's
  synthetic checks do not prove the missing managed full-app acceptance.
- Renderer frame/bitmap close paths, bounded ingest queues, recorder identity
  checks and timer/listener cleanup were inspected. A separate WebM fallback
  defect was reproduced: a stalled `Blob.arrayBuffer()` holds the lifecycle
  queue while live recorders accumulate chunks. That is outside this fix.
- #180's whole-file synchronous PNG reads still exist on pack reopen/readback.
  They are not invoked by this isolated always-on control-history workload.
  Synchronous log writes also remain; no measured I/O amplification is claimed.
- The watchdog HWND strike map is another pre-existing lifetime concern. This
  change does not claim to bound all process state or all capture backends.

## Regression and measured evidence

The worker runs the actual `ControlLane`, injecting synthetic tracker messages
and a clock. One unchanged visible window survives throughout; another
64-control window is replaced every ten simulated seconds. Retention is 30
seconds and pruning runs every two simulated seconds. No helper, renderer,
encoder, desktop capture, or forced GC is started. Every step asserts the window
bound; checkpoints also verify both visible trees retain their actual controls.

On 2026-09-12, sequential before/after Node v24.13.1 Windows runs produced:

| Measurement | Baseline RED | Fixed GREEN |
|---|---:|---:|
| Retained windows at 15 / 30 / 60 / 120 simulated minutes | 92 / 182 / 362 / 722 | 6 / 6 / 6 / 6 |
| Retained controls at 120 simulated minutes | 46,208 | 384 |
| Windows after all become hidden and retention expires | 722 | 0 |
| Churn prune entry visits | 1,302,120 | 19,406 |
| Churn control-record copies | 82,598,400 | 458,880 |
| Accumulated churn prune wall time (microseconds, observed) | 1,436,242.2 | 15,465.6 |
| Sampled process CPU total, last (milliseconds) | 1,843.75 | 93.75 |
| Sampled CPU maximum (% of one core) | 44.3138 | 3.0491 |
| Private bytes, min–max | 19,984,384–201,318,400 | 20,013,056–32,559,104 |
| Working set bytes, min–max | 55,357,440–232,058,880 | 55,365,632–67,719,168 |
| Handles, min–max | 178–178 | 178–178 |
| Threads, min–max | 12–12 | 12–12 |
| OS samples | 11 | 10 |

The six-window/384-control bound is deterministic for this workload. Process
resource envelopes and timings are observations, not universal memory or CPU
limits. Prune work totals exclude the final retirement prune. The worker has a
60-second wall watchdog and a 256 MiB V8 old-space limit; simulated two hours
is not a two-hour real-time soak. GPU/VRAM and I/O counters were unavailable in
this restricted sampling environment and are recorded as null/unavailable.
Capture surfaces, captured frames, ring bytes and encoder sessions are zero
because this isolated worker creates none; they are not a measurement of a
running capture app. Live capture telemetry integration remains field work.

Machine-readable reports include source/bundle hashes, exact checkpoints,
Node memory/CPU readings and raw OS samples:

- [Baseline report](evidence/issue240/before-report.json) and [OS samples](evidence/issue240/before-process.ndjson).
- [Fixed report](evidence/issue240/after-report.json) and [OS samples](evidence/issue240/after-process.ndjson).

The focused regression additionally churns 100 windows with 1,000 controls each:
101 retained trees become four (100,001 controls become 3,001), then zero after
expiry. It checks inclusive cutoffs, unchanged visible trees, returning windows,
late helper output, copied observation immutability and `resourceStats()`.

## Reproduce safely

From `core`, after `npm ci`, choose new output directories:

```powershell
# Expected exit 1: same assertions against the exact pre-fix Git source.
npm run qa:longrun-resources -- --baseline --artifacts=out/issue240/before-new
# Expected exit 0: current source. Neither command starts CapturePack.
npm run qa:longrun-resources -- --artifacts=out/issue240/after-new
npm run check:longrun-resources
npm run check:controls
```

`--baseline` loads the named Git blob without checking out or editing files.
The reports preserve failed baseline measurements before reporting the assertion
failure. `--quick` is two simulated minutes without the OS sampler and is
registered in both the complete and video QA profiles.

## Validation and remaining field gate

Required native build passed. Final RDC `qa:checks` passed **89/89 steps in
66.36 seconds**, after correcting the documentation count contract for the new
check. Typecheck, native parser/helper
compilation, recorder retention/ring, context, lifecycle and performance-related
checks passed. `CAPTUREPACK_DESKTOP_INTERACTIVE=0` explicitly skipped live GDI
frames. An initial sandbox QA run failed on temporary-directory permissions and
loopback access; the RDC run supersedes it. Independent review found no blocker
in this isolated fix.

No DevHotel provider was available in this session. Keep #240 open and this
change draft until managed Windows/app validation supplies incident attribution,
real capture resource counters and the issue's two-hour installed-app soak.

If installed-app evidence becomes necessary, the proposed **unexecuted** next
step is a 120-second read-only observation of an already-running installation:

1. Record its version/backend/settings and explicitly identify main, renderer,
   GPU and native-helper PIDs. Do not launch or restart it.
2. Run `scripts/sample-process-resources.ps1 -TargetProcessId <explicit PID list>
   -DurationSeconds 120 -IntervalMs 1000`, redirecting to a new local NDJSON file.
   The sampler accepts explicit PIDs, rejects PID reuse, and never stops targets.
3. Observe 30 seconds idle, then 60 seconds of ordinary window open/close/focus
   activity, then 30 seconds idle. Stop activity immediately if responsiveness
   worsens. Do not run a game or stress workload for this first check.
4. Compare per-PID private/working set, CPU, handles, threads, I/O and available
   GPU engine/VRAM counters. Encoder session counts are null unless a separate
   vendor source supplies them; video-encode engine activity is retained.

Capture off/on and exit/recovery comparisons, full replay counters, display
churn, multi-monitor/game cases and the two-hour soak are later managed tests,
not actions authorized or executed by this procedure.
