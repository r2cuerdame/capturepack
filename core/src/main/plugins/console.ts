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
    const sanitizedContext = redactSecrets(context)
    const contextualOutput = redactSecrets(context + boundedSource)
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

function redactSecrets(value: string): string {
  return value
    .replace(/\b(BEARER\s+)[A-Za-z0-9._~+/-]+=*/giu, '$1[REDACTED]')
    .replace(/(["'](?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret)["']\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,}\s]+)/giu, '$1"[REDACTED]"')
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret)\b(\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/giu, '$1$2[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu, '[REDACTED]')
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
