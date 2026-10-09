import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import * as esbuild from 'esbuild'

const core = path.resolve(import.meta.dirname, '..')
const output = path.join(core, 'out', 'issue-243', 'routing')
fs.mkdirSync(output, { recursive: true })
const bundle = path.join(output, 'formats.cjs')
await esbuild.build({ entryPoints: [path.join(core, 'src/renderer/capture/recorderFormats.ts')],
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs' })
const { pickRecorderFormat } = createRequire(import.meta.url)(bundle)
const source = fs.readFileSync(path.join(core, 'src/renderer/capture/capture.ts'), 'utf8')
const factory = source.slice(source.indexOf('function createRecorder('), source.indexOf('function startRecorder('))
const compiled = await esbuild.transform(factory, { loader: 'ts', target: 'es2022' })

class NativeRecorderModel {
  constructor(stream, options) { this.options = options; this.position = 0n; this.starts = 0 }
  start() { this.starts++ }
  write(bytes) {
    const next = this.position + BigInt(bytes)
    if (this.options.mimeType.startsWith('video/mp4') && next > 0xffffffffn) {
      throw new RangeError('OutputPositionTracker checked uint32 cumulative overflow')
    }
    this.position = next
  }
}
const createRecorder = vm.runInNewContext(compiled.code + '\ncreateRecorder', {
  MediaRecorder: NativeRecorderModel, stream: {}, VIDEO_BITS_PER_SECOND: 6_000_000,
  currentMp4FragmentIntervalMs: () => 200,
})

test('the production recorder factory keeps one AVC encoder beyond 4GiB without the Chromium MP4 tracker', () => {
  const format = pickRecorderFormat(() => true)
  const recorder = createRecorder(format)
  recorder.start()
  assert.doesNotThrow(() => { recorder.write(0xffffff00); recorder.write(0x1000) })
  assert.equal(recorder.starts, 1)
  assert.equal(recorder.position, 0x100000f00n)
  assert.equal(recorder.options.mimeType, 'video/x-matroska;codecs=avc1')
})
test('AVC output remains legal MP4 and keeps the existing keyframe cadence', () => {
  const format = pickRecorderFormat(() => true)
  const recorder = createRecorder(format)
  assert.equal(format.mimeType, 'video/mp4;codecs=avc1')
  assert.equal(format.replayFile, 'replay.mp4')
  assert.equal(recorder.options.videoKeyFrameIntervalDuration, 200)
})
test('the VP8/VP9 fallback stays legal WebM when AVC is unavailable', () => {
  const format = pickRecorderFormat(type => type === 'video/webm;codecs=vp9')
  assert.equal(format.replayFile, 'replay.webm')
  assert.equal(format.mimeType, 'video/webm;codecs=vp9')
})
