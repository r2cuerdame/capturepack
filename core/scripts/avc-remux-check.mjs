import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildSync } from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { join, prefix, cluster, block, stream, size, element, unknown,
  annexSample, avccSample, avcC, sps, pps, startCode, nal } from './avc-remux-fixture.mjs'

const core = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const compiled = buildSync({ stdin: {
  contents: "export * from './src/renderer/capture/avcMatroskaRemuxer.ts'; export * from './src/renderer/capture/boundedBlobIngestQueue.ts'; export * from './src/renderer/capture/fragmentedMp4Ring.ts'",
  resolveDir: core, loader: 'ts',
}, bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
const sandbox = { module: { exports: {} }, exports: {}, Blob, Uint8Array, DataView, ArrayBuffer, TextEncoder, TextDecoder, console }
vm.runInNewContext(compiled,sandbox)
const { AvcMatroskaRemuxer: Muxer, BoundedBlobIngestQueue: Queue,
  commitRecorderBatchBeforeReplacement: commit, FragmentedMp4Ring: Ring } = sandbox.module.exports
const budget = 1024 * 1024
const complete = (bytes, chunkSize = bytes.length) => {
  const mux = new Muxer(budget)
  const output = []
  for (let i = 0; i < bytes.length; i += chunkSize) output.push(...mux.pushBytes(bytes.subarray(i,i+chunkSize),1000))
  output.push(...mux.finish(1000))
  return { mux, output, bytes: join(...output.map(x=>x.bytes)) }
}
function boxes(bytes,start = 0,end = bytes.length) {
  const result = []
  for(let i=start;i<end;) {
    const length = new DataView(bytes.buffer,bytes.byteOffset).getUint32(i)
    assert.ok(length >= 8 && i+length <= end)
    result.push({type:new TextDecoder().decode(bytes.subarray(i+4,i+8)),start:i,end:i+length})
    i+=length
  }
  return result
}
function times(bytes) {
  const result = []
  for (const moof of boxes(bytes).filter(x=>x.type==='moof')) {
    const traf = boxes(bytes,moof.start+8,moof.end).find(x=>x.type==='traf')
    const fields = boxes(bytes,traf.start+8,traf.end)
    const tfdt = fields.find(x=>x.type==='tfdt')
    const trun = fields.find(x=>x.type==='trun')
    const view = new DataView(bytes.buffer,bytes.byteOffset)
    assert.equal(bytes[tfdt.start+8],1,'uint64 decode time version')
    const offset = view.getUint32(trun.start+16)
    assert.equal(moof.start+offset,moof.end+8,'data offset addresses next mdat payload locally')
    result.push(view.getBigUint64(tfdt.start+12))
  }
  return result
}
test('incremental one-byte EBML headers preserve all MP4 bytes and final samples', () => {
  const fixture = stream()
  const whole = complete(fixture)
  for(const split of [1,2,3,7,31,97]) {
    const other = complete(fixture,split)
    assert.deepEqual(other.bytes,whole.bytes)
    assert.equal(other.mux.stats().emittedSamples,3n)
    assert.equal(other.mux.stats().pendingBytes+other.mux.stats().sampleBytes,0)
  }
})
test('actual production ring reads local-offset legal fMP4 and honest frame durations', () => {
  const {output} = complete(stream())
  const ring = new Ring(30000,6_000_000)
  for(const chunk of output) ring.pushBytes(chunk.bytes,chunk.endAtMs)
  assert.equal(ring.stats().timing.sampleCount,3)
  assert.equal(ring.stats().timing.maxSampleDurationMs,67)
  const replay = ring.assemble(1000)
  assert.ok(replay)
  assert.ok(replay.durationMs>=200 && replay.durationMs<=202)
  times(new Uint8Array(replay.buffer))
})
test('uint64 media clocks preserve a stream beyond the uint32 timestamp boundary', () => {
  const {bytes} = complete(stream(undefined,5_000_000))
  assert.equal(times(bytes)[0],5_000_000_000n)
})
test('Annex B three/four byte prefixes keep terminal zero and CABAC bytes intact', () => {
  const media = new Uint8Array([0x65,0x88,0,0])
  const mixed = join(new Uint8Array([0,0,1]),sps,startCode,pps,new Uint8Array([0,0,1]),media)
  const {bytes}=complete(stream([block(0,true,{payload:mixed})]))
  const mdat=boxes(bytes).find(x=>x.type==='mdat')
  assert.deepEqual(bytes.slice(mdat.start+8,mdat.end),join(new Uint8Array([0,0,0,4]),media))
})
test('AVCC CodecPrivate input stays legal MP4 with unchanged encoded sample bytes', () => {
  const {bytes,mux}=complete(join(prefix({codecPrivate:avcC}),cluster(0,[
    block(0,true,{payload:avccSample(true)}),block(67,false,{payload:avccSample(false)})])))
  const mdat=boxes(bytes).find(x=>x.type==='mdat')
  assert.deepEqual(bytes.slice(mdat.start+8,mdat.end),join(avccSample(true),avccSample(false)))
  assert.equal(mux.stats().emittedSamples,2n)
})
test('zero-byte stop finalizes previous samples in queue order before new session bytes', async () => {
  const old = new Muxer(budget), next = new Muxer(budget)
  const emitted = [], order = []
  const queue = new Queue(budget,(bytes,payload)=>{
    order.push(payload.name)
    emitted.push(...payload.mux.pushBytes(bytes,1000))
    if(payload.finish) emitted.push(...payload.mux.finish(1000))
  })
  assert.equal(queue.enqueue(new Blob([stream([block(0,true),block(67,false)])]),{name:'ordinary',mux:old}),true)
  const batch=queue.createBatch()
  const settled=commit(queue,batch,{name:'finish',mux:old,finish:true},()=>{
    assert.equal(queue.enqueue(new Blob([stream([block(0,true)])]),{name:'replacement',mux:next}),true)
  },true,true)
  assert.equal(await settled,true)
  await queue.flush()
  assert.deepEqual(order,['ordinary','finish','replacement'])
  assert.equal(old.stats().emittedSamples,2n)
  assert.equal(old.stats().sampleCount,0)
  queue.cancel();old.clear();next.clear()
})
test('empty barrier compatibility still avoids consumer and Blob conversion by default', async () => {
  let called=0
  const queue=new Queue(budget,()=>called++)
  const batch=queue.createBatch()
  assert.equal(await commit(queue,batch,{},()=>{},true),true)
  assert.equal(called,0)
})
test('cancellation prevents a pending empty finalizer from reaching discarded owners', async () => {
  let resolve
  class Delayed extends Blob { arrayBuffer() {return new Promise(r=>{resolve=r})} }
  const calls=[]
  const queue=new Queue(budget,(_b,p)=>calls.push(p))
  queue.enqueue(new Delayed([new Uint8Array([1])]),'ordinary')
  const batch=queue.createBatch()
  batch.commit('finish',true,true)
  queue.cancel()
  resolve(new Uint8Array([1]).buffer)
  await queue.flush()
  for(let n=0;n<4;n++)await Promise.resolve()
  assert.deepEqual(calls,[])
  assert.equal(queue.stats().activePayloadRetained,false)
})
test('clear synchronously releases GOP and incomplete input and rejects late reuse', () => {
  const mux=new Muxer(budget)
  mux.pushBytes(stream([block(0,true),block(67,false)]),1000)
  assert.equal(mux.stats().sampleCount,2)
  mux.pushBytes(new Uint8Array([0x1f]),1000)
  mux.clear()
  assert.equal(mux.stats().sampleBytes+mux.stats().pendingBytes+mux.stats().sampleCount,0)
  assert.throws(()=>mux.pushBytes(new Uint8Array(0),1000),/already finished/)
})
for(const [label,fixture,pattern] of [
  ['lacing',stream([block(0,true,{flags:0x82})]),/laced/],
  ['invisible block',stream([block(0,true,{flags:0x88})]),/invisible/],
  ['wrong track',stream([block(0,true,{track:2})]),/track/],
  ['non-video',join(prefix({type:2}),cluster(0,[block()])),/non-video/],
  ['missing keyframe',stream([block(0,false)]),/first AVC keyframe|begin at a keyframe/],
  ['reordered timestamps',stream([block(0,true),block(67,false),block(0,false)]),/decreasing/],
  ['missing timestamp',join(prefix(),unknown(0x1f43b675),block()),/precedes/],
  ['NAL length',join(prefix({codecPrivate:avcC}),cluster(0,[block(0,true,{payload:new Uint8Array([0,0,0,5,0x65])})])),/truncated AVC NAL/],
  ['parameter-set change',stream([block(0,true),block(67,true,{payload:join(startCode,new Uint8Array([0x67,0x42,0,0x1f]),startCode,pps,startCode,nal())})]),/parameter sets changed/],
]) test('fail closed: '+label,()=>assert.throws(()=>complete(fixture),pattern))
test('finish rejects an incomplete known-size Cluster even at an element boundary',()=>{
  const fixture=join(prefix(),cluster(0,[block(0,true),block(67,false)],{known:true,missing:4}))
  const mux=new Muxer(budget)
  mux.pushBytes(fixture,1000)
  assert.throws(()=>mux.finish(1000),/truncated final Matroska enclosure/)
})
test('complete known-size Cluster is accepted',()=>{
  const {mux}=complete(join(prefix(),cluster(0,[block(0,true)],{known:true})))
  assert.equal(mux.stats().emittedSamples,1n)
})
test('truncated final element and non-finite clocks reject',()=>{
  assert.throws(()=>complete(stream().subarray(0,stream().length-1)),/truncated final/)
  const mux=new Muxer(budget)
  assert.throws(()=>mux.pushBytes(new Uint8Array(0),NaN),/delivery clock/)
  assert.throws(()=>mux.finish(NaN),/delivery clock/)
})
test('byte and sample budgets refuse unbounded input and GOPs',()=>{
  const mux=new Muxer(65536)
  assert.throws(()=>mux.pushBytes(stream([block(0,true,{payload:annexSample(true,new Uint8Array(65537).fill(0x55))})]),1000),/byte budget/)
  const long=new Muxer(budget)
  long.pushBytes(prefix(),1000)
  for(let i=0;i<512;i++)long.pushBytes(cluster(i*67,[block(0,i===0)]),1000+i*67)
  assert.throws(()=>long.pushBytes(cluster(512*67,[block(0,false)]),1000),/sample budget/)
  assert.ok(long.stats().sampleCount<=512)
  long.clear()
})

test('a delayed delivery larger than the GOP budget streams without retaining its complete envelope',()=>{
  const payload=annexSample(true,new Uint8Array(400*1024).fill(0x55))
  const input=join(prefix(),...Array.from({length:8},(_,n)=>cluster(n*200,[block(0,true,{payload})])))
  assert.ok(input.length>budget)
  const mux=new Muxer(budget)
  const output=[...mux.pushBytes(input,1000),...mux.finish(1000)]
  assert.equal(mux.stats().emittedSamples,8n)
  assert.equal(mux.stats().position,BigInt(input.length))
  assert.equal(mux.stats().pendingBytes+mux.stats().sampleBytes,0)
  assert.equal(times(join(...output.map(x=>x.bytes))).length,8)
})

test('equal native startup timestamps preserve both samples without inventing time',()=>{
  let result
  assert.doesNotThrow(()=>{result=complete(stream([block(0,true),block(0,false),block(67,true)]))},'legal equal Matroska timestamps must preserve both samples')
  const {bytes,mux}=result
  assert.equal(mux.stats().emittedSamples,3n)
  const moof=boxes(bytes).find(x=>x.type==='moof')
  const traf=boxes(bytes,moof.start+8,moof.end).find(x=>x.type==='traf')
  const trun=boxes(bytes,traf.start+8,traf.end).find(x=>x.type==='trun')
  const view=new DataView(bytes.buffer,bytes.byteOffset)
  assert.equal(view.getUint32(trun.start+20),0)
  assert.equal(view.getUint32(trun.start+32),67000)
  const ring=new Ring(30000,6_000_000)
  for(const chunk of complete(stream([block(0,true),block(0,false),block(67,true)])).output)ring.pushBytes(chunk.bytes,chunk.endAtMs)
  assert.equal(ring.stats().timing.sampleCount,3)
})
