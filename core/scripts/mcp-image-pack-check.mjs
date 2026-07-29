// Runner for mcp-image-pack-check.ts.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const work = mkdtempSync(path.join(tmpdir(), 'capturepack-mcp-image-'))
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
      path.join(here, 'mcp-image-pack-check.ts'),
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
