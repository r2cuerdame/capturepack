import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const work = mkdtempSync(path.join(tmpdir(), 'capturepack-native-replay-'))
try {
  const bundle = path.join(work, 'check.cjs')
  const electronStub = path.join(work, 'electron-stub.cjs')
  writeFileSync(
    electronStub,
    `exports.app={getVersion:()=>'0.0.0-check'};` +
      `exports.clipboard={writeText:()=>{}};` +
      `exports.screen={getAllDisplays:()=>[]};\n`,
  )
  const helper = path.join(work, 'native-replay-capture.exe')
  const windows = process.env.WINDIR ?? 'C:\\Windows'
  const compilers = [
    path.join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windows, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ]
  const compiler = compilers.find((candidate) => existsSync(candidate))
  if (process.platform !== 'win32' || compiler === undefined) {
    throw new Error('native replay fallback check requires Windows .NET Framework csc.exe')
  }
  execFileSync(
    compiler,
    [
      '/nologo',
      '/optimize+',
      '/target:exe',
      '/reference:System.Drawing.dll',
      `/out:${helper}`,
      path.join(here, 'native-replay-capture.cs'),
    ],
    { stdio: 'inherit', windowsHide: true },
  )
  execFileSync(
    process.execPath,
    [
      path.join(here, '..', 'node_modules', 'esbuild', 'bin', 'esbuild'),
      path.join(here, 'native-replay-fallback-check.ts'),
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--alias:electron=${electronStub}`,
      `--outfile=${bundle}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  // The check intentionally captures the left-most physical display. Query
  // its native dimensions from the helper's strict contract through the same
  // Windows APIs is overkill here; this desk fixture is discovered from the
  // virtual-screen metrics exposed by PowerShell's SystemInformation.
  const probe = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; ' +
        '$s=[System.Windows.Forms.Screen]::AllScreens | Sort-Object {$_.Bounds.X},{$_.Bounds.Y} | Select-Object -First 1; ' +
        'Write-Output ($s.Bounds.X.ToString()+\",\"+$s.Bounds.Y.ToString()+\",\"+$s.Bounds.Width.ToString()+\",\"+$s.Bounds.Height.ToString())',
    ],
    { encoding: 'utf8', windowsHide: true },
  ).trim()
  const [x, y, width, height] = probe.split(',')
  execFileSync(process.execPath, [bundle], {
    stdio: 'inherit',
    env: {
      ...process.env,
      CAPTUREPACK_NATIVE_REPLAY_HELPER: helper,
      CAPTUREPACK_NATIVE_WIDTH: width,
      CAPTUREPACK_NATIVE_HEIGHT: height,
      CAPTUREPACK_NATIVE_X: x,
      CAPTUREPACK_NATIVE_Y: y,
    },
  })
} finally {
  rmSync(work, { recursive: true, force: true })
}
