// End-to-end still-capture wiring regression check.
//
// Geometry and filesystem behavior have executable checks of their own. This
// small source contract guards the seams between Electron-only components
// without launching a real global shortcut or fullscreen overlay on the user's
// desktop (mem:app/safety): trigger -> freeze -> selector -> crop -> editor ->
// history/tray/settings.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'esbuild'

const core = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let failed = 0

function source(relative) {
  // GitHub's Windows checkout may materialize CRLF even when the developer
  // worktree uses LF. Source contracts compare structural markers, not a
  // platform's newline convention.
  return readFileSync(path.join(core, relative), 'utf8').replace(/\r\n?/g, '\n')
}

function check(name, condition) {
  if (!condition) failed += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}`)
}

function section(text, start, end) {
  const from = text.indexOf(start)
  const to = text.indexOf(end, from + start.length)
  return from >= 0 && to > from ? text.slice(from, to) : ''
}

console.log('IMAGE TRIGGER + PRIVACY ORDER')
const session = source('src/main/session.ts')
const imageFlow = section(session, 'async function runImageFlow(', 'async function runFlow(')
const freezeAt = imageFlow.indexOf('await takeDisplaySnapshots(')
const selectorAt = imageFlow.indexOf('selectionPending = selectImageRegion(')
const cropAt = imageFlow.indexOf('cropSnapshot(desktopPng, selection)')
const desktopAt = imageFlow.indexOf('composeImageDesktop(desktop, snapshots)')
const detachAt = imageFlow.indexOf('desktopPng = null')
const clearAt = imageFlow.indexOf('snapshots.clear()', detachAt)
const saveAt = imageFlow.indexOf('await savePack(')
const editorAt = imageFlow.indexOf('createEditorWindow(')
check(
  'pixels freeze before any selector overlay opens',
  freezeAt >= 0 && selectorAt > freezeAt,
)
check(
  'crop and explicit full-desktop image are materialized before source buffers detach',
  desktopAt > selectorAt &&
    cropAt > desktopAt &&
    detachAt > cropAt &&
    clearAt > detachAt,
)
check(
  'the last selected full-display reference is gone before save or editor IPC',
  clearAt >= 0 &&
    saveAt > clearAt &&
    editorAt > clearAt &&
    !imageFlow.slice(detachAt + 'desktopPng = null'.length).includes('desktopPng'),
)
check(
  'image flow never requests or persists replay/context-timeline media',
  !imageFlow.includes('requestReplay(') &&
    imageFlow.includes("captureKind: 'image'") &&
    imageFlow.includes('replayWebm: null') &&
    imageFlow.includes('windowsContext: null') &&
    imageFlow.includes('displays: []'),
)
check(
  'the selector full-screen action expands to every frozen display in Main',
  imageFlow.includes("if (selection.mode === 'fullscreen')") &&
    imageFlow.includes('selectable.length !== allDisplays.length') &&
    imageFlow.includes('layoutImageDesktop(selectable)') &&
    imageFlow.includes('screenDeclaration = desktop.placements.map(') &&
    imageFlow.includes('composeUiaForImageDesktop('),
)
check(
  'region editor placement follows the selected display rather than shortcut focus',
  imageFlow.includes('String(display.id) === selection.displayId') &&
    imageFlow.includes('selectedDisplay.bounds'),
)
check(
  'reopen treats capture_kind-absent 0.3 packs as legacy video evidence',
  session.includes(
    "if (manifest.capture_kind !== 'image') return { captureKind: 'video' }",
  ),
)
check(
  'reopen adopts a valid one-checkpoint Windows context instead of discarding it',
  session.includes('loadedWindowsContextObservations.length > 0') &&
    session.includes(
      'loadedWindowsContextObservations.some((observation) => observation.windows.length > 0)',
    ) &&
    !session.includes('loadedWindowsContextObservations.length > 1'),
)

console.log('\nSELECTOR UX + TRUST SURFACE')
const selectorMain = source('src/main/imageRegionSelector.ts')
const selectorRenderer = source('src/renderer/image-region/image-region.ts')
const selectorHtml = source('src/renderer/image-region/image-region.html')
const selectorCss = source('src/renderer/image-region/image-region.css')
const makeOverlay = section(
  selectorMain,
  'function makeOverlay(',
  '/**\n * Opens one native overlay per frozen display',
)
const revealOverlays = section(
  selectorMain,
  'function allReady(',
  'function settle(',
)
const initPayload = section(
  source('src/shared/ipc.ts'),
  'export interface ImageRegionSelectorInitPayload',
  'export interface ImageRegionSelectorFocusPayload',
)
check(
  'selector IPC receives geometry only, never a raster or filesystem path',
  initPayload.includes('desktopBounds: ImageRegionRect') &&
    initPayload.includes('displays: ImageRegionSelectorDisplay[]') &&
    initPayload.includes('layout: ImageRegionCompositeLayout') &&
    !/\b(?:Buffer|ArrayBuffer|Uint8Array)\b/.test(initPayload),
)
check(
  'main validates sender ownership and recomputes renderer geometry',
  selectorMain.includes('const found = senderRecord(event)') &&
    selectorMain.includes('resolveImageDesktopRegion(') &&
    selectorMain.includes('preferredImageRegionDisplay('),
)
check(
  'native per-monitor overlays coordinate one drag without mixed-DPI window scaling',
  selectorMain.includes('...display.bounds') &&
    selectorMain.includes('flow.records.push(makeOverlay(flow, display))') &&
    selectorMain.includes('ipcMain.on(IPC.imageRegionDrag') &&
    selectorRenderer.includes("sendDrag('start', event)") &&
    selectorRenderer.includes("sendDrag((event.buttons & 1) === 0 ? 'end' : 'move', event)") &&
    !selectorRenderer.includes('document.body.setPointerCapture('),
)
check(
  'Windows selector windows prove full display bounds before reveal and after focus activation',
  /^\s*resizable:\s*true,/mu.test(makeOverlay) &&
    /^\s*thickFrame:\s*false,/mu.test(makeOverlay) &&
    !/^\s*resizable:\s*false,/mu.test(makeOverlay) &&
    makeOverlay.includes("win.on('will-resize', (event) => event.preventDefault())") &&
    revealOverlays.includes('record.win.setBounds(record.display.bounds)') &&
    revealOverlays.includes('const actual = record.win.getBounds()') &&
    revealOverlays.includes('actual.height !== expected.height') &&
    revealOverlays.indexOf('record.win.getBounds()') <
      revealOverlays.indexOf('record.win.showInactive()') &&
    revealOverlays.indexOf(
      'record.win.getBounds()',
      revealOverlays.indexOf('record.win.showInactive()'),
    ) > revealOverlays.indexOf('record.win.showInactive()'),
    selectorMain.includes('function revalidateFocusedBounds(flow: ActiveSelector): void') &&
    selectorMain.includes('focused image selector changed display bounds') &&
    selectorMain.includes('record.win.focus()') &&
    selectorMain.indexOf('record.win.focus()') <
      selectorMain.indexOf('revalidateFocusedBounds(flow)', selectorMain.indexOf('record.win.focus()')),
)
check(
  'drag is the default region action and Esc is explicit cancel',
  selectorRenderer.includes("sendDrag('start', event)") &&
    selectorMain.includes("mode: 'region'") &&
    selectorRenderer.includes("event.key !== 'Escape'") &&
    selectorRenderer.includes('window.imageRegionBridge.cancel('),
)
check(
  'the top toolbar exposes a separate full-screen capture button',
  selectorHtml.includes('id="fullscreenBtn"') &&
    selectorRenderer.includes("mode: 'fullscreen'") &&
    /#toolbar\s*\{[\s\S]*?\btop:\s*18px;/.test(selectorCss),
)
check(
  'selector strings follow the active CapturePack language',
  initPayload.includes('uiLanguage: Language') &&
    imageFlow.includes('uiLanguage: uiLanguage(settings)') &&
    selectorRenderer.includes('applyDomI18n(makeT(payload.uiLanguage))') &&
    selectorHtml.includes('data-i18n="imageRegion.fullscreen"'),
)

console.log('\nINDEPENDENT SHORTCUT + USER SURFACES')
const sharedTypes = source('src/shared/types.ts')
const index = source('src/main/index.ts')
// Ends at registerSettingsIpc, the first thing after the two trigger closures.
// It used to end at `captureFlow = capture`, which was the Start Menu fallback's
// early-press hand-off; #80 deleted that line with the fallback.
const imageTrigger = section(
  index,
  'const imageCapture = (): void => {',
  'registerSettingsIpc(settings, {',
)
const tray = source('src/main/tray.ts')
const settingsHtml = source('src/renderer/settings/settings.html')
const settingsRenderer = source('src/renderer/settings/settings.ts')
const history = source('src/renderer/history/history.ts')
const editor = source('src/renderer/editor/editor.ts')
const viewport = source('src/renderer/editor/viewport.ts')
const compiledViewport = await transform(viewport, {
  loader: 'ts',
  format: 'esm',
  target: 'node20',
})
const viewportApi = await import(
  `data:text/javascript;base64,${Buffer.from(compiledViewport.code).toString('base64')}`
)
const initialImageView = section(
  editor,
  'function openInitialView(): void {',
  'function showNativeImageView(): void {',
)
const nativeImageView = section(
  editor,
  'function showNativeImageView(): void {',
  '/** Paints the control from the viewport',
)
check(
  'Ctrl+Alt+S is a distinct persisted image shortcut',
  sharedTypes.includes("DEFAULT_IMAGE_CAPTURE_HOTKEY = 'Ctrl+Alt+S'") &&
    settingsHtml.includes('id="imageCaptureHotkeyBtn"') &&
    settingsRenderer.includes('apply({ imageCaptureHotkey: accelerator })'),
)
check(
  'image trigger is independent from the always-on video recorder switch',
  imageTrigger.includes('startImageCaptureFlow(settings)') &&
    !imageTrigger.includes('recordingEnabled') &&
    !imageTrigger.includes('startCaptureFlow('),
)
check(
  'tray puts image capture immediately above video capture',
  tray.indexOf("t('tray.captureImage'") >= 0 &&
    tray.indexOf("t('tray.captureImage'") < tray.indexOf("t('tray.captureVideo'"),
)
check(
  'history visibly distinguishes image and video packs',
  history.includes("p.captureKind === 'image'") &&
    history.includes("p.captureKind === 'video'") &&
    history.includes("t('history.badgeImage')") &&
    history.includes("t('history.badgeVideo')"),
)
check(
  'the same editor opens fitting images at 1:1, oversized images contained, and video fitted',
    editor.includes('Math.min(availW / board.width, availH / board.height, 1)') &&
    editor.includes("oneToOneBtn.hidden = captureKind !== 'image'") &&
    initialImageView.includes("captureKind === 'image'") &&
    initialImageView.includes("initialImageViewMode(fitScale) === 'native'") &&
    initialImageView.includes('showNativeImageView()') &&
    nativeImageView.includes('applyControlZoom(hundredPercentZoom(), false)') &&
    nativeImageView.includes('nativeImageView = true') &&
    editor.includes('else if (nativeImageView) showNativeImageView()') &&
    initialImageView.includes('fitBoard()') &&
    editor.includes('openInitialView()'),
)
check(
  'initial still-image zoom is native at or below the viewport and fit when oversized',
  viewportApi.initialImageViewMode(1) === 'native' &&
    viewportApi.initialImageViewMode(0.999) === 'fit' &&
    viewportApi.initialImageViewMode(0.25) === 'fit',
)
check(
  'large-image 1:1 can exceed 4x fit zoom while video/default zoom remains capped at 4x',
  viewportApi.nativeImageZoomCeiling(0.1) === 10 &&
    viewportApi.clampZoom(10, viewportApi.nativeImageZoomCeiling(0.1)) === 10 &&
    viewportApi.clampZoom(10) === 4 &&
    editor.includes("captureKind === 'image' ? nativeImageZoomCeiling(fitScale) : ZOOM_MAX") &&
    editor.includes('viewport.zoomTo(next, r.left + r.width / 2, r.top + r.height / 2, ceiling)') &&
    editor.includes('viewport.zoomAt(e.clientX, e.clientY, e.deltaY < 0, zoomCeiling())'),
)

console.log(
  failed === 0
    ? '\nimage-flow-contract-check ok'
    : `\nimage-flow-contract-check FAILED (${failed})`,
)
process.exitCode = failed === 0 ? 0 : 1
