import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import {
  dxgiReplayCapabilityArguments,
  parseDxgiReplayRunResult,
  type DxgiReplayBounds,
} from '../src/main/dxgiReplayRing'

interface Options {
  deviceName?: string
  bounds?: DxgiReplayBounds
  captureMs: number
}

function parseInteger(name: string, value: string | undefined): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} requires an integer`)
  return parsed
}

function parseOptions(argv: readonly string[]): Options {
  let deviceName: string | undefined
  let captureMs = 3_000
  const bounds: { x?: number; y?: number; width?: number; height?: number } = {}
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (option === '--device') deviceName = argv[++index]
    else if (option === '--left') bounds.x = parseInteger(option, argv[++index])
    else if (option === '--top') bounds.y = parseInteger(option, argv[++index])
    else if (option === '--native-width') bounds.width = parseInteger(option, argv[++index])
    else if (option === '--native-height') bounds.height = parseInteger(option, argv[++index])
    else if (option === '--capture-ms') captureMs = parseInteger(option, argv[++index])
    else throw new Error(`unknown option: ${String(option)}`)
  }
  const parts = [bounds.x, bounds.y, bounds.width, bounds.height]
    .filter((value) => value !== undefined).length
  if (parts !== 0 && parts !== 4) throw new Error('physical bounds require all four fields')
  if ((deviceName ?? '').trim() === '' && parts === 0) {
    throw new Error('provide --device or exact physical bounds')
  }
  if (captureMs < 100 || captureMs > 30_000) {
    throw new Error('--capture-ms must be between 100 and 30000')
  }
  return {
    captureMs,
    ...(deviceName === undefined ? {} : { deviceName }),
    ...(parts === 0 ? {} : { bounds: bounds as DxgiReplayBounds }),
  }
}

function main(): void {
  const options = parseOptions(process.argv.slice(2))
  const helperPath = process.env.CAPTUREPACK_DXGI_REPLAY_HELPER
  if (helperPath === undefined || helperPath === '') {
    throw new Error('CAPTUREPACK_DXGI_REPLAY_HELPER is not set')
  }
  const identityArguments = dxgiReplayCapabilityArguments(options)
  if (identityArguments === null) throw new Error('invalid display identity')
  const packet = execFileSync(
    resolve(helperPath),
    [...identityArguments, '--capture-ms', String(options.captureMs)],
    {
      encoding: 'buffer',
      maxBuffer: 1_024,
      timeout: options.captureMs + 10_000,
      windowsHide: true,
    },
  )
  const result = parseDxgiReplayRunResult(packet)
  console.log(JSON.stringify({
    schema: 'capturepack.dxgi-replay-run',
    version: 1,
    measured_at: new Date().toISOString(),
    result,
  }, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value, 2))
  if (result.status !== 'completed') process.exitCode = 1
}

try {
  main()
} catch (error: unknown) {
  console.error(error)
  process.exitCode = 1
}
