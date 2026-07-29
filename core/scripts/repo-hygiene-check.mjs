// Repository hygiene gate: generated backups and local crash/scratch files
// must never become release inputs.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyReleaseArtifacts } from './release-contract-check.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
let failures = 0

function check(ok, message) {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${message}`)
}

const generatedNames = [
  'scratch.bak',
  'scratch.backup',
  'scratch.tmp',
  'scratch.temp',
  'scratch.old',
  'scratch.orig',
  'scratch.rej',
  'scratch.swp',
  'scratch.swo',
  'scratch.dmp',
  'scratch.stackdump',
  'scratch~',
  '.review-archive/example.patch',
  '.agents/local-note.md',
  'core/.serena/project.local.yml',
  'core/rc999/CapturePack Setup.exe',
  'core/release-rc999/CapturePack-Setup.exe',
]

console.log('GENERATED FILES ARE IGNORED')
for (const relative of generatedNames) {
  let ignored = false
  try {
    execFileSync('git', ['check-ignore', '--quiet', '--no-index', relative], {
      cwd: root,
      stdio: 'ignore',
    })
    ignored = true
  } catch {
    ignored = false
  }
  check(ignored, relative)
}

console.log('\nNO EXISTING TRACKED BACKUP IS PRESENT')
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root })
  .toString('utf8')
  .split('\0')
  .filter(Boolean)
const backupPattern =
  /(^|\/)(?:\.review-archive|backup|backups|tmp|temp)(?:\/|$)|\.(?:bak|backup|tmp|temp|old|orig|rej|swp|swo|dmp|stackdump)$|~$/i
const presentBackups = tracked.filter(
  (relative) => backupPattern.test(relative) && existsSync(path.join(root, relative)),
)
check(
  presentBackups.length === 0,
  presentBackups.length === 0
    ? 'no tracked backup/temp/dump files remain'
    : `tracked generated files: ${presentBackups.join(', ')}`,
)

console.log('\nPUBLIC RELEASE IS VERIFIED BEFORE IT BECOMES VISIBLE')
const builderConfig = readFileSync(path.join(root, 'core', 'electron-builder.yml'), 'utf8')
const releaseWorkflow = readFileSync(
  path.join(root, '.github', 'workflows', 'release.yml'),
  'utf8',
)
const contractPosition = releaseWorkflow.indexOf('release-contract-check.mjs')
const tagPosition = releaseWorkflow.indexOf('Create or verify the release tag')
const draftCleanupPosition = releaseWorkflow.indexOf('gh release delete-asset')
const uploadPosition = releaseWorkflow.indexOf('gh release upload')
const remoteVerificationPosition = releaseWorkflow.indexOf(
  'Verify draft assets byte-for-byte',
)
const publishPosition = releaseWorkflow.indexOf('--draft=false')
check(
  builderConfig.includes('releaseType: draft') && builderConfig.includes('timeout: 120000'),
  'electron-builder can only stage a bounded draft upload',
)
check(
  releaseWorkflow.includes('group: capturepack-public-release') &&
    releaseWorkflow.includes('cancel-in-progress: false'),
  'public release jobs are serialized without cancelling an active upload',
)
check(
  releaseWorkflow.includes('npm run qa:rc -- --fail-fast') &&
    releaseWorkflow.includes('timeout-minutes: 45') &&
    releaseWorkflow.includes('timeout-minutes: 15'),
  'QA, packaging, and the whole release job have explicit time bounds',
)
check(
  releaseWorkflow.includes('run: npm run dist') &&
    !releaseWorkflow.includes('run: npm run release'),
  'packaging cannot publish before the local artifact contract passes',
)
check(
  contractPosition >= 0 &&
    contractPosition < tagPosition &&
    tagPosition < draftCleanupPosition &&
    draftCleanupPosition < uploadPosition &&
    uploadPosition < remoteVerificationPosition &&
    remoteVerificationPosition < publishPosition,
  'local hashes precede tagging; draft cleanup/upload and remote verification precede publication',
)
check(
  releaseWorkflow.includes('refusing to replace its assets') &&
    releaseWorkflow.includes('Get-FileHash -LiteralPath $local') &&
    releaseWorkflow.includes('Get-FileHash -LiteralPath $remote'),
  'an existing public tag is immutable and every staged asset is downloaded for comparison',
)

const releaseProbe = mkdtempSync(path.join(tmpdir(), 'capturepack-release-contract-'))
try {
  const version = '9.8.7-test.1'
  const installerName = `CapturePack-Setup-${version}.exe`
  const installer = path.join(releaseProbe, installerName)
  const blockmap = path.join(releaseProbe, `${installerName}.blockmap`)
  const latest = path.join(releaseProbe, 'latest.yml')
  const bytes = Buffer.from('deterministic fake installer bytes\n', 'utf8')
  const sha512 = createHash('sha512').update(bytes).digest('base64')
  writeFileSync(installer, bytes)
  writeFileSync(blockmap, 'fake blockmap\n', 'utf8')
  const validMetadata = [
    `version: ${version}`,
    'files:',
    `  - url: ${installerName}`,
    `    sha512: ${sha512}`,
    `    size: ${bytes.length}`,
    `path: ${installerName}`,
    `sha512: ${sha512}`,
    "releaseDate: '2030-01-01T00:00:00.000Z'",
    '',
  ].join('\n')
  writeFileSync(latest, validMetadata, 'utf8')
  const verified = await verifyReleaseArtifacts({
    releaseDirectory: releaseProbe,
    version,
  })
  await verifyReleaseArtifacts({ releaseDirectory: releaseProbe, version })
  const sums = readFileSync(path.join(releaseProbe, 'SHA256SUMS.txt'), 'utf8')
  check(
    sums === `${verified.sha256}  ${installerName}\n`,
    'artifact contract writes one exact installer checksum without a BOM',
  )

  const stale = path.join(releaseProbe, 'CapturePack-Setup-0.0.1.exe')
  writeFileSync(stale, 'stale')
  let staleRejected = false
  try {
    await verifyReleaseArtifacts({ releaseDirectory: releaseProbe, version })
  } catch {
    staleRejected = true
  }
  unlinkSync(stale)
  check(staleRejected, 'artifact contract rejects stale installers in the release directory')

  writeFileSync(latest, validMetadata.replace(sha512, 'invalid-sha512'), 'utf8')
  let badHashRejected = false
  try {
    await verifyReleaseArtifacts({ releaseDirectory: releaseProbe, version })
  } catch {
    badHashRejected = true
  }
  check(badHashRejected, 'artifact contract rejects latest.yml that does not match installer bytes')
} finally {
  rmSync(releaseProbe, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nrepo-hygiene-check ok' : `\nrepo-hygiene-check FAILED (${failures})`)
process.exitCode = failures === 0 ? 0 : 1
