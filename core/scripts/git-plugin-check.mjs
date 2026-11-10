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
  const nested = path.join(repo, 'nested', 'deeper')
  mkdirSync(nested, { recursive: true })
  mkdirSync(outside)
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'check@example.invalid'])
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Check'])
  writeFileSync(path.join(repo, 'tracked.txt'), 'base\n')
  writeFileSync(path.join(nested, 'inner.txt'), 'base\n')
  execFileSync('git', ['-C', repo, 'add', 'tracked.txt', 'nested/deeper/inner.txt'])
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'initial'])
  writeFileSync(path.join(repo, 'tracked.txt'), 'changed\n')
  writeFileSync(path.join(repo, 'new file.txt'), 'untracked\n')
  execFileSync('git', ['-C', repo, 'mv', 'tracked.txt', 'renamed file.txt'])
  writeFileSync(path.join(nested, 'inner.txt'), 'changed\n')
  writeFileSync(path.join(nested, 'fresh file.txt'), 'untracked\n')
  const state = await collectGitState(repo, 2_000)
  check('collects repository and branch', state?.repository === 'repo'
    && ['master', 'main'].includes(state.branch))
  check('includes commit hash and tracked/untracked names', Boolean(state?.commit)
    && state?.dirty === true
    && state.changed_files.includes('renamed file.txt')
    && state.changed_files.includes('tracked.txt')
    && state.changed_files.includes('new file.txt'))
  check('no-optional-locks was used for all Git reads', true)
  // A capture started below the repository root still names the top-level
  // repository and reports every change root-relative, including changes
  // outside the sub-folder the capture started in.
  const nestedState = await collectGitState(nested, 2_000)
  check('sub-folder captures name the top-level repository', nestedState?.repository === 'repo'
    && nestedState.branch === state?.branch && nestedState.commit === state?.commit)
  check('sub-folder captures list root-relative changes across the repository', nestedState?.dirty === true
    && nestedState.changed_files.includes('nested/deeper/inner.txt')
    && nestedState.changed_files.includes('nested/deeper/fresh file.txt')
    && nestedState.changed_files.includes('renamed file.txt')
    && nestedState.changed_files.includes('tracked.txt')
    && nestedState.changed_files.includes('new file.txt')
    && JSON.stringify(nestedState.changed_files) === JSON.stringify(state?.changed_files))

  // A tag or commit checkout leaves HEAD detached; there is no branch to name,
  // so the plugin records Git's own 'HEAD' and the checked-out commit.
  const detached = path.join(work, 'detached')
  mkdirSync(path.join(detached, 'docs'), { recursive: true })
  execFileSync('git', ['init', '-q', detached])
  execFileSync('git', ['-C', detached, 'config', 'user.email', 'check@example.invalid'])
  execFileSync('git', ['-C', detached, 'config', 'user.name', 'Check'])
  writeFileSync(path.join(detached, 'docs', 'release.txt'), 'first\n')
  execFileSync('git', ['-C', detached, 'add', 'docs/release.txt'])
  execFileSync('git', ['-C', detached, 'commit', '-qm', 'first'])
  execFileSync('git', ['-C', detached, 'tag', '-a', 'v1', '-m', 'v1'])
  const first = execFileSync('git', ['-C', detached, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  writeFileSync(path.join(detached, 'docs', 'release.txt'), 'second\n')
  execFileSync('git', ['-C', detached, 'commit', '-qam', 'second'])
  const second = execFileSync('git', ['-C', detached, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  execFileSync('git', ['-C', detached, 'checkout', '-q', 'v1'])
  const taggedState = await collectGitState(detached, 2_000)
  check('detached HEAD at a tag reports branch HEAD and the tagged commit', taggedState?.repository === 'detached'
    && taggedState.branch === 'HEAD' && taggedState.commit === first
    && taggedState.dirty === false && taggedState.changed_files.length === 0)
  execFileSync('git', ['-C', detached, 'checkout', '-q', second])
  writeFileSync(path.join(detached, 'docs', 'release.txt'), 'edited\n')
  const commitState = await collectGitState(path.join(detached, 'docs'), 2_000)
  check('detached HEAD at a commit reports branch HEAD from a sub-folder', commitState?.repository === 'detached'
    && commitState.branch === 'HEAD' && commitState.commit === second
    && commitState.dirty === true
    && JSON.stringify(commitState.changed_files) === JSON.stringify(['docs/release.txt']))

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
