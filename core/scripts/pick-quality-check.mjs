// Runner for pick-quality-check.ts (#134). The check imports BOTH main-process
// and renderer TypeScript — the pack reader, the context session, the providers
// and the editor's object index — so it is bundled first, with `electron`
// stubbed, because the only thing the import chain wants from it is a log
// directory.
//
// Arguments are forwarded: `node scripts/pick-quality-check.mjs --report` prints
// the per-pack table (video packs included) instead of only the gate.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const work = mkdtempSync(path.join(tmpdir(), 'capturepack-pick-quality-run-'))
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
      path.join(here, '..', 'node_modules', 'esbuild', 'bin', 'esbuild'),
      path.join(here, 'pick-quality-check.ts'),
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--outfile=${bundle}`,
      `--alias:electron=${stub}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  execFileSync(process.execPath, [bundle, ...process.argv.slice(2)], { stdio: 'inherit' })
} finally {
  rmSync(work, { recursive: true, force: true })
}
