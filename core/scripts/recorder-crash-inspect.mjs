// Read-only minidump metadata for #243. Never opens an app, writes a dump,
// uploads memory, or prints arbitrary strings from process memory.
// Usage: node scripts/recorder-crash-inspect.mjs dump.dmp [...dump.dmp]
//   [--checked-u32-add]
// The optional operand interpretation is ONLY for the x64 instruction sequence
// independently disassembled in docs/recorder-status-breakpoint-243.md. It is
// not a symbolizer or a generic diagnosis of every STATUS_BREAKPOINT.
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const args = process.argv.slice(2)
const interpretCounter = args.includes('--checked-u32-add')
const paths = args.filter(arg => arg !== '--checked-u32-add')
if (paths.length === 0 || paths.some(arg => arg.startsWith('--'))) {
  throw new Error('Usage: recorder-crash-inspect.mjs dump.dmp [...] [--checked-u32-add]')
}
const hex = value => `0x${value.toString(16)}`
// Allow only the executable/site independently disassembled in the #243 notes.
// GUID is the RSDS on-disk byte order, not the display GUID's first three fields.
const verifiedSite = {
  exception: '0x80000003', module: 'CapturePack.exe', rva: '0x3b28d0a',
  codeViewGuidBytes: '0dff164f3181aab74c4c44205044422e', codeViewAge: 1,
}
for (const path of paths) {
  const data = readFileSync(path)
  const u32 = offset => data.readUInt32LE(offset)
  const u64 = offset => data.readBigUInt64LE(offset)
  if (data.toString('ascii', 0, 4) !== 'MDMP') throw new Error('Not a minidump')
  const streams = new Map()
  for (let index = 0; index < u32(8); index++) {
    const entry = u32(12) + index * 12
    const size = u32(entry + 4)
    const rva = u32(entry + 8)
    if (rva + size > data.length) throw new Error('Truncated stream')
    streams.set(u32(entry), { rva, size })
  }
  const exception = streams.get(6)?.rva
  const system = streams.get(7)?.rva
  if (exception === undefined || system === undefined) throw new Error('Missing exception/system stream')
  const address = u64(exception + 24)
  const moduleList = streams.get(4)?.rva
  let faultModule = null
  if (moduleList !== undefined) {
    for (let i = 0; i < u32(moduleList); i++) {
      const module = moduleList + 4 + 108 * i
      const base = u64(module)
      if (address < base || address >= base + BigInt(u32(module + 8))) continue
      const name = u32(module + 20)
      const cvSize = u32(module + 76)
      const cv = u32(module + 80)
      faultModule = {
        name: data.toString('utf16le', name + 4, name + 4 + u32(name)).split(/[\\/]/).at(-1),
        base: hex(base), rva: hex(address - base),
      }
      if (cvSize >= 24 && cv + cvSize <= data.length && data.toString('ascii', cv, cv + 4) === 'RSDS') {
        // CodeView GUID byte order as stored; suitable for exact identity
        // comparison without displaying the original build-machine PDB path.
        faultModule.codeViewGuidBytes = data.subarray(cv + 4, cv + 20).toString('hex')
        faultModule.codeViewAge = u32(cv + 20)
      }
      break
    }
  }
  const output = {
    dump: basename(path), bytes: data.length,
    timestampUtc: new Date(u32(20) * 1000).toISOString(),
    exception: hex(u32(exception + 8)), threadId: u32(exception),
    faultModule,
  }
  if (interpretCounter) {
    const siteMatches = data.readUInt16LE(system) === 9
      && output.exception === verifiedSite.exception
      && faultModule?.name === verifiedSite.module
      && faultModule.rva === verifiedSite.rva
      && faultModule.codeViewGuidBytes === verifiedSite.codeViewGuidBytes
      && faultModule.codeViewAge === verifiedSite.codeViewAge
    if (!siteMatches) {
      output.checkedU32Add = {
        available: false,
        reason: 'Independently verified #243 crash identity/site not established',
      }
    } else {
      const contextSize = u32(exception + 160)
      const context = u32(exception + 164)
      // A matching fault site does not make uncaptured integer registers valid.
      // Check the whole declared record before flags, then require AMD64 and
      // CONTEXT_INTEGER (control-only dumps may contain plausible stale slots).
      const integerContext = contextSize >= 256 && context + contextSize <= data.length
        && (u32(context + 48) & 0x100002) === 0x100002
      if (!integerContext) {
        output.checkedU32Add = {
          available: false,
          reason: 'Complete AMD64 integer context not established',
        }
        console.log(JSON.stringify(output, null, 2))
        continue
      }
      const ranges = []
      const memory = streams.get(5)?.rva
      if (memory !== undefined) {
        for (let i = 0; i < u32(memory); i++) {
          const entry = memory + 4 + i * 16
          ranges.push({ base: u64(entry), size: u32(entry + 8), rva: u32(entry + 12) })
        }
      }
      const memory64 = streams.get(9)?.rva
      if (memory64 !== undefined) {
        let rva = Number(u64(memory64 + 8))
        for (let i = 0; i < Number(u64(memory64)); i++) {
          const entry = memory64 + 16 + i * 16
          const size = Number(u64(entry + 8))
          ranges.push({ base: u64(entry), size, rva })
          rva += size
        }
      }
      const memoryAt = (address, size) => {
        const range = ranges.find(range => address >= range.base && address + BigInt(size) <= range.base + BigInt(range.size))
        if (!range) throw new Error('Counter operand was not included in dump memory')
        return range.rva + Number(address - range.base)
      }
      const prior = BigInt(u32(memoryAt(u64(context + 168), 4)))
      const incoming = u64(memoryAt(u64(context + 176) + 8n, 8))
      const sum = prior + incoming
      output.checkedU32Add = {
        interpretation: 'verified #243 site: mov [rsi]; add [rdi+8]; checked uint32 narrowing',
        prior: prior.toString(), incoming: incoming.toString(), sum: sum.toString(),
        rax: hex(u64(context + 120)), rcx: hex(u64(context + 128)),
        sumMatchesRax: sum === u64(context + 120),
        exceedsUint32: sum > 0xffff_ffffn,
      }
    }
  }
  console.log(JSON.stringify(output, null, 2))
}
