// Physical-byte stress for the shipped streaming parser and MP4 ring.
// Structural AVC samples are deliberately synthetic. This does not establish
// Chromium encoder/GPU stability, decoding, installed-app RSS or wall-clock soak.
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prefix, cluster, block, annexSample } from './avc-remux-fixture.mjs'
const core=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const out=resolve(core,'out/issue-243/cumulative/modules.cjs')
mkdirSync(dirname(out),{recursive:true})
buildSync({stdin:{contents:"export * from './src/renderer/capture/avcMatroskaRemuxer.ts'; export * from './src/renderer/capture/fragmentedMp4Ring.ts'",resolveDir:core,loader:'ts'},outfile:out,bundle:true,platform:'node',format:'cjs'})
const {AvcMatroskaRemuxer,FragmentedMp4Ring}=createRequire(import.meta.url)(out)
const mux=new AvcMatroskaRemuxer(8*1024*1024)
const ring=new FragmentedMp4Ring(30000,6_000_000)
const filler=new Uint8Array(1024*1024).fill(0x55)
const payload=annexSample(true,filler)
let inputBytes=0n,outputBytes=0n,peakRemux=0,peakRing=0,parts=0
const push=bytes=>{
  inputBytes+=BigInt(bytes.length)
  for(const chunk of mux.pushBytes(bytes,clock)){
    outputBytes+=BigInt(chunk.bytes.length);parts++
    ring.pushBytes(chunk.bytes,chunk.endAtMs)
  }
  const stats=mux.stats(), retained=stats.pendingBytes+stats.sampleBytes
  peakRemux=Math.max(peakRemux,retained)
  const rs=ring.stats();peakRing=Math.max(peakRing,rs.retainedBytes)
  assert.ok(retained<=8*1024*1024)
  assert.ok(rs.retainedBytes<=rs.retainedBudgetBytes)
}
const started=performance.now()
let clock=1000
push(prefix())
for(let n=0;n<4100;n++){
  clock=1000+n*200
  push(cluster(n*200,[block(0,true,{payload})]))
}
for(const chunk of mux.finish(clock)){outputBytes+=BigInt(chunk.bytes.length);parts++;ring.pushBytes(chunk.bytes,chunk.endAtMs)}
assert.ok(inputBytes>0x1_0000_0000n)
assert.ok(outputBytes>0x1_0000_0000n)
assert.equal(mux.stats().position,inputBytes)
assert.equal(mux.stats().outputBytes,outputBytes)
assert.equal(mux.stats().emittedSamples,4100n)
assert.equal(mux.stats().pendingBytes+mux.stats().sampleBytes,0)
const replay=ring.assemble(clock)
assert.ok(replay && replay.buffer.byteLength>0)
const retained=ring.stats().retainedBytes
ring.clear();mux.clear()
assert.equal(ring.stats().retainedBytes,0)
console.log(JSON.stringify({result:'PASS',scope:'actual physical bytes through production parser/ring, synthetic structural AVC; no native encoder/decoder/elapsed-soak claim',
  inputBytes:String(inputBytes),outputBytes:String(outputBytes),samples:4100,parts,
  peakRemuxBytes:peakRemux,peakRingBytes:peakRing,finalRetainedBytes:retained,
  replayBytes:replay.buffer.byteLength,wallMs:Math.round(performance.now()-started)},null,2))
