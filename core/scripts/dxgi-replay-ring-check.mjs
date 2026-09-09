import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileDxgiReplayRingHelper } from './build-dxgi-timing-helper.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const nativeSource = readFileSync(path.join(here, 'dxgi-replay-ring.cpp'), 'utf8')
  .replace(/\r\n?/g, '\n')
const encoderStart = nativeSource.indexOf('class EncoderSession')
const encoderEnd = nativeSource.indexOf('bool GpuCompletedWithin(', encoderStart)
const encoder = encoderStart >= 0 && encoderEnd > encoderStart
  ? nativeSource.slice(encoderStart, encoderEnd)
  : ''
const bFrameContract = encoder.indexOf(
  'SetCodecUint32(codec.Get(), CODECAPI_AVEncMPVDefaultBPictureCount,\n                        0, true)',
)
const outputTypeCommit = encoder.indexOf('transform_->SetOutputType(0, outputType_.Get(), 0)')
if (bFrameContract < 0 || outputTypeCommit < 0 || bFrameContract > outputTypeCommit) {
  throw new Error(
    'DXGI replay encoder must require zero B pictures before committing its output type',
  )
}
const expectedNativeSelfTestLines = [
  'SELFTEST PASS timestamps',
  'SELFTEST PASS rotation-topology',
  'SELFTEST PASS cursor-position-pointer-only-clipping',
  'SELFTEST PASS cursor-rotation-multi-output-coordinates',
  'SELFTEST PASS cursor-monochrome-and-xor-semantics',
  'SELFTEST PASS cursor-masked-color-copy-xor-semantics',
  'SELFTEST PASS cursor-color-shape-rotation-semantics',
  'SELFTEST PASS cursor-shape-validation-fails-closed',
  'SELFTEST PASS bounded-bytes-keyframe-cut',
  'SELFTEST PASS bounded-time',
  'SELFTEST PASS bounded-max-units',
  'SELFTEST PASS short-retention-awaits-keyframe',
  'SELFTEST PASS retention-sized-bounds',
  'SELFTEST PASS cursor-contract-fails-closed',
  'SELFTEST PASS config-generation-keyframe-cut',
  'SELFTEST PASS encoder-transition-semantics',
  'SELFTEST PASS device-loss-retry-boundaries',
  'SELFTEST PASS output-identity-topology',
  'dxgi replay ring self-test: OK',
]
const work = mkdtempSync(path.join(tmpdir(), 'capturepack-dxgi-replay-ring-check-'))
try {
  const helper = compileDxgiReplayRingHelper({
    outputDirectory: work,
    required: process.platform === 'win32',
  })
  if (helper !== null) {
    const selfTestOutput = execFileSync(helper, ['--self-test'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
    })
    process.stdout.write(selfTestOutput)
    const actualLines = selfTestOutput.trim().split(/\r?\n/)
    if (JSON.stringify(actualLines) !== JSON.stringify(expectedNativeSelfTestLines)) {
      throw new Error(
        'DXGI replay native self-test markers changed or were incomplete:\n' +
          `expected ${JSON.stringify(expectedNativeSelfTestLines)}\n` +
          `actual   ${JSON.stringify(actualLines)}`,
      )
    }
  }
  const bundle = path.join(work, 'check.cjs')
  execFileSync(
    process.execPath,
    [
      path.join(here, '..', 'node_modules', 'esbuild', 'bin', 'esbuild'),
      path.join(here, 'dxgi-replay-ring-check.ts'),
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--outfile=${bundle}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  execFileSync(process.execPath, [bundle], { stdio: 'inherit' })
} finally {
  rmSync(work, { recursive: true, force: true })
}
