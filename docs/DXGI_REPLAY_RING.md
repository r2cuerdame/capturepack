# DXGI replay ring

Issue [#138](https://github.com/r2cuerdame/capturepack/issues/138) replaces the
always-on Windows replay path only after the replacement proves lower overhead
and preserves replay timing, retention, fallback, and still capture.

The native helper now contains a bounded opt-in production candidate. The
shipping backend remains the default and covers native warm-up. After native
READY, its MediaRecorder encoders and replay rings are suspended so only one
replay encoder owns a display; a native failure restarts shipping capture. The
focused window keeps its live one-pixel presentation sink temporarily because
that is still the source of CapturePack's Lane-S context clock:

`DXGI Desktop Duplication -> D3D11 BGRA surface -> D3D11 video processor NV12
surface -> adapter-bound Media Foundation hardware H.264 MFT -> bounded native
access-unit ring`

No captured pixels are mapped to the CPU. A desktop-duplication surface is
copied to an owned GPU surface before `ReleaseFrame`, rotated and converted on
the same D3D11 device, and submitted as an `MFCreateDXGISurfaceBuffer` sample.
Only a hardware, D3D11-aware H.264 transform selected for the capture adapter is
accepted. Unsupported duplication, rotation, GPU conversion, or encoding is an
explicit unavailable result; this helper never substitutes a CPU converter or
software encoder.

Desktop Duplication may expose the hardware cursor as a separate plane. Native
READY therefore also requires explicit `cursor-composited` health evidence.
The helper persists `PointerPosition` and `GetFramePointerShape` metadata across
pointer-only updates, clips and inverse-rotates the cursor for the selected
output, and composites it onto the owned BGRA D3D11 render target before NV12
conversion. COLOR shapes use the pointer metadata directly; MONOCHROME and
MASKED_COLOR shapes read back only the bounded clipped cursor region, never the
full frame. The proof bit is set only after GPU composition completes and the
converted frame is accepted by the hardware encoder. Malformed or unsupported
cursor data and composition failures report `cursor-composition-unavailable`
and leave or return the application to the shipping recorder.

The existing Chromium/MediaRecorder replay flow and its declared GDI fallback
remain available. The exact `--dxgi-native-replay` process switch permits a native
candidate only after capability probing and a successful service `READY`
health packet. Missing helper, locked session, encoder failure, malformed
protocol, invalid export, timeout, or service death retains or restarts the
shipping replay path. A failure after native takeover can make that triggering
capture screenshot-only while shipping rebuilds an honest fresh buffer. The
normal still-image capture flow is unchanged and is never routed through this
helper.

## Modes and wire contracts

- Identity arguments alone run the original bounded capability handshake and
  emit exactly one 256-byte `CPNRCP01` packet.
- `--capture-ms 100..30000` runs continuous bounded acquisition at a target of
  15 fps and emits exactly one 256-byte `CPNRUN01` summary. A completed summary
  requires evidence of a real desktop frame, GPU NV12 conversion, a real H.264
  output sample, and retention in the native ring.
- `--serve --retention-ms 1000..60000` runs the persistent export service.
  It accepts bounded `SNAPSHOT\t<request-id>\t<absolute-path>` commands and a
  `STOP` command on stdin, and emits exact 288-byte version-2 `CPNSRV01` READY, SNAPSHOT,
  or FATAL packets. A successful READY is emitted only after an internal
  keyframe/config-safe snapshot has been muxed and decoded successfully.
- `--self-test` opens neither the desktop nor a codec. It exercises the native
  timestamp, geometry, encoder-transition, retention, keyframe/configuration,
  and device-loss/reinitialization contracts.

The encoder must establish zero B pictures before streaming: request zero before
media types, retry after commitment only for encoders requiring that ordering,
and require a successful request plus exact zero readback. Failed or unavailable
readback rejects native selection. FIFO output PTS checks remain a separate
ordering guard; the application's structural MP4 validator is not a decoder.

Every submitted frame starts with DXGI `LastPresentTime` in QPC units. Pointer-
only updates, duplicate/regressing timestamps, and acquire timeouts do not
become encoded frames. The exact input QPC is retained alongside its Media
Foundation 100 ns timestamp so output samples are not mapped back through a
lossy inverse conversion. Service snapshots carry a measured QPC/system-time
anchor, so the app maps the first retained exposure to the replay origin instead
of estimating it from request time minus duration.

The native candidate deliberately supports the settings UI's 1–60 second
range. Legacy or hand-edited settings above 60 seconds are rejected before the
helper starts, leaving the shipping recorder selected. For supported values,
the byte and access-unit bounds are derived from the requested duration, the
fixed 6 Mbps encoder rate, one keyframe interval, and explicit container/rate
headroom; a 60 second service therefore cannot quietly inherit a 30 second
capacity. The ring still has independent byte, time, and access-unit count
bounds. Its snapshots
are immutable deep copies, start on an IDR clean point, carry validated matching
SPS/PPS configuration, remain inside one pipeline generation, and rebase their
timestamps to zero while preserving monotonic duration.
Reinitialization advances the generation, clears the old configuration and
access units, and refuses predictive frames until a new clean point is
available. An unexpected encoder stream-format change is terminal and
fail-closed, so incompatible codec generations cannot be joined by a cut.

Snapshot muxing and full decode validation run from the immutable copy on a
worker thread while desktop acquisition continues. After warm-up, the
application also requires the returned duration to cover the available
requested history minus one bounded GOP and timestamp tolerance; an encoder
that overruns its byte budget therefore falls back instead of silently
returning a much shorter replay. A transient access/device loss rebuilds the
pipeline within the existing retry bound even after READY and resumes at a new
clean point without emitting a contradictory second READY packet.

Snapshot export uses the Windows Media Foundation fragmented MP4 sink and sink
writer with converters explicitly disabled. The helper supplies the retained
hardware H.264 access units directly; there is no external ffmpeg executable,
CPU pixel conversion, or software H.264 fallback. Success requires bounded
`ftyp`/`moov`/`moof`/non-empty `mdat` structure and a complete Media Foundation
Source Reader decode whose sample count, monotonic timestamps, dimensions, and
duration agree with the snapshot. The application independently validates the
fragmented MP4 structure, AVC configuration, sample timeline, size, sample
count, and duration before accepting its bytes.

Desktop-duplication access loss and D3D device removal/reset/hang cause a bounded
full-pipeline rebuild. The output is re-selected by its exact device identity;
an identity mismatch, exhausted retry budget, encoder error, or malformed
sample is terminal and fail-closed.

The lower-overhead acceptance is measured at application-process scope after
native READY. It must compare CPU, GPU, working set, and capture/export latency
against the shipping-only baseline with the same displays, resolution, FPS,
retention, and desktop activity. The focused shipping stream retained solely
for Lane-S ticks is part of the native result; absence of a second
MediaRecorder is necessary but is not by itself proof of materially lower
total overhead.

## Deterministic gate

```powershell
cd core
npm run check:dxgi-replay-ring
```

The gate compiles the helper, requires each named native self-test marker, and
exercises the strict capability and run-summary parsers. Runtime/export and
application-switch contracts are covered by:

```powershell
npm run check:dxgi-replay-runtime
```

## Managed Windows field acceptance

Probe DevHotel first and use its assigned managed Windows room when available.
If no usable managed Windows provider exists, an explicitly authorized bounded
local run may use the same gate, isolated worktree build, and fresh user data.
Run after `npm run build -- --require-dxgi-helper`. Use the exact DXGI device name
when known:

```powershell
npm run qa:dxgi-replay-ring -- --device \\.\DISPLAY1 --capture-ms 3000
```

Or use exact physical-pixel bounds, including a negative display origin:

```powershell
npm run qa:dxgi-replay-ring -- --left -1920 --top 0 --native-width 1920 --native-height 1080 --capture-ms 3000
```

The remaining field gate must prove the full real unlocked-host path reaches
READY and exports a playable recent-history MP4 through the application. Record
the room/session, build identity, output identity, hardware encoder, duration,
sample/keyframe counts, and resource measurements. Record provider probe results
and local authorization when using the bounded local fallback. Never use the
installed application or mix artifact/user-data directories. A locked LogonUI
session returning `E_ACCESSDENIED` is an expected
fail-closed unavailable result and is not a reason to weaken the gate.
