// Bundles the production pure helpers so this check cannot drift from them.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const work = mkdtempSync(path.join(tmpdir(), 'capturepack-settings-limits-'))
try {
  const electronStub = path.join(work, 'electron-stub.cjs')
  writeFileSync(
    electronStub,
    `const defaultUserData = ${JSON.stringify(path.join(work, 'user-data'))};\n` +
      `const defaultDesktop = ${JSON.stringify(path.join(work, 'desktop'))};\n` +
      `exports.app = {\n` +
      `  getPath: (name) =>\n` +
      `    name === 'desktop'\n` +
      `      ? (process.env.CAPTUREPACK_TEST_DESKTOP || defaultDesktop)\n` +
      `      : (process.env.CAPTUREPACK_TEST_USER_DATA || defaultUserData),\n` +
      `};\n`,
  )
  const fsStub = path.join(work, 'fs-stub.cjs')
  writeFileSync(
    fsStub,
    `const realFs = require('fs');\n` +
      `const hooks = { readFileSync: null, existsSync: null, lstatSync: null };\n` +
      `const proxy = { ...realFs };\n` +
      `proxy.readFileSync = (...args) =>\n` +
      `  hooks.readFileSync ? hooks.readFileSync(() => realFs.readFileSync(...args), args[0]) : realFs.readFileSync(...args);\n` +
      `proxy.existsSync = (...args) =>\n` +
      `  hooks.existsSync ? hooks.existsSync(() => realFs.existsSync(...args), args[0]) : realFs.existsSync(...args);\n` +
      `proxy.lstatSync = (...args) =>\n` +
      `  hooks.lstatSync ? hooks.lstatSync(() => realFs.lstatSync(...args), args[0]) : realFs.lstatSync(...args);\n` +
      `globalThis.__capturepackFsHooks = hooks;\n` +
      `module.exports = proxy;\n`,
  )
  const bundle = path.join(work, 'check.cjs')
  execFileSync(
    process.execPath,
    [
      path.join(here, '..', 'node_modules', 'esbuild', 'bin', 'esbuild'),
      path.join(here, 'settings-limits-check.ts'),
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--outfile=${bundle}`,
      `--alias:electron=${electronStub}`,
      `--alias:node:fs=${fsStub}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  execFileSync(process.execPath, [bundle], { stdio: 'inherit' })
} finally {
  rmSync(work, { recursive: true, force: true })
}
