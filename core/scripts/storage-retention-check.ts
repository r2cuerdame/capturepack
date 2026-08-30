// AUTOMATIC CLEANUP IS THE ONLY CODE IN THIS APPLICATION THAT DELETES A USER'S
// EVIDENCE WITH NOBODY'S FINGER ON A BUTTON.
//
// Everything else that trashes a pack was pressed: the four Settings purge
// buttons, History's per-card delete. Issue #47 adds a rule that runs at
// startup and once a day on a timer, and issue #48 gives it a second trigger
// keyed on a size. That is a background job holding a shovel, so the rule it
// obeys is kept pure (shared/retention.ts — no disk, no clock, no Electron) and
// this check runs it to exhaustion, plus pins the wiring that decides whether
// the pure rule is the one that actually gets consulted.
//
// THE FAILURE THIS EXISTS FOR, above all others: the manual scale and the
// automatic scale both use the number 0, and they mean opposite things by it.
// "Purge older than 0 days" is every pack ever written — correct, and what the
// [Delete everything] button promises. "Retention: 0 days" is KEEP EVERYTHING,
// the default a fresh install ships with. Wire the mode into the purge and the
// first scheduled run empties the folder of a user who never touched the
// setting.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  budgetFraction,
  budgetLevel,
  budgetPercent,
  DEFAULT_STORAGE_MAX_BYTES,
  isRetentionDays,
  isStorageMaxBytes,
  MIN_STORAGE_MAX_BYTES,
  planRetention,
  RETENTION_DAY_CHOICES,
  RETENTION_KEEP_EVERYTHING,
  STORAGE_MAX_BYTES_CHOICES,
  formatBytes,
  type RetentionCandidate,
  type RetentionPolicy,
} from '../src/shared/retention'

let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (!condition) failed += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

/** The body of `name`'s declaration, from its signature to the next top-level `}`. */
function functionBody(text: string, name: string): string {
  const at = text.indexOf(`function ${name}(`)
  if (at < 0) return ''
  const end = text.indexOf('\n}', at)
  return end < 0 ? '' : text.slice(at, end)
}

const DAY = 86_400_000
const MB = 1_048_576
const NOW = Date.UTC(2026, 6, 1, 12, 0, 0)

function pack(name: string, ageDays: number, megabytes: number): RetentionCandidate {
  return { path: `C:\\out\\${name}`, bytes: megabytes * MB, mtimeMs: NOW - ageDays * DAY }
}

/**
 * The newest pack a real folder can hold.
 *
 * NOT `pack(name, 0, …)`. Both rules ask `mtimeMs < cutoff`, so a pack whose
 * mtime is exactly the evaluation instant is not older than it — true, and
 * unreachable on a real disk, where a pack is finished writing before anything
 * gets round to counting it. A fixture that pretends otherwise makes "delete
 * everything" look like it misses one.
 */
function justWritten(name: string, megabytes: number): RetentionCandidate {
  return { path: `C:\\out\\${name}`, bytes: megabytes * MB, mtimeMs: NOW - 30 * 60_000 }
}

function policy(over: Partial<RetentionPolicy> = {}): RetentionPolicy {
  return {
    retentionDays: RETENTION_KEEP_EVERYTHING,
    maxBytes: DEFAULT_STORAGE_MAX_BYTES,
    enforceMaxBytes: false,
    ...over,
  }
}

function names(packs: readonly RetentionCandidate[]): string {
  return packs.map((p) => path.basename(p.path)).join(',')
}

console.log('KEEP EVERYTHING IS THE DEFAULT, AND IT KEEPS EVERYTHING')
const aged = [pack('a', 400, 100), pack('b', 40, 100), pack('c', 2, 100), justWritten('d', 100)]
{
  const plan = planRetention(aged, policy(), NOW)
  check('the default mode is 0 days', RETENTION_KEEP_EVERYTHING === 0)
  check('a fresh profile deletes nothing, however old the packs are', plan.doomed.length === 0, names(plan.doomed))
  check('and reports the folder untouched', plan.bytes === 0 && plan.remainingBytes === plan.totalBytes)
}
{
  // THE WHOLE POINT. The same zero, run through the manual rule, takes the lot.
  const manualCutoff = NOW - 0 * DAY
  const manualDoomed = aged.filter((p) => p.mtimeMs < manualCutoff)
  const automatic = planRetention(aged, policy({ retentionDays: 0 }), NOW)
  check(
    'the MANUAL zero still means every pack there is',
    manualDoomed.length === aged.length,
    `${String(manualDoomed.length)} of ${String(aged.length)}`,
  )
  check(
    'the AUTOMATIC zero means the opposite, and the two never share a code path',
    automatic.doomed.length === 0,
    names(automatic.doomed),
  )
}

console.log('\nAGE RULE')
{
  const plan = planRetention(aged, policy({ retentionDays: 7 }), NOW)
  check('takes only what is past the age', names(plan.expired) === 'a,b', names(plan.expired))
  check('oldest first', names(plan.doomed) === 'a,b', names(plan.doomed))
  check('and frees exactly what it took', plan.bytes === 200 * MB)
  check('a pack exactly at the cutoff is kept', planRetention([pack('edge', 7, 10)], policy({ retentionDays: 7 }), NOW).doomed.length === 0)
  check('30 days reaches further back than 7', planRetention(aged, policy({ retentionDays: 30 }), NOW).expired.length === 2)
  check('1 day takes everything but today', planRetention(aged, policy({ retentionDays: 1 }), NOW).expired.length === 3)
  check(
    'the age rule MAY empty the folder, because that is what it says out loud',
    planRetention([pack('old', 90, 10)], policy({ retentionDays: 30 }), NOW).doomed.length === 1,
  )
}

console.log('\nBUDGET RULE (issue #48: the second trigger)')
const heavy = [pack('p1', 9, 4000), pack('p2', 6, 4000), pack('p3', 3, 4000), justWritten('p4', 4000)]
{
  const unarmed = planRetention(heavy, policy({ maxBytes: 1024 * MB }), NOW)
  check(
    'a budget alone deletes NOTHING — the bar is a picture until the box is ticked',
    unarmed.doomed.length === 0,
    names(unarmed.doomed),
  )
  const armed = planRetention(heavy, policy({ maxBytes: 9000 * MB, enforceMaxBytes: true }), NOW)
  check('armed, it takes the oldest first', names(armed.overBudget) === 'p1,p2', names(armed.overBudget))
  check('and stops the moment it is under', armed.remainingBytes <= 9000 * MB)
  check('taking no more than it had to', armed.remainingBytes + armed.doomed[armed.doomed.length - 1]!.bytes > 9000 * MB)
}
{
  // A budget smaller than one recording must not delete the capture the user
  // took thirty seconds ago, every day, forever.
  const one = planRetention([justWritten('only', 4000)], policy({ maxBytes: 512 * MB, enforceMaxBytes: true }), NOW)
  check('the newest pack is never taken by the budget', one.doomed.length === 0, names(one.doomed))
  const two = planRetention(
    [pack('older', 5, 4000), justWritten('newest', 4000)],
    policy({ maxBytes: 512 * MB, enforceMaxBytes: true }),
    NOW,
  )
  check('so an impossible budget stops at one survivor', names(two.doomed) === 'older', names(two.doomed))
}
{
  const both = planRetention(
    heavy,
    policy({ retentionDays: 7, maxBytes: 4000 * MB, enforceMaxBytes: true }),
    NOW,
  )
  const unique = new Set(both.doomed.map((p) => p.path))
  check('age and budget combine without counting a pack twice', unique.size === both.doomed.length)
  check('and the freed total matches the packs listed', both.bytes === both.doomed.reduce((s, p) => s + p.bytes, 0))
  check('nothing survives that the budget still cannot fit', both.remainingBytes <= 4000 * MB || both.doomed.length === heavy.length - 1)
}
{
  const empty = planRetention([], policy({ retentionDays: 1, maxBytes: 1, enforceMaxBytes: true }), NOW)
  check('an empty folder plans nothing and divides by nothing', empty.doomed.length === 0 && empty.totalBytes === 0)
}

console.log('\nA HAND-EDITED settings.json CANNOT ASK FOR A SHORTER LEASH')
check('the offered ages are exactly 0/1/7/30', RETENTION_DAY_CHOICES.join(',') === '0,1,7,30')
check('an unlisted age is refused', !isRetentionDays(3) && !isRetentionDays(365) && !isRetentionDays(0.5))
check('a string age is refused', !isRetentionDays('7'))
check('the listed ages are accepted', RETENTION_DAY_CHOICES.every((d) => isRetentionDays(d)))
check('a budget below one capture-worth is refused', !isStorageMaxBytes(MIN_STORAGE_MAX_BYTES - 1))
check('a fractional budget is refused', !isStorageMaxBytes(1.5 * MIN_STORAGE_MAX_BYTES + 0.5))
check('every offered budget is accepted', STORAGE_MAX_BYTES_CHOICES.every((b) => isStorageMaxBytes(b)))
check('the default budget is one of the offered ones', STORAGE_MAX_BYTES_CHOICES.includes(DEFAULT_STORAGE_MAX_BYTES))

console.log('\nTHE GLANCE')
check('an empty folder is an empty bar', budgetFraction(0, DEFAULT_STORAGE_MAX_BYTES) === 0)
check('a bar cannot draw past its own end', budgetFraction(99 * DEFAULT_STORAGE_MAX_BYTES, DEFAULT_STORAGE_MAX_BYTES) === 1)
check('half full is calm', budgetLevel(5, 10) === 'ok')
check('three quarters is not', budgetLevel(75, 100) === 'near')
check('at the line it is over', budgetLevel(100, 100) === 'over')
check('percent is the exact number the tooltip carries', budgetPercent(33, 100) === 33)
check('no budget is not a division by zero', budgetFraction(100, 0) === 0 && budgetLevel(100, 0) === 'ok')
check('bytes read as a person reads them', formatBytes(0) === '0 B' && formatBytes(1536) === '1.5 KB')

console.log('\nPERSISTED, AND VALIDATED THE SAME WAY ON EVERY ROUTE IN')
const settingsStore = source('src/main/settings.ts')
check(
  'the three keys are in SETTINGS_KEY_SET, so the GUI patch filter lets them through',
  /storageRetentionDays: true/.test(settingsStore) &&
    /storageMaxBytes: true/.test(settingsStore) &&
    /storageEnforceMaxBytes: true/.test(settingsStore),
)
check(
  'a fresh profile is born keeping everything',
  /storageRetentionDays: RETENTION_KEEP_EVERYTHING/.test(settingsStore) &&
    /storageEnforceMaxBytes: false/.test(settingsStore),
)
check(
  'loading and IPC patching share one validator per key',
  /isRetentionDays\(raw\.storageRetentionDays\)/.test(settingsStore) &&
    /isStorageMaxBytes\(raw\.storageMaxBytes\)/.test(settingsStore) &&
    settingsStore.includes('return mergeSettings(current, raw)'),
)

console.log('\nTHE SCHEDULER: STARTUP AND ONCE A DAY, AND ONLY THEN')
const storage = source('src/main/storage.ts')
const settingsWindow = source('src/main/settingsWindow.ts')
const sweep = functionBody(storage, 'runRetentionSweep')
check('the sweep exists', sweep !== '')
check(
  'the sweep asks planRetention for the PACKS',
  sweep.includes('planRetention(') && sweep.includes('retentionPolicyOf('),
)
check(
  'THE TWO ZEROES NEVER MEET: nothing automatic reaches the manual purge',
  sweep !== '' && !sweep.includes('purgeOlderThan'),
  'runRetentionSweep must never hand a day count to purgeOlderThan',
)
check(
  'it is started once, from the one startup call that owns the live settings',
  settingsWindow.includes('startRetentionScheduler(live)'),
)
check(
  'a settings change runs nothing — it only changes what the next run would take',
  !settingsWindow.includes('runRetentionSweep'),
)
check(
  'the two moments are a delayed startup run and a daily one',
  /STARTUP_SWEEP_DELAY_MS/.test(storage) && /SWEEP_INTERVAL_MS = 24 \* 60 \* 60 \* 1_000/.test(storage),
)
check(
  'the timers never hold the app open',
  functionBody(storage, 'startRetentionScheduler').includes('startup.unref()'),
)

console.log('\nDELETING EVIDENCE STILL MEANS THE RECYCLE BIN')
check('the only delete is shell.trashItem', /await shell\.trashItem\(/.test(storage))
check(
  'nothing in the storage path unlinks',
  !/fs\.(unlink|rm|rmdir|rmSync|unlinkSync)/.test(storage) && !/\brmSync\(/.test(storage),
)
const trash = functionBody(storage, 'trashPacks')
check(
  'the full zip twin goes with the folder, automatically as well as manually',
  trash.includes('pack.twin') && trash.includes('shell.trashItem(pack.twin.path)'),
)
check(
  'the reviewed Share Copy goes with the folder too',
  trash.includes('pack.share') && trash.includes('shell.trashItem(pack.share.path)'),
)
check(
  'retention takes the same per-pack operation lock as History mutations',
  trash.includes('beginPackOperation(pack.path)') &&
    trash.includes("firstError = 'pack is busy'") &&
    trash.includes('release()'),
)
const shareTrashAt = trash.indexOf('shell.trashItem(pack.share.path)')
const twinTrashAt = trash.indexOf('shell.trashItem(pack.twin.path)')
const packTrashAt = trash.indexOf('shell.trashItem(pack.path)')
check(
  'managed copies move before their pack, so a failure cannot orphan a Share Copy',
  shareTrashAt >= 0 &&
    twinTrashAt >= 0 &&
    packTrashAt >= 0 &&
    shareTrashAt < packTrashAt &&
    twinTrashAt < packTrashAt,
)
check(
  'only successfully trashed companions are counted as freed',
  trash.includes('bytesFreed += pack.twin.bytes') &&
    trash.includes('bytesFreed += pack.share.bytes') &&
    !trash.includes('bytesFreed -= pack.twin.bytes') &&
    !trash.includes('bytesFreed -= pack.share.bytes'),
)
check(
  'both the manual buttons and the sweep delete through that one function',
  functionBody(storage, 'purgeOlderThan').includes('trashPacks(') && sweep.includes('trashPacks('),
)
check(
  'measuring and deleting read one list',
  functionBody(storage, 'storageUsage').includes('storedPacks(') &&
    functionBody(storage, 'purgeOlderThan').includes('storedPacks(') &&
    sweep.includes('storedPacks('),
)

console.log('\nTHE SIZE IS CACHED, NOT WALKED PER REPAINT')
check(
  'the expensive recursive walk is cached per pack and keyed by its mtime',
  /packBytesCache = new Map/.test(storage) && /cached\.mtimeMs === entry\.mtimeMs/.test(storage),
)
check(
  'a pack that left the index leaves the cache',
  functionBody(storage, 'storedPacks').includes('packBytesCache.delete(key)'),
)
check(
  'and a delete the user is watching invalidates it immediately',
  storage.includes('export function invalidateStorageUsage') &&
    source('src/main/historyWindow.ts').includes('invalidateStorageUsage()'),
)

console.log('\nTHE BAR IS A NEW ELEMENT, NOT THE RENDER PROGRESS ONE')
const historyHtml = source('src/renderer/history/history.html')
const historyCss = source('src/renderer/history/history.css')
const historyRenderer = source('src/renderer/history/history.ts')
check('History has a usage bar in its header', historyHtml.includes('id="usageBar"'))
check(
  'it uses the storage classes, never renderBar/renderBarFill',
  historyHtml.includes('class="storageBar"') &&
    historyHtml.includes('class="storageBarFill"') &&
    !/id="usageBar"[^>]*renderBar/.test(historyHtml),
)
check('and renderBar is still the per-card render indicator', historyCss.includes('.renderBar {') && historyRenderer.includes("elc('span', 'renderBar')"))
{
  // The per-card sizes arrive one lazy invoke at a time as cards scroll into
  // view, so a header total summed from them would climb while the user reads
  // it and would be short by every pack they never reached.
  const refreshUsage = functionBody(historyRenderer, 'refreshUsage')
  check(
    'the header total is one ask for the whole folder',
    refreshUsage !== '' && /bridge\s*\.?\s*\n?\s*\.usage\(\)/.test(refreshUsage),
  )
  check(
    'and is never summed from the lazily loaded per-card sizes',
    refreshUsage !== '' && !refreshUsage.includes('sizes'),
  )
}
check(
  'the numbers are printed beside it: packs, size, oldest',
  /'history\.usage'/.test(historyRenderer) &&
    historyRenderer.includes('packs:') &&
    historyRenderer.includes('size:') &&
    historyRenderer.includes('date:'),
)

console.log('\nSETTINGS OFFERS THE MODES THE VALIDATOR ACCEPTS, AND NO MORE')
const settingsHtml = source('src/renderer/settings/settings.html')
const settingsRenderer = source('src/renderer/settings/settings.ts')
{
  const select = /<select id="storageRetentionDays">([\s\S]*?)<\/select>/.exec(settingsHtml)?.[1] ?? ''
  const offered = [...select.matchAll(/value="(-?\d+)"/g)].map((m) => Number(m[1]))
  check(
    'the retention dropdown offers exactly the accepted ages',
    offered.join(',') === RETENTION_DAY_CHOICES.join(','),
    offered.join(','),
  )
  check(
    '"Delete everything" stays a BUTTON and never becomes a mode you can leave on',
    settingsHtml.includes('data-purge="0"') && !select.includes('purgeAll'),
  )
  check(
    'the budget options are generated from the accepted list',
    settingsRenderer.includes('for (const bytes of STORAGE_MAX_BYTES_CHOICES)') &&
      /<select id="storageMaxBytes"><\/select>/.test(settingsHtml),
  )
  check(
    'the panel says what the next run would take',
    settingsHtml.includes('id="storageNext"') &&
      /'settings\.retentionNext'/.test(settingsRenderer) &&
      /'settings\.retentionNextNone'/.test(settingsRenderer),
  )
  check(
    'and the bar sits beside the policy that controls it',
    settingsHtml.includes('id="storageBar"') && settingsHtml.includes('id="storageRetentionDays"'),
  )
  check(
    'the old "there will never be an automatic expiry" note is gone rather than left lying',
    !settingsHtml.includes('There is no automatic expiry setting'),
  )
}

console.log('\nNINE LOCALES, OR THE TYPECHECK IS THE ONLY THING THAT NOTICED')
const i18n = source('src/shared/i18n.ts')
for (const key of [
  'common.storageMeter',
  'common.storageEmpty',
  'history.usage',
  'settings.retention',
  'settings.retentionKeep',
  'settings.retention1',
  'settings.retention7',
  'settings.retention30',
  'settings.retentionNext',
  'settings.retentionNextNone',
  'settings.maxSize',
  'settings.enforceMaxSize',
]) {
  const count = (i18n.match(new RegExp(`'${key.replace('.', '\\.')}':`, 'g')) ?? []).length
  check(`${key} is translated nine times`, count === 9, `found ${String(count)}`)
}

console.log('\nTHE USAGE ANSWER IS WIRED END TO END')
check('the channel exists', source('src/shared/ipc.ts').includes("historyUsage: 'history:usage'"))
check('main answers it', source('src/main/historyWindow.ts').includes('IPC.historyUsage'))
check('the preload exposes it', source('src/preload/history.ts').includes('IPC.historyUsage'))
check(
  'both windows draw one bar against one denominator',
  source('src/shared/ipc.ts').includes('maxBytes: number') &&
    settingsRenderer.includes('budgetLevel(usage.totalBytes, usage.maxBytes)') &&
    historyRenderer.includes('budgetLevel(usage.totalBytes, usage.maxBytes)'),
)

if (failed > 0) {
  console.error(`\nstorage-retention-check failed: ${String(failed)}`)
  process.exitCode = 1
} else {
  console.log('\nstorage-retention-check ok')
}
