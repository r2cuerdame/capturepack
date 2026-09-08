# DXGI replay ring

Issue [#138](https://github.com/r2cuerdame/capturepack/issues/138) replaces the
always-on Windows replay path only after the replacement proves lower overhead
and preserves replay timing, retention, fallback, and still capture.

The native helper now contains a bounded opt-in production candidate. The
shipping backend stays live and remains the default:

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

The existing Chromium/MediaRecorder replay flow and its declared GDI fallback
remain live. The exact `--dxgi-native-replay` process switch permits a native
candidate only after capability probing and a successful service `READY`
health packet. Missing helper, locked session, encoder failure, malformed
protocol, invalid export, timeout, or service death retains or immediately
returns to the shipping replay path. The normal still-image capture flow is
unchanged and is never routed through this helper.

## Modes and wire contracts

- Identity arguments alone run the original bounded capability handshake and
  emit exactly one 256-byte `CPNRCP01` packet.
- `--capture-ms 100..30000` runs continuous bounded acquisition at a target of
  15 fps and emits exactly one 256-byte `CPNRUN01` summary. A completed summary
  requires evidence of a real desktop frame, GPU NV12 conversion, a real H.264
  output sample, and retention in the native ring.
- `--serve --retention-ms 1000..600000` runs the persistent export service.
  It accepts bounded `SNAPSHOT\t<request-id>\t<absolute-path>` commands and a
  `STOP` command on stdin, and emits exact 256-byte `CPNSRV01` READY, SNAPSHOT,
  or FATAL packets. A successful READY is emitted only after an internal
  keyframe/config-safe snapshot has been muxed and decoded successfully.
- `--self-test` opens neither the desktop nor a codec. It exercises the native
  timestamp, geometry, encoder-transition, retention, keyframe/configuration,
  and device-loss/reinitialization contracts.

Every submitted frame starts with DXGI `LastPresentTime` in QPC units. Pointer-
only updates, duplicate/regressing timestamps, and acquire timeouts do not
become encoded frames. The exact input QPC is retained alongside its Media
Foundation 100 ns timestamp so output samples are not mapped back through a
lossy inverse conversion.

The ring has independent byte, time, and access-unit count bounds. Its snapshots
are immutable deep copies, start on an IDR clean point, carry validated matching
SPS/PPS configuration, remain inside one pipeline generation, and rebase their
timestamps to zero while preserving monotonic duration.
Reinitialization advances the generation, clears the old configuration and
access units, and refuses predictive frames until a new clean point is
available. An unexpected encoder stream-format change is terminal and
fail-closed, so incompatible codec generations cannot be joined by a cut.

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

Run only in the DevHotel managed Windows room assigned to the acceptance job,
after `npm run build -- --require-dxgi-helper`. Use the exact DXGI device name
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
sample/keyframe counts, and resource measurements. If no managed Windows room
is available, leave that gate unverified; do not substitute an ad-hoc local
desktop run. A locked LogonUI session returning `E_ACCESSDENIED` is an expected
fail-closed unavailable result and is not a reason to weaken the gate.
