// Runner for recorder-retention-check.ts. The lifecycle helper is pure and the
// check uses a fake recorder, so no Electron window or real capture is needed.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const work = mkdtempSync(path.join(tmpdir(), 'capturepack-recorder-retention-'))
try {
  const bundle = path.join(work, 'check.cjs')
  execFileSync(
    process.execPath,
    [
      path.join(here, '..', 'node_modules', 'esbuild', 'bin', 'esbuild'),
      path.join(here, 'recorder-retention-check.ts'),
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
