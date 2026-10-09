// Minimal deterministic Matroska/AVC fixtures for ownership/container tests.
// NAL bytes are structural fixtures, not claimed to be decodable video.
export const join = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) { out.set(p, offset); offset += p.length }
  return out
}
const id = value => {
  let hex = value.toString(16); if (hex.length % 2) hex = '0' + hex
  return Uint8Array.from(Buffer.from(hex, 'hex'))
}
export function size(value, width = 0) {
  const n = BigInt(value)
  if (!width) { width = 1; while (n >= (1n << BigInt(width * 7)) - 1n) width++ }
  if (width > 8 || n < 0n || n >= (1n << BigInt(width * 7)) - 1n) throw Error('fixture size')
  let v = n | (1n << BigInt(width * 7))
  const result = new Uint8Array(width)
  for (let i = width - 1; i >= 0; i--) { result[i] = Number(v & 255n); v >>= 8n }
  return result
}
export const element = (identifier, ...parts) => {
  const data = join(...parts)
  return join(id(identifier), size(data.length), data)
}
export function integer(value) {
  let n = BigInt(value), width = 1
  while (n >= 1n << BigInt(width * 8)) width++
  const result = new Uint8Array(width)
  for (let i = width - 1; i >= 0; i--) { result[i] = Number(n & 255n); n >>= 8n }
  return result
}
export const unknown = identifier => join(id(identifier), new Uint8Array([1,255,255,255,255,255,255,255]))
export const text = value => new TextEncoder().encode(value)
export const sps = new Uint8Array([0x67,0x42,0,0x1e])
export const pps = new Uint8Array([0x68,0xce,0x06,0xe2])
export const avcC = join(new Uint8Array([1,0x42,0,0x1e,255,225,0,4]),sps,new Uint8Array([1,0,4]),pps)
export const startCode = new Uint8Array([0,0,0,1])
export const nal = (key = true, bytes = new Uint8Array([0x88,0,0])) => join(new Uint8Array([key ? 0x65 : 0x41]),bytes)
export function annexSample(key = true, bytes) {
  const media = nal(key,bytes)
  return key ? join(startCode,sps,startCode,pps,startCode,media) : join(startCode,media)
}
export const avccSample = (key = true) => join(new Uint8Array([0,0,0,4]),nal(key))
export function prefix({ codecPrivate, track = 1, type = 1 } = {}) {
  return join(element(0x1a45dfa3),unknown(0x18538067),
    element(0x1549a966,element(0x2ad7b1,integer(1_000_000))),
    element(0x1654ae6b,element(0xae,
      element(0xd7,integer(track)),element(0x83,integer(type)),
      element(0x86,text('V_MPEG4/ISO/AVC')),
      ...(codecPrivate ? [element(0x63a2,codecPrivate)] : []),
      element(0xe0,element(0xb0,integer(16)),element(0xba,integer(16))))))
}
export function block(time = 0, key = true, { payload = annexSample(key), flags, track = 1, identifier = 0xa3 } = {}) {
  const clock = new Uint8Array(2)
  new DataView(clock.buffer).setInt16(0,time)
  return element(identifier,size(track),clock,new Uint8Array([flags ?? (key ? 0x80 : 0)]),payload)
}
export function cluster(timestamp, blocks, { known = false, missing = 0 } = {}) {
  const body = join(element(0xe7,integer(timestamp)),...blocks)
  return known ? join(id(0x1f43b675),size(body.length + missing),body) :
    join(unknown(0x1f43b675),body)
}
export const stream = (blocks = [block(0,true),block(67,false),block(134,true)], timestamp = 0) =>
  join(prefix(),cluster(timestamp,blocks))
