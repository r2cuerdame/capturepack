import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const work = mkdtempSync(path.join(tmpdir(), 'capturepack-pack-geometry-e2e-'))
const outfile = path.join(work, 'check.cjs')

try {
  const electronStub = path.join(work, 'electron-stub.cjs')
  writeFileSync(
    electronStub,
    `exports.app={getAppPath:()=>'',getVersion:()=>'0.0.0-check'};` +
      `exports.screen={getAllDisplays:()=>[],getPrimaryDisplay:()=>({id:0,bounds:{x:0,y:0,width:1,height:1}}),dipToScreenRect:(_w,r)=>r};` +
      `exports.BrowserWindow=class{};exports.ipcMain={};exports.powerMonitor={};\n`,
  )
  await build({
    entryPoints: [path.join(here, 'pack-geometry-e2e-check.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    alias: { electron: electronStub },
    logLevel: 'silent',
  })
  execFileSync(process.execPath, [outfile], { stdio: 'inherit' })
} finally {
  rmSync(work, { recursive: true, force: true })
}
