import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'

const require = createRequire(import.meta.url)
const electron = require('electron')
const work = mkdtempSync(join(tmpdir(), 'capturepack-page-compose-'))
const bundle = join(work, 'check.cjs')
try {
  buildSync({
    entryPoints: [resolve('scripts', 'chrome-full-page-compose-check.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  })
  const electronArgs = typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : []
  const result = spawnSync(electron, [...electronArgs, bundle], { stdio: 'inherit', timeout: 30_000 })
  if (result.error !== undefined) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  rmSync(work, { recursive: true, force: true })
}
