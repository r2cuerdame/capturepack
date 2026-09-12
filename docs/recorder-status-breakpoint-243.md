# Recorder STATUS_BREAKPOINT investigation (#243)

Canonical scope: [#243](https://github.com/r2cuerdame/capturepack/issues/243),
with broader system slowdown tracked in [#240](https://github.com/r2cuerdame/capturepack/issues/240).
Baseline: `af30c383299eae470b55dfb2ab04b90054fa26c4`, installed CapturePack 0.5.0.
This change supplies diagnostics and a bounded harness, **not a shipped crash fix**.

## Concrete native evidence

Both supplied crash timestamps match minidump header timestamps to the second.
Both exceptions are `0x80000003` at `CapturePack.exe+0x3b28d0a` on
`CrRendererMain`. The installed executable and both dumps have matching CodeView
identity: `electron.exe.pdb`, GUID `4f16ff0d-8131-b7aa-4c4c-44205044422e`, age 1.

| UTC on September 12, 2026 | Dump | Prior uint32 | Incoming size | Sum / RAX |
| --- | --- | ---: | ---: | ---: |
| 03:31:12 | `869f4a52-528b-475f-8ef2-114a4f32bb33.dmp` | 4,294,935,597 | 153,170 | 4,295,088,767 |
| 05:03:24 | `8a1524c6-a99a-45a6-9836-99d4aa805286.dmp` | 4,294,898,286 | 168,199 | 4,295,066,485 |

Read-only disassembly at the matching executable revision:

```asm
+0x3b28ccf  mov (%rsi),%eax
+0x3b28cd1  add 0x8(%rdi),%rax
+0x3b28cd5  jb  +0x3b28d0a
+0x3b28cd7  mov %rax,%rcx
+0x3b28cda  shr $0x20,%rcx
+0x3b28cde  jne +0x3b28d0a
...
+0x3b28d0a  int3
+0x3b28d0b  ud2
```

The operands are present in captured memory at RSI and RDI+8. Both dumps have
RCX=1 and RAX equal to the computed sum: the checked conversion to uint32 fails
at 4 GiB. This establishes the same counter-overflow failure in both crashes.
It does **not** establish a retained 4 GiB heap or an out-of-memory crash.
No fatal/check/OOM annotation was found. No matching local PDB was available;
stack-address candidates were not symbolically unwound.

Electron [43.2.0 DEPS](https://github.com/electron/electron/blob/v43.2.0/DEPS)
pins Chromium `150.0.7871.129`. Its
[OutputPositionTracker header](https://github.com/chromium/chromium/blob/150.0.7871.129/media/muxers/output_position_tracker.h)
declares a uint32 cumulative position; its
[WriteSpan implementation](https://github.com/chromium/chromium/blob/150.0.7871.129/media/muxers/output_position_tracker.cc)
calls the output callback, then checks addition of the span size into that
position. This matches the disassembled callback/accumulation sequence and both
dump operands. Attribution to the MP4 tracker is strongly corroborated by source
and machine code, but is not a PDB-symbolized stack identification.

The MP4 muxer keeps this tracker across fragment flushes. CapturePack's healthy
maintenance path intentionally keeps the encoder running while parsed fragments
continue arriving. Pruning the JavaScript ring cannot reset the native cumulative
output position. The two renderer processes began September 10 at 16:34:24Z and
16:34:31Z, consistent with long-lived recorder processes. Logs do not supply each
encoder session's cumulative byte count, so no byte-for-byte log reconstruction
is claimed. Recovery after approximately 44/33 seconds resets the failed runtime;
it is not the correction. PR #241's retired-UIA-history fix is separate.

## Ownership audit and bounded test

- MP4: explicit ingest byte budget, one conversion per queue, bounded pending
  Blobs and stop batches; parser copies retained box views and prunes media.
  Old recorder handlers are detached after stop/assembly or deadline.
- Processor calibration: cloned track, one unread frame, 128 retained compact
  fingerprints; frames close in finally, clone stops, reader cancels/releases.
- Replay decoding: object URL revoked and video sink released in finally;
  metadata/seek listeners have cleanup/deadlines. This path is only on replay.
- WebM fallback: two timed slots with stop deadlines and handler/chunk cleanup.
  It is separate from the installed MP4 path.
- Main: four IPC listeners per recorder removed on window close; replay waiters
  release timeout/closed listeners; display rebuilds serialize; native delivery
  has one pending frame, one in flight and at most 32 presentation sequence IDs.
  No accumulating main-process owner explaining these crashes was established.
- Existing ring coverage includes 400 fragments (40 simulated seconds); existing
  retention checks cover individual races. Neither exercises native lifetime
  cumulative output crossing 4 GiB.

Run from `core`:

```powershell
npm run check:recorder-lifecycle-soak
```

The harness bundles the **actual capture renderer source** with test-only
accessors in memory. It drives MP4 install, Blob ingestion, maintenance, stop
flush, HOLD/resume, teardown, and the processor sampler. It uses real Blob and
ArrayBuffer objects, synthetic MP4 box structures (not decodable H.264), fake
MediaRecorder/processor sources and accelerated time. esbuild compiles once;
no CapturePack/Electron application, desktop capture or native helper is launched.
No GC, periodic restart, budget adjustment or crash suppression is used.

Coverage:

- 180,700 simulated seconds (50h11m40s), 500 in-window capture generations;
  180,700 ordinary Blob conversions, 600 explicit flush/HOLD boundaries.
- 300 healthy stretches of 600 seconds must preserve recorder identity across
  20 retention windows each; 6,000 complete ring rotations in total.
- 54,000 processor frames; every delivered frame closed, clone stopped and
  reader unlocked; the 128-sample cap and eight recorder-clock samples reached.
- 100 cancelled conversions complete after a replacement starts; retired ring
  bytes stay zero and late bytes cannot reach the replacement consumer.
- 30 additional script realms reinitialize the five bridge subscriptions and
  perform another 1,050 conversions, then tear down their recording owners.

Observed main-realm maxima: 30 fragments / 18,324 retained ring bytes, 692 ingest
bytes, one live recording encoder model, five bridge subscriptions and three
transient timers (including processor read/cleanup); teardown leaves zero owned
timers/recorder handlers and zero ring bytes. Small synthetic fragments prove
reference lifetime; existing retention checks exercise byte-budget pressure.

Limits: this is not an Electron process/window recreation or native encoder test.
It does not cover startup/readiness, cadence/health intervals, video-frame
callbacks, physical display churn, or IPC early-resume races. It cannot measure
Chromium allocator/Blob-service backlog, handles, threads, GPU memory, or driver
resource lifetime. Cancelled browser conversions are unabortable; indefinitely
unresolved conversions across unlimited generations are not proven bounded.
No claim that passing this test clears #240 or #243 is intended.

## Reproduce the native boundary without desktop capture

`core/test/fixtures/issue243/output-position-regression.cc` is a candidate
regression for the **Chromium source build**, not a test linked into this app.
It uses one reusable 1 MiB buffer and a callback that only counts bytes. 4,097
WriteSpan calls cross 4 GiB without retaining or encoding 4 GiB of media. A
pair of tests exercises the exact dump operands separately. All are expected to
fail fatally on the pinned uint32 implementation. They have **not been executed**
here because this worktree contains the prebuilt Electron dependency, not the
Chromium build and `media_unittests` target.

Shortest next procedure on an isolated source-build machine (DevHotel preferred):

1. Append the fixture to Chromium's existing
   `media/muxers/output_position_tracker_unittest.cc` at the pinned revision.
2. Build `media_unittests`; run each of `CrossFourGiBWithoutRetainingOutput`,
   `InstalledDumpOneOperands`, and `InstalledDumpTwoOperands` separately with
   `--gtest_filter=OutputPositionTrackerIssue243Test.<test-name>` and a 30-second
   execution deadline. A fatal CHECK terminates that test process, so a single
   wildcard invocation cannot collect all three RED results. Record the native
   CHECK and stack. No live capture is needed.
3. Correct lifetime output-position representation and audit its readers/writers
   and serialized MP4 offsets; rerun the regression tests and muxer tests.
   Preserve individual box-size checks. Changing the application's retention
   budget cannot correct this native arithmetic.
4. Consume a verified Electron build carrying that correction, then run hosted
   capture-e2e and a bounded synthetic renderer/encoder test. Do not infer that
   an arbitrary Electron upgrade includes the fix: upstream main still declared
   this field uint32 when inspected on September 12.

This repository cannot apply a genuine native counter correction to its prebuilt
Electron through TypeScript. A byte-triggered/periodic recorder restart, arbitrary
codec switch, or unverified dependency bump would be a workaround, and none is
included. The dependency-side regression/build is the remaining blocker.

## Read-only dump inspection and local validation

```powershell
node scripts/recorder-crash-inspect.mjs <dump.dmp>
# Interpretation is gated on the independently verified identity/site above:
node scripts/recorder-crash-inspect.mjs <dump.dmp> --checked-u32-add
npm run check:recorder-crash-inspect
```

The inspector prints metadata and selected numeric operands only. Before reading
RSI/RDI or operand memory, the optional interpretation requires AMD64,
`STATUS_BREAKPOINT` (`0x80000003`), fault module `CapturePack.exe`, fault RVA
`0x3b28d0a`, and a complete RSDS record with GUID bytes
`0dff164f3181aab74c4c44205044422e` (the on-disk encoding of the GUID above), age 1.
If this independently verified identity/site cannot be established, it reports
`checkedU32Add.available: false` with a reason and no operand/diagnosis fields.
It is not a generic STATUS_BREAKPOINT detector.

The focused check constructs tiny synthetic minidumps from the two documented
dump identities/operands in `core/test/fixtures/issue243/crash-identities.json`;
these are not copies of private dump memory. Both expected sums remain covered.
An unrelated breakpoint with identical registers/memory, individual identity
mismatches, missing/out-of-file CodeView, missing module, non-AMD64 context and
an unrelated site with unusable context must all be unavailable. Before the
gate, 11 negative tests failed (the two positive fixtures and metadata-only test
passed); with the gate, all 14 pass. The check is registered for hosted QA.

Installed logs, dumps and executable were only read; no installed app was started
or modified. No dump or binary is committed/uploaded.

Local validation: typecheck and build passed; the soak passed; all 16 selected
checks passed: recorder-ring, recorder-retention, tick-owner, display-media-policy,
capture-cadence, capture-latency, replay-health, source-latency-calibration,
source-latency-pack, processor-qpc-latency, dxgi-timing-reference, replay-clock-map,
fmp4-sample-timeline, temporal-alignment, native-replay-fallback, qa-process-tree.
For native-replay-fallback, `CAPTUREPACK_DESKTOP_INTERACTIVE=0` explicitly skipped
live BitBlt while 34 isolated assertions passed. Two initial checks failed due to
esbuild traversing the sandboxed system temp path; both passed after TEMP/TMP
were moved into this worktree's ignored `core/out/issue-243/tmp`.

Full local QA/capture-e2e/perf desktop scripts were not run: chrome-bridge
`--wire-only` still starts the app, chrome-lifecycle tests modify registry state,
and surface-bench/native-field tests sample the desktop. No DevHotel tool was
available in this session. Hosted CI results belong to the eventual exact PR head
and must be reported separately; local isolated checks do not substitute for them.
