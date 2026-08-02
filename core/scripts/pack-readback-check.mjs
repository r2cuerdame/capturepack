// Runner for pack-readback-check.ts (#136). The check imports the exporter, the
// still's image-context assembly, the pack reader and the context session, so it
// is bundled first with `electron` stubbed — the only things that import chain
// wants from Electron are a log directory and a display list, neither of which
// exists in a plain Node process.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const work = mkdtempSync(path.join(tmpdir(), 'capturepack-pack-readback-run-'))
try {
  const stub = path.join(work, 'electron-stub.cjs')
  writeFileSync(
    stub,
    `const p=require('node:path');exports.app={getPath:()=>p.join(${JSON.stringify(work)},'logs'),` +
      `getAppPath:()=>'.',isPackaged:false,getVersion:()=>'0.0.0-check',on:()=>{},` +
      `whenReady:()=>Promise.resolve()};\n` +
      `exports.screen={getAllDisplays:()=>[],getPrimaryDisplay:()=>null,` +
      `getDisplayNearestPoint:()=>null,on:()=>{}};\n` +
      `exports.clipboard={writeText:()=>{},readText:()=>''};\n` +
      `exports.nativeImage={createFromBuffer:()=>null,createFromBitmap:()=>null};\n` +
      `exports.shell={openPath:()=>Promise.resolve('')};\n`,
  )
  const bundle = path.join(work, 'check.cjs')
  execFileSync(
    process.execPath,
    [
      path.join(here, '..', 'node_modules', 'esbuild', 'bin', 'esbuild'),
      path.join(here, 'pack-readback-check.ts'),
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--outfile=${bundle}`,
      `--alias:electron=${stub}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  // A failing gate check must read as a failing gate check. `execFileSync`
  // throws a Node stack trace on a non-zero exit, which buries the PASS/FAIL
  // lines the check just printed under a paragraph about `child_process`.
  try {
    execFileSync(process.execPath, [bundle, ...process.argv.slice(2)], { stdio: 'inherit' })
  } catch (err) {
    process.exitCode = typeof err?.status === 'number' && err.status !== 0 ? err.status : 1
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}
