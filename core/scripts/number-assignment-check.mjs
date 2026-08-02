// Runner for number-assignment-check.ts (SPEC §8.5, #51). Same shape as
// numbering-check.mjs: the check imports app TypeScript, so it is bundled first
// with `electron` stubbed. It also READS the sources it makes claims about, and
// the bundle runs from a temp directory — so the core directory is handed over
// in the environment rather than guessed from __dirname.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const core = path.join(here, '..')
const work = mkdtempSync(path.join(tmpdir(), 'capturepack-numbers-'))
try {
  const stub = path.join(work, 'electron-stub.cjs')
  writeFileSync(
    stub,
    `const p=require('node:path');exports.app={getPath:()=>p.join(${JSON.stringify(work)},'logs'),` +
      `getAppPath:()=>'.',isPackaged:false,getVersion:()=>'0.0.0-check',on:()=>{},` +
      `whenReady:()=>Promise.resolve()};\n`,
  )
  const bundle = path.join(work, 'check.cjs')
  execFileSync(
    process.execPath,
    [
      path.join(core, 'node_modules', 'esbuild', 'bin', 'esbuild'),
      path.join(here, 'number-assignment-check.ts'),
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--outfile=${bundle}`,
      `--alias:electron=${stub}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  execFileSync(process.execPath, [bundle], {
    stdio: 'inherit',
    env: { ...process.env, CAPTUREPACK_CHECK_ROOT: core },
  })
} finally {
  rmSync(work, { recursive: true, force: true })
}
