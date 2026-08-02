// Bundle the production --save-now decision logic and its deterministic checks
// into one small CommonJS program, matching the repository's other focused
// check runners. No Electron process: the flag's argv parsing, its verdicts and
// its person-less export payload are all plain values.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const work = mkdtempSync(path.join(tmpdir(), 'capturepack-save-now-'))
try {
  const stub = path.join(work, 'electron-stub.cjs')
  writeFileSync(
    stub,
    `exports.app={getVersion:()=>'0.0.0-check'};` +
      `exports.screen={getAllDisplays:()=>[]};\n`,
  )
  const bundle = path.join(work, 'check.cjs')
  execFileSync(
    process.execPath,
    [
      path.join(here, '..', 'node_modules', 'esbuild', 'bin', 'esbuild'),
      path.join(here, 'save-now-check.ts'),
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--outfile=${bundle}`,
      `--alias:electron=${stub}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  execFileSync(process.execPath, [bundle], { stdio: 'inherit' })
} finally {
  rmSync(work, { recursive: true, force: true })
}
