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
  const blankLinesRoot = path.join(root, 'blank-lines')
  await mkdir(blankLinesRoot)
  const blankLinesOutput = { output: 'first\n\nthird\n', source: 'environment', truncated: false }
  await tryWriteConsolePlugin(blankLinesRoot, blankLinesOutput)
  const blankLinesState = JSON.parse(await readFile(
    path.join(blankLinesRoot, 'plugins', 'console', 'state.json'), 'utf8'))
  const blankLinesLog = await readFile(path.join(blankLinesRoot, 'plugins', 'console', 'output.log'), 'utf8')
  check('console state counts blank log lines without counting the final newline',
    blankLinesState.lines === 3 && blankLinesLog === blankLinesOutput.output)
  const exactHundredLines = await collectConsoleOutput(async () =>
    `${Array.from({ length: 100 }, (_, i) => `line-${i}`).join('\n')}\n`)
  const exactHundredRows = exactHundredLines?.output
    .replace(/\r?\n$/u, '').split(/\r?\n/u) ?? []
  check('exactly 100 console lines preserve the first row and remain untruncated',
    exactHundredLines !== null && !exactHundredLines.truncated
      && exactHundredRows.length === 100
      && exactHundredRows[0] === 'line-0' && exactHundredRows[99] === 'line-99')
  const overHundredLines = await collectConsoleOutput(async () =>
    `${Array.from({ length: 110 }, (_, i) => `line-${i}`).join('\n')}\n`)
  const overHundredRows = overHundredLines?.output
    .replace(/\r?\n$/u, '').split(/\r?\n/u) ?? []
  check('over 100 console lines retain the newest 100 rows and report truncation',
    overHundredLines !== null && overHundredLines.truncated
      && overHundredRows.length === 100
      && overHundredRows[0] === 'line-10' && overHundredRows[99] === 'line-109')

  const hundredWithBlank = [...Array.from({ length: 99 }, (_, i) => 'line-' + i), '']
  const hundredTenWithBlank = [...Array.from({ length: 109 }, (_, i) => 'line-' + i), '']
  const newestHundredWithBlank = [...Array.from({ length: 99 }, (_, i) => 'line-' + (i + 10)), '']
  const trailingBlankCases = [
    { name: 'one trailing blank row', rows: ['first', ''], expected: 'first\n\n', lines: 2, truncated: false },
    { name: 'multiple trailing blank rows', rows: ['first', '', ''], expected: 'first\n\n\n', lines: 3, truncated: false },
    { name: '100 rows ending in a blank', rows: hundredWithBlank,
      expected: hundredWithBlank.join('\n') + '\n', lines: 100, truncated: false },
    { name: '110 rows ending in a blank', rows: hundredTenWithBlank,
      expected: newestHundredWithBlank.join('\n') + '\n', lines: 100, truncated: true },
  ]
  for (const [endingName, ending] of [['LF', '\n'], ['CRLF', '\r\n']]) {
    for (const [index, fixture] of trailingBlankCases.entries()) {
      const collected = await collectConsoleOutput(async () => fixture.rows.join(ending) + ending)
      const caseRoot = path.join(root, 'trailing-blank-' + endingName + '-' + index)
      await mkdir(caseRoot)
      const published = await tryWriteConsolePlugin(caseRoot, collected)
      const caseDir = path.join(caseRoot, 'plugins', 'console')
      const storedLog = published ? await readFile(path.join(caseDir, 'output.log'), 'utf8') : null
      const storedState = published
        ? JSON.parse(await readFile(path.join(caseDir, 'state.json'), 'utf8')) : null
      check('collection and publication preserve ' + fixture.name + ' (' + endingName + ')',
        published && collected?.output === fixture.expected
          && collected.truncated === fixture.truncated
          && storedLog === fixture.expected && storedState.lines === fixture.lines
          && storedState.truncated === fixture.truncated
          && storedState.bytes === Buffer.byteLength(fixture.expected, 'utf8')
          && storedState.bytes <= 256 * 1024)
    }
  }
  for (const [index, emptyInput] of ['', '\n', '\n\n', '\r\n', '\r\n\r\n',
    'older\n' + '\n'.repeat(110)].entries()) {
    const collected = await collectConsoleOutput(async () => emptyInput)
    const caseRoot = path.join(root, 'empty-output-' + index)
    await mkdir(caseRoot)
    check('empty or newline-only retained output creates no plugin (case ' + index + ')',
      collected === null && !await tryWriteConsolePlugin(caseRoot, collected)
        && !(await readdir(caseRoot)).includes('plugins'))
  }
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

  const cutCredential = await collectConsoleOutput(async () =>
    'password=hunter2\n' + 'x'.repeat(262135))
  check('input truncation drops an incomplete credential line before redaction',
    cutCredential !== null && !cutCredential.output.includes('hunter2')
      && cutCredential.output.endsWith('\n') && cutCredential.truncated)

  const inputLimit = 256 * 1024
  const inputBoundaryCases = []
  for (const [endingName, ending] of [['LF', '\n'], ['CRLF', '\r\n']]) {
    const alignedTail = ['first', 'password=' + 'x'.repeat(inputLimit - 18 - 3 * ending.length),
      'last'].join(ending) + ending
    const partialTail = ['partial-token', 'first',
      'password=' + 'x'.repeat(inputLimit - 31 - 4 * ending.length), 'last'].join(ending) + ending
    assert.equal(alignedTail.length, inputLimit)
    assert.equal(partialTail.length, inputLimit)
    inputBoundaryCases.push(
      { name: 'a complete first row at the input boundary (' + endingName + ')',
        input: 'old' + ending + alignedTail },
      { name: 'a complete first row with the full look-behind budget (' + endingName + ')',
        input: 'o'.repeat(inputLimit - ending.length) + ending + alignedTail },
      { name: 'only complete rows after a partial credential (' + endingName + ')',
        input: 'password=discarded-' + partialTail },
    )
  }
  for (const [boundaryName, prefix, remainingBreak] of [
    ['before CR', 'password=discarded-token', '\r\n'],
    ['between CR and LF', 'password=discarded-token\r', '\n'],
  ]) {
    const tail = remainingBreak + ['first',
      'password=' + 'x'.repeat(inputLimit - 24 - remainingBreak.length), 'last'].join('\r\n') + '\r\n'
    assert.equal(tail.length, inputLimit)
    inputBoundaryCases.push({ name: 'complete rows when input is cut ' + boundaryName,
      input: prefix + tail })
  }
  const expectedBoundaryLog = 'first\npassword=[REDACTED]\nlast\n'
  for (const [index, fixture] of inputBoundaryCases.entries()) {
    const collected = await collectConsoleOutput(async () => fixture.input)
    const caseRoot = path.join(root, 'input-boundary-' + index)
    await mkdir(caseRoot)
    const published = await tryWriteConsolePlugin(caseRoot, collected)
    const caseDir = path.join(caseRoot, 'plugins', 'console')
    const storedLog = published ? await readFile(path.join(caseDir, 'output.log'), 'utf8') : null
    const storedState = published
      ? JSON.parse(await readFile(path.join(caseDir, 'state.json'), 'utf8')) : null
    check('collection and publication preserve ' + fixture.name,
      published && collected?.output === expectedBoundaryLog && collected.truncated
        && storedLog === expectedBoundaryLog && storedState.lines === 3 && storedState.truncated
        && storedState.bytes === Buffer.byteLength(expectedBoundaryLog, 'utf8')
        && storedState.bytes <= inputLimit)
  }

  for (const [endingName, ending] of [['LF', '\n'], ['CRLF', '\r\n']]) {
    const credentialBoundaryCases = [
      { name: 'password assignment', prefix: 'password=' + ending,
        value: 'boundarySecret', redacted: '[REDACTED]' },
      { name: 'password assignment using the full look-behind budget',
        prefix: 'password=' + ' '.repeat(inputLimit - 9 - ending.length) + ending,
        value: 'boundarySecret', redacted: '[REDACTED]' },
      { name: 'assignment separated by blank rows', prefix: 'access_token= \t' + ending.repeat(3),
        value: 'boundarySecret', redacted: '[REDACTED]' },
      { name: 'JSON credential', prefix: '{"password":' + ending,
        value: '"boundarySecret"', redacted: '"[REDACTED]"' },
      { name: 'bearer token', prefix: 'Authorization: Bearer' + ending,
        value: 'boundarySecret', redacted: '[REDACTED]' },
    ]
    for (const [index, fixture] of credentialBoundaryCases.entries()) {
      const emptyTail = [fixture.value, 'password=', 'last'].join(ending) + ending
      const retainedTail = [fixture.value, 'password=' + 'x'.repeat(inputLimit - emptyTail.length),
        'last'].join(ending) + ending
      assert.equal(retainedTail.length, inputLimit)
      const expectedLog = fixture.redacted + '\npassword=[REDACTED]\nlast\n'
      const untruncated = await collectConsoleOutput(async () => fixture.prefix + fixture.value)
      const collected = await collectConsoleOutput(async () => fixture.prefix + retainedTail)
      const caseRoot = path.join(root, 'credential-boundary-' + endingName + '-' + index)
      await mkdir(caseRoot)
      const published = await tryWriteConsolePlugin(caseRoot, collected)
      const caseDir = path.join(caseRoot, 'plugins', 'console')
      const storedLog = published ? await readFile(path.join(caseDir, 'output.log'), 'utf8') : null
      const storedState = published
        ? JSON.parse(await readFile(path.join(caseDir, 'state.json'), 'utf8')) : null
      check('collection and publication redact a boundary-aligned ' + fixture.name + ' (' + endingName + ')',
        untruncated !== null && !untruncated.output.includes('boundarySecret')
          && published && collected?.output === expectedLog && collected.truncated
          && storedLog === expectedLog && !storedLog.includes('boundarySecret')
          && storedState.lines === 3 && storedState.truncated
          && storedState.bytes === Buffer.byteLength(expectedLog, 'utf8')
          && storedState.bytes <= inputLimit)
    }
    const unsafeContextCases = [
      { name: 'a quoted credential that rewrites the retained boundary',
        prefix: 'password="prefix-first' + ending + 'prefix-second' + ending,
        value: 'boundarySecret"' },
      { name: 'credential context beyond the bounded whitespace look-behind',
        prefix: 'password=' + ending.repeat(inputLimit), value: 'boundarySecret' },
      { name: 'a password key clipped immediately before its equals sign',
        prefix: 'password=' + ' '.repeat(inputLimit - 1 - ending.length) + ending,
        value: 'boundarySecret' },
      { name: 'a partially clipped password key',
        prefix: 'password=' + ' '.repeat(inputLimit - 7 - ending.length) + ending,
        value: 'boundarySecret' },
      { name: 'a partially clipped JSON credential key',
        prefix: '{"password":' + ' '.repeat(inputLimit - 7 - ending.length) + ending,
        value: '"boundarySecret"' },
      { name: 'a partially clipped bearer prefix',
        prefix: 'Authorization: Bearer' + ' '.repeat(inputLimit - 4 - ending.length) + ending,
        value: 'boundarySecret' },
      { name: 'a clipped key before a quoted multiline credential',
        prefix: 'password="' + 'q'.repeat(inputLimit - 1 - ending.length) + ending,
        value: 'boundarySecret"' },
    ]
    for (const [index, fixture] of unsafeContextCases.entries()) {
      const emptyTail = [fixture.value, 'password=', 'last'].join(ending) + ending
      const retainedTail = [fixture.value, 'password=' + 'x'.repeat(inputLimit - emptyTail.length),
        'last'].join(ending) + ending
      assert.equal(retainedTail.length, inputLimit)
      const collected = await collectConsoleOutput(async () => fixture.prefix + retainedTail)
      const caseRoot = path.join(root, 'unsafe-context-' + endingName + '-' + index)
      await mkdir(caseRoot)
      check('unsafe ' + fixture.name + ' omits the optional plugin (' + endingName + ')',
        collected === null && !await tryWriteConsolePlugin(caseRoot, collected)
          && !(await readdir(caseRoot)).includes('plugins'))
    }
  }

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
