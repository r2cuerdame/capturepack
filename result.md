# CapturePack PR #156 cursor-composition result

## Outcome

- Canonical repository: `r2cuerdame/capturepack`
- Existing draft PR: https://github.com/r2cuerdame/capturepack/pull/156
- Continued branch: `herder/job_01M1W2VBD2VG6GDEJZJTJSF1QV`
- Starting head: `996a950bcc1d0a132915a2059dfa860cd06c4eaa`
- Cursor implementation build identity:
  `c016c28` (`fix(replay): composite desktop duplication cursor`)
- Merge, release, deployment, and publication were not attempted.

The final cursor blocker is implemented. Desktop Duplication pointer metadata is
persisted independently of desktop-image presents, including pointer-only frames
whose `LastPresentTime` is zero. Every submitted BGRA frame now passes through
cursor composition before the existing VideoProcessor BGRA-to-NV12 conversion.
The `cursor-composited` proof bit is set only after that work completes on the
GPU and the converted frame is accepted by the hardware encoder.

The previously field-PASS DXGI -> D3D11 -> VideoProcessor -> NVIDIA H.264 path
remains intact. A focused three-second Windows field run completed on the
rotated, negative-origin `\\.\DISPLAY1` output using `NVIDIA H.264 Encoder MFT`.

## Implementation

- `core/scripts/dxgi-replay-ring.cpp`
  - Updates persistent pointer position, visibility, timestamp, and shape before
    checking `LastPresentTime`, so pointer-only frames are retained for the next
    desktop-image submission.
  - Accepts only validated COLOR, MONOCHROME, and MASKED_COLOR shape records;
    unsupported types, invalid dimensions/pitch/hotspot, inconsistent byte
    counts, and oversized buffers fail closed.
  - Keeps the pointer position in virtual-desktop coordinates and maps it back
    to the selected output, preserving negative origins and output offsets.
  - Clips in logical output coordinates and inverse-rotates the clipped shape
    into the unrotated Desktop Duplication surface for identity/90/180/270
    output rotations.
  - Uses Microsoft sample-compatible alpha, AND/XOR, and masked-color
    copy/XOR semantics.
  - Uses no CPU full-frame readback. MONOCHROME and MASKED_COLOR read back only
    the bounded clipped cursor region; COLOR uses shape metadata directly.
  - Draws the resulting cursor texture onto the owned BGRA render target with
    D3D11 shaders and blending, unbinds graphics views, then runs the unchanged
    VideoProcessor/NVENC path.
  - Keeps the owned VideoProcessor input at `D3D11_BIND_RENDER_TARGET`; it does
    not restore the rejected shader-resource-only binding.
  - Clears stale cursor proof on pipeline rebuild and requires the proof for a
    successful capture summary and service READY.
- `core/src/main/dxgiReplayRing.ts`
  - Extends strict run parsing with the cursor stage and failure reason and
    requires cursor proof on completed native runs.
- `core/scripts/dxgi-replay-ring-check.{mjs,ts}`
  - Adds deterministic native position, pointer-only, clipping, multi-output,
    all-rotation, COLOR, MONOCHROME, MASKED_COLOR, and malformed-shape tests.
  - Adds run-packet contract checks for required cursor proof and explicit
    cursor-composition failure.
- `core/scripts/build-dxgi-timing-helper.mjs`
  - Links `d3dcompiler.lib` for the small in-process D3D11 cursor shaders.

The composition rules follow Microsoft's Windows classic Desktop Duplication
sample (`DuplicationManager.cpp`, `OutputManager.cpp`, and
`DisplayManager.cpp`) while retaining CapturePack's single-output owned BGRA
and VideoProcessor architecture.

## Verification

Environment: Windows x64, Node `v24.13.1`, MSVC Build Tools 2022. The exact
source under test was implementation commit `c016c28` based on `996a950`.

- PASS - `npm run typecheck`.
- PASS - `node scripts/build-dxgi-timing-helper.mjs --required`; both required
  native helpers compiled.
- PASS - `dist\scripts\dxgi-replay-ring.exe --self-test`; all 18 named native
  markers passed. Cursor cases cover pointer-only position persistence,
  hotspot-preserving clipping, negative-origin output mapping, 90/180/270
  inverse rotation, COLOR pixel rotation, all four MONOCHROME AND/XOR results,
  both MASKED_COLOR branches, and malformed/unsupported shape rejection.
- PASS - `npm run check:dxgi-replay-ring`; native self-test plus 20 strict
  capability/run contract checks passed.
- PASS - `npm run check:dxgi-replay-runtime`; 25 runtime checks plus 10
  application-integration checks passed.
- PASS - `git diff --check` (line-ending conversion warnings only).
- PASS - focused field command:
  `npm run qa:dxgi-replay-ring -- --device '\\.\DISPLAY1' --capture-ms 3000`.
  Evidence measured at `2026-09-08T12:08:39.146Z`:
  - status/reason: `completed` / `none`
  - output: adapter `0`, output `1`, bounds `(-1200, 0) 1200x1920`, rotation `2`
  - pointer-only frames: `1`
  - acquired/converted/submitted/encoded: `2 / 1 / 1 / 1`
  - encoded bytes/ring bytes: `134982 / 135018`
  - encoder: `NVIDIA H.264 Encoder MFT`
  - stages include `frame-gpu-converted`, `h264-sample-produced`,
    `sample-retained`, and `cursor-composited`
  - reinitializations/access losses/device losses/encoder failures: `0 / 0 / 0 / 0`

## Deployment policy evidence

No deployment or publication was requested or performed, so the mandatory
DevHotel pre-deploy gate was not entered. This session exposed no DevHotel
MCP/CLI surface; no DevHotel room/session was created and there was no room to
sleep. The focused local Windows field run above is implementation evidence,
not a substitute for a future DevHotel managed Windows release acceptance.

The PR remains open and draft. No merge, release, or cleanup of another
worktree was performed.
