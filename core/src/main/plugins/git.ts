import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'

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
    const statusEntries = statusResult.stdout.split('\0')
    const changedFiles: string[] = []
    for (let index = 0; index < statusEntries.length; index += 1) {
      const entry = statusEntries[index]
      if (!entry) continue
      changedFiles.push(entry.slice(3))
      if (entry.slice(0, 2).includes('R') || entry.slice(0, 2).includes('C')) {
        const sourcePath = statusEntries[index + 1]
        if (sourcePath) changedFiles.push(sourcePath)
        index += 1
      }
    }
    changedFiles.sort()
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

export async function writeGitPlugin(dirPath: string, state: GitState): Promise<void> {
  const pluginDir = join(dirPath, 'plugins', 'git')
  await mkdir(pluginDir, { recursive: true })
  await writeFile(join(pluginDir, 'meta.json'), `${JSON.stringify({ name: 'git', version: GIT_PLUGIN_VERSION }, null, 2)}\n`)
  await writeFile(join(pluginDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`)
}
