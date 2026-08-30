import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const MOVE_TIMEOUT_MS = 10_000
const MAX_HELPER_OUTPUT_BYTES = 8 * 1024
const WIN32_ERROR_PATTERN = /(?:^|\r?\n)WIN32_ERROR=(\d+)(?:\r?\n|$)/

type MoveErrorCode =
  | 'EACCES'
  | 'EBUSY'
  | 'EEXIST'
  | 'EINVAL'
  | 'EIO'
  | 'ENOENT'
  | 'ENOSYS'
  | 'EXDEV'
  | 'ETIMEDOUT'

export class MoveNoReplaceError extends Error {
  readonly code: MoveErrorCode
  readonly source: string
  readonly destination: string
  readonly win32Error?: number

  constructor(
    message: string,
    code: MoveErrorCode,
    source: string,
    destination: string,
    win32Error?: number,
  ) {
    super(message)
    this.name = 'MoveNoReplaceError'
    this.code = code
    this.source = source
    this.destination = destination
    this.win32Error = win32Error
  }
}

interface MoveHelperCommand {
  executable: string
  argsBeforePaths: string[]
}

function isPackagedPath(value: string): boolean {
  return value.toLowerCase().includes(`${path.sep}app.asar${path.sep}`)
}

function unpackedPath(value: string): string {
  const lower = value.toLowerCase()
  const marker = `${path.sep}app.asar${path.sep}`
  const markerIndex = lower.indexOf(marker)
  if (markerIndex < 0) return value
  return (
    value.slice(0, markerIndex)
    + `${path.sep}app.asar.unpacked${path.sep}`
    + value.slice(markerIndex + marker.length)
  )
}

function windowsPowerShellPath(): string | null {
  const roots = [process.env.SystemRoot, process.env.WINDIR]
  for (const root of roots) {
    if (root === undefined || !path.win32.isAbsolute(root)) continue
    const candidate = path.win32.join(
      root,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    )
    if (existsSync(candidate)) return candidate
  }
  const defaultCandidate = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  return existsSync(defaultCandidate) ? defaultCandidate : null
}

function moveHelperCommand(mainDirectory = __dirname): MoveHelperCommand | null {
  const distScripts = path.resolve(mainDirectory, '..', 'scripts')
  const packaged = isPackagedPath(distScripts)
  const externalDistScripts = packaged ? unpackedPath(distScripts) : distScripts
  const nativeHelper = path.join(externalDistScripts, 'move-no-replace.exe')
  if (existsSync(nativeHelper)) {
    return { executable: nativeHelper, argsBeforePaths: [] }
  }

  const rawFallbackCandidates = [
    path.join(externalDistScripts, 'move-no-replace.ps1'),
    ...(packaged
      ? []
      : [
          path.resolve(mainDirectory, '..', '..', 'scripts', 'move-no-replace.ps1'),
          path.resolve(process.cwd(), 'scripts', 'move-no-replace.ps1'),
        ]),
  ]
  const seenFallbacks = new Set<string>()
  const fallbackCandidates = rawFallbackCandidates.filter((candidate) => {
    const key = path.normalize(candidate).toLowerCase()
    if (seenFallbacks.has(key)) return false
    seenFallbacks.add(key)
    return true
  })
  const fallback = fallbackCandidates.find((candidate) => existsSync(candidate))
  const powershell = windowsPowerShellPath()
  if (fallback === undefined || powershell === null) return null
  return {
    executable: powershell,
    argsBeforePaths: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      fallback,
    ],
  }
}

function win32ErrorCode(error: number): MoveErrorCode {
  if (error === 2 || error === 3) return 'ENOENT'
  if (error === 5) return 'EACCES'
  if (error === 17) return 'EXDEV'
  if (error === 32 || error === 33) return 'EBUSY'
  if (error === 80 || error === 183) return 'EEXIST'
  if (error === 87 || error === 123 || error === 161) return 'EINVAL'
  return 'EIO'
}

function moveError(
  code: MoveErrorCode,
  source: string,
  destination: string,
  win32Error?: number,
): MoveNoReplaceError {
  const detail = win32Error === undefined ? '' : ` (Win32 ${String(win32Error)})`
  return new MoveNoReplaceError(
    `No-replace move failed: ${code}${detail}`,
    code,
    source,
    destination,
    win32Error,
  )
}

/**
 * Atomically rename one file or directory without replacing an existing path.
 * The operation is deliberately limited to one Windows path root; callers must
 * use a copy protocol, not a rename primitive, for cross-volume transfers.
 */
export async function moveNoReplace(
  source: string,
  destination: string,
): Promise<void> {
  if (source.trim() === '' || destination.trim() === '') {
    throw moveError('EINVAL', source, destination)
  }
  const absoluteSource = path.resolve(source)
  const absoluteDestination = path.resolve(destination)
  if (process.platform !== 'win32') {
    throw moveError('ENOSYS', absoluteSource, absoluteDestination)
  }
  if (
    path.parse(absoluteSource).root.toLowerCase()
    !== path.parse(absoluteDestination).root.toLowerCase()
  ) {
    throw moveError('EXDEV', absoluteSource, absoluteDestination)
  }

  const command = moveHelperCommand()
  if (command === null) {
    throw moveError('ENOSYS', absoluteSource, absoluteDestination)
  }

  await new Promise<void>((resolve, reject) => {
    execFile(
      command.executable,
      [...command.argsBeforePaths, absoluteSource, absoluteDestination],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: MOVE_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: MAX_HELPER_OUTPUT_BYTES,
      },
      (error, _stdout, stderr) => {
        if (error === null) {
          resolve()
          return
        }
        if (error.killed === true || typeof error.signal === 'string') {
          reject(moveError('ETIMEDOUT', absoluteSource, absoluteDestination))
          return
        }
        if (error.code === 'ENOENT' || error.code === 'EACCES') {
          reject(moveError(error.code, absoluteSource, absoluteDestination))
          return
        }
        const match = WIN32_ERROR_PATTERN.exec(stderr)
        const nativeError = match?.[1] === undefined ? undefined : Number(match[1])
        reject(
          moveError(
            nativeError === undefined ? 'EIO' : win32ErrorCode(nativeError),
            absoluteSource,
            absoluteDestination,
            nativeError,
          ),
        )
      },
    )
  })
}
