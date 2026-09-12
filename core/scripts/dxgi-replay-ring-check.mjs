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
const bFrameRequest = encoder.search(
  /SetCodecUint32\(\s*codec\.Get\(\),\s*CODECAPI_AVEncMPVDefaultBPictureCount,\s*0,\s*true(?:,\s*&zeroBBeforeTypesResult)?\s*\)/u,
)
const outputTypeCommit = encoder.indexOf('transform_->SetOutputType(0, outputType_.Get(), 0)')
const inputTypeCommit = encoder.indexOf('transform_->SetInputType(0, inputType_.Get(), 0)')
const bFrameVerification = encoder.search(
  /if\s*\(!EstablishZeroBPictureCount\(\s*codec\.Get\(\),\s*zeroBRequestedBeforeTypes(?:,\s*&zeroBDiagnostic)?\s*\)\)/u,
)
const beginStreaming = encoder.indexOf('MFT_MESSAGE_NOTIFY_BEGIN_STREAMING')
const unitGuard = encoder.indexOf('zeroReorderGuard_.Validate(nals, keyframe)')
const ringAppend = encoder.indexOf('ring.Append(std::move(unit))')
if (unitGuard < 0 || ringAppend <= unitGuard ||
    !encoder.includes('H264NoBSlices(nals, keyframe)')) {
  throw new Error('Every native access unit needs the no-B guard before ring insertion')
}
if (bFrameRequest < 0 || outputTypeCommit <= bFrameRequest ||
    inputTypeCommit <= outputTypeCommit || bFrameVerification <= inputTypeCommit ||
    beginStreaming <= bFrameVerification) {
  throw new Error(
    'DXGI replay must request zero B pictures before types and fail closed on verified configuration before streaming',
  )
}
const expectedNativeSelfTestLines = [
  'SELFTEST PASS mux-absolute-boundaries-no-cumulative-rounding',
  'SELFTEST PASS mux-tfdt-tfra-interior-wide-sample-index',
  'SELFTEST PASS mux-malformed-unsupported-timing-transactional',
  'SELFTEST PASS mux-field-width-overflow-fails-closed',
  'SELFTEST PASS h264-config-explicit-zero-reorder',
  'SELFTEST PASS h264-poc2-frame-progression-wrap-idr',
  'SELFTEST PASS h264-b-reorder-marking-fail-closed',
  'SELFTEST PASS h264-multislice-one-picture',
  'SELFTEST PASS h264-malformed-extension-config-rejected',
  'SELFTEST PASS h264-cabac-padding-bounded',
  'SELFTEST PASS timestamps',
  'SELFTEST PASS rotation-topology',
  'SELFTEST PASS replay-output-size-physical-cursor-contract',
  'SELFTEST PASS replay-output-arguments-fail-closed',
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
  'SELFTEST PASS service-clock-precision-fails-closed',
  'SELFTEST PASS encoder-zero-b-contract-fails-closed',
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
