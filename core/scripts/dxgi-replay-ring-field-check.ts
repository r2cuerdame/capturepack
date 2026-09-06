import { resolve } from 'node:path'
import {
  probeDxgiReplayCapability,
  type DxgiReplayBounds,
} from '../src/main/dxgiReplayRing'

interface Options {
  deviceName?: string
  bounds?: DxgiReplayBounds
}

function parseInteger(name: string, value: string | undefined): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} requires an integer`)
  return parsed
}

function parseOptions(argv: readonly string[]): Options {
  let deviceName: string | undefined
  const bounds: { x?: number; y?: number; width?: number; height?: number } = {}
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (option === '--device') deviceName = argv[++index]
    else if (option === '--left') bounds.x = parseInteger(option, argv[++index])
    else if (option === '--top') bounds.y = parseInteger(option, argv[++index])
    else if (option === '--native-width') bounds.width = parseInteger(option, argv[++index])
    else if (option === '--native-height') bounds.height = parseInteger(option, argv[++index])
    else throw new Error(`unknown option: ${String(option)}`)
  }
  const parts = [bounds.x, bounds.y, bounds.width, bounds.height]
    .filter((value) => value !== undefined).length
  if (parts !== 0 && parts !== 4) throw new Error('physical bounds require all four fields')
  if ((deviceName ?? '').trim() === '' && parts === 0) {
    throw new Error('provide --device or exact physical bounds')
  }
  return {
    ...(deviceName === undefined ? {} : { deviceName }),
    ...(parts === 0 ? {} : { bounds: bounds as DxgiReplayBounds }),
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  const helperPath = process.env.CAPTUREPACK_DXGI_REPLAY_HELPER
  if (helperPath === undefined || helperPath === '') {
    throw new Error('CAPTUREPACK_DXGI_REPLAY_HELPER is not set')
  }
  const result = await probeDxgiReplayCapability({
    ...options,
    helperPath: resolve(helperPath),
  })
  console.log(JSON.stringify({
    schema: 'capturepack.dxgi-replay-capability',
    version: 1,
    measured_at: new Date().toISOString(),
    result,
  }, null, 2))
  if (result.status !== 'available') process.exitCode = 1
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
