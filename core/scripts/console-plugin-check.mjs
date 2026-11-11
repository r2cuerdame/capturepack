import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const pluginUrl = pathToFileURL(path.resolve('src/main/plugins/console.ts'))
const {
  collectConsoleOutput,
  consolePluginDeclaration,
  tryWriteConsolePlugin,
} = await import(pluginUrl.href)
const root = await mkdtemp(path.join(tmpdir(), 'capturepack-console-plugin-'))
let failed = 0
function check(name, condition) {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`)
  if (!condition) failed += 1
}

try {
  const source = `first\n${Array.from({ length: 110 }, (_, i) => `line-${i}`).join('\n')}\npassword=hunter2\n{"password":"jsonSecret","access_token":"jsonToken"}`
  const output = await collectConsoleOutput(async () => source)
  const successRoot = path.join(root, 'success')
  await mkdir(successRoot)
  const written = await tryWriteConsolePlugin(successRoot, output)
  const pluginDir = path.join(successRoot, 'plugins', 'console')
  const metadata = JSON.parse(await readFile(path.join(pluginDir, 'meta.json'), 'utf8'))
  const state = JSON.parse(await readFile(path.join(pluginDir, 'state.json'), 'utf8'))
  const log = await readFile(path.join(pluginDir, 'output.log'), 'utf8')
  const declaration = consolePluginDeclaration()
  const exporterSource = await readFile(path.resolve('src/main/exporter.ts'), 'utf8')
  const successfulContract = written
    && metadata.name === declaration.name && metadata.version === declaration.version
    && state.lines <= 100 && Buffer.byteLength(log) <= 256 * 1024
    && log.includes('[REDACTED]') && !log.includes('hunter2')
    && log.includes('"password":"[REDACTED]"')
    && log.includes('"access_token":"[REDACTED]"')
    && !log.includes('jsonSecret') && !log.includes('jsonToken')
    && log.includes('line-109') && !/^line-0$/mu.test(log)
  if (!successfulContract) {
    console.log('DETAIL console success:', JSON.stringify({
      written,
      metadataMatches: metadata.name === declaration.name && metadata.version === declaration.version,
      lines: state.lines,
      bytes: Buffer.byteLength(log),
      redacted: log.includes('[REDACTED]'),
      originalSecretAbsent: !log.includes('hunter2'),
      jsonValuesAbsent: !log.includes('jsonSecret') && !log.includes('jsonToken'),
      latestLinePresent: log.includes('line-109'),
      oldestLineAbsent: !/^line-0$/mu.test(log),
    }))
  }
  check('successful capture writes bounded plugin payload and metadata', written
    && successfulContract)
  check('manifest declaration uses the payload directory', declaration.path === 'plugins/console/')
  check('save-first capture declares console only after a successful plugin write',
    exporterSource.includes('const consoleOutput = await collectConsoleOutput()')
      && exporterSource.includes('if (await tryWriteConsolePlugin(dirPath, consoleOutput))')
      && exporterSource.includes('consoleDeclaration = consolePluginDeclaration()')
      && exporterSource.includes('capturePlugins.length > 0 ? capturePlugins : undefined'))

  const jsonCredentials = await collectConsoleOutput(async () =>
    '{"password":"hunter2","access_token":"abcd"}')
  check('quoted JSON credential keys and values are redacted', jsonCredentials !== null
    && jsonCredentials.output.includes('"password":"[REDACTED]"')
    && jsonCredentials.output.includes('"access_token":"[REDACTED]"')
    && !jsonCredentials.output.includes('hunter2') && !jsonCredentials.output.includes('abcd'))

  const newestTail = await collectConsoleOutput(async () => `${'界'.repeat(90_000)}\nLATEST LINE`)
  check('UTF-8 byte bound retains the newest complete line and includes its final newline',
    newestTail !== null && newestTail.output.endsWith('LATEST LINE\n')
      && Buffer.byteLength(newestTail.output, 'utf8') <= 256 * 1024
      && !newestTail.output.includes('\uFFFD') && newestTail.truncated)

  const absent = await collectConsoleOutput(async () => null)
  const denied = await collectConsoleOutput(async () => { throw new Error('access denied') })
  const absentRoot = path.join(root, 'absent')
  await mkdir(absentRoot)
  check('absent or inaccessible console output is omitted without creating a plugin', absent === null
    && denied === null
    && !await tryWriteConsolePlugin(absentRoot, absent)
    && !(await readdir(absentRoot)).includes('plugins'))

  const timedOut = await collectConsoleOutput(() => new Promise(() => {}), 15)
  const timeoutRoot = path.join(root, 'timeout')
  await mkdir(timeoutRoot)
  check('collection exceeding its deadline is abandoned and omitted', timedOut === null
    && !await tryWriteConsolePlugin(timeoutRoot, timedOut)
    && !(await readdir(timeoutRoot)).includes('plugins'))

  const failureRoot = path.join(root, 'failure')
  await mkdir(path.join(failureRoot, 'plugins', 'console', 'state.json'), { recursive: true })
  const failureResult = await tryWriteConsolePlugin(failureRoot, output)
  const remainingPlugins = await readdir(path.join(failureRoot, 'plugins'))
  check('write failure is fail-open and removes temporary and unpublished plugin files', !failureResult
    && remainingPlugins.length === 0)
} finally {
  await rm(root, { recursive: true, force: true })
}

if (failed > 0) process.exitCode = 1
