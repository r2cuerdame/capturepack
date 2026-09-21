import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'capturepack-extension-sync-'))
let passed = 0
let failed = 0

function check(name, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}`)
  if (condition) passed += 1
  else failed += 1
}

try {
  const bundle = join(work, 'extension-sync.cjs')
  execFileSync(
    process.execPath,
    [
      join(here, '..', 'node_modules', 'esbuild', 'bin', 'esbuild'),
      join(here, '..', 'src', 'main', 'chrome', 'extensionSync.ts'),
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--outfile=${bundle}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  const { extensionTreeDigest, syncExtensionTree } = await import(pathToFileURL(bundle).href)
  const source = join(work, 'source')
  const target = join(work, 'target')
  mkdirSync(join(source, 'icons'), { recursive: true })
  mkdirSync(join(target, 'obsolete'), { recursive: true })
  writeFileSync(join(source, 'background.js'), 'current worker\n')
  writeFileSync(join(source, 'icons', 'icon.txt'), 'current icon\n')
  writeFileSync(join(source, 'manifest.json'), '{"version":"0.4.0"}\n')
  writeFileSync(join(target, 'background.js'), 'stale worker\n')
  writeFileSync(join(target, 'manifest.json'), '{"version":"0.4.0"}\n')
  writeFileSync(join(target, 'obsolete', 'left-behind.js'), 'stale extra\n')

  const sourceDigest = extensionTreeDigest(source)
  syncExtensionTree(source, target)
  check(
    'same-version candidate bytes are updated and verified',
    extensionTreeDigest(target) === sourceDigest &&
      readFileSync(join(target, 'background.js'), 'utf8') === 'current worker\n',
  )
  check('files removed from the bundle do not survive an update', !existsSync(join(target, 'obsolete')))

  const manifestMtime = statSync(join(target, 'manifest.json')).mtimeMs
  syncExtensionTree(source, target)
  check(
    'an identical extension tree is not rewritten on app startup',
    statSync(join(target, 'manifest.json')).mtimeMs === manifestMtime,
  )

  writeFileSync(join(target, 'background.js'), 'interrupted copy\n')
  syncExtensionTree(source, target)
  check(
    'a partial target is retried even when manifest versions match',
    extensionTreeDigest(target) === sourceDigest,
  )

  const invalid = join(work, 'invalid-source')
  mkdirSync(invalid)
  writeFileSync(join(invalid, 'background.js'), 'no manifest\n')
  let rejected = false
  try {
    syncExtensionTree(invalid, target)
  } catch {
    rejected = true
  }
  check('a bundle without manifest.json is refused before touching the target', rejected)
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(`\nresult: ${failed === 0 ? 'OK' : 'BROKEN'} — ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
