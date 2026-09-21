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
import { buildSync } from 'esbuild'

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

  const qa = readFileSync(join(ROOT, 'docs', 'QA.md'), 'utf8')
  const claimsQaDiscovered = new RegExp(`the gate discovers ${String(discovered.length)} checks`, 'u')
  check(
    `docs/QA.md states the real discovered check count (${String(discovered.length)} checks)`,
    claimsQaDiscovered.test(qa),
    `docs/QA.md does not state "the gate discovers ${String(discovered.length)} checks"`,
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

console.log('\nThe usage journal template still says what Issue #1 says')
{
  // Issue #1 is the standing description of the journal practice: one issue
  // per day, title `Journal: YYYY-MM-DD`, label `journal`, three sections, and
  // `pain` / `idea` as the labels the roadmap is later mined by. The template
  // is what a person actually sees when they click New issue, so it is the
  // copy that drifts — and a template that quietly drops the label or renames
  // a section makes a month of entries unminable.
  const templatePath = join(ROOT, '.github', 'ISSUE_TEMPLATE', 'usage-journal.md')
  check('the usage journal issue template exists', existsSync(templatePath), templatePath)
  const template = existsSync(templatePath) ? readFileSync(templatePath, 'utf8') : ''
  const frontMatter = template.match(/^---\r?\n([\s\S]*?)\r?\n---/u)?.[1] ?? ''
  const field = (name) => frontMatter.match(new RegExp(`^${name}:\\s*(.+?)\\s*$`, 'mu'))?.[1] ?? ''
  check(
    'the template titles the entry "Journal: YYYY-MM-DD"',
    field('title').replace(/^["']|["']$/gu, '') === 'Journal: YYYY-MM-DD',
    `title is ${field('title') || '(missing)'}`,
  )
  check(
    'the template applies the journal label',
    field('labels').split(',').map((label) => label.trim()).includes('journal'),
    `labels is ${field('labels') || '(missing)'}`,
  )
  const headings = [...template.matchAll(/^## (.+?)\s*$/gmu)].map((match) => match[1])
  check(
    'the template carries the three sections in order',
    JSON.stringify(headings) === JSON.stringify(['Used Today', 'Pain', 'Idea']),
    `sections are ${JSON.stringify(headings)}`,
  )
  check(
    'the template tells the writer about the pain and idea labels',
    /`pain`/u.test(template) && /`idea`/u.test(template),
    'the template never mentions `pain` or `idea`',
  )

  // The contributor-facing copy of the rule has to agree with the template.
  const contributing = readFileSync(join(ROOT, 'CONTRIBUTING.md'), 'utf8')
  check(
    'CONTRIBUTING.md states the journal rule',
    /## Usage journal/u.test(contributing) &&
      contributing.includes('`Journal: YYYY-MM-DD`') &&
      contributing.includes('label `journal`') &&
      contributing.includes('.github/ISSUE_TEMPLATE/usage-journal.md'),
    'CONTRIBUTING.md lost the Usage journal section, the title format, the label or the template path',
  )
}

console.log('\nSPEC §8.3 defines annotation.text as OPTIONAL')
{
  const spec = readFileSync(join(ROOT, 'SPEC.md'), 'utf8')
  check(
    'SPEC §8.3 declares annotation.text as OPTIONAL where absent means empty string',
    /\|\s*`text`\s*\|\s*string\s*\|\s*OPTIONAL\s*\|\s*The box's description/u.test(spec) &&
      spec.includes('absent means `""`'),
    'SPEC.md §8.3 lost its text OPTIONAL declaration',
  )
  const typesSource = readFileSync(join(CORE, 'src', 'shared', 'types.ts'), 'utf8')
  check(
    'types.ts declares BoxAnnotation.text as optional string',
    /text\?:\s*string/u.test(typesSource),
    'types.ts does not declare text?: string in BoxAnnotation',
  )
}

console.log('\nSPEC §8.3 defines annotation.z as OPTIONAL')
{
  const spec = readFileSync(join(ROOT, 'SPEC.md'), 'utf8')
  check(
    'SPEC §8.3 declares annotation.z as OPTIONAL defaulting to array position',
    /\|\s*`z`\s*\|\s*integer\s*\|\s*OPTIONAL\s*\|\s*Stacking order for rendering/u.test(spec) &&
      spec.includes("Default: the annotation's array position"),
    'SPEC.md §8.3 lost its z OPTIONAL declaration',
  )
  const typesSource = readFileSync(join(CORE, 'src', 'shared', 'types.ts'), 'utf8')
  check(
    'types.ts declares BoxAnnotation.z as optional number',
    /z\?:\s*number/u.test(typesSource),
    'types.ts does not declare z?: number in BoxAnnotation',
  )
}

console.log('\nSPEC §5.3 / §13.1 defines media.replay as nullable/omitted for screenshot-only packs')
{
  const spec = readFileSync(join(ROOT, 'SPEC.md'), 'utf8')
  check(
    'SPEC §5.3 declares media.replay as string or null where null is a screenshot-only pack',
    /\|\s*`replay`\s*\|\s*string\s+\*\*or\*\*\s+`null`\s*\|\s*REQUIRED\s*\|\s*Filename of the original replay video/u.test(spec),
    'SPEC.md §5.3 lost its replay string or null declaration',
  )

  const reportSource = readFileSync(join(CORE, 'src', 'main', 'report.ts'), 'utf8')
  const packdocsSource = readFileSync(join(CORE, 'src', 'main', 'packdocs.ts'), 'utf8')
  const sessionSource = readFileSync(join(CORE, 'src', 'main', 'session.ts'), 'utf8')
  const exporterSource = readFileSync(join(CORE, 'src', 'main', 'exporter.ts'), 'utf8')

  check(
    'report.ts determines hasReplay defensively for string replay filename',
    reportSource.includes("const hasReplay = typeof manifest.media.replay === 'string' && manifest.media.replay.length > 0"),
    'report.ts hasReplay does not check typeof string and length > 0',
  )
  check(
    'report.ts keyframeSet treats non-string replay as duration 0',
    reportSource.includes("typeof manifest.media.replay !== 'string' ? 0 : (manifest.media.replay_duration_ms ?? 0)"),
    'report.ts keyframeSet does not check typeof string for replay duration',
  )
  check(
    'packdocs.ts determines hasReplay defensively in all generator functions',
    (packdocsSource.match(/const hasReplay = typeof manifest\.media\.replay === 'string' && manifest\.media\.replay\.length > 0/gu) ?? []).length === 4,
    'packdocs.ts does not declare hasReplay via typeof string and length > 0 in buildReadme, buildOverviewSkill, buildTimelineSkill, and buildProjectSkill',
  )
  check(
    'packdocs.ts replayLabel guards non-string replay as screenshotOnly',
    packdocsSource.includes("if (typeof manifest.media.replay !== 'string') return t('pack.screenshotOnly')"),
    'packdocs.ts replayLabel does not check typeof string for screenshotOnly fallback',
  )
  check(
    'session.ts guards image CapturePack replay check with typeof string',
    sessionSource.includes("if (typeof manifest.media.replay === 'string' || manifest.media.displays !== undefined)"),
    'session.ts captureMetadataFromManifest does not guard typeof manifest.media.replay === string',
  )
  check(
    'exporter.ts guards replay_annotated declaration with typeof string',
    exporterSource.includes("if (outputs.replayAnnotated && typeof manifest.media.replay === 'string')"),
    'exporter.ts does not guard replay_annotated with typeof manifest.media.replay === string',
  )
}

const bundleResult = buildSync({
  stdin: {
    contents: [
      "export { buildReport, formatClock, keyframeSet, displaySummaryLines, extraDisplayFiles } from './src/main/report'",
      "export { buildReadme, buildSkills, replayLabel } from './src/main/packdocs'",
      "export { buildViewerHtml } from './src/main/viewer'",
      "export { makeT } from './src/shared/i18n'",
    ].join('\n'),
    resolveDir: CORE,
    sourcefile: 'contract-runner.ts',
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  external: ['electron'],
})

const mod = { exports: {} }
const runner = new Function('module', 'exports', 'require', bundleResult.outputFiles[0].text)
runner(mod, mod.exports, () => ({}))
const { buildReport, formatClock, keyframeSet, displaySummaryLines, extraDisplayFiles, buildReadme, buildSkills, replayLabel, makeT, buildViewerHtml } = mod.exports

console.log('\nPacks with omitted media.replay render clean screenshot-only documentation without undefined')
{
  const t = makeT('en')
  const testAnnotations = {
    reference_width: 1920,
    reference_height: 1080,
    annotations: [],
  }
  const testTimeline = {
    t0: '2026-07-27T10:41:07+09:00',
    events: [],
  }

  for (const kind of ['omitted', 'null']) {
    const manifest = {
      format: 'capturepack',
      format_version: '0.1.0',
      id: `test-${kind}-replay-pack`,
      created_at: '2026-07-27T10:41:07+09:00',
      generator: { name: 'test', version: '0.1.0' },
      environment: { os: 'windows' },
      media: {
        snapshot: 'snapshot.png',
        ...(kind === 'null' ? { replay: null } : {}),
      },
    }

    const report = buildReport(manifest, testAnnotations, 'en', false, true)
    const readme = buildReadme(manifest, testAnnotations, 'en', false, true)
    const skills = buildSkills(manifest, testAnnotations, testTimeline, 'en', false)
    const keyframes = keyframeSet(manifest, testAnnotations, false)
    const label = replayLabel(manifest, t)

    check(
      `[${kind} replay] report.md never emits literal undefined or bogus replay entries`,
      !report.includes('undefined') &&
        report.includes('- **Replay:** none') &&
        !report.includes('- undefined') &&
        !report.includes('replay.webm'),
    )

    check(
      `[${kind} replay] README.md never emits literal undefined or bogus replay instruction`,
      !readme.includes('undefined') &&
        !readme.includes('| undefined |') &&
        readme.includes('1. Open `snapshot.png` — this pack is screenshot-only, so there is no `replay_annotated.webm`') &&
        readme.includes('- **Duration:** screenshot only (no replay)'),
    )

    check(
      `[${kind} replay] skills documents describe screenshot-only capture without undefined`,
      !skills.overview.includes('undefined') &&
        skills.overview.includes('**Media:** screenshot only (1920×1080 snapshot.png); no replay, no annotated replay.') &&
        !skills.overview.includes('replay.webm') &&
        !skills.timeline.includes('undefined') &&
        skills.timeline.includes('this pack has no replay, so offsets are relative to the trigger') &&
        !skills.timeline.includes('the start of replay.webm') &&
        !skills.project.includes('undefined') &&
        skills.project.includes('- `replay.webm` — optional last seconds before capture (absent here: screenshot-only pack).') &&
        !skills.project.includes('the last seconds before the capture. Original evidence, never modified.'),
    )

    check(
      `[${kind} replay] keyframeSet treats pack as screenshot-only with duration 0`,
      keyframes.frames.length === 0 && keyframes.dropped === 0,
    )

    check(
      `[${kind} replay] replayLabel returns localized screenshotOnly`,
      label === 'screenshot only (no replay)',
    )
  }
}

console.log('\nSPEC §5.6 / §13.1 defines displays[].replay as nullable/omitted for secondary displays without replay (Issue #210)')
{
  const spec = readFileSync(join(ROOT, 'SPEC.md'), 'utf8')
  check(
    'SPEC §5.6 declares displays[].replay as string or null',
    /\|\s*`replay`\s*\|\s*string\s+\*\*or\*\*\s+`null`\s*\|\s*REQUIRED\s*\|\s*Filename of this display's replay/u.test(spec),
    'SPEC.md §5.6 lost its displays[].replay string or null declaration',
  )
  const typesSource = readFileSync(join(CORE, 'src', 'shared', 'types.ts'), 'utf8')
  check(
    'types.ts declares ManifestDisplayMedia.replay as optional string or null',
    /replay\?:\s*string\s*\|\s*null/u.test(typesSource),
    'types.ts does not declare replay?: string | null in ManifestDisplayMedia',
  )
  const reportSource = readFileSync(join(CORE, 'src', 'main', 'report.ts'), 'utf8')
  check(
    'report.ts displaySummaryLines guards display replay with typeof string and length > 0',
    reportSource.includes("const hasReplay = typeof d.replay === 'string' && d.replay.length > 0"),
    'report.ts displaySummaryLines does not check typeof string and length > 0 for d.replay',
  )
  check(
    'report.ts extraDisplayFiles guards display replay with typeof string and length > 0',
    reportSource.includes("if (typeof d.replay === 'string' && d.replay.length > 0)"),
    'report.ts extraDisplayFiles does not check typeof string and length > 0 for d.replay',
  )

  const t = makeT('en')
  const testAnnotations = {
    reference_width: 1920,
    reference_height: 1080,
    annotations: [],
  }

  for (const secondaryReplayKind of ['omitted', 'null', 'string']) {
    const secondaryDisplay = {
      index: 2,
      snapshot: 'snapshot-d2.png',
      snapshot_width: 1920,
      snapshot_height: 1080,
      bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
      scale: 1,
      focused: false,
      ...(secondaryReplayKind === 'omitted'
        ? {}
        : secondaryReplayKind === 'null'
          ? { replay: null }
          : { replay: 'replay-d2.webm', replay_duration_ms: 10000, replay_clock_offset_ms: 0 }),
    }

    const manifest = {
      format: 'capturepack',
      format_version: '0.7.0',
      id: `test-multi-display-${secondaryReplayKind}-secondary-replay-pack`,
      created_at: '2026-07-27T10:41:07+09:00',
      generator: { name: 'test', version: '0.1.0' },
      environment: {
        os: 'windows',
        screens: [
          { width: 1920, height: 1080, scale: 1 },
          { width: 1920, height: 1080, scale: 1 },
        ],
      },
      media: {
        snapshot: 'snapshot.png',
        replay: 'replay.webm',
        replay_duration_ms: 10000,
        displays: [
          {
            index: 1,
            snapshot: 'snapshot.png',
            snapshot_width: 1920,
            snapshot_height: 1080,
            replay: 'replay.webm',
            replay_duration_ms: 10000,
            replay_clock_offset_ms: 0,
            bounds: { x: 0, y: 0, width: 1920, height: 1080 },
            scale: 1,
            focused: true,
          },
          secondaryDisplay,
        ],
      },
    }

    const summaryLines = displaySummaryLines(manifest, t, [])
    const extraFiles = extraDisplayFiles(manifest)
    const report = buildReport(manifest, testAnnotations, 'en', false, true)
    const readme = buildReadme(manifest, testAnnotations, 'en', false, true)

    if (secondaryReplayKind === 'string') {
      check(
        `[${secondaryReplayKind} secondary replay] displaySummaryLines reports replay duration and name`,
        summaryLines.some((l) => l.includes('replay-d2.webm') && l.includes('10.0s')),
      )
      check(
        `[${secondaryReplayKind} secondary replay] extraDisplayFiles includes secondary replay file`,
        extraFiles.some((f) => f.name === 'replay-d2.webm'),
      )
      check(
        `[${secondaryReplayKind} secondary replay] report.md and README.md include secondary replay`,
        report.includes('replay-d2.webm') && readme.includes('replay-d2.webm'),
      )
    } else {
      check(
        `[${secondaryReplayKind} secondary replay] displaySummaryLines reports "no replay" and never emits literal undefined or 0.0s undefined`,
        summaryLines.some((l) => l.includes('2: 1920×1080') && l.includes('no replay')) &&
          !summaryLines.some((l) => l.includes('undefined')),
      )
      check(
        `[${secondaryReplayKind} secondary replay] extraDisplayFiles only includes snapshot and never emits undefined`,
        extraFiles.length === 1 &&
          extraFiles[0].name === 'snapshot-d2.png' &&
          !extraFiles.some((f) => f.name === undefined || f.name === 'undefined'),
      )
      check(
        `[${secondaryReplayKind} secondary replay] report.md never emits literal undefined or secondary replay entries`,
        !report.includes('undefined') &&
          !report.includes('- undefined') &&
          report.includes('`snapshot-d2.png`, no replay') &&
          report.includes('- snapshot-d2.png — Display 2, 1920×1080 — the same instant on another screen') &&
          !report.includes('replay-d2.webm'),
      )
      check(
        `[${secondaryReplayKind} secondary replay] README.md never emits literal undefined or secondary replay table rows`,
        !readme.includes('undefined') &&
          !readme.includes('| undefined |') &&
          readme.includes('| snapshot-d2.png | Display 2, 1920×1080 — the same instant on another screen') &&
          !readme.includes('replay-d2.webm'),
      )
    }
  }

  for (const kind of ['omitted', 'null']) {
    const screenshotMultiManifest = {
      format: 'capturepack',
      format_version: '0.7.0',
      id: `test-screenshot-multi-${kind}-pack`,
      created_at: '2026-07-27T10:41:07+09:00',
      generator: { name: 'test', version: '0.1.0' },
      environment: {
        os: 'windows',
        screens: [
          { width: 1920, height: 1080, scale: 1 },
          { width: 1920, height: 1080, scale: 1 },
        ],
      },
      media: {
        snapshot: 'snapshot.png',
        ...(kind === 'null' ? { replay: null } : {}),
        displays: [
          {
            index: 1,
            snapshot: 'snapshot.png',
            snapshot_width: 1920,
            snapshot_height: 1080,
            ...(kind === 'null' ? { replay: null } : {}),
            bounds: { x: 0, y: 0, width: 1920, height: 1080 },
            scale: 1,
            focused: true,
          },
          {
            index: 2,
            snapshot: 'snapshot-d2.png',
            snapshot_width: 1920,
            snapshot_height: 1080,
            ...(kind === 'null' ? { replay: null } : {}),
            bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
            scale: 1,
            focused: false,
          },
        ],
      },
    }

    const report = buildReport(screenshotMultiManifest, testAnnotations, 'en', false, true)
    const readme = buildReadme(screenshotMultiManifest, testAnnotations, 'en', false, true)
    const summaryLines = displaySummaryLines(screenshotMultiManifest, t, [])
    const extraFiles = extraDisplayFiles(screenshotMultiManifest)

    check(
      `[screenshot multi-display ${kind} replay] displaySummaryLines reports no replay on all displays without undefined`,
      summaryLines.every((l) => !l.includes('undefined')) &&
        summaryLines.filter((l) => l.includes('no replay')).length === 2,
    )
    check(
      `[screenshot multi-display ${kind} replay] extraDisplayFiles contains snapshot only`,
      extraFiles.length === 1 && extraFiles[0].name === 'snapshot-d2.png',
    )
    check(
      `[screenshot multi-display ${kind} replay] report.md and README.md never contain literal undefined`,
      !report.includes('undefined') &&
        !report.includes('- undefined') &&
        !readme.includes('undefined') &&
        !readme.includes('| undefined |'),
    )
  }
}

console.log('\nSPEC §4, §8, §14 define annotations.json as OPTIONAL')
{
  const spec = readFileSync(join(ROOT, 'SPEC.md'), 'utf8')
  check(
    'SPEC §4 and §8 declare annotations.json as OPTIONAL',
    spec.includes('`annotations.json` | OPTIONAL') &&
      spec.includes('`annotations.json` is OPTIONAL; it is present when the user annotated the capture.'),
    'SPEC.md lost its annotations.json OPTIONAL declaration in §4 or §8',
  )
  check(
    'SPEC §14 Rule 3 declares a screenshot-only pack without annotations is valid',
    /screenshot-only pack.*manifest\.json.*snapshot\.png.*fully valid/u.test(spec),
    'SPEC.md §14 lost the screenshot-only pack validity rule',
  )
  const exporterSource = readFileSync(join(CORE, 'src', 'main', 'exporter.ts'), 'utf8')
  check(
    'exporter.ts defines and exports readAnnotationsSafe',
    exporterSource.includes('export async function readAnnotationsSafe'),
    'exporter.ts does not export readAnnotationsSafe',
  )
  check(
    'addManifestPlugin and refreshPackDocs use readAnnotationsSafe to guard against ENOENT',
    /await readAnnotationsSafe\(\s*handle\.dirPath/u.test(exporterSource) &&
      /await readAnnotationsSafe\(\s*dirPath/u.test(exporterSource),
    'exporter.ts addManifestPlugin or refreshPackDocs does not use readAnnotationsSafe',
  )
}

console.log('\nbuildReport, buildReadme, and buildSkills succeed when annotationsFile.annotations is omitted or empty (Issue #207)')
{
  const reportSource = readFileSync(join(CORE, 'src', 'main', 'report.ts'), 'utf8')
  const packdocsSource = readFileSync(join(CORE, 'src', 'main', 'packdocs.ts'), 'utf8')
  check(
    'report.ts guards annotationsFile?.annotations with Array.isArray in buildReport and keyframeSet',
    reportSource.includes('Array.isArray(annotationsFile?.annotations)') &&
      reportSource.includes('displaySummaryLines(manifest, t, annotations)'),
    'report.ts does not guard annotationsFile?.annotations or does not pass guarded annotations',
  )
  check(
    'packdocs.ts guards annotationsFile?.annotations with Array.isArray in buildReadme and buildSkills helpers',
    packdocsSource.includes('Array.isArray(annotationsFile?.annotations)') &&
      packdocsSource.includes('buildOverviewSkill(manifest, annotationsFile') &&
      packdocsSource.includes('buildAnnotationSkill(manifest, annotationsFile') &&
      packdocsSource.includes('buildDomSkill(manifest, annotationsFile'),
    'packdocs.ts does not guard annotationsFile?.annotations in buildReadme and skill builders',
  )

  const testTimeline = {
    t0: '2026-07-27T10:41:07+09:00',
    events: [],
  }
  const testManifest = {
    format: 'capturepack',
    format_version: '0.1.0',
    id: 'test-no-annotations-pack',
    created_at: '2026-07-27T10:41:07+09:00',
    generator: { name: 'test', version: '0.1.0' },
    environment: { os: 'windows' },
    media: {
      snapshot: 'snapshot.png',
      replay: null,
      replay_duration_ms: null,
    },
  }

  const testCases = [
    { name: 'omitted annotations property', file: { reference_width: 1920, reference_height: 1080 } },
    { name: 'empty annotations array', file: { reference_width: 1920, reference_height: 1080, annotations: [] } },
    { name: 'undefined annotations property', file: { reference_width: 1920, reference_height: 1080, annotations: undefined } },
    { name: 'null annotations property', file: { reference_width: 1920, reference_height: 1080, annotations: null } },
    { name: 'non-array annotations property', file: { reference_width: 1920, reference_height: 1080, annotations: 'not-an-array' } },
  ]

  for (const tc of testCases) {
    let reportOk = false
    let readmeOk = false
    let skillsOk = false
    try {
      const report = buildReport(testManifest, tc.file, 'en', false, true)
      reportOk = typeof report === 'string' && report.includes('snapshot.png')
    } catch {
      reportOk = false
    }

    try {
      const readme = buildReadme(testManifest, tc.file, 'en', false, true)
      readmeOk = typeof readme === 'string' && readme.includes('snapshot.png')
    } catch {
      readmeOk = false
    }

    try {
      const skills = buildSkills(testManifest, tc.file, testTimeline, 'en', false)
      skillsOk =
        skills !== null &&
        typeof skills === 'object' &&
        typeof skills.overview === 'string' &&
        typeof skills.annotation === 'string' &&
        typeof skills.dom === 'string' &&
        skills.annotation.includes('This pack has no annotation boxes.')
    } catch {
      skillsOk = false
    }

    check(
      `buildReport does not throw on ${tc.name}`,
      reportOk,
      `buildReport threw or returned invalid result for ${tc.name}`,
    )
    check(
      `buildReadme does not throw on ${tc.name}`,
      readmeOk,
      `buildReadme threw or returned invalid result for ${tc.name}`,
    )
    check(
      `buildSkills does not throw on ${tc.name}`,
      skillsOk,
      `buildSkills threw or returned invalid result for ${tc.name}`,
    )
  }
}

console.log('\nSPEC §5.2 defines environment.os_version and environment.screens[].scale as OPTIONAL (Issue #209)')
{
  const spec = readFileSync(join(ROOT, 'SPEC.md'), 'utf8')
  check(
    'SPEC §5.2 declares os_version as OPTIONAL (RECOMMENDED)',
    /\|\s*`os_version`\s*\|\s*string\s*\|\s*OPTIONAL\s+\(RECOMMENDED\)\s*\|/u.test(spec),
    'SPEC.md §5.2 lost its os_version OPTIONAL (RECOMMENDED) declaration',
  )
  check(
    'SPEC §5.2 declares screens[].scale as OPTIONAL with default 1',
    /\|\s*`scale`\s*\|\s*number\s*\|\s*OPTIONAL\s*\|\s*OS display scale factor.*Default `1`/u.test(spec),
    'SPEC.md §5.2 lost its screens[].scale OPTIONAL declaration or default 1',
  )

  const schemaSource = readFileSync(join(ROOT, 'docs', 'schemas', 'manifest.schema.json'), 'utf8')
  const schema = JSON.parse(schemaSource)
  const envRequired = schema.properties?.environment?.required ?? []
  const screenRequired = schema.properties?.environment?.properties?.screens?.items?.required ?? []
  const scaleDefault = schema.properties?.environment?.properties?.screens?.items?.properties?.scale?.default

  check(
    'manifest.schema.json declares environment.os as required and os_version as optional',
    envRequired.includes('os') && !envRequired.includes('os_version'),
    'manifest.schema.json does not declare os as required and os_version as optional',
  )
  check(
    'manifest.schema.json declares screens items width/height required and scale optional with default 1',
    screenRequired.includes('width') &&
      screenRequired.includes('height') &&
      !screenRequired.includes('scale') &&
      scaleDefault === 1,
    'manifest.schema.json does not declare scale optional with default 1 on screens items',
  )

  const typesSource = readFileSync(join(CORE, 'src', 'shared', 'types.ts'), 'utf8')
  check(
    'types.ts declares os_version as optional in Manifest environment',
    /os_version\?:\s*string/u.test(typesSource),
    'types.ts does not declare os_version?: string in Manifest environment',
  )
  check(
    'types.ts declares scale as optional in Manifest environment screens',
    /screens\?:\s*Array<\{[\s\S]*?scale\?:\s*number[\s\S]*?\}>/u.test(typesSource),
    'types.ts does not declare scale?: number in Manifest environment screens',
  )
}

console.log('\nPacks omitting optional os_version and screens[].scale render clean docs and viewer without undefined (Issue #209)')
{
  const testAnnotations = {
    reference_width: 1920,
    reference_height: 1080,
    annotations: [],
  }
  const testTimeline = {
    t0: '2026-07-27T10:41:07+09:00',
    events: [],
  }

  const envCases = [
    {
      name: 'omitted os_version and scale',
      environment: {
        os: 'windows',
        screens: [{ width: 1920, height: 1080 }],
      },
      expectedOsText: 'windows',
      expectedReportOs: '- **OS:** windows',
      expectedViewerOs: '<dt>OS</dt><dd>windows</dd>',
      expectedReportScreens: '- **Screens:** 1920×1080 @1x scale',
      expectedViewerScreens: '<dt>Screens</dt><dd>1920×1080 @1x</dd>',
    },
    {
      name: 'omitted os_version only (scale present)',
      environment: {
        os: 'darwin',
        screens: [{ width: 1728, height: 1117, scale: 2 }],
      },
      expectedOsText: 'darwin',
      expectedReportOs: '- **OS:** darwin',
      expectedViewerOs: '<dt>OS</dt><dd>darwin</dd>',
      expectedReportScreens: '- **Screens:** 1728×1117 @2x scale',
      expectedViewerScreens: '<dt>Screens</dt><dd>1728×1117 @2x</dd>',
    },
    {
      name: 'omitted scale only (os_version present)',
      environment: {
        os: 'linux',
        os_version: '6.5.0-generic',
        screens: [{ width: 2560, height: 1440 }],
      },
      expectedOsText: 'linux 6.5.0-generic',
      expectedReportOs: '- **OS:** linux (version 6.5.0-generic)',
      expectedViewerOs: '<dt>OS</dt><dd>linux 6.5.0-generic</dd>',
      expectedReportScreens: '- **Screens:** 2560×1440 @1x scale',
      expectedViewerScreens: '<dt>Screens</dt><dd>2560×1440 @1x</dd>',
    },
    {
      name: 'multiple screens with mixed omitted scales',
      environment: {
        os: 'windows',
        screens: [
          { width: 1920, height: 1080 },
          { width: 3840, height: 2160, scale: 2 },
        ],
      },
      expectedOsText: 'windows',
      expectedReportOs: '- **OS:** windows',
      expectedViewerOs: '<dt>OS</dt><dd>windows</dd>',
      expectedReportScreens: '- **Screens:** 1920×1080 @1x scale; 3840×2160 @2x scale',
      expectedViewerScreens: '<dt>Screens</dt><dd>1920×1080 @1x; 3840×2160 @2x</dd>',
    },
    {
      name: 'minimal environment omitting both screens and os_version',
      environment: {
        os: 'windows',
      },
      expectedOsText: 'windows',
      expectedReportOs: '- **OS:** windows',
      expectedViewerOs: '<dt>OS</dt><dd>windows</dd>',
      expectedReportScreens: '- **Screens:** unknown',
      expectedViewerScreens: '<dt>Screens</dt><dd>unknown</dd>',
    },
  ]

  for (const tc of envCases) {
    const manifest = {
      format: 'capturepack',
      format_version: '0.5.0',
      id: `test-env-${tc.name.replace(/\s+/gu, '-')}`,
      created_at: '2026-07-27T10:41:07+09:00',
      generator: { name: 'test', version: '0.5.0' },
      environment: tc.environment,
      media: {
        snapshot: 'snapshot.png',
        replay: null,
      },
    }

    const report = buildReport(manifest, testAnnotations, 'en', false, true)
    const readme = buildReadme(manifest, testAnnotations, 'en', false, true)
    const skills = buildSkills(manifest, testAnnotations, testTimeline, 'en', false)
    const viewerHtml = buildViewerHtml(manifest, testAnnotations, testTimeline, 'en')

    check(
      `[${tc.name}] report.md never emits literal undefined and formats OS and screens cleanly`,
      !report.includes('undefined') &&
        !report.includes('@undefinedx') &&
        !report.includes('(version undefined)') &&
        report.includes(tc.expectedReportOs) &&
        report.includes(tc.expectedReportScreens),
      `report.md emitted undefined or mismatched format for ${tc.name}`,
    )

    check(
      `[${tc.name}] README.md never emits literal undefined`,
      !readme.includes('undefined'),
      `README.md emitted undefined for ${tc.name}`,
    )

    check(
      `[${tc.name}] skills/overview.md never emits literal undefined and formats OS cleanly`,
      !skills.overview.includes('undefined') &&
        skills.overview.includes(`on ${tc.expectedOsText}`) &&
        !skills.overview.includes(`on ${tc.expectedOsText} undefined`),
      `skills/overview.md emitted undefined or mismatched OS for ${tc.name}`,
    )

    check(
      `[${tc.name}] viewer.html never emits literal undefined and formats OS and screens cleanly`,
      !viewerHtml.includes('undefined') &&
        !viewerHtml.includes('@undefinedx') &&
        viewerHtml.includes(tc.expectedViewerOs) &&
        viewerHtml.includes(tc.expectedViewerScreens),
      `viewer.html emitted undefined or mismatched format for ${tc.name}`,
    )
  }
}

console.log('\nSPEC §10.1: formatClock preserves sign for negative millisecond offsets (Issue #211)')
{
  check(
    'formatClock correctly formats positive, zero, and negative millisecond offsets',
    formatClock(0) === '00:00.000' &&
      formatClock(3200) === '00:03.200' &&
      formatClock(65432) === '01:05.432' &&
      formatClock(-1500) === '-00:01.500' &&
      formatClock(-3500) === '-00:03.500' &&
      formatClock(-1200) === '-00:01.200' &&
      formatClock(-50) === '-00:00.050' &&
      formatClock(-65432) === '-01:05.432',
    `formatClock produced unexpected formatted strings: 0->${formatClock(0)}, 3200->${formatClock(3200)}, -1500->${formatClock(-1500)}, -50->${formatClock(-50)}`,
  )

  const reportSource = readFileSync(join(CORE, 'src', 'main', 'report.ts'), 'utf8')
  check(
    'report.ts does not clamp formatClock to Math.max(0, ...)',
    !reportSource.includes('Math.max(0, Math.round(ms))'),
    'report.ts still clamps negative ms values in formatClock',
  )

  const testAnnotations = {
    reference_width: 1920,
    reference_height: 1080,
    annotations: [],
  }
  const testTimeline = {
    t0: '2026-07-27T10:41:07+09:00',
    events: [
      { t_ms: -3500, type: 'input.window.focus', source: 'core', data: { title: 'Code' } },
      { t_ms: -1200, type: 'input.mouse.click', source: 'core', data: { button: 'left', x: 120, y: 300 } },
      { t_ms: 0, type: 'core.capture.triggered', source: 'core', data: {} },
      { t_ms: 1500, type: 'core.annotation.added', source: 'core', data: { annotation_id: 'box-1' } },
    ],
  }
  const manifest = {
    format: 'capturepack',
    format_version: '0.5.0',
    id: 'test-negative-timeline-pack',
    created_at: '2026-07-27T10:41:07+09:00',
    generator: { name: 'test', version: '0.5.0' },
    environment: { os: 'windows' },
    media: {
      snapshot: 'snapshot.png',
      replay: null,
    },
  }

  const skills = buildSkills(manifest, testAnnotations, testTimeline, 'en', false)
  check(
    'skills/timeline.md displays signed offsets for pre-t0 events (SPEC §10.1)',
    skills.timeline.includes('| -00:03.500 | input.window.focus |') &&
      skills.timeline.includes('| -00:01.200 | input.mouse.click |') &&
      skills.timeline.includes('| 00:00.000 | core.capture.triggered |') &&
      skills.timeline.includes('| 00:01.500 | core.annotation.added |'),
    `skills/timeline.md did not include expected signed offsets. Output:\n${skills.timeline}`,
  )

  const lines = skills.timeline.split('\n')
  const focusLine = lines.find((l) => l.includes('input.window.focus'))
  const clickLine = lines.find((l) => l.includes('input.mouse.click'))
  check(
    'skills/timeline.md preserves distinct timing offsets for pre-anchor events',
    focusLine !== undefined &&
      clickLine !== undefined &&
      !focusLine.includes('| 00:00.000 |') &&
      !clickLine.includes('| 00:00.000 |') &&
      focusLine !== clickLine,
    'pre-t0 events collapsed to 00:00.000 or identical timestamps',
  )
}

console.log(`\nresult: ${failed === 0 ? 'OK' : 'BROKEN'} — ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
