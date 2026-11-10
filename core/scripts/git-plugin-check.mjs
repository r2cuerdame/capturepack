import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
  // The pack reader the MCP server serves saved packs through, so a saved
  // plugin is re-read the way a consumer reads it, not by this check's own fs.
  const storeBundle = path.join(work, 'store.cjs')
  execFileSync(process.execPath, [
    path.join(here, '..', 'node_modules', 'esbuild', 'bin', 'esbuild'),
    path.join(here, '..', 'src', 'main', 'mcp', 'store.ts'),
    '--bundle', '--platform=node', '--format=cjs', `--outfile=${storeBundle}`,
  ], { stdio: 'inherit' })
  const require = createRequire(import.meta.url)
  const { collectGitState, writeGitPlugin, gitPluginDeclaration } = require(bundle)
  const { openPack } = require(storeBundle)
  const gitSource = readFileSync(path.join(here, '..', 'src', 'main', 'plugins', 'git.ts'), 'utf8')
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
  const gitReads = [...gitSource.matchAll(/execFileAsync\('git', \[([^\]]*)\]/gu)]
  check('no-optional-locks is used on every Git read', gitReads.length === 4
    && gitReads.every(([, args]) => args.includes("'--no-optional-locks'")))
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
  const unborn = path.join(work, 'unborn')
  mkdirSync(unborn)
  execFileSync('git', ['init', '-q', unborn])
  check('repositories without an initial commit fail open', await collectGitState(unborn, 2_000) === null)
  check('short deadlines fail open', await collectGitState(repo, 1) === null)

  const deleted = path.join(work, 'deleted')
  mkdirSync(deleted)
  execFileSync('git', ['init', '-q', deleted])
  execFileSync('git', ['-C', deleted, 'config', 'user.email', 'check@example.invalid'])
  execFileSync('git', ['-C', deleted, 'config', 'user.name', 'Check'])
  writeFileSync(path.join(deleted, 'removed.txt'), 'present\n')
  execFileSync('git', ['-C', deleted, 'add', 'removed.txt'])
  execFileSync('git', ['-C', deleted, 'commit', '-qm', 'initial'])
  rmSync(path.join(deleted, 'removed.txt'))
  const deletedState = await collectGitState(deleted, 2_000)
  check('deleted files remain in changed paths', deletedState?.dirty === true
    && deletedState.changed_files.includes('removed.txt'))

  // Hangul paths (#405). core.quotePath — Git's default, pinned here so a
  // machine's global config cannot weaken the fixture — octal-escapes every
  // non-ASCII byte in human-readable status. Porcelain -z is exempt, so each
  // Korean name must reach changed_files, and a re-read pack, exactly as the
  // file was named: modified, untracked, both sides of a rename, deleted, and
  // in a Korean sub-folder of a Korean-named repository.
  const hangul = path.join(work, '한글 저장소')
  const hangulDocs = path.join(hangul, '문서')
  mkdirSync(hangulDocs, { recursive: true })
  execFileSync('git', ['init', '-q', hangul])
  execFileSync('git', ['-C', hangul, 'config', 'user.email', 'check@example.invalid'])
  execFileSync('git', ['-C', hangul, 'config', 'user.name', 'Check'])
  execFileSync('git', ['-C', hangul, 'config', 'core.quotePath', 'true'])
  writeFileSync(path.join(hangulDocs, '회의록.md'), 'base\n')
  writeFileSync(path.join(hangul, '원본 이름.txt'), 'base\n')
  writeFileSync(path.join(hangul, '지울 파일.txt'), 'base\n')
  execFileSync('git', ['-C', hangul, 'add', '문서/회의록.md', '원본 이름.txt', '지울 파일.txt'])
  execFileSync('git', ['-C', hangul, 'commit', '-qm', 'initial'])
  writeFileSync(path.join(hangulDocs, '회의록.md'), 'changed\n')
  writeFileSync(path.join(hangulDocs, '새 메모.txt'), 'untracked\n')
  execFileSync('git', ['-C', hangul, 'mv', '원본 이름.txt', '바꾼 이름.txt'])
  rmSync(path.join(hangul, '지울 파일.txt'))
  const hangulPaths = ['문서/회의록.md', '문서/새 메모.txt', '바꾼 이름.txt', '원본 이름.txt', '지울 파일.txt']
  const quotedStatus = execFileSync('git', ['-C', hangul, 'status', '--porcelain=v1'], { encoding: 'utf8' })
  check('the Hangul fixture is octal-escaped in quoted status output', /\\3\d\d/u.test(quotedStatus)
    && !hangulPaths.some((name) => quotedStatus.includes(name)))
  const hangulState = await collectGitState(hangul, 2_000)
  check('Hangul changed paths are collected exactly as named', hangulState?.repository === '한글 저장소'
    && hangulState.dirty === true
    && JSON.stringify(hangulState.changed_files) === JSON.stringify([...hangulPaths].sort()))
  const hangulNestedState = await collectGitState(hangulDocs, 2_000)
  check('a Hangul sub-folder capture lists the same root-relative Hangul paths',
    hangulNestedState?.repository === '한글 저장소'
    && JSON.stringify(hangulNestedState.changed_files) === JSON.stringify(hangulState?.changed_files))
  const hangulPack = path.join(work, '저장된 팩', 'CapturePack_2026-11-11_090000')
  await writeGitPlugin(hangulPack, hangulState)
  const reopened = openPack(hangulPack, 'dir', 'hangul')
  const savedBytes = reopened.readBinary('plugins/git/state.json')
  const savedText = reopened.readText('plugins/git/state.json')
  const reread = savedText === null ? null : JSON.parse(savedText)
  check('a re-read pack keeps every Hangul path exactly as collected', reread?.repository === '한글 저장소'
    && reread.dirty === true
    && JSON.stringify(reread.changed_files) === JSON.stringify(hangulState?.changed_files)
    && reopened.plugins().some((plugin) => plugin.name === 'git'
      && plugin.files.includes('plugins/git/state.json')))
  check('saved state.json holds Hangul paths as literal UTF-8, not escapes', savedBytes !== null
    && hangulPaths.every((name) => savedBytes.includes(Buffer.from(JSON.stringify(name), 'utf8')))
    && !/\\u[0-9a-f]{4}|\\3\d\d/iu.test(savedText ?? ''))

  // Tab and newline paths (#407). Human-readable status C-quotes a name holding
  // either ("line\nbreak.txt"); porcelain -z passes it through raw, so each
  // name must reach changed_files, and a re-read pack, byte for byte. NTFS
  // forbids both characters in a filename, so the fixture lives in the index
  // only — Git for Windows silently ignores such index paths unless
  // core.protectNTFS is off in this throwaway repository — and Git also reports
  // every one of them as missing from the worktree, on every platform alike.
  const controlChars = path.join(work, 'control-character-paths')
  mkdirSync(controlChars)
  execFileSync('git', ['init', '-q', controlChars])
  execFileSync('git', ['-C', controlChars, 'config', 'user.email', 'check@example.invalid'])
  execFileSync('git', ['-C', controlChars, 'config', 'user.name', 'Check'])
  execFileSync('git', ['-C', controlChars, 'config', 'core.protectNTFS', 'false'])
  const blobOf = (text) => execFileSync('git', ['-C', controlChars, 'hash-object', '-w', '--stdin'],
    { input: text, encoding: 'utf8' }).trim()
  const stage = (entries) => execFileSync('git', ['-C', controlChars, 'update-index', '--add', '-z', '--index-info'],
    { input: entries.map(([name, text]) => `100644 ${blobOf(text)}\t${name}\0`).join('') })
  const tabPath = 'tab\tname.txt'
  const renamedFrom = 'old\tname.txt'
  const renamedTo = 'new\tname\nline.txt'
  const newlinePath = 'line\nbreak.txt'
  const edgePath = '\tleading tab and trailing newline\n'
  stage([[tabPath, 'tab base\n'], [renamedFrom, 'renamed\n']])
  execFileSync('git', ['-C', controlChars, 'commit', '-qm', 'initial'])
  // Modified, both sides of a rename, and two staged additions — one whose
  // name starts with a tab and ends with a newline, so no trim may touch it.
  stage([[tabPath, 'tab changed\n'], [renamedTo, 'renamed\n'], [newlinePath, 'newline\n'], [edgePath, 'edge\n']])
  execFileSync('git', ['-C', controlChars, 'update-index', '--force-remove', '-z', '--stdin'],
    { input: `${renamedFrom}\0` })
  const controlPaths = [tabPath, renamedFrom, renamedTo, newlinePath, edgePath]
  const quotedControl = execFileSync('git', ['-C', controlChars, 'status', '--porcelain=v1'], { encoding: 'utf8' })
  check('the tab/newline fixture is C-quoted in human-readable status', quotedControl.includes('"line\\nbreak.txt"')
    && quotedControl.includes('"old\\tname.txt" -> "new\\tname\\nline.txt"')
    && !controlPaths.some((name) => quotedControl.includes(name)))
  const controlState = await collectGitState(controlChars, 2_000)
  check('tab and newline changed paths are collected exactly as named',
    controlState?.repository === 'control-character-paths'
    && controlState.dirty === true
    && JSON.stringify(controlState.changed_files) === JSON.stringify([...controlPaths].sort()))
  const controlPack = path.join(work, 'control-pack')
  await writeGitPlugin(controlPack, controlState)
  const controlReopened = openPack(controlPack, 'dir', 'control-paths')
  const controlText = controlReopened.readText('plugins/git/state.json')
  const controlSaved = controlText === null ? null : JSON.parse(controlText)
  check('a re-read pack keeps every tab and newline path exactly as collected',
    JSON.stringify(controlSaved?.changed_files) === JSON.stringify(controlState?.changed_files)
    && controlPaths.every((name) => controlSaved?.changed_files?.includes(name))
    && controlReopened.plugins().some((plugin) => plugin.name === 'git'
      && plugin.files.includes('plugins/git/state.json')))
  check('saved state.json holds tabs and newlines as JSON escapes',
    controlPaths.every((name) => (controlText ?? '').includes(JSON.stringify(name))))

  check('empty porcelain paths are dropped and duplicate paths are deduplicated',
    JSON.stringify(require(bundle).parseChangedFiles(' M \0?? repeated.txt\0 M repeated.txt\0'))
      === JSON.stringify(['repeated.txt']))
  const pack = path.join(work, 'pack')
  await writeGitPlugin(pack, state)
  const meta = JSON.parse(readFileSync(path.join(pack, 'plugins', 'git', 'meta.json'), 'utf8'))
  const saved = JSON.parse(readFileSync(path.join(pack, 'plugins', 'git', 'state.json'), 'utf8'))
  check('writes SPEC plugin metadata and captured state', meta.name === 'git'
    && meta.version === '0.1.0' && saved.commit === state.commit)
  check('provides a matching manifest declaration', gitPluginDeclaration().path === 'plugins/git/')

  const failedPack = path.join(work, 'failed-pack')
  const failedPluginDir = path.join(failedPack, 'plugins', 'git')
  mkdirSync(path.join(failedPluginDir, 'state.json'), { recursive: true })
  let writeFailed = false
  try {
    await writeGitPlugin(failedPack, state)
  } catch {
    writeFailed = true
  }
  check('a state-file publish failure is propagated', writeFailed)
  check('a failed state-file publish leaves no metadata that advertises a partial plugin',
    !readdirSync(failedPluginDir).includes('meta.json'))
  check('a failed state-file publish removes its staged temporary file',
    !readdirSync(failedPluginDir).some((name) => name.endsWith('.tmp')))

  const failedMetaPack = path.join(work, 'failed-meta-pack')
  const failedMetaDir = path.join(failedMetaPack, 'plugins', 'git')
  mkdirSync(path.join(failedMetaDir, 'meta.json'), { recursive: true })
  let metaWriteFailed = false
  try {
    await writeGitPlugin(failedMetaPack, state)
  } catch {
    metaWriteFailed = true
  }
  const publishedState = JSON.parse(readFileSync(path.join(failedMetaDir, 'state.json'), 'utf8'))
  check('a metadata publish failure is propagated after the complete state is written',
    metaWriteFailed && publishedState.commit === state.commit)
  check('a failed metadata publish removes its staged temporary file',
    !readdirSync(failedMetaDir).some((name) => name.endsWith('.tmp')))
} finally {
  rmSync(work, { recursive: true, force: true })
}
if (failed) process.exitCode = 1
