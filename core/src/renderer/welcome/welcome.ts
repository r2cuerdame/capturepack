// First-launch welcome window renderer (GOAL "Welcome (first launch after
// install)"): prints what main reports — the LIVE capture hotkey, the real
// output folder, the configured replay length, the MCP endpoint — in the
// resolved UI language. [Try it now] and [Settings] are intentions sent to
// main; [Done] and Esc simply close the window.
import { applyDomI18n, makeT } from '../../shared/i18n'
import type { TranslateFn } from '../../shared/i18n'
import type { WelcomeInfoResult } from '../../shared/ipc'

interface WelcomeBridge {
  get(): Promise<WelcomeInfoResult>
  tryNow(): void
  openSettings(): void
}

declare global {
  interface Window {
    welcomeBridge: WelcomeBridge
  }
}

const bridge = window.welcomeBridge

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (found === null) throw new Error(`missing element #${id}`)
  return found as T
}

const hotkeyLine = el<HTMLParagraphElement>('hotkeyLine')
const recordedLine = el<HTMLParagraphElement>('recordedLine')
const saveBody = el<HTMLElement>('saveBody')
const mcpEndpoint = el<HTMLParagraphElement>('mcpEndpoint')
const tryBtn = el<HTMLButtonElement>('tryBtn')
const settingsBtn = el<HTMLButtonElement>('settingsBtn')
const doneBtn = el<HTMLButtonElement>('doneBtn')

function render(info: WelcomeInfoResult): void {
  const t = makeT(info.uiLanguage)
  applyDomI18n(t)
  renderHotkey(t, info.hotkey)
  recordedLine.textContent = t('welcome.recorded', { seconds: info.replaySeconds })
  saveBody.textContent = t('welcome.step3Body', { folder: info.outputDir })
  // No endpoint while the MCP server is disabled — the line above still
  // explains what the server does, but nothing is listening to point at.
  mcpEndpoint.hidden = info.mcpUrl === ''
  if (info.mcpUrl !== '') mcpEndpoint.textContent = t('welcome.mcpEndpoint', { url: info.mcpUrl })
}

/**
 * "Press <Ctrl+Alt+C> anytime" with the accelerator as a key cap. Built from
 * DOM nodes around the template's {hotkey} placeholder — never innerHTML, so a
 * translation (or an accelerator) can carry no markup.
 */
function renderHotkey(t: TranslateFn, hotkey: string): void {
  const [before = '', after = ''] = t('welcome.hotkeyLine').split('{hotkey}')
  const key = document.createElement('kbd')
  key.className = 'key'
  key.textContent = hotkey
  hotkeyLine.replaceChildren(document.createTextNode(before), key, document.createTextNode(after))
}

// The window closes main-side, right before the capture fires: the desktop is
// frozen by the capture and the welcome window must not be in that frame.
tryBtn.addEventListener('click', () => bridge.tryNow())
// Settings opens in front; this window stays behind it, so [Try it now] is
// still there once the user is done configuring.
settingsBtn.addEventListener('click', () => bridge.openSettings())
doneBtn.addEventListener('click', () => window.close())

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault()
    window.close()
  }
})

// A rejection is only possible if the window is torn down mid-invoke (main
// rejects a welcome:get from any other sender); nothing left to render then.
void bridge
  .get()
  .then(render)
  .catch(() => undefined)
