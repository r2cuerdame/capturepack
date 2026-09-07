# Issue #157 result — one-click full-page Chrome capture

## Canonical state

- Issue: https://github.com/r2cuerdame/capturepack/issues/157
- Draft PR: https://github.com/r2cuerdame/capturepack/pull/158 (`Tracks #157`)
- Branch: `feat/157-full-page-capture`
- Verified code head: `f9d0648`
- Base reconciled with `origin/main` at `8e21c14`; original implementation commit `30bf8e9` is retained in branch history.
- CapturePack version `0.5.0`; Chrome extension version `0.4.0`.
- PR remains draft. Nothing was merged, released, deployed, or published.

## Independently verified implementation

- The Chrome toolbar action performs one-click full-page capture; element picking remains secondary through `Ctrl+Shift+E` and the page context menu.
- Edge-aligned viewport tiles are captured with quota pacing and lazy-content warmup. Fixed content is shown only on the first tile; sticky content is temporarily returned to normal flow instead of hidden.
- Original document scroll position, document scrollbar styles, smooth-scroll behavior, and modified fixed/sticky inline styles are restored before the extension sends `page.capture.finish`.
- Tab activation/navigation and tab identity, URL, and active state are checked around every `captureVisibleTab`; application rejection cancels the tile loop.
- Failed captures carry their capture ID so the native host clears the matching in-flight assembly immediately.
- Full-page PNG plus DOM is saved through `saveBrowserPageCapture`, read back as a normal CapturePack, and opened through the same `ContextSession` editor/re-edit path used by the normal `Ctrl+Alt+S` workflow.
- That browser-page context is accepted only with the explicit `imageContextMode: 'browser-page'`; the ordinary image privacy boundary remains intact.
- Save and Save As New retain the browser DOM bundle. Re-edit recognition requires the Chrome DOM declaration, a document event, exactly one reserved synthetic browser surface, and no unrelated elements/deltas.
- Measured raster scale, including fractional DPR, is used for DOM viewport and manifest screen geometry. DOM and Windows context are required before full-page success is reported, and a busy editor returns failure.

## Local verification

- PASS — `npm run typecheck`
- PASS — `npm run build` (`build ok`; optional local DXGI helper skipped because MSVC was unavailable)
- PASS — `npm run check:chrome-full-page` (38/38)
- PASS — `npm run check:chrome-full-page-compose` (exact 2x4 red/blue composition through `saveBrowserPageCapture` → pack readback → normal `ContextSession`; Save, Save As New, and fractional DPR 1.5 covered)
- PASS — `npm run check:document-snapshot` (30/30)
- PASS — `npm run check:frame-geometry` (44/44)
- PASS — `npm run check:chrome-bridge` (10/10)
- PASS — `npm run check:still-dom`, `npm run check:image-pack`, `npm run check:spec` (21/21), `npm run check:repo-hygiene`, `npm run check:docs` (10/10), lifecycle/service/installer checks, JSON/JavaScript syntax checks, and `git diff --check`.
- Regression gate — `npm run qa:checks -- --skip-build`: 88/89 check scripts passed. The sole failure is the existing `check:temporal` esbuild bundle error, `Dynamic require of \"child_process\" is not supported`. It reproduced in a clean DevHotel Node 22 room and is unrelated to the #157 changes.

## DevHotel evidence

- Managed web room: `djeiradz` (`capturepack / issue-157-acceptance`), Node `22.23.2`, detached at verified code head `f9d0648`.
- PASS — core dependency install with `npm --prefix core ci`.
- PASS — typecheck, run `770f0a5c-d88d-46f8-a1f9-1d3c4c9ad68e`.
- PASS — full-page contract suite 38/38, run `c07f85c5-2a88-4b2c-8012-861318305fe1`.
- PASS — real Electron composition/reopen/Save As New/fractional-DPR suite under Xvfb, run `115d1d2b-f2b5-4959-a4c7-2c90a8e31bb5`.
- PASS — build, run `eba3df00-f07f-4fd1-b0ab-07fc19c9b209` (Windows-only helpers correctly skipped in the Linux web provider).
- PASS — document snapshot 30/30, run `03a97c30-a6b4-4c4f-8d59-713265b6ba31`.
- PASS — hosted fixture HTTP 200, run `a9a8d09c-f028-4cdc-9407-a350c02bf846`.
- PASS — Playwright acceptance at 1280x720 and 390x844 against a long page containing fixed, sticky, and lazy-loaded content; no console, page, or network failures; the unpacked extension service worker loaded. Run `e7300349-b142-4ce2-a007-7fd73fa16d6c`.
- EXPECTED EXISTING FAILURE — `check:temporal` reproduced on Node 22, run `740ba283-fb54-48bc-9429-93b8fff9b13f`.
- CAPABILITY-GAP EVIDENCE — direct service-worker invocation of the unpacked extension reached Chrome's `activeTab` boundary and failed with `Cannot access contents of url \"about:blank\". Extension manifest must request permission to access this host.`, run `5c195f4c-508e-4fc1-914d-6f0b38282c04`.
- The room was slept after verification; runtime state was confirmed `stopped` with recorded status `sleeping` at `2026-09-07T03:48:23.867Z`.

## Remaining shipped-extension acceptance blocker

DevHotel's web provider can load the unpacked extension service worker and run Playwright against web content, but Playwright has no Chrome browser-toolbar action surface with which to grant `activeTab`, and the Linux web room has no CapturePack Windows native-messaging host. Consequently, the real toolbar gesture → Windows native host → persisted pack → visible editor UI path was not executable in this environment.

Before merge/release, run final acceptance in a supported Windows installed-extension environment and record the actual toolbar gesture, restored page state, saved pack, and visible normal editor session. Keep #157 open until that evidence and the requested shipped-extension performance evidence are recorded.
