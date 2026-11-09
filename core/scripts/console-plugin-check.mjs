import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const work = mkdtempSync(path.join(tmpdir(), 'capturepack-console-plugin-'))
const bundle = path.join(work, 'console.cjs')
try {
  execFileSync(process.execPath, [
    path.join(here, '..', 'node_modules', 'esbuild', 'bin', 'esbuild'),
    path.join(here, '..', 'src', 'main', 'plugins', 'console.ts'),
    '--bundle', '--platform=node', '--format=cjs', `--outfile=${bundle}`,
  ], { stdio: 'inherit' })
  const require = createRequire(import.meta.url)
  const { collectConsoleOutput, writeConsolePlugin, consolePluginDeclaration, CONSOLE_PLUGIN_MAX_OUTPUT_BYTES } = require(bundle)
  const output = await collectConsoleOutput(() => ({
    stdout: `first\n${Array.from({ length: 105 }, (_, i) => `line-${i}`).join('\n')}\napi_key=supersecret`,
    stderr: 'Bearer abc.def.ghi\npassword: hidden',
  }))
  assert(output)
  assert.equal(output.lineCount, 100)
  assert(Buffer.byteLength(output.output) <= CONSOLE_PLUGIN_MAX_OUTPUT_BYTES)
  assert(!output.output.includes('supersecret'))
  assert(!output.output.includes('abc.def.ghi'))
  assert(!output.output.includes('hidden'))
  assert(output.output.includes('line-104'))
  assert.equal(await collectConsoleOutput(() => new Promise(() => {}), 20), null)
  assert.equal(await collectConsoleOutput(() => { throw new Error('unavailable') }), null)
  assert.equal(await collectConsoleOutput(() => null), null)
  assert.equal(await collectConsoleOutput(undefined), null)
  const oversized = await collectConsoleOutput(() => ({ stdout: 'x'.repeat(CONSOLE_PLUGIN_MAX_OUTPUT_BYTES * 2) }))
  assert(oversized)
  assert(Buffer.byteLength(oversized.output) <= CONSOLE_PLUGIN_MAX_OUTPUT_BYTES + 1)
  assert(oversized.output.length > 0)
  const pack = path.join(work, 'pack')
  await writeConsolePlugin(pack, output)
  const root = path.join(pack, 'plugins', 'console')
  const meta = JSON.parse(readFileSync(path.join(root, 'meta.json'), 'utf8'))
  const state = JSON.parse(readFileSync(path.join(root, 'state.json'), 'utf8'))
  assert.equal(meta.name, 'console')
  assert.equal(state.line_count, 100)
  assert.equal(readFileSync(path.join(root, 'output.log'), 'utf8'), output.output)
  assert.equal(consolePluginDeclaration().path, 'plugins/console/')
  console.log('PASS collects bounded, redacted stdout and stderr')
  console.log('PASS times out, throws, and missing collectors fail open')
  console.log('PASS writes SPEC plugin files and manifest declaration')
} finally {
  rmSync(work, { recursive: true, force: true })
}
