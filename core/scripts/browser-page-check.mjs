// Runner for browser-page-check.ts (#157). The check imports main-process
// TypeScript, so it is bundled first — with `electron` stubbed, because the only
// thing the import chain wants from it is a log directory and an app path.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const work = mkdtempSync(path.join(tmpdir(), 'capturepack-page-check-'))
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
      path.join(here, 'browser-page-check.ts'),
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
