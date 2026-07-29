import { createHash } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function scalarValue(raw, label) {
  const value = raw.trim()
  invariant(value.length > 0, `${label} is empty`)
  if (value.startsWith("'")) {
    invariant(value.endsWith("'"), `${label} has an unterminated single-quoted value`)
    return value.slice(1, -1).replaceAll("''", "'")
  }
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value)
    } catch {
      throw new Error(`${label} has an invalid double-quoted value`)
    }
  }
  return value
}

function oneYamlScalar(lines, expression, label) {
  const matches = lines
    .map((line) => expression.exec(line)?.[1])
    .filter((value) => value !== undefined)
  invariant(matches.length === 1, `latest.yml must contain exactly one ${label}`)
  return scalarValue(matches[0], label)
}

async function hashFile(file, algorithm, encoding) {
  const hash = createHash(algorithm)
  await new Promise((resolve, reject) => {
    const input = createReadStream(file)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('error', reject)
    input.on('end', resolve)
  })
  return hash.digest(encoding)
}

function assertRegularFile(file, label) {
  invariant(existsSync(file), `${label} is missing: ${file}`)
  invariant(lstatSync(file).isFile(), `${label} is not a regular file: ${file}`)
  invariant(statSync(file).size > 0, `${label} is empty: ${file}`)
}

/**
 * Verify the exact Windows release payload and write its human-verifiable
 * SHA256SUMS.txt. This is intentionally independent of electron-builder so a
 * malformed/stale latest.yml cannot be uploaded merely because packaging
 * itself returned exit code zero.
 */
export async function verifyReleaseArtifacts({
  releaseDirectory,
  version,
  writeChecksums = true,
}) {
  invariant(
    /^[0-9A-Za-z][0-9A-Za-z.+-]*$/u.test(version),
    `Unsafe package version for an artifact name: ${version}`,
  )

  const installerName = `CapturePack-Setup-${version}.exe`
  const blockmapName = `${installerName}.blockmap`
  const latestName = 'latest.yml'
  const checksumsName = 'SHA256SUMS.txt'
  const installer = path.join(releaseDirectory, installerName)
  const blockmap = path.join(releaseDirectory, blockmapName)
  const latest = path.join(releaseDirectory, latestName)
  const checksums = path.join(releaseDirectory, checksumsName)

  assertRegularFile(installer, 'installer')
  assertRegularFile(blockmap, 'installer blockmap')
  assertRegularFile(latest, 'updater metadata')

  const installerCandidates = readdirSync(releaseDirectory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /^CapturePack-Setup-.*\.exe(?:\.blockmap)?$/u.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort()
  const expectedInstallerFiles = [blockmapName, installerName].sort()
  invariant(
    JSON.stringify(installerCandidates) === JSON.stringify(expectedInstallerFiles),
    `release directory contains stale or unexpected installers: ${installerCandidates.join(', ')}`,
  )

  const latestText = readFileSync(latest, 'utf8')
  invariant(!latestText.startsWith('\uFEFF'), 'latest.yml must not contain a UTF-8 BOM')
  const lines = latestText.split(/\r?\n/u)
  const metadataVersion = oneYamlScalar(lines, /^version:\s*(.+?)\s*$/u, 'top-level version')
  const metadataPath = oneYamlScalar(lines, /^path:\s*(.+?)\s*$/u, 'top-level path')
  const metadataSha512 = oneYamlScalar(
    lines,
    /^sha512:\s*(.+?)\s*$/u,
    'top-level sha512',
  )
  const fileUrl = oneYamlScalar(lines, /^\s+-\s+url:\s*(.+?)\s*$/u, 'files[0].url')
  const fileSha512 = oneYamlScalar(
    lines,
    /^\s+sha512:\s*(.+?)\s*$/u,
    'files[0].sha512',
  )
  const fileSizeRaw = oneYamlScalar(lines, /^\s+size:\s*(.+?)\s*$/u, 'files[0].size')
  const fileSize = Number(fileSizeRaw)
  const actualSize = statSync(installer).size
  const actualSha512 = await hashFile(installer, 'sha512', 'base64')

  invariant(metadataVersion === version, `latest.yml version is ${metadataVersion}, expected ${version}`)
  invariant(metadataPath === installerName, `latest.yml path is ${metadataPath}, expected ${installerName}`)
  invariant(fileUrl === installerName, `latest.yml URL is ${fileUrl}, expected ${installerName}`)
  invariant(
    Number.isSafeInteger(fileSize) && fileSize === actualSize,
    `latest.yml size is ${fileSizeRaw}, actual installer size is ${actualSize}`,
  )
  invariant(
    metadataSha512 === actualSha512,
    'latest.yml top-level sha512 does not match the installer bytes',
  )
  invariant(
    fileSha512 === actualSha512,
    'latest.yml files[0].sha512 does not match the installer bytes',
  )

  const sha256 = await hashFile(installer, 'sha256', 'hex')
  if (writeChecksums) {
    const temporary = `${checksums}.tmp-${process.pid}`
    try {
      writeFileSync(temporary, `${sha256}  ${installerName}\n`, 'utf8')
      renameSync(temporary, checksums)
    } finally {
      rmSync(temporary, { force: true })
    }
  }

  return {
    version,
    installerName,
    blockmapName,
    latestName,
    checksumsName,
    installerSize: actualSize,
    sha256,
    sha512: actualSha512,
  }
}

function parseArguments(argv) {
  const options = {
    tag: '',
    releaseDirectory: path.resolve('release'),
    packageFile: path.resolve('package.json'),
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = argv[index + 1]
    if (argument === '--tag' || argument === '--release-dir' || argument === '--package') {
      invariant(value && !value.startsWith('--'), `${argument} requires a value`)
      index += 1
      if (argument === '--tag') options.tag = value
      if (argument === '--release-dir') options.releaseDirectory = path.resolve(value)
      if (argument === '--package') options.packageFile = path.resolve(value)
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  invariant(options.tag.length > 1 && options.tag.startsWith('v'), '--tag must be v<package version>')
  return options
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const packageJson = JSON.parse(readFileSync(options.packageFile, 'utf8'))
  const packageDirectory = path.dirname(options.packageFile)
  const packageLockFile = path.join(packageDirectory, 'package-lock.json')
  const packageLock = JSON.parse(readFileSync(packageLockFile, 'utf8'))
  const version = String(packageJson.version ?? '')

  invariant(options.tag === `v${version}`, `Tag ${options.tag} does not match package version ${version}`)
  invariant(packageLock.version === version, 'package-lock.json version does not match package.json')
  invariant(
    packageLock.packages?.['']?.version === version,
    'package-lock.json root package version does not match package.json',
  )

  const result = await verifyReleaseArtifacts({
    releaseDirectory: options.releaseDirectory,
    version,
  })
  console.log(`release contract ok: ${result.installerName}`)
  console.log(`sha256 ${result.sha256}`)
  console.log(`sha512 ${result.sha512}`)
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
