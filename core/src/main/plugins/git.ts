import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)
export const GIT_PLUGIN_VERSION = '0.1.0'
export const GIT_PLUGIN_TIMEOUT_MS = 100

export interface GitState {
  repository: string
  branch: string
  commit: string
  dirty: boolean
  changed_files: string[]
}

/** Parse NUL-delimited porcelain v1 status paths without emitting empty or duplicate paths. */
export function parseChangedFiles(statusOutput: string): string[] {
  const statusEntries = statusOutput.split('\0')
  const changedFiles = new Set<string>()
  for (let index = 0; index < statusEntries.length; index += 1) {
    const entry = statusEntries[index]
    if (!entry) continue
    const filePath = entry.slice(3)
    if (filePath) changedFiles.add(filePath)
    if (entry.slice(0, 2).includes('R') || entry.slice(0, 2).includes('C')) {
      const sourcePath = statusEntries[index + 1]
      if (sourcePath) changedFiles.add(sourcePath)
      index += 1
    }
  }
  return [...changedFiles].sort()
}

/** Best-effort capture-time repository context; timeout and all Git errors fail open. */
export async function collectGitState(
  cwd: string,
  timeoutMs = GIT_PLUGIN_TIMEOUT_MS,
): Promise<GitState | null> {
  const started = Date.now()
  try {
    const options = { cwd, encoding: 'utf8' as const, windowsHide: true, timeout: timeoutMs }
    const collection = Promise.all([
      execFileAsync('git', ['--no-optional-locks', 'rev-parse', '--show-toplevel'], options),
      execFileAsync('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], options),
      execFileAsync('git', ['--no-optional-locks', 'rev-parse', '--abbrev-ref', 'HEAD'], options),
      execFileAsync('git', ['--no-optional-locks', 'status', '--porcelain=v1', '-z'], options),
    ])
    let timeout: NodeJS.Timeout | undefined
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('timeout')), timeoutMs)
    })
    let results: Awaited<typeof collection>
    try {
      results = await Promise.race([collection, deadline])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
    const [rootResult, headResult, branchResult, statusResult] = results
    if (Date.now() - started > timeoutMs) return null
    const root = rootResult.stdout.trim()
    const branch = branchResult.stdout.trim()
    const commit = headResult.stdout.trim()
    if (!root || !branch || !/^[0-9a-f]{40,64}$/iu.test(commit)) return null
    // Porcelain v1 with -z is deliberately NUL-delimited: filenames may
    // contain spaces, tabs, or newlines. Rename/copy records carry a second
    // NUL-delimited source path, which must not be mistaken for a status row.
    const changedFiles = parseChangedFiles(statusResult.stdout)
    return {
      repository: root.split(/[\\/]/u).filter(Boolean).at(-1) ?? root,
      branch,
      commit,
      dirty: changedFiles.length > 0,
      changed_files: changedFiles,
    }
  } catch {
    return null
  }
}

export function gitPluginDeclaration() {
  return { name: 'git', version: GIT_PLUGIN_VERSION, path: 'plugins/git/' }
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

/**
 * Cleanup after a failed write. meta.json is published last, so a directory
 * without an ordinary meta.json never finished and is removed rather than left
 * for a reader that lists plugins/ by directory (the MCP store, a full ZIP) to
 * find. A directory an earlier write already published is left alone: each of
 * its files is replaced atomically, so it still holds a complete payload.
 */
async function removeUnpublishedGitPlugin(pluginDir: string): Promise<void> {
  try {
    if ((await lstat(join(pluginDir, 'meta.json'))).isFile()) return
  } catch {
    // No metadata at all: this write never published the plugin.
  }
  await rm(pluginDir, { recursive: true, force: true }).catch(() => {})
}

export async function writeGitPlugin(dirPath: string, state: GitState): Promise<void> {
  const pluginsDir = join(dirPath, 'plugins')
  const pluginDir = join(pluginsDir, 'git')
  // A recursive mkdir that creates anything creates its last component, so a
  // returned path means plugins/ is new to this write.
  const createdPluginsDir = await mkdir(pluginsDir, { recursive: true }) !== undefined
  try {
    await mkdir(pluginDir, { recursive: true })
    // Publish metadata last so readers never discover a plugin before its state
    // file has been written successfully.
    await writeAtomicFile(join(pluginDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`)
    await writeAtomicFile(join(pluginDir, 'meta.json'), `${JSON.stringify({ name: 'git', version: GIT_PLUGIN_VERSION }, null, 2)}\n`)
  } catch (error) {
    await removeUnpublishedGitPlugin(pluginDir)
    // plugins/ itself goes too when this write created it and nothing else
    // has landed there since; rmdir refuses a directory that is not empty.
    if (createdPluginsDir) await rmdir(pluginsDir).catch(() => {})
    throw error
  }
}

/**
 * writeGitPlugin() that can never fail a save: returns whether the plugin was
 * published, which is exactly when it may be declared. A write that did not
 * finish leaves no state file, temporary file or half-made directory behind.
 */
export async function tryWriteGitPlugin(dirPath: string, state: GitState): Promise<boolean> {
  try {
    await writeGitPlugin(dirPath, state)
    return true
  } catch (err) {
    console.error(
      'capturepack: writing plugins/git failed:',
      err instanceof Error ? err.message : String(err),
    )
    return false
  }
}
