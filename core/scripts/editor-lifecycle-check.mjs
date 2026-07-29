// Bundle the production watchdog and its deterministic checks into one small
// CommonJS program, matching the repository's other focused check runners.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const work = mkdtempSync(path.join(tmpdir(), 'capturepack-editor-lifecycle-'))
try {
  const bundle = path.join(work, 'check.cjs')
  execFileSync(
    process.execPath,
    [
      path.join(here, '..', 'node_modules', 'esbuild', 'bin', 'esbuild'),
      path.join(here, 'editor-lifecycle-check.ts'),
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--outfile=${bundle}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  execFileSync(process.execPath, [bundle], { stdio: 'inherit' })
} finally {
  rmSync(work, { recursive: true, force: true })
}
