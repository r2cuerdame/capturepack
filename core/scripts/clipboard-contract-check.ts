import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  CLIPBOARD_RETRY_DELAYS_MS,
  writeClipboardImageVerified,
  writeClipboardTextVerified,
  type ClipboardImagePort,
  type ClipboardTextPort,
} from '../src/shared/clipboard'

let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (!condition) failed += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

async function run(): Promise<void> {
  console.log('VERIFIED CLIPBOARD WRITE')
  let value = ''
  let writes = 0
  const immediate: ClipboardTextPort = {
    writeText(text) {
      writes += 1
      value = text
    },
    readText() {
      return value
    },
  }
  const exactPrompt = 'Analyze the CapturePack at C:\\_CapturePack\\CapturePack_2026-07-30_015214.'
  const immediateResult = await writeClipboardTextVerified(immediate, exactPrompt)
  check('a successful write is verified once', immediateResult.ok && writes === 1)
  check('the prompt is copied byte-for-byte', value === exactPrompt)

  let contestedWrites = 0
  const waits: number[] = []
  const contested: ClipboardTextPort = {
    writeText(text) {
      contestedWrites += 1
      value = contestedWrites === 1 ? 'clipboard owner won the race' : text
    },
    readText() {
      return value
    },
  }
  const recovered = await writeClipboardTextVerified(contested, exactPrompt, async (ms) => {
    waits.push(ms)
  })
  check('a transient ownership race is retried and recovered', recovered.ok && recovered.attempts === 2)
  check('the retry uses the first bounded delay', waits.length === 1 && waits[0] === 20)

  let rejectedWrites = 0
  const rejected: ClipboardTextPort = {
    writeText() {
      rejectedWrites += 1
      throw new Error('clipboard busy')
    },
    readText() {
      throw new Error('clipboard busy')
    },
  }
  const rejectedResult = await writeClipboardTextVerified(rejected, exactPrompt, async () => {})
  check(
    'persistent contention returns an honest failure after the bounded attempts',
    !rejectedResult.ok &&
      rejectedResult.attempts === CLIPBOARD_RETRY_DELAYS_MS.length &&
      rejectedWrites === CLIPBOARD_RETRY_DELAYS_MS.length,
  )

  console.log('\nVERIFIED FINAL-IMAGE WRITE')
  const expectedPixels = new Uint8Array([10, 20, 30, 255])
  let imageWrites = 0
  const imagePort: ClipboardImagePort = {
    writeImage() {
      imageWrites += 1
    },
    readImage() {
      return imageWrites === 1
        ? { width: 2, height: 1, pixels: expectedPixels }
        : { width: 1, height: 1, pixels: expectedPixels }
    },
  }
  const imageResult = await writeClipboardImageVerified(
    imagePort,
    { width: 1, height: 1, pixels: expectedPixels },
    async () => {},
  )
  check(
    'a contested final image is retried and verified by dimensions plus pixels',
    imageResult.ok && imageResult.attempts === 2 && imageWrites === 2,
  )

  console.log('\nAUTOMATIC AND MANUAL COPY CONTRACT')
  const exporter = source('src/main/exporter.ts')
  const session = source('src/main/session.ts')
  const settingsMain = source('src/main/settings.ts')
  const settingsHtml = source('src/renderer/settings/settings.html')
  const settingsRenderer = source('src/renderer/settings/settings.ts')
  const annotatedRender = source('src/main/annotatedRender.ts')
  const clipboardMain = source('src/main/clipboard.ts')
  const toastMain = source('src/main/saveToast.ts')
  const toastPreload = source('src/preload/toast.ts')
  const toastRenderer = source('src/renderer/toast/toast.ts')
  const ipc = source('src/shared/ipc.ts')
  const historyMain = source('src/main/historyWindow.ts')
  const historyPreload = source('src/preload/history.ts')
  const imageFlow = session.slice(
    session.indexOf('async function runImageFlow('),
    session.indexOf('async function runFlow('),
  )
  const videoFlow = session.slice(
    session.indexOf('async function runFlow('),
    session.indexOf('async function runEditFlow('),
  )
  const editFlow = session.slice(session.indexOf('async function runEditFlow('))

  check(
    'automatic prompt/path copy uses the verified helper',
    exporter.includes('await copyTextToClipboard(') &&
      !exporter.includes('clipboard.writeText(mode ==='),
  )
  for (const [name, flow] of [
    ['image save', imageFlow],
    ['video save', videoFlow],
    ['re-edit save', editFlow],
  ] as const) {
    check(
      `${name} awaits any pack-oriented copy before showing the saved-pack toast`,
      flow.indexOf('await copyAfterSave(') >= 0 &&
        flow.indexOf('await copyAfterSave(') < flow.indexOf('showSaveToast({'),
    )
  }
  check(
    'toast Copy Prompt is request/response rather than fire-and-forget',
    toastMain.includes('ipcMain.handle(IPC.toastCopyPrompt') &&
      toastMain.includes('return copyTextToClipboard(analyzePrompt(toast.folderPath))') &&
      toastPreload.includes('ipcRenderer.invoke(IPC.toastCopyPrompt)'),
  )
  check(
    'toast only displays Copied after main confirms the clipboard',
    toastRenderer.includes('copyPrompt(): Promise<boolean>') &&
      toastRenderer.includes('const copied = await window.toastBridge.copyPrompt()') &&
      toastRenderer.includes("if (copied) flash(copyPromptBtn, t('toast.copiedFlash'))"),
  )
  check(
    'History Copy Prompt uses the same verified request/response helper',
    historyMain.includes('ipcMain.handle(IPC.historyCopyPrompt') &&
      historyMain.includes('return copyTextToClipboard(analyzePrompt(entry.path))') &&
      historyPreload.includes('ipcRenderer.invoke(IPC.historyCopyPrompt, packPath)'),
  )
  check(
    'settings expose an independent image post-capture action',
    settingsHtml.includes('id="imageClipboardAfterSave"') &&
      settingsRenderer.includes("el<HTMLSelectElement>('imageClipboardAfterSave')"),
  )
  // THE STILL COPIES ITS PATH, NOT ITS PIXELS.
  //
  // This pinned `imageClipboardAfterSave: 'image'` — paste what you just
  // annotated, the screenshot-tool convention. That convention assumes the image
  // IS the output. A 0.3.4 still is not: it carries the whole UI Automation tree
  // and the visible page of every browser window, which is the entire reason
  // Object Pick moved to the still. Copying a flattened PNG discards all of it,
  // silently, and the user never learns there was a folder behind the picture.
  check(
    'and a still copies the prompt carrying its path by default',
    settingsMain.includes("imageClipboardAfterSave: 'prompt'"),
    'the context a still now collects is only reachable through the path',
  )
  // Changing a default must not remove a choice. Someone whose workflow is
  // paste-into-chat still needs the pixels, one dropdown away.
  check(
    'while the final image is still offered as a mode',
    settingsHtml.includes('value="image"') && imageFlow.includes("=== 'image'"),
  )
  check(
    'image final-image mode copies only the completed derived PNG',
    imageFlow.includes("settings.imageClipboardAfterSave === 'image'") &&
      imageFlow.includes('onRendered: async (png) =>') &&
      imageFlow.includes('await copyPngToClipboard(png)') &&
      imageFlow.indexOf('await copyPngToClipboard(png)') >
        imageFlow.indexOf('startKeyframeStill('),
  )
  check(
    'still rendering publishes the manifest before handing the final PNG to the action',
    annotatedRender.includes('onRendered?: (png: Buffer) => Promise<void> | void') &&
      annotatedRender.indexOf('await setManifestRenderOutputs(handle, {') <
        annotatedRender.indexOf('await callbacks.onRendered?.(renderedPng)'),
  )
  check(
    'the image action reports rendering, copied, and honest failure states in the save toast',
      ipc.includes("'image-rendering'") &&
      ipc.includes("'image-copied'") &&
      ipc.includes("'image-copy-failed'") &&
      imageFlow.includes("'image-rendering'") &&
      imageFlow.includes("updateToastRenderStatus(savedHandle.dirPath, 'image-copied')") &&
      imageFlow.includes("updateToastRenderStatus(savedHandle.dirPath, 'image-copy-failed')") &&
      annotatedRender.includes('onFailed?: (error: Error) => Promise<void> | void') &&
      toastRenderer.includes("state === 'image-copy-failed'"),
  )
  check(
    'main clipboard image verification compares decoded dimensions and pixels',
    clipboardMain.includes('writeClipboardImageVerified') &&
      clipboardMain.includes('readBack.getSize()') &&
      clipboardMain.includes('readBack.toBitmap()'),
  )

  console.log(failed === 0 ? '\nclipboard-contract-check ok' : `\nclipboard-contract-check FAILED (${failed})`)
  process.exitCode = failed === 0 ? 0 : 1
}

void run()
