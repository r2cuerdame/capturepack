// About window renderer: renders the snapshot main sends (version, icon,
// language, updater state) and re-renders on every push, so the update line
// follows a check started from the tray while the window is open.
//
// Links are never opened here: each button carries a data-link KEY that main
// maps to its own hardcoded URL allowlist.
import { applyDomI18n, makeT } from '../../shared/i18n'
import type { TranslateFn } from '../../shared/i18n'
import type { AboutInfoResult, AboutLinkKey } from '../../shared/ipc'

interface AboutBridge {
  get(): Promise<AboutInfoResult>
  onState(cb: (info: AboutInfoResult) => void): void
  openLink(key: AboutLinkKey): void
  restartUpdate(): void
  showWelcome(): void
}

declare global {
  interface Window {
    aboutBridge: AboutBridge
  }
}

const bridge = window.aboutBridge

const LINK_KEYS: readonly AboutLinkKey[] = ['website', 'github', 'issues', 'sponsor']

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (found === null) throw new Error(`missing element #${id}`)
  return found as T
}

const iconEl = el<HTMLImageElement>('icon')
const versionEl = el<HTMLElement>('version')
const lastRunEl = el<HTMLElement>('lastRun')
const updateStateEl = el<HTMLElement>('updateState')
const restartBtn = el<HTMLButtonElement>('restartBtn')
const welcomeBtn = el<HTMLButtonElement>('welcomeBtn')

function render(info: AboutInfoResult): void {
  const t = makeT(info.uiLanguage)
  applyDomI18n(t)
  versionEl.textContent = t('about.version', { version: info.version })
  if (info.iconDataUrl !== '') {
    iconEl.src = info.iconDataUrl
    iconEl.hidden = false
  }
  renderLastRun(t, info)
  renderUpdate(t, info)
}

/**
 * How the previous run ended (issue #61). The timestamp is formatted HERE, in
 * the UI language, because only the renderer knows how this user reads a date —
 * main sends the ISO instant and nothing else.
 */
function renderLastRun(t: TranslateFn, info: AboutInfoResult): void {
  const { status, endedAt } = info.lastRun
  const when = endedAt === null ? '' : new Date(endedAt).toLocaleString(info.uiLanguage)
  lastRunEl.textContent =
    status === 'none'
      ? t('about.lastRunNone')
      : status === 'unclean'
        ? t('about.lastRunUnclean', { when })
        : t('about.lastRunClean', { when })
  lastRunEl.classList.toggle('unclean', status === 'unclean')
}

function renderUpdate(t: TranslateFn, info: AboutInfoResult): void {
  // An update is installable iff one finished downloading — main reports that
  // as a STICKY value, so a scheduled re-check (which revalidates the cached
  // file and passes back through 'checking'/'available') does not make the
  // button flicker out while the tray still offers "Restart and update (vX)".
  const ready = info.downloadedVersion !== null
  updateStateEl.textContent = updateText(t, info)
  updateStateEl.classList.toggle('ready', ready)
  updateStateEl.classList.toggle('failed', info.updater.state === 'error')
  restartBtn.hidden = !ready
}

function updateText(t: TranslateFn, info: AboutInfoResult): string {
  const updater = info.updater
  switch (updater.state) {
    case 'checking':
      return t('about.stateChecking')
    case 'available':
    case 'downloaded':
      // The version is always known for these states in practice; without it,
      // "Downloading update…" is the honest fallback (autoDownload is on).
      return updater.version === undefined
        ? t('about.stateDownloading')
        : t('about.stateAvailable', { version: updater.version })
    case 'downloading':
      return t('about.stateDownloading')
    case 'error':
      return t('about.stateError')
    case 'dev':
      return t('about.stateDev')
    case 'up-to-date':
      return t('about.stateUpToDate')
    default:
      // 'idle' — the boot state, and where the up-to-date label lands once its
      // timer expires. NOT the same as "up to date": no check has necessarily
      // run (autoUpdateCheck may be off), so claiming so would be a fact the
      // app has not verified. A downloaded update still names itself here;
      // otherwise the row stays blank (.update has a min-height, no jump).
      return info.downloadedVersion === null
        ? ''
        : t('about.stateAvailable', { version: info.downloadedVersion })
  }
}

function isLinkKey(value: string): value is AboutLinkKey {
  return (LINK_KEYS as readonly string[]).includes(value)
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-link]')) {
  const key = button.dataset['link']
  if (key === undefined || !isLinkKey(key)) continue
  button.addEventListener('click', () => bridge.openLink(key))
}

restartBtn.addEventListener('click', () => bridge.restartUpdate())

// Re-opens the first-launch introduction (GOAL "Welcome"): About is where a
// once-only window stays reachable. Not a data-link button — nothing external.
welcomeBtn.addEventListener('click', () => bridge.showWelcome())

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault()
    window.close()
  }
})

bridge.onState(render)

// A rejection is only possible if the window is torn down mid-invoke (main
// rejects an about:get from any other sender); nothing left to render then.
void bridge.get().then(render).catch(() => undefined)
