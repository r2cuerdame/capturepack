// Bundles the production helpers so this check cannot drift from them. The
// Electron stub supplies a private userData directory and a safeStorage
// implementation that deterministically rejects the stored ciphertext.
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
    `exports.app={getPath:()=>${JSON.stringify(path.join(work, 'user-data'))}};` +
      `exports.safeStorage={` +
        `isEncryptionAvailable:()=>true,` +
        `encryptString:value=>Buffer.from(value,'utf8'),` +
        `decryptString:()=>{throw new Error('simulated decryption failure')}` +
      `};\n`,
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
