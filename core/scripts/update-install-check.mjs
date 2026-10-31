import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const work = mkdtempSync(path.join(tmpdir(), 'capturepack-update-install-'))
try {
  const electronStub = path.join(work, 'electron-stub.cjs')
  writeFileSync(
    electronStub,
    `exports.app={` +
      `getPath:()=>${JSON.stringify(path.join(work, 'user-data'))},` +
      `getVersion:()=>'0.6.0',` +
      `on:()=>{},once:()=>{},isPackaged:true` +
      `};` +
      `exports.crashReporter={start:()=>{}};\n`,
  )
  const updaterStub = path.join(work, 'electron-updater-stub.cjs')
  writeFileSync(
    updaterStub,
    `const calls=[];` +
      `exports.autoUpdater={` +
      `calls,` +
      `autoDownload:false,autoInstallOnAppQuit:false,logger:null,` +
      `on:()=>exports.autoUpdater,` +
      `quitAndInstall:(...args)=>{calls.push(args)},` +
      `checkForUpdates:()=>Promise.resolve(null)` +
      `};\n`,
  )
  const bundle = path.join(work, 'check.cjs')
  execFileSync(
    process.execPath,
    [
      path.join(here, '..', 'node_modules', 'esbuild', 'bin', 'esbuild'),
      path.join(here, 'update-install-check.ts'),
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--outfile=${bundle}`,
      `--alias:electron=${electronStub}`,
      `--alias:electron-updater=${updaterStub}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  execFileSync(process.execPath, [bundle], { stdio: 'inherit', cwd: path.join(here, '..') })
} finally {
  rmSync(work, { recursive: true, force: true })
}
