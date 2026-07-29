import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  BACKGROUND_MEDIA_CONCURRENCY,
  BoundedBackgroundMediaQueue,
  copyBufferResponsively,
} from '../src/main/backgroundMediaQueue'

let failures = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (!condition) failures += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function nextImmediate(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

async function main(): Promise<void> {
  console.log('RESPONSIVE MEDIA COPY')
  const source = Buffer.allocUnsafe(9 * 1024 * 1024 + 137)
  for (let index = 0; index < source.length; index += 1) source[index] = index % 251
  const controller = new AbortController()
  let yields = 0
  let heartbeat = 0
  const copied = await copyBufferResponsively(source, controller.signal, {
    chunkBytes: 1024 * 1024,
    yieldToEventLoop: async () => {
      await nextImmediate()
      yields += 1
      heartbeat += 1
    },
  })
  check('chunked copy is byte-for-byte exact', Buffer.from(copied).equals(source))
  check('a large replay yields between every non-final chunk', yields === 9)
  check('the main event loop remains serviceable during copy', heartbeat === yields && heartbeat > 1)

  const cancelled = new AbortController()
  let cancellationObserved = false
  try {
    await copyBufferResponsively(source, cancelled.signal, {
      chunkBytes: 1024 * 1024,
      yieldToEventLoop: async () => {
        cancelled.abort(new Error('quit'))
        await nextImmediate()
      },
    })
  } catch (error) {
    cancellationObserved = error instanceof Error && error.message === 'quit'
  }
  check('copy stops at the next chunk boundary on shutdown', cancellationObserved)

  console.log('\nONE GLOBAL MEDIA LANE')
  const queue = new BoundedBackgroundMediaQueue(BACKGROUND_MEDIA_CONCURRENCY)
  const gates = [deferred(), deferred(), deferred()]
  let active = 0
  let maxActive = 0
  const started: number[] = []
  const jobs = gates.map((gate, index) =>
    queue.enqueue(async () => {
      started.push(index)
      active += 1
      maxActive = Math.max(maxActive, active)
      await gate.promise
      active -= 1
      return index
    }),
  )
  await nextImmediate()
  check(
    'only the first 4K job starts while two remain allocation-free',
    started.join(',') === '0' && queue.activeCount === 1 && queue.pendingCount === 2,
  )
  gates[0]?.resolve()
  await nextImmediate()
  await nextImmediate()
  check('the second job starts only after the first releases the lane', started.join(',') === '0,1')
  gates[1]?.resolve()
  await nextImmediate()
  await nextImmediate()
  check('the third job also waits its turn', started.join(',') === '0,1,2')
  gates[2]?.resolve()
  check('serialized jobs keep their results', JSON.stringify(await Promise.all(jobs)) === '[0,1,2]')
  check('decode/encode concurrency never exceeds one', maxActive === 1)

  console.log('\nQUIT CANCELLATION')
  const quitQueue = new BoundedBackgroundMediaQueue(1)
  let queuedStarted = false
  let activeSawAbort = false
  const activeJob = quitQueue.enqueue(
    (signal) =>
      new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          activeSawAbort = true
          reject(signal.reason)
        }
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      }),
  )
  const queuedJob = quitQueue.enqueue(async () => {
    queuedStarted = true
  })
  await nextImmediate()
  quitQueue.shutdown(new Error('app quit'))
  const quitResults = await Promise.allSettled([activeJob, queuedJob])
  check('active media work receives the quit AbortSignal', activeSawAbort)
  check('queued media work is rejected without starting', !queuedStarted)
  check(
    'shutdown settles active and queued jobs as cancellations',
    quitResults.every(
      (result) => result.status === 'rejected' && result.reason instanceof Error,
    ),
  )
  check(
    'shutdown drains the queue and refuses new work',
    quitQueue.pendingCount === 0 && !quitQueue.isAccepting,
  )

  console.log('\nPRODUCTION WIRING')
  const renderSource = readFileSync(
    path.join(process.cwd(), 'src', 'main', 'annotatedRender.ts'),
    'utf8',
  )
  const sessionSource = readFileSync(
    path.join(process.cwd(), 'src', 'main', 'session.ts'),
    'utf8',
  )
  check(
    'all replay/snapshot copies happen inside the bounded queue callback',
    !renderSource.includes('function toArrayBuffer(') &&
      renderSource.includes('await enqueueRender(async (signal) =>') &&
      renderSource.includes('await copyBufferResponsively(job.replayWebm, signal)') &&
      renderSource.includes('await copyBufferResponsively(job.snapshotPng, signal)'),
  )
  check(
    'the active hidden render window is abortable on app quit',
    renderSource.includes("app.on('before-quit'") &&
      renderSource.includes('renderQueue.shutdown()') &&
      renderSource.includes("signal?.addEventListener('abort', onAbort"),
  )
  check(
    'quit cancellation does not invoke the trim-failure source rewrite',
    sessionSource.includes('if (appIsQuitting) {') &&
      sessionSource.indexOf('if (appIsQuitting) {') <
        sessionSource.indexOf('await handleExactCutFailure('),
  )

  console.log(
    `\n${failures === 0 ? 'background-media-queue-check ok' : `${failures} failure(s)`}`,
  )
  if (failures > 0) process.exitCode = 1
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
