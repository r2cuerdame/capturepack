# Issue #157 result — one-click full-page Chrome capture

## Canonical state

- Issue: https://github.com/r2cuerdame/capturepack/issues/157
- Existing draft PR: https://github.com/r2cuerdame/capturepack/pull/158 (`Tracks #157`)
- Existing branch reused: `feat/157-full-page-capture`; no duplicate branch or PR was created.
- Final Windows harness provenance hardening commit: `2e571b3` (`test(qa): isolate Chrome acceptance process provenance`).
- CapturePack version `0.5.0`; Chrome extension version `0.4.0`.
- PR #158 remains draft. Nothing was merged, released, deployed, or published.

## Implemented behavior and regression evidence

- The toolbar action performs a bounded full-page capture; element picking remains secondary through `Ctrl+Shift+E` and the context menu.
- The full-page PNG and aligned DOM/URL/title/timestamp/geometry use the normal save-first CapturePack and `ContextSession` editor/re-edit path. Save and Save As New preserve the DOM bundle.
- The normal screenshot path is unchanged and remains covered by `check:image-flow`; toolbar-vs-picker behavior is covered by `check:chrome-full-page` and `check:frame-geometry`.
- Capture restores the exact scroll position, scrollbar/smooth-scroll state, modified fixed/sticky styles, and the absence of an original inline `style` attribute before publishing `page.capture.finish`.
- Limits remain explicit: 256 tiles, 50,000 CSS px per dimension, 40,000,000 output pixels, 20,000 elements in the fixed/sticky scan, and 512 KiB transport chunks. Raster/viewport scale mismatches are still rejected rather than rounded or tolerated.
- Local Node `22.23.2` release-candidate gate: PASS, 90 discovered checks / 93 sequential steps including typecheck, build, smoke, Chrome full-page 40/40, bridge wire 10/10, document snapshot, frame geometry 44/44, pack geometry, normal image flow, extension sync 5/5, and installed-Windows harness contract 14/14. Runtime: 84.51 s. Evidence: `core/release/qa-pr158-finalization-3/qa-report.json` and `qa-junit.xml`.

## Windows finalization automation

- `scripts/windows-chrome-installed-acceptance.mjs` provides three explicit phases: clean-head Windows build/package and evidence preparation, unlocked headed execution, and idempotent cleanup.
- Preparation builds the exact clean Git head with the invoking Node runtime, requires the DXGI helper, creates the unpacked app and NSIS installer, stages the exact unpacked Chrome extension, and records SHA-256 identities for the application, installer, native host, and both source/packaged extension inventories.
- The headed phase uses an owned Chrome profile, owned app-data/output roots, a unique native pipe, and a run-ID-specific fixture window title. It still refuses a locked `LogonUI.exe` session, but is designed to coexist with an operator's pre-existing Chrome processes.
- Before launch it journals every pre-existing Chrome PID plus Windows creation time. Each spawned test Chrome root is recorded with the same identity tuple and must still be live, be the prepared Chrome executable, carry the exact unique `--user-data-dir`, and not reuse a pre-existing/protected PID. A delegating/reused launch fails closed.
- The final trigger is a physical mouse click on a Chrome action discovered with Windows UI Automation. It does not invoke the extension helper, native host, or Chrome DevTools Protocol directly, so Chrome's toolbar user gesture and `activeTab` grant remain inside the proof.
- UI Automation resolves the exact run-specific fixture title and rejects any window, toolbar control, popup, folder dialog, or editor whose process does not trace through the expected owned root PID and creation time.
- Native-host evidence is accepted only while its PID is live and its complete Windows parent chain reaches the active owned Chrome root without a missing parent, cycle, backwards creation time, or PID-identity mismatch. The ancestry chain and test Chrome root identity are included in acceptance evidence.
- Evidence also correlates `page.capture.start`, `page.capture.finish`, the persisted pack ID/path, DOM URL/title/viewport/marker geometry, `chrome-dom` and `windows-context` payloads, PNG identity, and a visible normal CapturePack editor window.
- The Chrome native-host registry default value and type are journaled and restored exactly in `finally`. Cleanup re-reads process identities before using `taskkill /T`, selects only descendants of recorded owned roots, protects the pre-run Chrome identity set, refuses legacy bare-PID state, and removes only profile/app-data/transient paths owned below the evidence directory. Cleanup passes only if every pre-existing Chrome PID/start-time pair remains unchanged.
- Extension installation now compares the complete file tree digest instead of trusting only the version, publishes `manifest.json` last, removes stale files, verifies the final digest, and retries partial same-version copies. A missing plain-Node `native-host.js` is a hard registration failure; Settings disconnect removes both generated manifest and launcher.
- `scripts/windows-installer-lifecycle.ps1` covers install, same-candidate update, uninstall, and residue assertions, but is hard-gated by `CAPTUREPACK_DISPOSABLE_WINDOWS_ACCEPTANCE=1` and an initially clean disposable Windows user. This prevents the real NSIS lifecycle from killing or overwriting the operator's installed CapturePack state.

## DevHotel evidence

Managed web room `djeiradz` (`capturepack / issue-157-acceptance`), Node `22.23.2`, implementation head `c906ba1`. The room was slept after verification.

- PASS `b604c224-2aed-4a23-8a55-281628dd0aab`: full-page contract 40/40.
- PASS `fa935232-e603-4900-8dc3-5b9df1706e2c`: Electron composition under Xvfb, exact 2x4 raster, saved-pack reopen through the normal editor session, Save/Save As New DOM preservation, fractional-DPR mapping.
- PASS `011d2247-f3cd-407c-952b-5f4ca6feb77e`: Playwright/Chromium long page (1024×7,216 CSS px), 11 unique tiles, 48,845 tile bytes, 1,214 DOM bytes, 7,952 ms, JS heap +546,324 bytes. Scroll restored to 233; fixed content hidden after tile 1; sticky content neutralized; lazy image requested once; styles restored exactly; console/network failures 0/0; raster geometry matched.
- PASS `82749909-ad5e-47ae-beb8-b7a4c2a50a6e`: `chrome://version` rejected in 1.1 ms with no capture messages.
- PARTIAL/FAIL `8a120042-bffc-46f3-9ce1-f8e77902f0d1`: responsive 390×5,080 CSS px, 7 unique tiles, 5,158 ms, heap +505,260 bytes; all page-state/lazy/error checks passed, but `captureVisibleTab` returned 390×705 while the Playwright viewport reported 390×844.
- PARTIAL/FAIL `dd4d5bd9-e31a-44ed-b080-5e4b905278f8`: very tall 1024×30,016 CSS px, 42 unique tiles, 29,652 ms, 135,225 tile bytes, heap +107,548 bytes; state/lazy/error checks passed, but the first tile was 1024×581 for a reported 1024×720 viewport.
- PARTIAL/FAIL `f738cda7-ac4d-49ec-88d6-4491684b2169`: DPR 2, 800×8,016 CSS px, 14 unique tiles, 10,057 ms, heap +576,960 bytes; state/lazy/error checks passed, but headless `captureVisibleTab` returned 800×461 instead of 1600×1200.
- FAIL `c8b1c862-a3e5-4a56-ad45-7638e368ca34`: short page reproduced the headless compositor mismatch (1280×581 raster for a reported 1280×720 viewport) even after a 500 ms dwell.

The long-page scenario passed end to end at DPR 1, and all exercised scenarios stayed below a 0.56 MiB measured service-worker/page JS heap delta. The responsive, very-tall first tile, short-page, and DPR-2 raster checks remain failed in the managed headless browser. No compositor tolerance was weakened; these cases must be rerun in the real headed Windows suite.

## Remaining acceptance blocker

No headed Windows UI run was performed during the provenance-hardening job, because it could interact with the operator desktop. Do not claim a Windows UI pass from the deterministic/mock/wire checks. The harness may now run alongside existing Chrome, but still fails closed if Windows process ancestry cannot be inspected or if Chrome delegates the unique profile to a pre-existing process.

Current non-headed verification at `2e571b3`:

- PASS `npm run check:windows-chrome-installed`: 22/22, including valid host ancestry, unrelated/missing/cyclic/reused-PID rejection, unique-profile root ownership, cleanup selection, and missing/replaced pre-existing Chrome detection.
- PASS `npm run typecheck`.
- PASS on the final clean two-commit head: `npm run qa:rc -- --artifacts C:\Users\recue\AppData\Local\Temp\capturepack-qa-pr158-provenance-final`: 93/93 sequential CI steps in 123.84 s, including build and isolated smoke. `qa-report.json` and `qa-junit.xml` were written under that artifact directory.
- NOT RUN: `qa:windows-chrome-installed -- --run`; no Chrome launch, UI Automation click, registry mutation, deployment, merge, release, or publication was performed by this job.

After unlock, the remaining final Windows acceptance suite is:

1. In an unlocked Windows acceptance session, run `qa:windows-chrome-installed -- --run` against prepared clean-head evidence while an ordinary pre-existing Chrome window remains open. Require the evidence to prove the operator Chrome PID/start-time identities survived cleanup and the owned test chain completed toolbar click → `activeTab` → full-page tiles + DOM → Chrome-spawned native messaging → persisted pack → visible normal editor.
2. Repeat the strict responsive, very-tall, DPR-2, and short-page compositor cases in that headed Chrome environment; the raster checks must pass as written.
3. In a disposable Windows user or managed Windows room, run `windows-installer-lifecycle.ps1` to prove install → same-candidate update → remove and zero native-host/install residue.

This is one headed Windows acceptance suite and is the only outstanding implementation acceptance blocker. Public release `v0.5.0` already exists, so any later release also requires an independent version/release-notes decision; no release work is authorized here.

---

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
