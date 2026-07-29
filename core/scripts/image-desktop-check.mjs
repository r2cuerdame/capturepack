import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const work = mkdtempSync(path.join(tmpdir(), 'capturepack-image-desktop-'))
const outfile = path.join(work, 'check.cjs')

try {
  await build({
    entryPoints: [path.join(here, 'image-desktop-check.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  })
  execFileSync(process.execPath, [outfile], { stdio: 'inherit' })
} finally {
  rmSync(work, { recursive: true, force: true })
}
