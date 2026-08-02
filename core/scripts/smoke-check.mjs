import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { terminateProcessTree } from './process-tree.mjs'

const profile = mkdtempSync(join(tmpdir(), 'capturepack-smoke-'))
// Electron 42+ downloads its development binary lazily when the package is
// first resolved. Requiring the package supports both a fresh `npm ci` and an
// already-warmed checkout; hard-coding dist/electron.exe does not.
const require = createRequire(import.meta.url)
const electron = require('electron')

let child = null
let timedOut = false

async function stopChildTree(target) {
  if (
    target === null ||
    target.exitCode !== null ||
    target.signalCode !== null
  ) {
    return
  }
  const killer = terminateProcessTree(target)
  if (killer !== null) {
    await Promise.race([
      new Promise((resolve) => {
        killer.once('close', resolve)
        killer.once('error', resolve)
      }),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ])
  }
  await Promise.race([
    new Promise((resolve) => target.once('close', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ])
}

try {
  child = spawn(
    electron,
    [
      '.',
      '--smoke',
      `--user-data-dir=${profile}`,
      '--no-global-shortcut',
      '--no-login-item',
    ],
    {
      cwd: process.cwd(),
      stdio: 'inherit',
      windowsHide: true,
    },
  )

  const exit = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  const timeout = new Promise((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true
      resolve({ code: null, signal: 'TIMEOUT' })
    }, 30_000)
    timer.unref()
  })
  const result = await Promise.race([exit, timeout])
  if (timedOut) {
    await stopChildTree(child)
    throw new Error('isolated Electron smoke timed out after 30000 ms')
  }
  if (result.code !== 0) {
    throw new Error(
      `isolated Electron smoke exited with ${String(result.code)} (${String(result.signal)})`,
    )
  }
  console.log('isolated Electron smoke ok')
} finally {
  await stopChildTree(child)
  rmSync(profile, { recursive: true, force: true })
}
