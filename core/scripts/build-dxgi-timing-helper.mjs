import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

function commandOnPath(name) {
  const result = spawnSync('where.exe', [name], {
    encoding: 'utf8',
    windowsHide: true,
  })
  return result.status === 0
}

function visualStudioDeveloperCommand() {
  const candidates = [
    path.join(
      process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
      'Microsoft Visual Studio',
      'Installer',
      'vswhere.exe',
    ),
    path.join(
      process.env.ProgramFiles ?? 'C:\\Program Files',
      'Microsoft Visual Studio',
      'Installer',
      'vswhere.exe',
    ),
  ]
  const vswhere = candidates.find((candidate) => existsSync(candidate))
  if (vswhere === undefined) return null
  const query = spawnSync(
    vswhere,
    [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      'installationPath',
    ],
    { encoding: 'utf8', windowsHide: true },
  )
  if (query.status !== 0) return null
  const installation = query.stdout.trim()
  if (installation === '') return null
  const command = path.join(installation, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat')
  return existsSync(command) ? command : null
}

function quoted(value) {
  return `"${String(value).replaceAll('"', '""')}"`
}

/**
 * Compile from inspectable source when MSVC is available.
 *
 * A normal developer build remains portable and reports a skipped optional
 * helper. Installer/release commands pass required=true: producing a package
 * that silently lacks the calibration helper is not an acceptable success.
 */
function compileDxgiHelper({
  helperName,
  source,
  outputDirectory = path.join(process.cwd(), 'dist', 'scripts'),
  required = false,
  libraries,
}) {
  if (process.platform !== 'win32') {
    const message = `${helperName} skipped: Windows MSVC build host required`
    if (required) throw new Error(message)
    console.warn(message)
    return null
  }
  const developerCommand = commandOnPath('cl.exe')
    ? null
    : visualStudioDeveloperCommand()
  if (developerCommand === null && !commandOnPath('cl.exe')) {
    const message =
      `${helperName} skipped: MSVC C++ Build Tools were not found; ` +
      'install the x64 Desktop development with C++ workload'
    if (required) throw new Error(message)
    console.warn(message)
    return null
  }

  mkdirSync(outputDirectory, { recursive: true })
  const output = path.join(outputDirectory, helperName)
  const object = path.join(
    outputDirectory,
    `${path.basename(helperName, path.extname(helperName))}.obj`,
  )
  const compilerArguments = [
    '/nologo',
    '/std:c++17',
    '/O2',
    '/EHsc',
    '/W4',
    '/DUNICODE',
    '/D_UNICODE',
    `/Fo${object}`,
    `/Fe${output}`,
    source,
    ...libraries,
  ]
  const result = developerCommand === null
    ? spawnSync('cl.exe', compilerArguments, {
        encoding: 'utf8',
        windowsHide: true,
      })
    : spawnSync(
        `call ${quoted(developerCommand)} >nul && ` +
          `cl.exe ${compilerArguments.map(quoted).join(' ')}`,
        {
          encoding: 'utf8',
          windowsHide: true,
          shell: process.env.ComSpec ?? 'cmd.exe',
        },
      )
  rmSync(object, { force: true })
  if (result.status !== 0 || !existsSync(output)) {
    throw new Error(
      `${helperName} compile failed (${String(result.status)}): ` +
        String(result.stderr || result.stdout || result.error),
    )
  }
  console.log(`DXGI helper built: ${path.relative(process.cwd(), output)}`)
  return output
}

export function compileDxgiTimingHelper({
  source = path.join(process.cwd(), 'scripts', 'dxgi-timing-reference.cpp'),
  outputDirectory = path.join(process.cwd(), 'dist', 'scripts'),
  required = false,
} = {}) {
  return compileDxgiHelper({
    helperName: 'dxgi-timing-reference.exe',
    source,
    outputDirectory,
    required,
    libraries: ['d3d11.lib', 'dxgi.lib', 'user32.lib'],
  })
}

export function compileDxgiReplayRingHelper({
  source = path.join(process.cwd(), 'scripts', 'dxgi-replay-ring.cpp'),
  outputDirectory = path.join(process.cwd(), 'dist', 'scripts'),
  required = false,
} = {}) {
  return compileDxgiHelper({
    helperName: 'dxgi-replay-ring.exe',
    source,
    outputDirectory,
    required,
    libraries: [
      'd3d11.lib',
      'dxgi.lib',
      'mf.lib',
      'mfplat.lib',
      'mfuuid.lib',
      'ole32.lib',
      'user32.lib',
    ],
  })
}

if (
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  compileDxgiTimingHelper({
    required: process.argv.includes('--required'),
  })
  compileDxgiReplayRingHelper({
    required: process.argv.includes('--required'),
  })
}
