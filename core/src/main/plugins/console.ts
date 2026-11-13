import { randomUUID } from 'node:crypto'
import { lstat, mkdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const CONSOLE_PLUGIN_VERSION = '0.1.0'
export const CONSOLE_PLUGIN_TIMEOUT_MS = 100
export const CONSOLE_PLUGIN_MAX_BYTES = 256 * 1024
export const CONSOLE_PLUGIN_MAX_LINES = 100

export interface ConsoleOutput {
  output: string
  source: 'environment'
  truncated: boolean
}

/**
 * Read only a bounded snapshot explicitly supplied by a console host. A GUI
 * process cannot safely inspect another terminal's scrollback; absent input is
 * therefore a normal no-plugin result rather than a process/window scrape.
 */
export async function collectConsoleOutput(
  readOutput: () => string | null | Promise<string | null> = async () =>
    process.env.CAPTUREPACK_CONSOLE_OUTPUT ?? null,
  timeoutMs = CONSOLE_PLUGIN_TIMEOUT_MS,
): Promise<ConsoleOutput | null> {
  let timer: NodeJS.Timeout | undefined
  try {
    const source = await Promise.race([
      Promise.resolve().then(readOutput),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      }),
    ])
    if (timer) clearTimeout(timer)
    if (typeof source !== 'string' || source.length === 0) return null
    // Bound the retained input and any look-behind copies as well as persisted bytes.
    const inputLimited = source.length > CONSOLE_PLUGIN_MAX_BYTES
    let sourceStart = inputLimited ? source.length - CONSOLE_PLUGIN_MAX_BYTES : 0
    if (sourceStart > 0 && source.charCodeAt(sourceStart) >= 0xdc00
      && source.charCodeAt(sourceStart) <= 0xdfff) {
      sourceStart += 1
    }
    let boundedSource = source.slice(sourceStart)
    if (sourceStart > 0 && source[sourceStart - 1] !== '\n') {
      // Drop only an incomplete leading line so redaction never sees a
      // credential value without its key.
      const firstLineBreak = boundedSource.indexOf('\n')
      if (firstLineBreak < 0) return null
      boundedSource = boundedSource.slice(firstLineBreak + 1)
      sourceStart += firstLineBreak + 1
    }
    // An assignment or Bearer prefix can end before the retained row, with
    // whitespace (including newlines) between the key and its value. Sanitize
    // with bounded look-behind, then remove only the sanitized context.
    // A clipped context can lose a credential key or the start of a quoted
    // value even when it contains non-whitespace. Omit the optional plugin if
    // the entire prefix cannot fit within the look-behind budget.
    if (sourceStart > CONSOLE_PLUGIN_MAX_BYTES) return null
    const context = source.slice(0, sourceStart)
    const sanitizedContext = redactSecrets(stripTerminalControls(context))
    const contextualOutput = redactSecrets(stripTerminalControls(context + boundedSource))
    // A quoted value crossing the boundary can rewrite the context itself.
    // Omit the optional plugin if that boundary cannot be retained safely.
    if (!contextualOutput.startsWith(sanitizedContext)) return null
    const sanitized = contextualOutput.slice(sanitizedContext.length)
    const bytes = Buffer.from(sanitized, 'utf8')
    // Keep the newest bytes. Reserve one byte for the required final newline,
    // then advance past any UTF-8 continuation bytes at the leading boundary.
    const byteBudget = CONSOLE_PLUGIN_MAX_BYTES - 1
    const byteLimited = bytes.length > byteBudget
    let tailStart = Math.max(0, bytes.length - byteBudget)
    while (tailStart < bytes.length && ((bytes[tailStart] ?? 0) & 0xc0) === 0x80) tailStart += 1
    const limited = bytes.subarray(tailStart).toString('utf8')
    const allLines = limited.replace(/\r?\n$/u, '').split(/\r?\n/u)
    const lineLimited = allLines.length > CONSOLE_PLUGIN_MAX_LINES
    const lines = allLines.slice(-CONSOLE_PLUGIN_MAX_LINES)
    // Omit a blank-only tail without stripping real blank rows from a nonempty log.
    if (lines.every((line) => line.length === 0)) return null
    const output = lines.join('\n')
    return {
      output: `${output}\n`,
      source: 'environment',
      truncated: inputLimited || byteLimited || lineLimited,
    }
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function stripTerminalControls(value: string): string {
  return value
    .replace(/\r\n/gu, '\n')
    // OSC / DCS / SOS / PM / APC can carry invisible hyperlink targets or payloads; stop at line breaks too so an unclosed escape cannot swallow later rows.
    .replace(/(?:\x1b\]|\x9d)[^\r\n]*?(?:\x07|\x1b\\|\x9c|(?=[\r\n])|$)/gu, '')
    .replace(/(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[^\r\n]*?(?:\x1b\\|\x9c|(?=[\r\n])|$)/gu, '')
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*(?:[@-~]|$)/gu, '')
    .replace(/\x1b(?:[ -/]*[0-~]|$)/gu, '')
}

const SECRET_NAME_SOURCE = 'api[_-]?key|secret|token|password|passwd|pwd|passphrase|access[_-]?key|private[_-]?key'
const SECRET_NAME = new RegExp(SECRET_NAME_SOURCE, 'iu')
// Spelled [xX] per letter so a pattern can stay case-sensitive for the PWD/OLDPWD exception.
const SECRET_NAME_CASELESS = SECRET_NAME_SOURCE.replace(/[a-z]/gu, (letter) => `[${letter}${letter.toUpperCase()}]`)
// Match only secret names: a kept match would resume the scan after its value
// and hide an assignment inside it (`INFO: password=...`). `&` is a valid
// credential character here; URL parameters are split by the query pass.
const SECRET_ASSIGNMENT = new RegExp(
  String.raw`\b(?!(?:OLD)?PWD\s*[:=])(?=[\w.-]*(?:${SECRET_NAME_CASELESS}))([\w.-]+\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[[^\[\]{}\r\n]*\]|(?!(?:\{\s*["'\w.-]+\s*[:=]|\[\s*\{))(?:[^\s,;}"']+(?:["'][^\s,;}\]\)"'>]+)*|["'][^\s,;}]*))`,
  'gu',
)
// A following long option is the next flag, never this option's value.
const SECRET_OPTION = new RegExp(
  String.raw`(?<![\w-])(--(?=[\w-]*(?:${SECRET_NAME_CASELESS}))([\w-]+)[ \t]+)(?!--[A-Za-z])(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+)`,
  'gu',
)

function secretName(name: string): boolean {
  // PWD and OLDPWD are conventional working-directory variables, not passwords.
  return name !== 'PWD' && name !== 'OLDPWD' && SECRET_NAME.test(name)
}

function redactSecrets(value: string): string {
  return value
    .replace(
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/gu,
      '[REDACTED]',
    )
    // An END without a visible BEGIN means the snapshot starts inside the key.
    .replace(/^[\s\S]*-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/gu, '[REDACTED]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#"']+@/giu, '$1[REDACTED]@')
    .replace(
      /([?&#]([\w.-]+)=)[^&#\s"']*/giu,
      (match, prefix: string, name: string) =>
        secretName(name) || /^(?:key|sig|signature)$/iu.test(name) ? `${prefix}[REDACTED]` : match,
    )
    .replace(
      /(?<![\w-])((?:authorization|proxy-authorization|cookie|set-cookie)[ \t]*[:=][ \t]*)([^\r\n]+)/giu,
      (match, prefix: string, contents: string) => {
        if (/^[ \t]*$/u.test(contents)) return match
        if (/authorization/iu.test(prefix) && /^Bearer(?:[ \t]*$|[ \t]+\S)/iu.test(contents)) {
          return /^Bearer[ \t]*$/iu.test(contents) ? match : `${prefix}Bearer [REDACTED]`
        }
        return `${prefix}[REDACTED]`
      },
    )
    .replace(
      /\b(BEARER\s+)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z0-9._~+/-]+=*)/giu,
      '$1[REDACTED]',
    )
    .replace(
      /(["']([\w.-]+)["']\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[[^\[\]{}]*\]|[^,}\[\]{\s]+)/gu,
      (match, prefix: string, name: string) => {
        if (secretName(name)) return `${prefix}"[REDACTED]"`
        if (
          /^(?:authorization|proxy-authorization|cookie|set-cookie)$/iu.test(name)
          && /^["']/u.test(match.slice(prefix.length))
        ) {
          return `${prefix}"[REDACTED]"`
        }
        return match
      },
    )
    .replace(SECRET_ASSIGNMENT, '$1[REDACTED]')
    .replace(
      SECRET_OPTION,
      (match, prefix: string, name: string) => secretName(name) ? `${prefix}[REDACTED]` : match,
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,}|(?:AKIA|ASIA)[0-9A-Z]{16}|npm_[A-Za-z0-9]{20,}|sk_(?:live|test)_[A-Za-z0-9]{16,})\b/gu,
      '[REDACTED]',
    )
    .replace(
      /\b(?:xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)(?![A-Za-z0-9_-])/gu,
      '[REDACTED]',
    )
}

export function consolePluginDeclaration() {
  return { name: 'console', version: CONSOLE_PLUGIN_VERSION, path: 'plugins/console/' }
}

async function writeAtomicFile(filePath: string, contents: string): Promise<void> {
  const temporaryPath = `${filePath}.${String(process.pid)}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, contents, 'utf8')
    await rename(temporaryPath, filePath)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {})
  }
}

async function removeUnpublishedPlugin(pluginDir: string): Promise<void> {
  try {
    if ((await lstat(join(pluginDir, 'meta.json'))).isFile()) return
  } catch {
    // Without metadata, readers cannot treat this directory as a published plugin.
  }
  await rm(pluginDir, { recursive: true, force: true }).catch(() => {})
}

export async function writeConsolePlugin(dirPath: string, output: ConsoleOutput): Promise<void> {
  const pluginsDir = join(dirPath, 'plugins')
  const pluginDir = join(pluginsDir, 'console')
  const createdPluginsDir = await mkdir(pluginsDir, { recursive: true }) !== undefined
  try {
    await mkdir(pluginDir, { recursive: true })
    await writeAtomicFile(join(pluginDir, 'output.log'), output.output)
    await writeAtomicFile(join(pluginDir, 'state.json'), `${JSON.stringify({
      source: output.source,
      truncated: output.truncated,
      lines: output.output.replace(/\r?\n$/u, '').split(/\r?\n/u).length,
      bytes: Buffer.byteLength(output.output, 'utf8'),
    }, null, 2)}\n`)
    await writeAtomicFile(join(pluginDir, 'meta.json'), `${JSON.stringify({
      name: 'console',
      version: CONSOLE_PLUGIN_VERSION,
    }, null, 2)}\n`)
  } catch (error) {
    await removeUnpublishedPlugin(pluginDir)
    if (createdPluginsDir) await rmdir(pluginsDir).catch(() => {})
    throw error
  }
}

/** Optional capture binding: no provider, timeout, or write failure can fail the save. */
export async function tryWriteConsolePlugin(
  dirPath: string,
  output: ConsoleOutput | null,
): Promise<boolean> {
  if (!output) return false
  try {
    await writeConsolePlugin(dirPath, output)
    return true
  } catch (error) {
    console.error(
      'capturepack: writing plugins/console failed:',
      error instanceof Error ? error.message : String(error),
    )
    return false
  }
}
