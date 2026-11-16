import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const PURPLEPULSE_ENDPOINT = 'https://pulse-api.purpleshiphub.workers.dev/api/v1/ping'
export const PURPLEPULSE_PROJECT_ID = 'pp_capturepack_6bede657'
const TELEMETRY_TIMEOUT_MS = 2_500

interface TelemetryState {
  install_id: string
  last_attempt_day: string
}

export interface TelemetryPayload {
  project_id: string
  install_id: string
  version: string
  os: string
  platform: 'electron'
  environment?: string
}

interface DailyTelemetryOptions {
  statePath: string
  version: string
  os: string
  environment?: string
  now?: Date
  createInstallId?: () => string
  post?: (payload: TelemetryPayload) => Promise<void>
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export function localCalendarDay(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function telemetryOs(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'macos'
  if (platform === 'linux') return 'linux'
  return 'other'
}

async function readState(statePath: string): Promise<Partial<TelemetryState>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(statePath, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    const record = parsed as Record<string, unknown>
    return {
      install_id: typeof record.install_id === 'string' ? record.install_id : undefined,
      last_attempt_day:
        typeof record.last_attempt_day === 'string' ? record.last_attempt_day : undefined,
    }
  } catch {
    return {}
  }
}

async function writeState(statePath: string, state: TelemetryState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true })
  const temporary = `${statePath}.${String(process.pid)}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(state)}\n`, 'utf8')
    await rename(temporary, statePath)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

async function postTelemetry(payload: TelemetryPayload): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT_MS)
  try {
    const response = await fetch(PURPLEPULSE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    // The status is not consulted and the body is never read. Left uncancelled,
    // it holds its connection until garbage collection, and an app kept running
    // for weeks would leave one behind every day (same as #511's webhook).
    await response.body?.cancel().catch(() => undefined)
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Makes one best-effort attempt per local calendar day. The gate is persisted
 * before the request so an offline endpoint cannot turn every launch into a
 * retry. Any storage or network failure is deliberately silent.
 */
export async function sendDailyTelemetry(options: DailyTelemetryOptions): Promise<void> {
  try {
    const today = localCalendarDay(options.now ?? new Date())
    const previous = await readState(options.statePath)
    const installId =
      typeof previous.install_id === 'string' && UUID_PATTERN.test(previous.install_id)
        ? previous.install_id
        : (options.createInstallId ?? randomUUID)()
    if (!UUID_PATTERN.test(installId) || previous.last_attempt_day === today) return

    await writeState(options.statePath, { install_id: installId, last_attempt_day: today })

    const payload: TelemetryPayload = {
      project_id: PURPLEPULSE_PROJECT_ID,
      install_id: installId,
      version: options.version,
      os: options.os,
      platform: 'electron',
    }
    if (options.environment !== undefined) payload.environment = options.environment
    await (options.post ?? postTelemetry)(payload)
  } catch {
    // Telemetry must never affect startup or surface an error to the user.
  }
}

/**
 * How often the scheduler LOOKS at the calendar day, which is not how often it
 * sends. A tray app started at login and only ever put to sleep would otherwise
 * be counted on the day it launched and never again (#537). One date comparison
 * an hour survives sleep the same way the retention sweep does (storage.ts);
 * the persisted daily gate is what keeps it to one attempt per local day.
 */
export const DAILY_TELEMETRY_TICK_MS = 60 * 60 * 1_000

export interface TelemetrySchedulerTimer {
  unref?: () => unknown
}

export interface DailyTelemetrySchedulerOptions extends Omit<DailyTelemetryOptions, 'now'> {
  /** Read on every attempt; the default is the wall clock. */
  clock?: () => Date
  /** Defaults to setInterval. A test fires the tick by hand and awaits it. */
  schedule?: (tick: () => Promise<void>, intervalMs: number) => TelemetrySchedulerTimer
  cancel?: (timer: TelemetrySchedulerTimer) => void
}

let schedulerTimer: TelemetrySchedulerTimer | null = null
let schedulerCancel: ((timer: TelemetrySchedulerTimer) => void) | null = null
let schedulerGeneration = 0

/**
 * Attempts once now, then once every tick for as long as the app runs. No new
 * state: sendDailyTelemetry's file gate decides whether a tick sends. A tick
 * that lands while an attempt is still in flight joins it instead of racing it
 * through the gate, and the timer never keeps the process alive.
 *
 * Resolves when the immediate attempt has finished; it never rejects.
 */
export function startDailyTelemetryScheduler(options: DailyTelemetrySchedulerOptions): Promise<void> {
  stopDailyTelemetryScheduler()
  const generation = ++schedulerGeneration
  const { clock, schedule, cancel, ...send } = options
  let inFlight: Promise<void> | null = null
  const attempt = (): Promise<void> => {
    if (generation !== schedulerGeneration) return Promise.resolve()
    if (inFlight !== null) return inFlight
    inFlight = sendDailyTelemetry({ ...send, now: (clock ?? (() => new Date()))() }).finally(() => {
      inFlight = null
    })
    return inFlight
  }
  const timer = (schedule ?? ((tick, intervalMs) => setInterval(() => { void tick() }, intervalMs)))(
    attempt,
    DAILY_TELEMETRY_TICK_MS,
  )
  timer.unref?.()
  schedulerTimer = timer
  schedulerCancel = cancel ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>))
  return attempt()
}

/** An attempt already in flight finishes; nothing is attempted after this. */
export function stopDailyTelemetryScheduler(): void {
  schedulerGeneration += 1
  if (schedulerTimer !== null && schedulerCancel !== null) schedulerCancel(schedulerTimer)
  schedulerTimer = null
  schedulerCancel = null
}

/** Keep packaged QA out of production counts and out of the production daily gate. */
export function dailyTelemetryLaunchPolicy(
  isPackaged: boolean,
  env: Readonly<Record<string, string | undefined>>,
): { enabled: boolean; stateFile: string; environment?: 'test' | 'dev' } {
  if (env.CAPTUREPACK_FIELD_QA !== undefined && env.CAPTUREPACK_FIELD_QA !== '1') {
    return { enabled: false, stateFile: 'purplepulse.json' }
  }
  const requested = env.CAPTUREPACK_FIELD_QA === '1'
    ? 'test'
    : env.CAPTUREPACK_TELEMETRY_ENVIRONMENT
  if (
    !isPackaged ||
    (requested !== undefined && !['prod', 'test', 'dev'].includes(requested))
  ) {
    return { enabled: false, stateFile: 'purplepulse.json' }
  }
  if (requested === 'test' || requested === 'dev') {
    return {
      enabled: true,
      stateFile: `purplepulse.${requested}.json`,
      environment: requested,
    }
  }
  return { enabled: true, stateFile: 'purplepulse.json' }
}
