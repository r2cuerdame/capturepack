// A check the user asked for gets exactly one answer, even from an empty
// releases page (#523).
//
// electron-updater reports "No published versions on GitHub" as an error. The
// updater rightly refused to call that a failure, but it answered with 'idle' —
// which is not an answer — so the pending manual check was consumed and the
// "you're up to date" notification never came. This drives the REAL updater.ts
// event handlers and checkNow() through scripted electron-updater behaviour and
// counts the notifications index.ts would show (owesUpToDateNotice). Timers are
// faked so the 60-second "up to date" window can be ended on demand.
import { autoUpdater } from 'electron-updater'
import type { UpdaterStatusPayload } from '../src/shared/ipc'
import {
  checkNow,
  initUpdater,
  owesUpToDateNotice,
  setAutoUpdateCheck,
  updaterState,
} from '../src/main/updater'

let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (!condition) failed += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

// --- fake timers -----------------------------------------------------------
type Pending = { id: number; run: () => void }
let timers: Pending[] = []
let nextTimer = 1
const fakeSetTimeout = ((run: () => void): number => {
  const id = nextTimer++
  timers.push({ id, run })
  return id
}) as unknown as typeof setTimeout
const fakeClearTimeout = ((id: number): void => {
  timers = timers.filter((t) => t.id !== id)
}) as unknown as typeof clearTimeout
globalThis.setTimeout = fakeSetTimeout
globalThis.clearTimeout = fakeClearTimeout
// The four-hourly interval is never fired here; automatic checks are started
// through setAutoUpdateCheck(true), which runs the same check function.
globalThis.setInterval = ((): number => nextTimer++) as unknown as typeof setInterval

function runTimers(): void {
  const due = timers
  timers = []
  for (const t of due) t.run()
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

// --- scripted electron-updater ---------------------------------------------
type Reply = 'not-available' | 'empty-releases' | 'network-failure' | 'reject-empty' | 'reject-failure'
const EMPTY = 'No published versions on GitHub'
const NETWORK = 'net::ERR_INTERNET_DISCONNECTED'

const updater = autoUpdater as unknown as {
  emit: (event: string, ...args: unknown[]) => boolean
  checkForUpdates: () => Promise<unknown>
}

function script(reply: Reply): void {
  updater.checkForUpdates = () => {
    updater.emit('checking-for-update')
    return Promise.resolve().then(() => {
      switch (reply) {
        case 'not-available':
          updater.emit('update-not-available', { version: '0.6.0' })
          return null
        case 'empty-releases':
          // What electron-updater does: the event, then the same rejection.
          updater.emit('error', new Error(EMPTY))
          throw new Error(EMPTY)
        case 'network-failure':
          updater.emit('error', new Error(NETWORK))
          throw new Error(NETWORK)
        case 'reject-empty':
          // A rejection that skips the 'error' event.
          throw new Error(EMPTY)
        case 'reject-failure':
          throw new Error(NETWORK)
      }
    })
  }
}

// --- observed statuses -----------------------------------------------------
let seen: UpdaterStatusPayload[] = []
initUpdater({ autoCheck: false, onStatus: (s) => seen.push({ ...s }) })

const notices = (): number => seen.filter(owesUpToDateNotice).length
const errors = (): UpdaterStatusPayload[] => seen.filter((s) => s.state === 'error')
const requested = (): number => seen.filter((s) => s.userRequested === true).length
const trail = (): string => seen.map((s) => s.state + (s.userRequested === true ? '*' : '')).join(' > ')

function reset(): void {
  runTimers()
  seen = []
}

async function manual(reply: Reply): Promise<void> {
  reset()
  script(reply)
  await checkNow()
  await settle()
}

async function automatic(reply: Reply): Promise<void> {
  reset()
  script(reply)
  setAutoUpdateCheck(true)
  await settle()
  setAutoUpdateCheck(false)
}

async function main(): Promise<void> {
  console.log('MANUAL CHECK, EMPTY RELEASES PAGE')
  await manual('empty-releases')
  check('the user is told there is nothing to update, once', notices() === 1, trail())
  check('it is not reported as a failure', errors().length === 0, trail())
  check('it went through checking first', seen[0]?.state === 'checking', trail())
  check('it ends on up-to-date', updaterState().state === 'up-to-date', updaterState().state)
  runTimers()
  check('the answer gives way to idle when its window ends', updaterState().state === 'idle', updaterState().state)
  check('and that does not answer again', notices() === 1, trail())

  console.log('AUTOMATIC CHECK, EMPTY RELEASES PAGE')
  await automatic('empty-releases')
  check('the automatic check stays silent', notices() === 0, trail())
  check('it carries no user request', requested() === 0, trail())
  check('and is not a failure either', errors().length === 0, trail())

  console.log('AUTOMATIC CHECK AFTER A MANUAL ONE')
  await manual('empty-releases')
  check('the manual check answered', notices() === 1, trail())
  await automatic('not-available')
  check('the next automatic check inherits no user request', requested() === 0, trail())
  await automatic('empty-releases')
  check('nor does the one after it', requested() === 0, trail())

  console.log('MANUAL CHECK, ORDINARY UP TO DATE')
  await manual('not-available')
  check('the user is told, once', notices() === 1, trail())
  check('no failure', errors().length === 0, trail())

  console.log('MANUAL CHECK, REAL FAILURE')
  await manual('network-failure')
  check('a real failure is still a failure', errors().length === 1 && errors()[0]?.message === NETWORK, trail())
  check('it answers the user as a failure, not as up to date', requested() === 1 && notices() === 0, trail())
  await automatic('not-available')
  check('and leaves no request behind for the automatic check', requested() === 0, trail())

  console.log('AUTOMATIC CHECK, REAL FAILURE')
  await automatic('network-failure')
  check('reported as a failure', errors().length === 1, trail())
  check('without a user request', requested() === 0, trail())

  console.log('MANUAL CHECK, REJECTION WITHOUT AN ERROR EVENT')
  await manual('reject-empty')
  check('an empty releases page still answers once', notices() === 1 && errors().length === 0, trail())
  await manual('reject-failure')
  check('a real failure still fails', errors().length === 1 && notices() === 0, trail())

  if (failed > 0) {
    console.error(`\nupdate-manual-check failed: ${failed}`)
    process.exitCode = 1
  } else {
    console.log('\nupdate-manual-check ok')
  }
}

void main()
