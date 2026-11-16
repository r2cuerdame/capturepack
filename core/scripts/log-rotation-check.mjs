import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const work = mkdtempSync(path.join(tmpdir(), 'capturepack-log-rotation-runner-'))
let failed = 0
try {
  const stub = path.join(work, 'electron-stub.cjs')
  writeFileSync(
    stub,
    `exports.app={getPath:()=>process.env.CAPTUREPACK_LOG_CHECK_USERDATA,getVersion:()=>'0.0.0-check'};` +
      `exports.crashReporter={start:()=>{}};\n`,
  )
  const bundle = path.join(work, 'check.cjs')
  execFileSync(
    process.execPath,
    [
      path.join(here, '..', 'node_modules', 'esbuild', 'bin', 'esbuild'),
      path.join(here, 'log-rotation-check.ts'),
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--outfile=${bundle}`,
      `--alias:electron=${stub}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  // log.ts holds its byte counter and its enabled flag for the life of the
  // process, so each scenario gets a process of its own.
  for (const scenario of ['rotation', 'locked-oldest', 'locked-live']) {
    const result = spawnSync(process.execPath, [bundle, scenario], { stdio: 'inherit' })
    if (result.status !== 0) failed += 1
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}
if (failed > 0) {
  console.error(`log-rotation-check: ${String(failed)} scenario(s) failed`)
  process.exitCode = 1
} else {
  console.log('log-rotation-check ok')
}
