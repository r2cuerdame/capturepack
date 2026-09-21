// DOES THE WINGET MANIFEST STILL DESCRIBE THE INSTALLER WE SHIP?
//
// A WinGet manifest is a claim about bytes at a URL. Three of its fields fail
// silently when wrong: a ProductCode that does not match the uninstall key the
// installer writes means `winget upgrade` installs a second copy; a DisplayName
// that does not match Apps & Features means WinGet never correlates the
// install; a SHA-256 copied from the wrong file means the package is rejected
// upstream after a day of pipeline time. This check pins each of those to the
// evidence the installer itself produces, and proves the generator refuses
// inputs that would publish a wrong or premature manifest.
//
//   node scripts/winget-manifest-check.mjs
//
// If the `winget` CLI is on PATH the generated manifests are also run through
// `winget validate`, the official schema validator; elsewhere that step is
// reported as skipped rather than passed.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MANIFEST_VERSION,
  PACKAGE_IDENTIFIER,
  buildWingetManifests,
  changelogSection,
  parseSha256Sums,
  productCodeForAppId,
  uuidV5,
  writeWingetManifests,
} from './winget-manifest.mjs'

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = path.resolve(CORE, '..')

let failures = 0
function check(ok, message, detail) {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${message}${!ok && detail ? ` — ${detail}` : ''}`)
}
function rejects(fn, message) {
  let error = null
  try {
    fn()
  } catch (caught) {
    error = caught
  }
  check(error !== null, message, 'was accepted')
  return error
}

const packageJson = JSON.parse(readFileSync(path.join(CORE, 'package.json'), 'utf8'))
const electronBuilderConfig = readFileSync(path.join(CORE, 'electron-builder.yml'), 'utf8')
const changelog = readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')

// Release evidence for the version this checkout ships. The hash is a fixture:
// the generator must copy it verbatim, it is not asserted against GitHub here.
const version = packageJson.version
const installerName = `CapturePack-Setup-${version}.exe`
const fixtureSha = 'a'.repeat(60) + '0f1e'
const latestYml = [
  `version: ${version}`,
  'files:',
  `  - url: ${installerName}`,
  '    sha512: not-used-by-winget',
  '    size: 1',
  `path: ${installerName}`,
  'sha512: not-used-by-winget',
  "releaseDate: '2026-09-15T16:36:45.156Z'",
  '',
].join('\n')
const sha256Sums = `${fixtureSha}  ${installerName}\n`

console.log('PRODUCT CODE IS THE INSTALLER\'S UNINSTALL KEY')
// RFC 4122 appendix / known vector: v5 of "python.org" in the DNS namespace.
check(
  uuidV5('python.org', '6ba7b810-9dad-11d1-80b4-00c04fd430c8') === '886313e1-3b8a-5372-9b90-0c9aee199e5d',
  'uuidV5 matches the RFC 4122 DNS vector',
)
// Observed on a machine that ran CapturePack-Setup: HKCU\...\Uninstall\<key>
// for appId io.github.r2cuerdame.capturepack (electron-builder namespace).
check(
  productCodeForAppId('io.github.r2cuerdame.capturepack') === 'e2882de7-4701-50c8-9b29-3229ccb6fbcc',
  'appId derives the uninstall key electron-builder writes',
)
check(
  /^appId:\s*io\.github\.r2cuerdame\.capturepack\s*$/mu.test(electronBuilderConfig),
  'electron-builder.yml still declares the appId the product code is derived from',
)
check(
  /^\s+perMachine:\s*false\s*$/mu.test(electronBuilderConfig) && /^\s+oneClick:\s*true\s*$/mu.test(electronBuilderConfig),
  'installer is per-user one-click (Scope: user, silent /S without elevation)',
)
check(
  /^\s+artifactName:\s*CapturePack-Setup-\$\{version\}\.\$\{ext\}\s*$/mu.test(electronBuilderConfig),
  'artifact name still matches the InstallerUrl the manifest derives',
)

console.log('MANIFESTS ARE DERIVED FROM RELEASE ASSETS')
const manifests = buildWingetManifests({ latestYml, sha256Sums, changelog, packageJson, electronBuilderConfig })
const installer = manifests.files[`${PACKAGE_IDENTIFIER}.installer.yaml`]
const locale = manifests.files[`${PACKAGE_IDENTIFIER}.locale.en-US.yaml`]
const versionManifest = manifests.files[`${PACKAGE_IDENTIFIER}.yaml`]
check(manifests.directory === `manifests/r/r2cuerdame/CapturePack/${version}`, 'output path follows winget-pkgs layout')
check(
  installer.includes(`InstallerUrl: https://github.com/r2cuerdame/capturepack/releases/download/v${version}/${installerName}`),
  'InstallerUrl is the versioned GitHub release asset',
)
check(installer.includes(`InstallerSha256: ${fixtureSha.toUpperCase()}`), 'InstallerSha256 is SHA256SUMS.txt upper-cased')
check(installer.includes('InstallerType: nullsoft') && installer.includes('Scope: user'), 'NSIS per-user installer type')
check(installer.includes('ProductCode: e2882de7-4701-50c8-9b29-3229ccb6fbcc'), 'ProductCode is the uninstall key')
check(installer.includes(`DisplayName: "CapturePack ${version}"`), 'DisplayName is electron-builder\'s "<productName> <version>"')
check(installer.includes(`Publisher: ${JSON.stringify(packageJson.author)}`), 'Publisher is package.json author')
check(installer.includes(`DisplayVersion: ${version}`), 'DisplayVersion is the package version')
check(installer.includes('ReleaseDate: 2026-09-15'), 'ReleaseDate is the day of latest.yml releaseDate')
check(installer.includes('Architecture: x64'), 'architecture is x64')
check(!/InstallerSwitches/u.test(installer), 'no custom switches: WinGet uses /S for nullsoft')
check(locale.includes(`LicenseUrl: https://github.com/r2cuerdame/capturepack/blob/v${version}/LICENSE`), 'LicenseUrl pins the tag')
check(locale.includes(`License: ${packageJson.license}`) && locale.includes(`PackageUrl: ${packageJson.homepage}`), 'license and homepage come from package.json')
check(locale.includes(`ReleaseNotesUrl: https://github.com/r2cuerdame/capturepack/releases/tag/v${version}`), 'ReleaseNotesUrl pins the tag')
const notes = changelogSection(changelog, version)
check(notes.split('\n').every((line) => line.length === 0 || locale.includes(`  ${line}`)), 'ReleaseNotes is the CHANGELOG section for this version')
for (const [name, text] of Object.entries(manifests.files)) {
  check(
    text.includes(`ManifestVersion: ${MANIFEST_VERSION}`) && text.includes(`PackageVersion: ${version}`) && text.includes(`PackageIdentifier: ${PACKAGE_IDENTIFIER}`) && !text.includes('\r') && text.endsWith('\n'),
    `${name} carries identifier, version, schema ${MANIFEST_VERSION}, LF endings`,
  )
}
check(versionManifest.includes('DefaultLocale: en-US') && versionManifest.includes('ManifestType: version'), 'version manifest points at en-US')

console.log('WRONG OR PREMATURE EVIDENCE IS REFUSED')
const prerelease = rejects(
  () => buildWingetManifests({ latestYml: latestYml.replaceAll(version, `${version}-rc.1`), sha256Sums: sha256Sums.replaceAll(version, `${version}-rc.1`), changelog, packageJson: { ...packageJson, version: `${version}-rc.1` }, electronBuilderConfig }),
  'a prerelease version is refused (WinGet gets stable only)',
)
check(/prerelease/u.test(prerelease?.message ?? ''), 'the prerelease refusal names the reason', prerelease?.message)
rejects(
  () => buildWingetManifests({ latestYml, sha256Sums: `${fixtureSha}  CapturePack-Setup-0.0.1.exe\n`, changelog, packageJson, electronBuilderConfig }),
  'SHA256SUMS.txt for a different installer is refused',
)
rejects(
  () => buildWingetManifests({ latestYml, sha256Sums: `${fixtureSha.slice(1)}  ${installerName}\n`, changelog, packageJson, electronBuilderConfig }),
  'a hash that is not 64 hex characters is refused',
)
rejects(
  () => buildWingetManifests({ latestYml, sha256Sums, changelog, packageJson: { ...packageJson, version: '0.0.0' }, electronBuilderConfig }),
  'package.json from a different version than latest.yml is refused',
)
rejects(
  () => buildWingetManifests({ latestYml, sha256Sums, changelog: '# Changelog\n\n## 0.0.0 — never\n\n- nothing\n', packageJson, electronBuilderConfig }),
  'a changelog without this version\'s section is refused',
)
rejects(
  () => buildWingetManifests({ latestYml: latestYml.replace("releaseDate: '2026-09-15T16:36:45.156Z'", 'releaseDate: yesterday'), sha256Sums, changelog, packageJson, electronBuilderConfig }),
  'a non-ISO releaseDate is refused',
)
check(parseSha256Sums(`${fixtureSha}  *${installerName}\n`, installerName) === fixtureSha.toUpperCase(), 'sha256sum binary-mode marker is tolerated')

console.log('OFFICIAL VALIDATOR')
const probe = mkdtempSync(path.join(tmpdir(), 'capturepack-winget-'))
try {
  const directory = writeWingetManifests(probe, manifests)
  const winget = spawnSync(process.platform === 'win32' ? 'winget.exe' : 'winget', ['validate', '--manifest', directory], { encoding: 'utf8' })
  if (winget.error || winget.status === null) {
    console.log('  SKIP  winget CLI not available; run `winget validate --manifest <dir>` on Windows')
  } else {
    check(winget.status === 0 && /validation succeeded/iu.test(winget.stdout), 'winget validate accepts the generated manifests', (winget.stdout + winget.stderr).trim())
  }
} finally {
  rmSync(probe, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nwinget-manifest-check ok' : `\nwinget-manifest-check FAILED (${failures})`)
process.exitCode = failures === 0 ? 0 : 1
