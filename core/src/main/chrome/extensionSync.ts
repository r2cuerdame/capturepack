import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

const MANIFEST = 'manifest.json'

function filesBelow(root: string): string[] {
  const result: string[] = []
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name)
      const relative = path.relative(root, absolute).replace(/\\/g, '/')
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile()) result.push(relative)
      else throw new Error(`unsupported extension entry: ${relative}`)
    }
  }
  visit(root)
  return result.sort()
}

/** A path-independent identity for every shipped extension byte. */
export function extensionTreeDigest(root: string): string {
  const hash = crypto.createHash('sha256')
  for (const relative of filesBelow(root)) {
    hash.update(relative)
    hash.update('\0')
    hash.update(fs.readFileSync(path.join(root, ...relative.split('/'))))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function removeEmptyAndExtraEntries(root: string, wanted: ReadonlySet<string>, dir = root): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name)
    const relative = path.relative(root, absolute).replace(/\\/g, '/')
    if (entry.isDirectory()) {
      removeEmptyAndExtraEntries(root, wanted, absolute)
      if (fs.readdirSync(absolute).length === 0) fs.rmdirSync(absolute)
    } else if (entry.isFile() && !wanted.has(relative)) {
      fs.unlinkSync(absolute)
    }
  }
}

/**
 * Updates Chrome's stable unpacked folder exactly, publishing manifest.json
 * last. A crash at any earlier byte leaves a digest mismatch, so the next app
 * start retries instead of trusting a version that happened to copy first.
 */
export function syncExtensionTree(source: string, target: string): string {
  const sourceFiles = filesBelow(source)
  if (!sourceFiles.includes(MANIFEST)) throw new Error('bundled extension has no manifest.json')
  const sourceDigest = extensionTreeDigest(source)
  if (fs.existsSync(target)) {
    try {
      if (extensionTreeDigest(target) === sourceDigest) return sourceDigest
    } catch {
      // A partial/unsupported target is repaired below.
    }
  }

  fs.mkdirSync(target, { recursive: true })
  const manifestLast = sourceFiles.filter((relative) => relative !== MANIFEST)
  manifestLast.push(MANIFEST)
  for (const relative of manifestLast) {
    const destination = path.join(target, ...relative.split('/'))
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(path.join(source, ...relative.split('/')), destination)
  }
  removeEmptyAndExtraEntries(target, new Set(sourceFiles))
  const installedDigest = extensionTreeDigest(target)
  if (installedDigest !== sourceDigest) {
    throw new Error(`extension copy verification failed (${installedDigest} != ${sourceDigest})`)
  }
  return sourceDigest
}
