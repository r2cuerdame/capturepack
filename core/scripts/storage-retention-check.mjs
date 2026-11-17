// Bundles the production retention policy so this check cannot drift from it.
// The Electron stub gives the log a private directory and replaces the Recycle
// Bin with a folder whose arrivals the check can count (#583).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const work = mkdtempSync(path.join(tmpdir(), 'capturepack-storage-retention-'))
try {
  const stub = path.join(work, 'electron-stub.cjs')
  writeFileSync(
    stub,
    `const p=require('node:path');const fs=require('node:fs');` +
      `exports.app={getPath:()=>p.join(${JSON.stringify(work)},'logs'),` +
      `getAppPath:()=>'.',isPackaged:false,getVersion:()=>'0.0.0-check',on:()=>{},` +
      `whenReady:()=>Promise.resolve()};` +
      `const trashed=[];exports.__trashed=trashed;` +
      `const bin=p.join(${JSON.stringify(work)},'recycle-bin');` +
      `exports.shell={trashItem:async(item)=>{fs.mkdirSync(bin,{recursive:true});` +
      `fs.renameSync(item,p.join(bin,String(trashed.length)+'-'+p.basename(item)));trashed.push(item)}};\n`,
  )
  const bundle = path.join(work, 'check.cjs')
  execFileSync(
    process.execPath,
    [
      path.join(here, '..', 'node_modules', 'esbuild', 'bin', 'esbuild'),
      path.join(here, 'storage-retention-check.ts'),
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
