# DXGI source-timing reference

`core/scripts/dxgi-timing-reference.cpp` is a one-shot Windows calibration
helper. It is not a replay backend and does not run continuously.

An available packet contains a fixed 128×72 row-major RGB raster and
`DXGI_OUTDUPL_FRAME_INFO.LastPresentTime` from the same
`AcquireNextFrame` resource lease. The packet also names the exact DXGI output
(device, adapter/output indices, and physical-pixel bounds), QPC frequency, and
a `GetSystemTimePreciseAsFileTime` value bracketed by two QPC reads. Consumers
must retain the reported QPC bracket span; the wall-clock anchor is not
error-free.

The native acquire and GPU-copy waits are independently capped at 250 ms. The
Node owner in `src/main/dxgiTimingReference.ts` also kills the one-shot child
after at most one second. Timeout, pointer-only/no-desktop update, access loss,
copy timeout, unknown/incoherent output rotation, and malformed output all resolve to
`status: "unavailable"`; no cached timestamp or pixels are substituted.

## Build and packaging

The repository contains source, not a checked-in executable. `npm run build`
compiles `dist/scripts/dxgi-timing-reference.exe` when MSVC C++ Build Tools are
available and prints an explicit skip warning otherwise. That keeps ordinary
type/script work possible on machines without MSVC.

`npm run dist` and `npm run release` pass `--require-dxgi-helper`. Installer
creation therefore fails rather than silently shipping calibration plumbing
without its native helper. The existing `dist/scripts/**` `asarUnpack` rule
places the compiled helper at
`resources/app.asar.unpacked/dist/scripts/dxgi-timing-reference.exe`.

Required Windows components:

- Visual Studio 2022 Build Tools (or Visual Studio) with
  “Desktop development with C++” / x64 MSVC tools
- Windows 10/11 SDK (`d3d11.lib` and `dxgi.lib`)

Useful checks from `core/`:

```text
npm run check:dxgi-timing-reference
npm run qa:dxgi-timing-reference
```

The QA command compiles into a temporary directory, creates a short-lived
flashing WinForms marker, and captures the selected physical display. It never
writes a native binary into the repository.
