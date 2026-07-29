// Repository hygiene gate: generated backups and local crash/scratch files
// must never become release inputs.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

console.log(failures === 0 ? '\nrepo-hygiene-check ok' : `\nrepo-hygiene-check FAILED (${failures})`)
process.exitCode = failures === 0 ? 0 : 1
