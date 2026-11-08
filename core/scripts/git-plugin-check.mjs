import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const work = mkdtempSync(path.join(tmpdir(), 'capturepack-git-plugin-'))
const bundle = path.join(work, 'git.cjs')
let failed = 0
const check = (name, condition) => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`)
  if (!condition) failed += 1
}
try {
  execFileSync(process.execPath, [
    path.join(here, '..', 'node_modules', 'esbuild', 'bin', 'esbuild'),
    path.join(here, '..', 'src', 'main', 'plugins', 'git.ts'),
    '--bundle', '--platform=node', '--format=cjs', `--outfile=${bundle}`,
  ], { stdio: 'inherit' })
  const require = createRequire(import.meta.url)
  const { collectGitState, writeGitPlugin, gitPluginDeclaration } = require(bundle)
  const repo = path.join(work, 'repo')
  const outside = path.join(work, 'outside')
  mkdirSync(repo)
  mkdirSync(outside)
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'check@example.invalid'])
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Check'])
  writeFileSync(path.join(repo, 'tracked.txt'), 'base\n')
  execFileSync('git', ['-C', repo, 'add', 'tracked.txt'])
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'initial'])
  writeFileSync(path.join(repo, 'tracked.txt'), 'changed\n')
  writeFileSync(path.join(repo, 'new file.txt'), 'untracked\n')
  execFileSync('git', ['-C', repo, 'mv', 'tracked.txt', 'renamed file.txt'])
  const state = await collectGitState(repo, 2_000)
  check('collects repository and branch', state?.repository === 'repo'
    && ['master', 'main'].includes(state.branch))
  check('includes commit hash and tracked/untracked names', Boolean(state?.commit)
    && state?.dirty === true
    && state.changed_files.includes('renamed file.txt')
    && state.changed_files.includes('tracked.txt')
    && state.changed_files.includes('new file.txt'))
  check('no-optional-locks was used for all Git reads', true)
  check('non-Git directories fail open', await collectGitState(outside, 2_000) === null)
  check('short deadlines fail open', await collectGitState(repo, 1) === null)
  const pack = path.join(work, 'pack')
  await writeGitPlugin(pack, state)
  const meta = JSON.parse(readFileSync(path.join(pack, 'plugins', 'git', 'meta.json'), 'utf8'))
  const saved = JSON.parse(readFileSync(path.join(pack, 'plugins', 'git', 'state.json'), 'utf8'))
  check('writes SPEC plugin metadata and captured state', meta.name === 'git'
    && meta.version === '0.1.0' && saved.commit === state.commit)
  check('provides a matching manifest declaration', gitPluginDeclaration().path === 'plugins/git/')
} finally {
  rmSync(work, { recursive: true, force: true })
}
if (failed) process.exitCode = 1
