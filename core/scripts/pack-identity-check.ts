// A NAME IS NOT AN IDENTITY, AND THIS LIST FEEDS A DELETE (#111).
//
// Settings > Capture's "delete older than N days" trashes whatever
// listStoredPacks() returned. It used to return any directory holding a file
// called manifest.json and any file named *.zip — so pointing the output folder
// at Downloads or the Desktop put every unrelated archive, and every npm /
// Electron / Rust project folder, one confirmation away from the Recycle Bin.
//
// Run: npm run check:identity
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { directoryHoldsCapturePack, manifestNamesCapturePack } from '../src/shared/packIdentity'

const root = mkdtempSync(path.join(tmpdir(), 'capturepack-identity-'))
const cases: { name: string; build: () => string; pack: boolean }[] = []

const dir = (name: string, files: Record<string, string>): string => {
  const full = path.join(root, name)
  mkdirSync(full, { recursive: true })
  for (const [f, body] of Object.entries(files)) writeFileSync(path.join(full, f), body)
  return full
}

cases.push({
  name: 'a real pack folder',
  build: () => dir('pack', { 'manifest.json': JSON.stringify({ format: 'capturepack', format_version: '0.2.0' }) }),
  pack: true,
})
cases.push({
  name: 'a pack folder whose manifest has a BOM',
  build: () => dir('bom', { 'manifest.json': '\uFEFF' + JSON.stringify({ format: 'capturepack' }) }),
  pack: true,
})
cases.push({
  name: 'an npm project (manifest.json, not ours)',
  build: () => dir('npm-proj', { 'manifest.json': JSON.stringify({ name: 'my-app', version: '1.0.0' }) }),
  pack: false,
})
cases.push({
  name: 'a web app manifest',
  build: () => dir('webapp', { 'manifest.json': JSON.stringify({ short_name: 'App', icons: [] }) }),
  pack: false,
})
cases.push({
  name: 'manifest.json that is a DIRECTORY',
  build: () => {
    const full = path.join(root, 'weird')
    mkdirSync(path.join(full, 'manifest.json'), { recursive: true })
    return full
  },
  pack: false,
})
cases.push({
  name: 'manifest.json that is not JSON at all',
  build: () => dir('garbage', { 'manifest.json': 'not json {{{' }),
  pack: false,
})
cases.push({ name: 'a folder with no manifest', build: () => dir('empty', { 'readme.txt': 'hi' }), pack: false })

let failed = 0
console.log('FOLDERS')
for (const c of cases) {
  const got = directoryHoldsCapturePack(c.build())
  const ok = got === c.pack
  if (!ok) failed += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.name} — counted as a pack: ${got} (want ${c.pack})`)
}

// The same question of an archive, through the manifest text the zip holds.
const zipCase = (name: string, entries: Record<string, string> | null, want: boolean): void => {
  const p = path.join(root, `${name}.zip`)
  const zip = new AdmZip()
  if (entries !== null) for (const [n, body] of Object.entries(entries)) zip.addFile(n, Buffer.from(body, 'utf8'))
  zip.writeZip(p)
  const entry = new AdmZip(p).getEntry('manifest.json')
  const got = entry !== null && !entry.isDirectory && manifestNamesCapturePack(entry.getData().toString('utf8'))
  const ok = got === want
  if (!ok) failed += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — counted as a pack: ${got} (want ${want})`)
}
console.log('ARCHIVES')
zipCase('real-pack', { 'manifest.json': JSON.stringify({ format: 'capturepack' }) }, true)
zipCase('holiday-photos', { 'IMG_0001.jpg': 'x' }, false)
zipCase('some-node-module', { 'manifest.json': JSON.stringify({ name: 'left-pad' }) }, false)

rmSync(root, { recursive: true, force: true })
console.log(failed === 0 ? '\npack-identity-check ok' : `\npack-identity-check FAILED (${failed})`)
process.exitCode = failed === 0 ? 0 : 1
