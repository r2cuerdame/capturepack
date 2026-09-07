# Issue #157 result — one-click full-page Chrome capture

## Canonical state

- Issue: https://github.com/r2cuerdame/capturepack/issues/157
- Draft PR: https://github.com/r2cuerdame/capturepack/pull/158 (`Tracks #157`)
- Existing branch reused: `feat/157-full-page-capture`
- Verified implementation head: `c906ba1` (this result update is evidence-only)
- CapturePack version `0.5.0`; Chrome extension version `0.4.0`
- PR remains draft. Nothing was merged, released, deployed, or published.

## Completion and regression evidence

- The toolbar action performs a bounded full-page capture; element picking remains secondary through `Ctrl+Shift+E` and the context menu.
- The full-page PNG and aligned DOM/URL/title/timestamp/geometry use the normal save-first CapturePack and `ContextSession` editor/re-edit path. Save and Save As New preserve the DOM bundle.
- Capture restores the exact scroll position, scrollbar/smooth-scroll state, modified fixed/sticky styles, and the absence of an original inline `style` attribute before publishing `page.capture.finish`.
- Limits are explicit: 256 tiles, 50,000 CSS px per dimension, 40,000,000 output pixels, 20,000 elements in the fixed/sticky scan, and 512 KiB transport chunks.
- Local `npm --prefix core run qa:rc`: PASS, 91 checks including build/smoke, 79.73 s.
- GitHub Actions run 193 on `c906ba1`: PASS for `build`, `spec-validate`, and `capture-e2e`.
- No PR reviews or unresolved review threads were present when this evidence was recorded.

## Before/after

- Before this completion pass (`8fd979b`): GitHub `build` failed because the Chrome DOM provider pulled Electron's dynamic `child_process` require into the temporal Node bundle; the full-page contract had 38 checks; Settings still described the old toolbar grant/picker flow; restoration could leave `style=""`.
- After (`c906ba1`): the browser-page surface ID lives in an Electron-free shared module; GitHub CI is green; the contract is 40/40; all nine locales and fallback HTML describe the context-menu grant path; restoration removes an inline style attribute that was originally absent.
- There is no meaningful runtime baseline for the full-page operation before this PR because the toolbar only armed the picker. Post-change DevHotel measurements are below.

## DevHotel evidence

Managed web room `djeiradz` (`capturepack / issue-157-acceptance`), Node `22.23.2`, implementation head `c906ba1`.

- PASS `b604c224-2aed-4a23-8a55-281628dd0aab`: full-page contract 40/40.
- PASS `fa935232-e603-4900-8dc3-5b9df1706e2c`: Electron composition under Xvfb, exact 2x4 raster, saved-pack reopen through the normal editor session, Save/Save As New DOM preservation, fractional-DPR mapping.
- PASS `011d2247-f3cd-407c-952b-5f4ca6feb77e`: Playwright/Chromium long page (1024×7,216 CSS px), 11 unique tiles, 48,845 tile bytes, 1,214 DOM bytes, 7,952 ms, JS heap +546,324 bytes. Scroll restored to 233; fixed content hidden after tile 1; sticky content neutralized; lazy image requested once; styles restored exactly; console/network failures 0/0; raster geometry matched.
- PASS `82749909-ad5e-47ae-beb8-b7a4c2a50a6e`: `chrome://version` rejected in 1.1 ms with no capture messages.
- PARTIAL/FAIL `8a120042-bffc-46f3-9ce1-f8e77902f0d1`: responsive 390×5,080 CSS px, 7 unique tiles, 5,158 ms, heap +505,260 bytes; all page-state/lazy/error checks passed, but `captureVisibleTab` returned 390×705 while the Playwright viewport reported 390×844.
- PARTIAL/FAIL `dd4d5bd9-e31a-44ed-b080-5e4b905278f8`: very tall 1024×30,016 CSS px, 42 unique tiles, 29,652 ms, 135,225 tile bytes, heap +107,548 bytes; state/lazy/error checks passed, but the first tile was 1024×581 for a reported 1024×720 viewport.
- PARTIAL/FAIL `f738cda7-ac4d-49ec-88d6-4491684b2169`: DPR 2, 800×8,016 CSS px, 14 unique tiles, 10,057 ms, heap +576,960 bytes; state/lazy/error checks passed, but headless `captureVisibleTab` returned 800×461 instead of 1600×1200.
- FAIL `c8b1c862-a3e5-4a56-ad45-7638e368ca34`: short page reproduced the headless compositor mismatch (1280×581 raster for a reported 1280×720 viewport) even after a 500 ms dwell.

The long-page scenario passed end to end at DPR 1, and all exercised scenarios stayed below a 0.56 MiB measured service-worker/page JS heap delta. The responsive, very-tall first tile, short-page, and DPR-2 raster checks remain failed in the managed headless browser. The app compositor intentionally rejects inconsistent axis scale, so these are not counted as acceptance passes.

## Merge/release blockers

The mandatory DevHotel browser acceptance is not fully green because its headless Chrome `captureVisibleTab` raster disagrees with Playwright viewport/DPR emulation in the cases above. DevHotel also reported no managed Windows room; therefore the real Chrome toolbar gesture → `activeTab` grant → Windows native messaging → persisted pack → visible normal editor path, installed-extension process memory, and installation/update/removal flows could not be run. Policy forbids substituting a local browser, Orca, or physical device for this missing managed verification.

Release is additionally gated: public release `v0.5.0` already exists while the branch still declares `0.5.0`. Normal release policy requires a new version plus release notes/changelog and the Windows headed/installer acceptance above. Keep #157 and draft PR #158 open until a compatible DevHotel browser/Windows environment produces PASS evidence.
