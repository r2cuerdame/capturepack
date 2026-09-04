// DO THE DOCUMENTS STILL DESCRIBE THIS REPOSITORY?
//
// WHY THIS EXISTS. Every one of these has already happened here: a handoff that
// promised a 65-step gate after the gate had 68, a QA page naming an `npm run`
// script that was never added, a link to a document that moved, and an
// end-to-end harness the docs described as covered while `qa-gate.mjs` — which
// discovers checks from `core/package.json` — had never heard of it. Each was
// found by a person reading carefully, which is not a mechanism.
//
// Documentation drift is not cosmetic in this project. The handoff set IS the
// instruction given to the next engineer, so a stale sentence in it is a wrong
// instruction, and the repository already treats "silence is not absence" as a
// rule everywhere else.
//
// WHAT IT DOES NOT DO. It does not read prose for truth. It checks the claims
// that are mechanically checkable — links, anchors, script names, version and
// step counts — and leaves judgement to the reader.
//
//   node scripts/docs-contract-check.mjs

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = resolve(CORE, '..')

let passed = 0
let failed = 0
function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

// Build output and vendored trees are not documentation. `core/dist-*` and
// `core/rc-*` are gitignored release directories that carry copies of shipped
// markdown whose relative links only resolve inside an installed app.
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', '.claude', 'out', 'release'])
const SKIP_PREFIXES = ['dist', 'rc-', 'rc0', 'release-']

function markdownFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry)) continue
      if (SKIP_PREFIXES.some((prefix) => entry.startsWith(prefix))) continue
      markdownFiles(full, out)
    } else if (entry.endsWith('.md')) {
      out.push(full)
    }
  }
  return out
}

/**
 * A document's prose, with fenced code blocks and inline code removed.
 *
 * Without this, a regular expression in a code sample reads as a broken link
 * and an example filename reads as a missing file. The blank lines are kept so
 * a reported line number still means something.
 */
function withoutFences(text) {
  let fenced = false
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*```/u.test(line)) {
        fenced = !fenced
        return ''
      }
      if (fenced) return ''
      if (/^ {4,}\S/u.test(line)) return ''
      return line
    })
    .join('\n')
}

/**
 * Prose with inline code removed as well — for LINKS only.
 *
 * Headings must NOT go through this. `### 5.3 \`media\`` reduces to `### 5.3`
 * once its backticks are taken, and every §5.3 cross-reference in SPEC.md then
 * looks broken while GitHub resolves all of them: the punctuation is dropped by
 * the slug rule, the word is not.
 */
function prose(text) {
  return withoutFences(text)
    .split('\n')
    .map((line) => line.replace(/`[^`]*`/gu, ''))
    .join('\n')
}

/**
 * GitHub's heading slug: lower-cased, punctuation dropped, EACH space a dash.
 *
 * `\p{L}\p{N}`, NOT `\w`. JavaScript's `\w` is ASCII-only even under the `u`
 * flag, so the previous version deleted every Hangul, kana, Han and Cyrillic
 * character in a heading and left the dashes behind — meaning a localized
 * anchor could never match its own heading. It passed for a year because only
 * the English README linked to a section; the moment the eight translations
 * grew one, all eight reported a broken link that GitHub resolves perfectly
 * well. GitHub keeps Unicode letters in an anchor, and so does this now.
 */
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/gu, '-')
}

function anchorsOf(text) {
  const anchors = new Set()
  for (const match of withoutFences(text).matchAll(/^#{1,6}\s+(.+?)\s*$/gmu)) {
    anchors.add(slug(match[1]))
  }
  return anchors
}

const packageJson = JSON.parse(readFileSync(join(CORE, 'package.json'), 'utf8'))
const scriptNames = Object.keys(packageJson.scripts ?? {})
const files = markdownFiles(ROOT)

console.log(`\nEvery link and anchor resolves (${files.length} documents)`)
{
  const anchorCache = new Map()
  const anchorsFor = (file) => {
    if (!anchorCache.has(file)) anchorCache.set(file, anchorsOf(readFileSync(file, 'utf8')))
    return anchorCache.get(file)
  }
  const broken = []
  for (const file of files) {
    const text = prose(readFileSync(file, 'utf8'))
    const own = anchorsFor(file)
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/gu)) {
      const target = match[1]
      if (/^(?:https?:|mailto:|#!)/u.test(target)) continue
      const hashAt = target.indexOf('#')
      const pathPart = hashAt === -1 ? target : target.slice(0, hashAt)
      const hash = hashAt === -1 ? null : target.slice(hashAt + 1)
      const where = relative(ROOT, file).replace(/\\/gu, '/')
      if (pathPart === '') {
        if (hash !== null && !own.has(hash.toLowerCase())) {
          broken.push(`${where} -> #${hash}`)
        }
        continue
      }
      const absolute = resolve(dirname(file), decodeURIComponent(pathPart))
      if (!existsSync(absolute)) {
        broken.push(`${where} -> ${target}`)
        continue
      }
      if (hash !== null && absolute.endsWith('.md')) {
        if (!anchorsFor(absolute).has(hash.toLowerCase())) {
          broken.push(`${where} -> ${target}`)
        }
      }
    }
  }
  check('no broken relative link or section anchor', broken.length === 0, broken.join('; '))
}

console.log('\nEvery npm script the documents name exists')
{
  // Only the documents that speak for `core/` — `tools/site-motion` has its own
  // package and its own scripts.
  const coreDocs = files.filter((file) => !relative(ROOT, file).replace(/\\/gu, '/').startsWith('tools/'))
  const missing = []
  for (const file of coreDocs) {
    const text = prose(readFileSync(file, 'utf8'))
    for (const match of text.matchAll(/npm run ([a-z][a-z0-9:._-]*)/gu)) {
      const name = match[1]
      if (!scriptNames.includes(name)) {
        missing.push(`${relative(ROOT, file).replace(/\\/gu, '/')}: npm run ${name}`)
      }
    }
  }
  check('no document names a script that does not exist', missing.length === 0, missing.join('; '))
}

console.log('\nThe handoff set agrees with the gate it describes')
{
  const handoff = readFileSync(join(ROOT, 'docs', 'HANDOFF.md'), 'utf8')
  const prompt = readFileSync(join(ROOT, 'docs', 'HANDOFF-PROMPT.md'), 'utf8')

  // The gate is what `qa-gate.mjs` discovers, computed the same way it does.
  const discovered = scriptNames.filter((name) => name.startsWith('check:') && name !== 'check:qa')
  const gateSteps = discovered.length + 3 // typecheck + build + smoke
  const skipBuildSteps = discovered.length + 1
  const claimsFull = new RegExp(`\\b${String(gateSteps)}\\b`, 'u')
  const claimsChecks = new RegExp(`\\b${String(discovered.length)} discovered`, 'u')
  check(
    `the handoff states the real check count (${String(discovered.length)} discovered, ${String(gateSteps)} steps)`,
    claimsChecks.test(handoff) && claimsFull.test(handoff),
    'docs/HANDOFF.md does not state the number qa-gate would actually run',
  )
  check(
    `the handoff prompt states the real step count (${String(gateSteps)}, ${String(skipBuildSteps)} with --skip-build)`,
    claimsFull.test(prompt) && new RegExp(`\\b${String(skipBuildSteps)}\\b`, 'u').test(prompt),
    'docs/HANDOFF-PROMPT.md does not state the number qa-gate would actually run',
  )
}

console.log('\nThe documents name the version this repository builds')
{
  const version = packageJson.version
  const handoff = readFileSync(join(ROOT, 'docs', 'HANDOFF.md'), 'utf8')
  const docsIndex = readFileSync(join(ROOT, 'docs', 'README.md'), 'utf8')
  check(
    `the handoff names the application version under development (${version})`,
    handoff.includes(version),
    `docs/HANDOFF.md never mentions ${version}`,
  )
  check(
    `the documentation index names it too (${version})`,
    docsIndex.includes(version),
    `docs/README.md never mentions ${version}`,
  )

  // MENTIONING A VERSION IS NOT STATING IT.
  //
  // 0.4.5 shipped with a handoff that said "after v0.4.4" in its title and stated
  // outright that core/package.json is application version 0.4.4 — and this gate
  // stayed green, because one line further down mentioned 0.4.5 and `includes`
  // never asked where. A check that exists, is correct and asserts too little is
  // indistinguishable from coverage until someone reads the document by hand.
  //
  // Only the sentence below can be settled from core/package.json. The handoff
  // title and its public-release row track the last PUBLISHED release, which is
  // site/validate.mjs's PUBLIC_VERSION and is deliberately BEHIND this version
  // during an RC cycle; they are asserted there.
  const claimed = [
    ...handoff.matchAll(/`core\/package\.json` is application version `([^`]+)`/gu),
  ].map((match) => match[1])
  check(
    `every "core/package.json is application version" claim says ${version}`,
    claimed.length > 0 && claimed.every((claim) => claim === version),
    claimed.length === 0
      ? 'docs/HANDOFF.md never states the application version core/package.json carries'
      : `docs/HANDOFF.md claims ${claimed.join(', ')}`,
  )
}

console.log('\nThe current handoff is the only one that reads as instructions')
{
  const docsDirectory = join(ROOT, 'docs')
  const archived = readdirSync(docsDirectory).filter((name) => /^HANDOFF-v.*\.md$/u.test(name))
  const index = readFileSync(join(docsDirectory, 'README.md'), 'utf8')
  const problems = []
  for (const name of archived) {
    const text = readFileSync(join(docsDirectory, name), 'utf8')
    // An archived handoff has to say so in its own opening, because it is read
    // on its own as often as it is read from the index.
    const head = text.slice(0, 1500).toLowerCase()
    if (!/archiv|historical|superseded|not current/u.test(head)) {
      problems.push(`${name} does not declare itself archived in its opening`)
    }
    if (!index.includes(name)) problems.push(`${name} is not listed in docs/README.md`)
  }
  check(
    `every archived handoff declares itself historical (${String(archived.length)} found)`,
    problems.length === 0,
    problems.join('; '),
  )
  check(
    'the index separates historical material from current sources',
    /## Historical material/u.test(index) && /## Start here/u.test(index),
    'docs/README.md lost its Start here / Historical material split',
  )
}

console.log(`\nresult: ${failed === 0 ? 'OK' : 'BROKEN'} — ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
