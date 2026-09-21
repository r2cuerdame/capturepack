// WINGET MANIFESTS FROM RELEASE EVIDENCE, NOT FROM MEMORY.
//
// CapturePack ships one Windows artifact: the electron-builder one-click NSIS
// installer `CapturePack-Setup-<version>.exe`, per-user, unsigned, x64. The
// Windows Package Manager community repository (microsoft/winget-pkgs) needs
// three YAML manifests per version, and every field that matters — download
// URL, SHA-256, product code, display name — is something that can be copied
// wrong by hand. So none of it is typed here. This script reads the two files
// the release workflow publishes next to the installer (`latest.yml` and
// `SHA256SUMS.txt`), `core/package.json`, `core/electron-builder.yml` and the
// changelog section for the version, and derives everything else exactly the
// way the installer itself does:
//
//   * ProductCode is electron-builder's uninstall registry key, UUID v5 of the
//     appId in its fixed namespace — the same value a machine that ran the
//     installer shows under HKCU\...\Uninstall. It never changes between
//     versions, which is what lets `winget upgrade` find the old install.
//   * DisplayName is electron-builder's default `${productName} ${version}`.
//   * Publisher is package.json `author`, which is also the installer's
//     CompanyName version resource.
//
// Silent install/uninstall need no switches: NSIS honours `/S`, WinGet knows
// that for `InstallerType: nullsoft`, and electron-builder's one-click template
// does not launch the app when the install is silent.
//
//   node scripts/winget-manifest.mjs --latest <latest.yml> --sha256sums <SHA256SUMS.txt> --out <dir>
//
// Output: <dir>/manifests/r/r2cuerdame/CapturePack/<version>/*.yaml, ready to
// drop into a winget-pkgs fork. See docs/RELEASING.md "Publish to WinGet".

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CORE_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT_DIRECTORY = path.resolve(CORE_DIRECTORY, '..')

export const MANIFEST_VERSION = '1.12.0'
export const PACKAGE_IDENTIFIER = 'r2cuerdame.CapturePack'
export const GITHUB_REPOSITORY = 'r2cuerdame/capturepack'
// electron-builder's namespace for deriving the NSIS uninstall key from appId
// (app-builder-lib/out/targets/nsis/NsisTarget.js, ELECTRON_BUILDER_NS_UUID).
const ELECTRON_BUILDER_NS_UUID = '50e065bc-3134-11e6-9bab-38c9862bdaf3'

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

/** RFC 4122 UUID v5 (SHA-1) — what electron-builder computes for the app GUID. */
export function uuidV5(name, namespace) {
  const namespaceBytes = Buffer.from(namespace.replaceAll('-', ''), 'hex')
  invariant(namespaceBytes.length === 16, 'namespace must be a UUID')
  const digest = createHash('sha1').update(namespaceBytes).update(name, 'utf8').digest()
  digest[6] = (digest[6] & 0x0f) | 0x50
  digest[8] = (digest[8] & 0x3f) | 0x80
  const hex = digest.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function productCodeForAppId(appId) {
  invariant(typeof appId === 'string' && appId.length > 0, 'appId is required')
  return uuidV5(appId, ELECTRON_BUILDER_NS_UUID)
}

function unquote(raw, label) {
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

function oneScalar(lines, expression, label) {
  const matches = lines.map((line) => expression.exec(line)?.[1]).filter((v) => v !== undefined)
  invariant(matches.length === 1, `expected exactly one ${label}`)
  return unquote(matches[0], label)
}

/** The updater feed electron-builder publishes with every release. */
export function parseLatestYml(text) {
  const lines = text.split(/\r?\n/u)
  const version = oneScalar(lines, /^version:\s*(.+)$/u, 'version')
  const installerName = oneScalar(lines, /^path:\s*(.+)$/u, 'path')
  const releaseDate = oneScalar(lines, /^releaseDate:\s*(.+)$/u, 'releaseDate')
  invariant(
    /^[0-9A-Za-z][0-9A-Za-z.+-]*$/u.test(version),
    `latest.yml carries an unsafe version: ${version}`,
  )
  invariant(
    installerName === `CapturePack-Setup-${version}.exe`,
    `latest.yml path must be CapturePack-Setup-${version}.exe, got ${installerName}`,
  )
  const day = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.exec(releaseDate)?.[1]
  invariant(day !== undefined, `latest.yml releaseDate must be an ISO-8601 UTC instant: ${releaseDate}`)
  return { version, installerName, releaseDate: day }
}

/** The one-line file release-contract-check.mjs writes: `<sha256>  <installer>`. */
export function parseSha256Sums(text, installerName) {
  const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0)
  invariant(lines.length === 1, 'SHA256SUMS.txt must contain exactly one line')
  const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/u.exec(lines[0].trim())
  invariant(match !== null, 'SHA256SUMS.txt line is not "<sha256>  <file>"')
  invariant(
    match[2] === installerName,
    `SHA256SUMS.txt names ${match[2]}, expected ${installerName}`,
  )
  return match[1].toUpperCase()
}

/** The `## <version> — <date>` section of CHANGELOG.md, without its heading. */
export function changelogSection(text, version) {
  const lines = text.split(/\r?\n/u)
  const start = lines.findIndex((line) => new RegExp(`^## ${version.replaceAll('.', '\\.')}(\\s|$)`, 'u').test(line))
  invariant(start >= 0, `CHANGELOG.md has no "## ${version}" section`)
  let end = lines.findIndex((line, index) => index > start && /^## /u.test(line))
  if (end < 0) end = lines.length
  const body = lines.slice(start + 1, end).join('\n').trim()
  invariant(body.length > 0, `CHANGELOG.md section for ${version} is empty`)
  return body
}

function appIdFromElectronBuilderConfig(text) {
  return oneScalar(text.split(/\r?\n/u), /^appId:\s*(.+)$/u, 'appId')
}

function yamlScalar(value) {
  // Double-quoted JSON strings are valid YAML 1.2 scalars for every input.
  return JSON.stringify(String(value))
}

function yamlBlock(value, indent) {
  const pad = ' '.repeat(indent)
  const lines = String(value).replaceAll('\t', '  ').split('\n')
  return `|-\n${lines.map((line) => (line.length === 0 ? '' : pad + line)).join('\n')}`
}

/**
 * Build the three manifests. Every input is either read from a release asset
 * or from a repository file; nothing here is a hand-typed release fact.
 */
export function buildWingetManifests({
  latestYml,
  sha256Sums,
  changelog,
  packageJson,
  electronBuilderConfig,
}) {
  const { version, installerName, releaseDate } = parseLatestYml(latestYml)
  invariant(
    !version.includes('-'),
    `${version} is a prerelease; WinGet receives stable versions only (README and website name the stable line)`,
  )
  const sha256 = parseSha256Sums(sha256Sums, installerName)
  const pkg = typeof packageJson === 'string' ? JSON.parse(packageJson) : packageJson
  invariant(pkg.version === version, `package.json is ${pkg.version} but latest.yml is ${version}`)
  invariant(pkg.productName === 'CapturePack', 'package.json productName must be CapturePack')
  for (const field of ['author', 'description', 'homepage', 'license']) {
    invariant(typeof pkg[field] === 'string' && pkg[field].length > 0, `package.json ${field} is required`)
  }
  const appId = appIdFromElectronBuilderConfig(electronBuilderConfig)
  const productCode = productCodeForAppId(appId)
  const releaseNotes = changelogSection(changelog, version)
  const displayName = `${pkg.productName} ${version}`
  const installerUrl = `https://github.com/${GITHUB_REPOSITORY}/releases/download/v${version}/${installerName}`
  const licenseUrl = `https://github.com/${GITHUB_REPOSITORY}/blob/v${version}/LICENSE`
  const releaseNotesUrl = `https://github.com/${GITHUB_REPOSITORY}/releases/tag/v${version}`
  const publisher = pkg.author
  const directory = `manifests/r/r2cuerdame/CapturePack/${version}`

  const versionManifest = [
    `# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.${MANIFEST_VERSION}.schema.json`,
    '',
    `PackageIdentifier: ${PACKAGE_IDENTIFIER}`,
    `PackageVersion: ${version}`,
    'DefaultLocale: en-US',
    'ManifestType: version',
    `ManifestVersion: ${MANIFEST_VERSION}`,
    '',
  ].join('\n')

  const installerManifest = [
    `# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.${MANIFEST_VERSION}.schema.json`,
    '',
    `PackageIdentifier: ${PACKAGE_IDENTIFIER}`,
    `PackageVersion: ${version}`,
    'Platform:',
    '  - Windows.Desktop',
    // Electron 23+ runs on Windows 10 and later only.
    'MinimumOSVersion: 10.0.0.0',
    'InstallerType: nullsoft',
    // electron-builder.yml: nsis.perMachine is false, so the installer writes
    // HKCU and %LOCALAPPDATA%\Programs; it never asks for elevation.
    'Scope: user',
    'InstallModes:',
    '  - silent',
    '  - silentWithProgress',
    '  - interactive',
    'UpgradeBehavior: install',
    `ProductCode: ${productCode}`,
    'AppsAndFeaturesEntries:',
    `  - DisplayName: ${yamlScalar(displayName)}`,
    `    Publisher: ${yamlScalar(publisher)}`,
    `    DisplayVersion: ${version}`,
    `    ProductCode: ${productCode}`,
    '    InstallerType: nullsoft',
    'InstallationMetadata:',
    "  DefaultInstallLocation: '%LOCALAPPDATA%\\Programs\\capturepack'",
    `ReleaseDate: ${releaseDate}`,
    'Installers:',
    '  - Architecture: x64',
    `    InstallerUrl: ${installerUrl}`,
    `    InstallerSha256: ${sha256}`,
    'ManifestType: installer',
    `ManifestVersion: ${MANIFEST_VERSION}`,
    '',
  ].join('\n')

  const localeManifest = [
    `# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.${MANIFEST_VERSION}.schema.json`,
    '',
    `PackageIdentifier: ${PACKAGE_IDENTIFIER}`,
    `PackageVersion: ${version}`,
    'PackageLocale: en-US',
    `Publisher: ${yamlScalar(publisher)}`,
    'PublisherUrl: https://github.com/r2cuerdame',
    `PublisherSupportUrl: https://github.com/${GITHUB_REPOSITORY}/issues`,
    `Author: ${yamlScalar(publisher)}`,
    `PackageName: ${pkg.productName}`,
    `PackageUrl: ${pkg.homepage}`,
    `License: ${pkg.license}`,
    `LicenseUrl: ${licenseUrl}`,
    `Copyright: ${yamlScalar(`Copyright © ${releaseDate.slice(0, 4)} ${publisher}`)}`,
    `ShortDescription: ${yamlScalar(pkg.description)}`,
    'Description: |-',
    '  CapturePack is an open-source, local-first screen capture and structured',
    '  evidence collection tool for Windows. It rewinds recent screen activity,',
    '  picks captured UI objects with accessibility and window metadata, annotates',
    '  replays, and saves self-contained, browsable capture packs for debugging,',
    '  documentation, bug reporting, and AI analysis. Captures stay on the local',
    '  machine; there is no cloud service and no account.',
    'Moniker: capturepack',
    'Tags:',
    '  - developer-tools',
    '  - electron',
    '  - evidence',
    '  - mcp',
    '  - screen-capture',
    '  - screen-recorder',
    '  - screenshot',
    `ReleaseNotes: ${yamlBlock(releaseNotes, 2)}`,
    `ReleaseNotesUrl: ${releaseNotesUrl}`,
    'ManifestType: defaultLocale',
    `ManifestVersion: ${MANIFEST_VERSION}`,
    '',
  ].join('\n')

  return {
    version,
    directory,
    productCode,
    sha256,
    installerUrl,
    files: {
      [`${PACKAGE_IDENTIFIER}.yaml`]: versionManifest,
      [`${PACKAGE_IDENTIFIER}.installer.yaml`]: installerManifest,
      [`${PACKAGE_IDENTIFIER}.locale.en-US.yaml`]: localeManifest,
    },
  }
}

export function writeWingetManifests(outputRoot, manifests) {
  const directory = path.join(outputRoot, ...manifests.directory.split('/'))
  mkdirSync(directory, { recursive: true })
  for (const [name, content] of Object.entries(manifests.files)) {
    // winget-pkgs stores manifests as UTF-8 without BOM and LF line endings.
    writeFileSync(path.join(directory, name), content, 'utf8')
  }
  return directory
}

function parseArguments(argv) {
  const options = { latest: null, sha256sums: null, out: null }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = argv[index + 1]
    invariant(value !== undefined, `${argument} requires a value`)
    if (argument === '--latest') options.latest = path.resolve(value)
    else if (argument === '--sha256sums') options.sha256sums = path.resolve(value)
    else if (argument === '--out') options.out = path.resolve(value)
    else throw new Error(`Unknown argument: ${argument}`)
    index += 1
  }
  invariant(options.latest && options.sha256sums && options.out, 'usage: --latest <latest.yml> --sha256sums <SHA256SUMS.txt> --out <dir>')
  return options
}

function main() {
  const options = parseArguments(process.argv.slice(2))
  const manifests = buildWingetManifests({
    latestYml: readFileSync(options.latest, 'utf8'),
    sha256Sums: readFileSync(options.sha256sums, 'utf8'),
    changelog: readFileSync(path.join(ROOT_DIRECTORY, 'CHANGELOG.md'), 'utf8'),
    packageJson: readFileSync(path.join(CORE_DIRECTORY, 'package.json'), 'utf8'),
    electronBuilderConfig: readFileSync(path.join(CORE_DIRECTORY, 'electron-builder.yml'), 'utf8'),
  })
  const directory = writeWingetManifests(options.out, manifests)
  console.log(`winget manifests for ${PACKAGE_IDENTIFIER} ${manifests.version}`)
  console.log(`  installer   ${manifests.installerUrl}`)
  console.log(`  sha256      ${manifests.sha256}`)
  console.log(`  productCode ${manifests.productCode}`)
  console.log(`  written to  ${directory}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(`winget-manifest: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
