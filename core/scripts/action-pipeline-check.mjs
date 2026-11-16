// Bundles the production helpers so this check cannot drift from them. The
// Electron stub supplies a private userData directory, a safeStorage
// implementation that deterministically rejects the stored ciphertext, and a
// window-less BrowserWindow whose page load the check finishes by hand (#540).
// ESM, not CJS: the pipeline checks are async and use top-level await, which
// esbuild cannot express in a CommonJS bundle.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const work = mkdtempSync(path.join(tmpdir(), 'capturepack-action-pipeline-'))
try {
  const stub = path.join(work, 'electron-stub.cjs')
  writeFileSync(
    stub,
    `exports.app={getPath:()=>${JSON.stringify(path.join(work, 'user-data'))},getAppPath:()=>${JSON.stringify(work)}};` +
      `exports.safeStorage={` +
        `isEncryptionAvailable:()=>true,` +
        `encryptString:value=>Buffer.from(value,'utf8'),` +
        `decryptString:()=>{throw new Error('simulated decryption failure')}` +
      `};\n` +
      // Every window the code under test creates is kept in creation order.
      // Nothing loads by itself: finishLoad() fires did-finish-load when the
      // check decides the page is ready, which is exactly the race under test.
      `const windows=[];exports.__windows=windows;` +
      `class BrowserWindow{` +
        `constructor(options){` +
          `this.options=options;this.bounds={x:options.x,y:options.y,width:options.width,height:options.height};` +
          `this.destroyed=false;this.shown=false;this.listeners={};this.pageListeners={};this.sent=[];` +
          `const self=this;` +
          `this.webContents={` +
            `on:(name,fn)=>{(self.pageListeners[name]??=[]).push(fn)},` +
            `send:(channel,payload)=>{self.sent.push({channel,payload})}` +
          `};` +
          `windows.push(this)` +
        `}` +
        `on(name,fn){(this.listeners[name]??=[]).push(fn)}` +
        `loadFile(){return Promise.resolve()}` +
        `isDestroyed(){return this.destroyed}` +
        `close(){if(this.destroyed)return;this.destroyed=true;for(const fn of this.listeners.closed??[])fn()}` +
        `showInactive(){this.shown=true}` +
        `getBounds(){return {...this.bounds}}` +
        `setBounds(bounds){this.bounds={...bounds}}` +
        `finishLoad(){for(const fn of this.pageListeners['did-finish-load']??[])fn()}` +
      `}` +
      `exports.BrowserWindow=BrowserWindow;` +
      `const handlers={};exports.__ipcHandlers=handlers;` +
      `exports.ipcMain={on:(channel,fn)=>{handlers[channel]=fn},handle:(channel,fn)=>{handlers[channel]=fn}};` +
      `exports.screen={getPrimaryDisplay:()=>({workArea:{x:0,y:0,width:1920,height:1040}})};` +
      `exports.clipboard={writeText:()=>{}};` +
      `exports.shell={openPath:()=>Promise.resolve('')};\n`,
  )
  const bundle = path.join(work, 'check.mjs')
  execFileSync(
    process.execPath,
    [
      path.join(here, '..', 'node_modules', 'esbuild', 'bin', 'esbuild'),
      path.join(here, 'action-pipeline-check.ts'),
      '--bundle',
      '--platform=node',
      '--format=esm',
      `--outfile=${bundle}`,
      `--alias:electron=${stub}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  execFileSync(process.execPath, [bundle], { stdio: 'inherit' })
} finally {
  rmSync(work, { recursive: true, force: true })
}
