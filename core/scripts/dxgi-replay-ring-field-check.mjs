import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const helper = path.join(here, '..', 'dist', 'scripts', 'dxgi-replay-ring.exe')
if (!existsSync(helper)) {
  throw new Error('DXGI replay helper is missing; run npm run build first')
}
const work = mkdtempSync(path.join(tmpdir(), 'capturepack-dxgi-replay-field-'))
try {
  const bundle = path.join(work, 'field-check.cjs')
  execFileSync(
    process.execPath,
    [
      path.join(here, '..', 'node_modules', 'esbuild', 'bin', 'esbuild'),
      path.join(here, 'dxgi-replay-ring-field-check.ts'),
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--outfile=${bundle}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  execFileSync(process.execPath, [bundle, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, CAPTUREPACK_DXGI_REPLAY_HELPER: helper },
  })
} finally {
  rmSync(work, { recursive: true, force: true })
}
