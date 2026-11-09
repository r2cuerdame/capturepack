import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const CONSOLE_PLUGIN_VERSION = '0.1.0'
export const CONSOLE_PLUGIN_TIMEOUT_MS = 100
export const CONSOLE_PLUGIN_MAX_LINES = 100

export interface ConsoleOutput {
  stdout?: string
  stderr?: string
}

export interface ConsolePayload {
  output: string
  capturedAt: string
  lineCount: number
}

export type ConsoleCollector = () => ConsoleOutput | Promise<ConsoleOutput>

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:Bearer\s+)[A-Za-z0-9._~+/-]+=*/giu,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret)\b([\s"']*[:=][\s"']*)[^\s,;"']+/giu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
]

export function redactConsoleOutput(value: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, (_match, separator: string | undefined) =>
    separator ? `[REDACTED]` : 'Bearer [REDACTED]'), value)
}

/** Capture a caller-provided console buffer within a strict deadline; every failure is optional. */
export async function collectConsoleOutput(
  collector: ConsoleCollector | undefined,
  timeoutMs = CONSOLE_PLUGIN_TIMEOUT_MS,
): Promise<ConsolePayload | null> {
  if (!collector || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return null
  let timer: NodeJS.Timeout | undefined
  try {
    const result = await Promise.race([
      Promise.resolve().then(collector),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('console collection timed out')), timeoutMs)
      }),
    ])
    const combined = [
      ...(typeof result.stdout === 'string' ? result.stdout.split(/\r?\n/u).map((line) => `[stdout] ${line}`) : []),
      ...(typeof result.stderr === 'string' ? result.stderr.split(/\r?\n/u).map((line) => `[stderr] ${line}`) : []),
    ].filter((line) => line.trim() !== '')
    const output = combined.slice(-CONSOLE_PLUGIN_MAX_LINES).map(redactConsoleOutput).join('\n')
    if (!output) return null
    return { output: `${output}\n`, capturedAt: new Date().toISOString(), lineCount: Math.min(combined.length, CONSOLE_PLUGIN_MAX_LINES) }
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function consolePluginDeclaration() {
  return { name: 'console', version: CONSOLE_PLUGIN_VERSION, path: 'plugins/console/' }
}

export async function writeConsolePlugin(dirPath: string, payload: ConsolePayload): Promise<void> {
  const pluginDir = join(dirPath, 'plugins', 'console')
  await mkdir(pluginDir, { recursive: true })
  await writeFile(join(pluginDir, 'meta.json'), `${JSON.stringify({ name: 'console', version: CONSOLE_PLUGIN_VERSION }, null, 2)}\n`)
  await writeFile(join(pluginDir, 'output.log'), payload.output, 'utf8')
  await writeFile(join(pluginDir, 'state.json'), `${JSON.stringify({ captured_at: payload.capturedAt, line_count: payload.lineCount }, null, 2)}\n`)
}
