// Main-process language resolution (GOAL "Internationalization"): maps the
// stored settings values onto concrete languages via app.getLocale(). Kept out
// of shared/i18n.ts so the shared module stays Electron-free for renderers.
import { app } from 'electron'
import { makeT, resolveLanguage } from '../shared/i18n'
import type { Language, TranslateFn } from '../shared/i18n'
import type { Settings } from '../shared/types'

/** The resolved UI language: settings.language, "system" -> app locale -> en. */
export function uiLanguage(settings: Settings): Language {
  return resolveLanguage(settings.language, app.getLocale())
}

/** Pack document language: an explicit choice, or "ui" -> the UI language. */
export function packDocLanguage(settings: Settings): Language {
  return settings.packLanguage === 'ui'
    ? uiLanguage(settings)
    : resolveLanguage(settings.packLanguage, app.getLocale())
}

/** t() for the CURRENT resolved UI language (read at call time, never cached). */
export function uiT(settings: Settings): TranslateFn {
  return makeT(uiLanguage(settings))
}
