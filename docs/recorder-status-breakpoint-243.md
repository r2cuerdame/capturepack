# Recorder STATUS_BREAKPOINT investigation (#243)

Canonical scope: [#243](https://github.com/r2cuerdame/capturepack/issues/243),
with broader system slowdown tracked in [#240](https://github.com/r2cuerdame/capturepack/issues/240).
Baseline: `af30c383299eae470b55dfb2ab04b90054fa26c4`, installed CapturePack 0.5.0.
This change supplies diagnostics and a bounded harness, **not a shipped crash fix**.

Direction: [#243 correction](https://github.com/r2cuerdame/capturepack/issues/243#issuecomment-5645194850)
and [#240 correction](https://github.com/r2cuerdame/capturepack/issues/240#issuecomment-5645193539)
supersede the earlier escalation. Chromium/Electron source checkout, build and
toolchain work are **HOLD**. PR #244 remains draft diagnostics/test infrastructure.

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

## Product-level alternatives audit (September 12, 2026)

The [MediaStream Recording draft](https://www.w3.org/TR/2026/WD-mediastream-recording-20260316/#mediarecorder-methods)
provides start/stop, pause/resume and requestData. Timeslices/requestData deliver
Blobs, not independently finalized recordings. The combined output of a completed
recording must be playable; individual Blobs need not be. There is no public
operation that finalizes/replaces just the muxer while preserving the encoder.

The pinned Chromium implementation agrees: [requestData](https://github.com/chromium/chromium/blob/150.0.7871.129/third_party/blink/renderer/modules/mediarecorder/media_recorder.cc)
calls MaybeFlush and delivers the current Blob. [MaybeFlush](https://github.com/chromium/chromium/blob/150.0.7871.129/third_party/blink/renderer/modules/mediarecorder/media_recorder_handler.cc)
only acts on the seekable WebM memory delegate. MP4 timeslices invoke
[FlushFragment](https://github.com/chromium/chromium/blob/150.0.7871.129/media/muxers/mp4_muxer_delegate.cc),
which flushes and clears fragments while preserving context/output position.
EnsureInitialized creates that tracker only if context does not exist. Pause and
resume retain the muxer. Stop tears down recording owners; starting again creates
a new session. Thus a periodic stop/start would still be a prohibited restart,
even if described as segmentation. Smaller fragments or keyframe intervals do not
bound cumulative output. CapturePack already uses three-frame MP4 fragments.

| Product path | Finding and decision |
| --- | --- |
| Existing AVC/MP4 | `capture.ts` startRecorder/scheduleMaintenanceFlush keeps one healthy recorder at 6 Mbps. `fragmentedMp4Ring.ts` prunes/rebases already muxed output. Neither controls the native cumulative position. No safe reset/finalization hook found. |
| Existing VP8/VP9 WebM | `recorderFormats.ts` supports fallback; `webmDualSlotRing.ts` rotates two complete recording sessions every twice the retention interval. Promoting it changes codec and periodically cycles encoders, with no equivalent-quality/resource proof. Not selected as the fix. |
| AVC in Matroska | Explicitly rejected by recorder format selection; manifest schema and MCP accept replay.mp4/replay.webm only. Relabeling Matroska as WebM is invalid and tested against. Legal support would require pack/decoder/seek/trim/privacy/timing and bounded-lifetime validation, not a MIME-only patch. |
| Existing native replay fallback | `nativeReplayFallback.ts` is degraded GDI/JPEG (5 fps, 1280 long edge). `capture.ts` feeds its canvas stream into the same MediaRecorder. It neither avoids this muxer nor preserves quality. |
| Separate encoder and muxer | No production WebCodecs VideoEncoder or standalone encoding/muxing path exists here. A CapturePack-owned muxer could decouple fragment and encoder lifetimes, but requires encoded-sample, keyframe, backpressure, timestamp and replay-equivalence proof. It is not an evidenced small fix. |

Released-version research used official release metadata, tag DEPS and individual
upstream files, with no binary or source checkout. The lockfile stays unchanged.

| Released Electron checked | Chromium pin | Tracker evidence |
| --- | --- | --- |
| [43.7.0](https://github.com/electron/electron/releases/tag/v43.7.0), latest 43.x | [150.0.7871.250](https://github.com/electron/electron/blob/v43.7.0/DEPS) | [Header](https://github.com/chromium/chromium/blob/150.0.7871.250/media/muxers/output_position_tracker.h) still declares uint32; [WriteSpan](https://github.com/chromium/chromium/blob/150.0.7871.250/media/muxers/output_position_tracker.cc) still CHECKs addition. |
| [44.3.0](https://github.com/electron/electron/releases/tag/v44.3.0), latest stable | [152.0.7977.78](https://github.com/electron/electron/blob/v44.3.0/DEPS) | [Header](https://github.com/chromium/chromium/blob/152.0.7977.78/media/muxers/output_position_tracker.h) and [WriteSpan](https://github.com/chromium/chromium/blob/152.0.7977.78/media/muxers/output_position_tracker.cc) retain the same counter/check. |

No verified released fix was established. All manifest-listed Chromium patch
bodies were read in memory (253 for 43.7.0; 182 for 44.3.0; zero retrieval errors).
None matched `output_position_tracker`, `current_pos_`, `mp4_muxer`,
`MediaRecorderHandler::MaybeFlush`, `MediaRecorderHandler::Start` or
`media/muxers/`. This is source inspection, not binary/runtime verification.
Generic release-note crash fixes do not establish a correction for this site.
No dependency bump is justified by this evidence.

**Blocker:** no demonstrated supported path bounds the current AVC/MP4 cumulative
muxer state without recorder cycling or an unverified capture-contract change.
The missing evidence is a product path preserving quality/cadence, independent
decodability, trim/privacy/timing and bounded lifetime, or a released correction
verified against this failure. The synthetic JS soak cannot supply native proof.
Keep #243/#240 open. Further work remains within that product evidence boundary;
source-build work is not the next action or a prerequisite of this PR.

The existing `output-position-regression.cc` fixture is historical, unexecuted
research material on HOLD. It is not linked into CapturePack or counted as a
passing test. This audit supersedes the earlier source-build procedure.

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
It also requires an in-file AMD64 context record with CONTEXT_INTEGER set before
reading registers. A matching executable does not validate uncaptured register
slots. Missing flags or truncated/out-of-file context return unavailable with no
operand fields. It is not a generic STATUS_BREAKPOINT detector.

The focused check constructs tiny synthetic minidumps from the two documented
dump identities/operands in `core/test/fixtures/issue243/crash-identities.json`;
these are not copies of private dump memory. Both expected sums remain covered.
An unrelated breakpoint with identical registers/memory, individual identity
mismatches, missing/out-of-file CodeView, missing module, non-AMD64 context and
an unrelated site with unusable context must all be unavailable. Before the
gate, 11 negative tests failed (the two positive fixtures and metadata-only test
passed); with the identity gate, all 14 passed. The subsequent integer-context
review regression adds six negative cases (all RED before the correction) and an
integer-only positive case. All 21 pass after the correction. Both recorder
checks are registered in full QA and the video profile.

Installed logs, dumps and executable were only read; no installed app was started
or modified. No dump or binary is committed/uploaded.

Current local validation: typecheck and build with `--require-dxgi-helper` passed.
`qa:video` passed **61/61 steps** (60 checks plus typecheck), including the inspector
and accelerated lifecycle soak. Report: ignored
`core/out/issue-243/product-audit-video/qa-report.json` (52.07 seconds).
`CAPTUREPACK_DESKTOP_INTERACTIVE=0` explicitly skipped live BitBlt;
TEMP/TMP were scoped to ignored `core/out/issue-243/tmp`. The video profile's
installer-state tests use isolated `Software\\CapturePack-QA` registry roots.
No installed app was launched or changed. This is not a native lifetime or
installed-app acceptance test. No DevHotel tool was available.
Hosted capture-e2e/full RC results must identify the exact PR head/base separately;
these local checks do not substitute for them.
