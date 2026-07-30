import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileDxgiTimingHelper } from './build-dxgi-timing-helper.mjs'

if (process.platform !== 'win32') {
  throw new Error('DXGI timing field proof requires a physical Windows desktop')
}

const here = path.dirname(fileURLToPath(import.meta.url))
const work = mkdtempSync(path.join(tmpdir(), 'capturepack-dxgi-timing-field-'))
try {
  const helper = compileDxgiTimingHelper({
    outputDirectory: work,
    required: true,
  })
  if (helper === null) throw new Error('required DXGI helper was not built')
  const bundle = path.join(work, 'field-check.cjs')
  execFileSync(
    process.execPath,
    [
      path.join(here, '..', 'node_modules', 'esbuild', 'bin', 'esbuild'),
      path.join(here, 'dxgi-timing-reference-field-check.ts'),
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--outfile=${bundle}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  execFileSync(process.execPath, [bundle], {
    stdio: 'inherit',
    env: {
      ...process.env,
      CAPTUREPACK_DXGI_TIMING_HELPER: helper,
    },
  })
} finally {
  rmSync(work, { recursive: true, force: true })
}
