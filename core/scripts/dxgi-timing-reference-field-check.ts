import { createHash } from 'node:crypto'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import {
  captureDxgiTimingReference,
  dxgiQpcToUnixNs,
  type DxgiTimingAvailable,
} from '../src/main/dxgiTimingReference'

interface PhysicalDisplay {
  deviceName: string
  x: number
  y: number
  width: number
  height: number
}

function selectedDisplay(): PhysicalDisplay {
  const output = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; " +
        "public static class CapturePackDpi { [DllImport(\"user32.dll\")] " +
        "public static extern bool SetProcessDpiAwarenessContext(IntPtr value); }'; " +
        '[CapturePackDpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null; ' +
        'Add-Type -AssemblyName System.Windows.Forms; ' +
        '$s=[System.Windows.Forms.Screen]::AllScreens | ' +
        'Sort-Object @{Expression={$_.Primary};Descending=$true},' +
        '@{Expression={$_.Bounds.X};Ascending=$true} | Select-Object -First 1; ' +
        '[Console]::WriteLine(' +
        '$s.DeviceName+"|"+$s.Bounds.X+"|"+$s.Bounds.Y+"|"+' +
        '$s.Bounds.Width+"|"+$s.Bounds.Height)',
    ],
    { encoding: 'utf8', windowsHide: true },
  ).trim()
  const [deviceName, x, y, width, height] = output.split('|')
  const result = {
    deviceName: deviceName ?? '',
    x: Number(x),
    y: Number(y),
    width: Number(width),
    height: Number(height),
  }
  if (
    result.deviceName === ''
    || !Number.isSafeInteger(result.x)
    || !Number.isSafeInteger(result.y)
    || !Number.isSafeInteger(result.width)
    || !Number.isSafeInteger(result.height)
    || result.width <= 0
    || result.height <= 0
  ) {
    throw new Error(`could not discover a physical display: ${output}`)
  }
  return result
}

function markerScript(display: PhysicalDisplay): string {
  const markerWidth = Math.min(640, Math.max(128, display.width - 128))
  const markerHeight = Math.min(480, Math.max(128, display.height - 128))
  const markerX = display.x + Math.max(0, Math.floor((display.width - markerWidth) / 2))
  const markerY = display.y + Math.max(0, Math.floor((display.height - markerHeight) / 2))
  return `
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices;
public static class CapturePackMarkerDpi {
  [DllImport("user32.dll")]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}'
[CapturePackMarkerDpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.ShowInTaskbar = $false
$form.TopMost = $true
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.Bounds = New-Object System.Drawing.Rectangle(${markerX},${markerY},${markerWidth},${markerHeight})
$colors = @(
  [System.Drawing.Color]::FromArgb(255,229,41,93),
  [System.Drawing.Color]::FromArgb(255,33,201,151)
)
$next = 0
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 70
$timer.Add_Tick({
  $script:next = 1 - $script:next
  $form.BackColor = $colors[$script:next]
  $form.Refresh()
})
$form.Add_Shown({
  $form.BackColor = $colors[0]
  $form.Refresh()
  [Console]::Out.WriteLine("READY")
  [Console]::Out.Flush()
  $timer.Start()
})
[System.Windows.Forms.Application]::Run($form)
`
}

async function startMarker(display: PhysicalDisplay): Promise<ChildProcess> {
  const encoded = Buffer.from(markerScript(display), 'utf16le').toString('base64')
  const marker = spawn(
    'powershell.exe',
    ['-NoProfile', '-STA', '-EncodedCommand', encoded],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  )
  await new Promise<void>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      reject(new Error(`marker did not become ready: ${stderr}`))
    }, 5_000)
    const finish = (error?: Error): void => {
      clearTimeout(timer)
      if (error === undefined) resolve()
      else reject(error)
    }
    marker.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (stdout.includes('READY')) finish()
    })
    marker.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4_096)
    })
    marker.once('error', (error) => finish(error))
    marker.once('close', (code) => {
      finish(new Error(`marker exited ${String(code)}: ${stderr}`))
    })
  })
  return marker
}

async function main(): Promise<void> {
  const helper = process.env.CAPTUREPACK_DXGI_TIMING_HELPER
  if (helper === undefined) throw new Error('compiled helper path missing')
  const display = selectedDisplay()
  const marker = await startMarker(display)
  const available: DxgiTimingAvailable[] = []
  const unavailable: string[] = []
  try {
    for (let attempt = 0; attempt < 8 && available.length < 4; attempt += 1) {
      const result = await captureDxgiTimingReference({
        helperPath: helper,
        deviceName: display.deviceName,
        bounds: display,
        timeoutMs: 250,
        processTimeoutMs: 1_000,
      })
      if (result.status === 'available') available.push(result)
      else {
        unavailable.push(
          result.reason + (result.detail === undefined ? '' : `:${result.detail}`),
        )
      }
    }
  } finally {
    marker.kill()
  }
  if (available.length < 2) {
    throw new Error(
      `physical DXGI proof produced ${String(available.length)} available reference(s); ` +
        `unavailable=${unavailable.join(',')}`,
    )
  }
  const exactIdentity = available.every((sample) =>
    sample.deviceName.toLocaleLowerCase() === display.deviceName.toLocaleLowerCase()
    && sample.bounds.x === display.x
    && sample.bounds.y === display.y
    && sample.bounds.width === display.width
    && sample.bounds.height === display.height,
  )
  const clocksValid = available.every((sample) => {
    const projectedUnixMs = Number(
      dxgiQpcToUnixNs(sample, sample.lastPresentQpc) / 1_000_000n,
    )
    return sample.lastPresentQpc > 0n
      && sample.qpcFrequency > 0n
      && sample.anchor.spanQpc >= 0n
      && Math.abs(projectedUnixMs - Date.now()) < 10_000
  })
  const monotonic = available.every(
    (sample, index) =>
      index === 0
      || sample.lastPresentQpc > (available[index - 1]?.lastPresentQpc ?? 0n),
  )
  const digests = new Set(
    available.map((sample) =>
      createHash('sha256').update(sample.rgb).digest('hex'),
    ),
  )
  if (!exactIdentity || !clocksValid || !monotonic || digests.size < 2) {
    throw new Error(
      JSON.stringify({
        exactIdentity,
        clocksValid,
        monotonic,
        distinctRgbFrames: digests.size,
      }),
    )
  }
  console.log('result: OK — physical DXGI timing reference')
  console.log(JSON.stringify({
    device: display.deviceName,
    bounds: [display.x, display.y, display.width, display.height],
    samples: available.map((sample) => ({
      lastPresentQpc: sample.lastPresentQpc.toString(),
      qpcFrequency: sample.qpcFrequency.toString(),
      anchorQpc: sample.anchor.qpc.toString(),
      anchorUnixNs: sample.anchor.unixNs.toString(),
      anchorSpanQpc: sample.anchor.spanQpc.toString(),
      rgbSha256: createHash('sha256').update(sample.rgb).digest('hex'),
    })),
    unavailable,
  }, null, 2))
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
