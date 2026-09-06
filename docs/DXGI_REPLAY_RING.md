# DXGI replay ring foundation

Issue [#138](https://github.com/r2cuerdame/capturepack/issues/138) replaces the
always-on Windows replay path only after the replacement proves lower overhead
and preserves replay timing, retention, fallback, and still capture.

This first code slice does **not** select a new runtime backend. The shipping
Chromium/MediaRecorder recorder and the separate still-image path are unchanged.
It adds `dxgi-replay-ring.exe`, with two bounded operations:

- `--self-test` exercises a fixed-byte/fixed-time encoded-access-unit ring. A
  retention cut that crosses a GOP discards the undecodable prefix through the
  next keyframe.
- capability mode selects one exact DXGI output, creates a D3D11 video device
  on that adapter, opens Desktop Duplication, verifies GPU BGRA-to-NV12 video
  processor support, enumerates adapter-bound hardware H.264 MFTs, and requires
  a D3D11-aware encoder to accept the same `IMFDXGIDeviceManager`.

Capability stdout is exactly one 256-byte versioned packet. Available and
unavailable are both valid results; process failure, timeout, malformed output,
and unsupported capability stages stay distinct. The probe does not call
`AcquireNextFrame`, because an unchanged desktop may legitimately time out.

## Deterministic gate

```powershell
cd core
npm run check:dxgi-replay-ring
```

The gate compiles the helper, runs its native ring self-test, and exercises the
bounded TypeScript parser at every two-chunk boundary and byte by byte.

## Managed Windows field probe

Run this only in the DevHotel Windows room assigned to the acceptance job, after
`npm run build`. Use the exact DXGI device name when known:

```powershell
npm run qa:dxgi-replay-ring -- --device \\.\DISPLAY1
```

Or use exact physical-pixel bounds, including a negative display origin:

```powershell
npm run qa:dxgi-replay-ring -- --left -1920 --top 0 --native-width 1920 --native-height 1080
```

The JSON result is capability evidence only. It does not prove a frame can be
encoded, that a recent-history clip decodes, or that CPU/GPU/memory/latency is
better than the existing path. Those require the subsequent native encoder
slice and before/after DevHotel field evidence. An unavailable or failed probe
must select the declared fallback/disable path; it must not be promoted by
partial stage flags.
