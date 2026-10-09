import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { lifecycleLogEvidence } = createRequire(import.meta.url)('./fixtures/dxgi-replay-lifecycle.cjs')
const line = (message) => `[capture] display 7: ${message}\n`
const valid = {
  displayId: '7',
  mainLog: line('DXGI native replay READY (1920x1080 @ 15fps, hardware)') + line('shipping replay encoders suspended; native replay owns the display') + line('selected DXGI native replay snapshot (99 bytes, 30 ms, 3 samples, 1 keyframes)'),
  fallbackMainLog: line('DXGI native replay unavailable (native-runtime-failed)') + line('native replay unavailable; restarting shipping replay workload') + line('video/mp4 -> replay.mp4, 1920x1080') + line('primary recorder readiness after 100 ms (3 presented frames, timeout=false, excluded-before-recorder=100 ms, presentation-span=67 ms)') + line('starting -> recording'),
}
assert.equal(lifecycleLogEvidence(valid).pass, true)
for (const field of ['mainLog', 'fallbackMainLog']) {
  assert.equal(lifecycleLogEvidence({ ...valid, [field]: '' }).pass, false, field)
}
assert.equal(lifecycleLogEvidence({ ...valid, fallbackMainLog: valid.mainLog }).pass, false, 'old readiness cannot prove fallback')
assert.equal(lifecycleLogEvidence({ ...valid, fallbackMainLog: valid.fallbackMainLog.replace('timeout=false', 'timeout=true') }).pass, false)
assert.equal(lifecycleLogEvidence({ ...valid, fallbackMainLog: valid.fallbackMainLog.replace('starting -> recording', 'starting -> stopped') }).pass, false)
assert.equal(lifecycleLogEvidence({ ...valid, displayId: '8' }).pass, false)
assert.equal(lifecycleLogEvidence({ ...valid, mainLog: valid.mainLog.split('\n').reverse().join('\n') }).pass, false, 'wrong lifecycle ordering')
assert.equal(lifecycleLogEvidence({ ...valid, mainLog: valid.mainLog.replace('shipping replay encoders suspended', 'shipping replay encoders active') }).pass, false)
console.log('DXGI replay lifecycle: 9 checks passed (#243 READY suspension and honest fallback)')
