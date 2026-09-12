// Synthetic, numeric-only minidumps: no process memory or installed app access.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const identity = JSON.parse(readFileSync(new URL('../test/fixtures/issue243/crash-identities.json', import.meta.url)))
const inspector = fileURLToPath(new URL('./recorder-crash-inspect.mjs', import.meta.url))
function fixture(dump, overrides = {}) {
  const options = { module: identity.module, faultRva: identity.faultRva,
    guid: identity.codeViewGuidBytes, age: identity.codeViewAge,
    exception: 0x80000003, architecture: 9, cvSize: 24, cvRva: 1000,
    modules: 1, contextSize: 256, contextRva: 512, contextFlags: 0x100003, ...overrides }
  const data = Buffer.alloc(1400)
  const u32 = (at, value) => data.writeUInt32LE(value, at)
  const u64 = (at, value) => data.writeBigUInt64LE(BigInt(value), at)
  data.write('MDMP'); u32(8, 5); u32(12, 32)
  u32(20, Date.parse(dump.timestampUtc) / 1000)
  for (const [i, [type, size, rva]] of [[6, 168, 128], [7, 56, 304],
    [4, 112, 368], [5, 36, 800], [0, 0, 0]].entries()) {
    u32(32 + i * 12, type); u32(36 + i * 12, size); u32(40 + i * 12, rva)
  }
  u32(128, 42); u32(136, options.exception)
  const base = 0x7ff600000000n
  u64(152, base + BigInt(options.faultRva))
  u32(288, options.contextSize); u32(292, options.contextRva)
  data.writeUInt16LE(options.architecture, 304)
  u32(368, options.modules); u64(372, base); u32(380, 0x8000000); u32(392, 900)
  u32(448, options.cvSize); u32(452, options.cvRva)
  const name = Buffer.from(options.module, 'utf16le')
  u32(900, name.length); name.copy(data, 904)
  data.write('RSDS', 1000); Buffer.from(options.guid, 'hex').copy(data, 1004); u32(1020, options.age)
  u32(560, options.contextFlags) // AMD64 control + integer context
  u64(632, dump.sum); u64(640, 1); u64(680, 0x10000); u64(688, 0x20000)
  u64(760, base + BigInt(options.faultRva))
  u32(800, 2); u64(804, 0x10000); u32(812, 4); u32(816, 1200)
  u64(820, 0x20000); u32(828, 16); u32(832, 1220)
  u32(1200, Number(dump.prior)); u64(1228, dump.incoming)
  return data
}
function inspect(dump, overrides, interpret = true) {
  const directory = mkdtempSync(join(tmpdir(), 'issue243-inspect-'))
  try {
    const path = join(directory, dump.name)
    writeFileSync(path, fixture(dump, overrides))
    const result = spawnSync(process.execPath, [inspector, path, ...(interpret ? ['--checked-u32-add'] : [])],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  } finally { rmSync(directory, { recursive: true, force: true }) }
}
for (const dump of identity.dumps) {
  test(`verified issue #243 identity and operands: ${dump.name}`, () => {
    const output = inspect(dump)
    assert.equal(output.faultModule.codeViewGuidBytes, identity.codeViewGuidBytes)
    assert.equal(output.faultModule.codeViewAge, 1)
    assert.equal(output.faultModule.rva, identity.faultRva)
    assert.equal(output.timestampUtc, new Date(dump.timestampUtc).toISOString())
    for (const key of ['prior', 'incoming', 'sum']) assert.equal(output.checkedU32Add[key], dump[key])
    assert.equal(output.checkedU32Add.sumMatchesRax, true)
    assert.equal(output.checkedU32Add.exceedsUint32, true)
  })
}
for (const [label, overrides] of [
  ['same-register unrelated breakpoint', { faultRva: '0x3b28d20' }],
  ['different exception', { exception: 0xc0000005 }],
  ['different module', { module: 'unrelated.exe' }],
  ['different CodeView GUID', { guid: '11111111111111111111111111111111' }],
  ['different CodeView age', { age: 2 }],
  ['missing CodeView', { cvSize: 0 }],
  ['out-of-file CodeView', { cvRva: 1390 }],
  ['out-of-file CodeView record extent', { cvSize: 1000 }],
  ['missing fault module', { modules: 0 }],
  ['non-AMD64 dump', { architecture: 0 }],
  ['unrelated site with unusable context', { faultRva: '0x3b28d20', contextSize: 0 }],
]) {
  test(`interpretation unavailable: ${label}`, () => {
    const output = inspect(identity.dumps[0], overrides)
    assert.equal(output.checkedU32Add.available, false)
    assert.match(output.checkedU32Add.reason, /verified.*(identity|site)/i)
    for (const key of ['prior', 'incoming', 'sum', 'rax', 'rcx', 'sumMatchesRax', 'exceedsUint32']) {
      assert.equal(Object.hasOwn(output.checkedU32Add, key), false, key)
    }
  })
}
test('metadata-only mode never interprets operands', () => {
  assert.equal(Object.hasOwn(inspect(identity.dumps[0], {}, false), 'checkedU32Add'), false)
})

for (const [label, overrides] of [
  ['control-only context with plausible operand slots', { contextFlags: 0x100001 }],
  ['missing context flags', { contextFlags: 0 }],
  ['integer flag without AMD64 context', { contextFlags: 2 }],
  ['truncated context', { contextSize: 128 }],
  ['context outside file', { contextRva: 1300 }],
  ['context extent outside file', { contextSize: 1000 }],
]) {
  test(`interpretation unavailable: ${label}`, () => {
    const output = inspect(identity.dumps[0], overrides)
    assert.equal(output.checkedU32Add.available, false)
    assert.match(output.checkedU32Add.reason, /context/i)
    for (const key of ['prior', 'incoming', 'sum', 'rax', 'rcx', 'sumMatchesRax', 'exceedsUint32']) {
      assert.equal(Object.hasOwn(output.checkedU32Add, key), false, key)
    }
  })
}

test('integer-only AMD64 context is sufficient for operand interpretation', () => {
  assert.equal(inspect(identity.dumps[0], { contextFlags: 0x100002 }).checkedU32Add.sumMatchesRax, true)
})
