import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  CLIPBOARD_RETRY_DELAYS_MS,
  writeClipboardTextVerified,
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

  console.log('\nAUTOMATIC AND MANUAL COPY CONTRACT')
  const exporter = source('src/main/exporter.ts')
  const session = source('src/main/session.ts')
  const toastMain = source('src/main/saveToast.ts')
  const toastPreload = source('src/preload/toast.ts')
  const toastRenderer = source('src/renderer/toast/toast.ts')
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
      `${name} awaits copy before showing the success toast`,
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

  console.log(failed === 0 ? '\nclipboard-contract-check ok' : `\nclipboard-contract-check FAILED (${failed})`)
  process.exitCode = failed === 0 ? 0 : 1
}

void run()
