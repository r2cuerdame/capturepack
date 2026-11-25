import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const work = mkdtempSync(path.join(tmpdir(), 'capturepack-console-epipe-'))
let failed = 0
try {
  const stub = path.join(work, 'electron-stub.cjs')
  writeFileSync(
    stub,
    `exports.app={getPath:()=>process.env.CAPTUREPACK_LOG_CHECK_USERDATA,getVersion:()=>'0.0.0-check',on:()=>{}};` +
      `exports.crashReporter={start:()=>{}};\n`,
  )
  const bundle = path.join(work, 'check.cjs')
  execFileSync(
    process.execPath,
    [
      path.join(here, '..', 'node_modules', 'esbuild', 'bin', 'esbuild'),
      path.join(here, 'console-epipe-check.ts'),
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--outfile=${bundle}`,
      `--alias:electron=${stub}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  const userData = path.join(work, 'userData')
  const child = spawn(process.execPath, [bundle], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CAPTUREPACK_LOG_CHECK_USERDATA: userData },
  })
  child.stdout.destroy()
  child.stderr.destroy()
  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill()
      resolve('timeout')
    }, 20_000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
  const resultFile = path.join(userData, 'result.json')
  if (!existsSync(resultFile)) {
    console.log(`  FAIL  the app process reported nothing (exit ${String(exit)})`)
    failed += 1
  } else {
    for (const result of JSON.parse(readFileSync(resultFile, 'utf8'))) {
      if (!result.pass) failed += 1
      console.log(`  ${result.pass ? 'PASS' : 'FAIL'}  ${result.name}${result.detail === '' ? '' : ` — ${result.detail}`}`)
    }
  }
  if (exit !== 0) {
    console.log(`  FAIL  the app process exits 0 — exit ${String(exit)}`)
    failed += 1
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}
if (failed > 0) {
  console.error(`console-epipe-check: ${String(failed)} failure(s)`)
  process.exitCode = 1
} else {
  console.log('console-epipe-check ok')
}
