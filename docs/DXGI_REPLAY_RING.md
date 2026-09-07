# DXGI replay ring

Issue [#138](https://github.com/r2cuerdame/capturepack/issues/138) replaces the
always-on Windows replay path only after the replacement proves lower overhead
and preserves replay timing, retention, fallback, and still capture.

The native helper now contains the next bounded production slice, while the
shipping backend remains unchanged:

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

The existing Chromium/MediaRecorder replay flow, its declared GDI fallback, and
the normal still-image capture flow are not routed through this helper. Runtime
selection and MP4 export remain a later slice.

## Modes and wire contracts

- Identity arguments alone run the original bounded capability handshake and
  emit exactly one 256-byte `CPNRCP01` packet.
- `--capture-ms 100..30000` runs continuous bounded acquisition at a target of
  15 fps and emits exactly one 256-byte `CPNRUN01` summary. A completed summary
  requires evidence of a real desktop frame, GPU NV12 conversion, a real H.264
  output sample, and retention in the native ring.
- `--self-test` opens neither the desktop nor a codec. It exercises the native
  timestamp, geometry, encoder-transition, retention, keyframe/configuration,
  and device-loss/reinitialization contracts.

Every submitted frame starts with DXGI `LastPresentTime` in QPC units. Pointer-
only updates, duplicate/regressing timestamps, and acquire timeouts do not
become encoded frames. The exact input QPC is retained alongside its Media
Foundation 100 ns timestamp so output samples are not mapped back through a
lossy inverse conversion.

The ring has independent byte, time, and access-unit count bounds. Its snapshots
start on a clean point and carry the matching `MF_MT_MPEG_SEQUENCE_HEADER`.
Reinitialization advances the generation, clears the old configuration and
access units, and refuses predictive frames until a new clean point is
available. An unexpected encoder stream-format change is terminal and
fail-closed, so incompatible codec generations cannot be joined by a cut.

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
exercises the strict capability and run-summary parsers.

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

The JSON result proves only the bounded native helper run on that managed host.
It is not proof of a valid exported MP4, runtime fallback selection, sustained
performance, or screenshot non-regression. Those require the next integration
slice and the recorded DevHotel CPU/GPU/memory/latency and application-flow
acceptance matrix. If no managed Windows room is available, leave that gate
unverified; do not substitute an ad-hoc local desktop run.
