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
  const copied = await copyBufferResponsively(source, controller.signal, {
    chunkBytes: 1024 * 1024,
    yieldToEventLoop: async () => {
      await nextImmediate()
      yields += 1
    },
  })
  check('chunked copy is byte-for-byte exact', Buffer.from(copied).equals(source))
  check('a large replay yields between every non-final chunk', yields === 9)

  // This callback is scheduled independently of the copy's default scheduler.
  // Counting calls to an injected yield would not prove the event loop ran.
  let heartbeat = 0
  let heartbeatHandle: ReturnType<typeof setImmediate>
  const beat = (): void => {
    heartbeat += 1
    heartbeatHandle = setImmediate(beat)
  }
  heartbeatHandle = setImmediate(beat)
  try {
    const defaultCopy = await copyBufferResponsively(source, controller.signal)
    check('the default chunked copy is byte-for-byte exact', Buffer.from(defaultCopy).equals(source))
    check('the default copy services an independent event-loop heartbeat', heartbeat > 1)
  } finally {
    clearImmediate(heartbeatHandle)
  }

  const cancelled = new AbortController()
  const cancellationReason = new Error('quit')
  let cancellationYields = 0
  let cancellationObserved = false
  try {
    await copyBufferResponsively(source, cancelled.signal, {
      chunkBytes: 1024 * 1024,
      yieldToEventLoop: async () => {
        cancellationYields += 1
        cancelled.abort(cancellationReason)
        await nextImmediate()
      },
    })
  } catch (error) {
    cancellationObserved = error === cancellationReason
  }
  check('copy stops at the next chunk boundary on shutdown', cancellationObserved && cancellationYields === 1)

  console.log('\nONE GLOBAL MEDIA LANE')
  const queue = new BoundedBackgroundMediaQueue(BACKGROUND_MEDIA_CONCURRENCY)
  const gates = [deferred(), deferred(), deferred()]
  const copyStarted = gates.map(() => deferred())
  let active = 0
  let maxActive = 0
  let exactCopies = 0
  const started: number[] = []
  const jobs = gates.map((gate, index) =>
    queue.enqueue(async (signal) => {
      started.push(index)
      active += 1
      maxActive = Math.max(maxActive, active)
      try {
        let firstYield = true
        const result = await copyBufferResponsively(source, signal, {
          chunkBytes: 1024 * 1024,
          yieldToEventLoop: async () => {
            if (firstYield) {
              firstYield = false
              copyStarted[index]?.resolve()
              await gate.promise
            }
            await nextImmediate()
          },
        })
        if (Buffer.from(result).equals(source)) exactCopies += 1
        return index
      } finally {
        active -= 1
      }
    }),
  )
  await copyStarted[0]?.promise
  check(
    'only the first 4K job starts while two remain allocation-free',
    started.join(',') === '0' && queue.activeCount === 1 && queue.pendingCount === 2,
  )
  gates[0]?.resolve()
  await copyStarted[1]?.promise
  check('the second job starts only after the first releases the lane', started.join(',') === '0,1')
  gates[1]?.resolve()
  await copyStarted[2]?.promise
  check('the third job also waits its turn', started.join(',') === '0,1,2')
  gates[2]?.resolve()
  check('serialized jobs keep their results', JSON.stringify(await Promise.all(jobs)) === '[0,1,2]')
  check('concurrent duplicate media buffers never exceed one', maxActive === 1 && exactCopies === 3)
  await nextImmediate()
  check('completed copies release all queue slots', queue.activeCount === 0 && queue.pendingCount === 0)

  console.log('\nQUIT CANCELLATION')
  const quitQueue = new BoundedBackgroundMediaQueue(1)
  const copyBoundary = deferred()
  const resumeCopy = deferred()
  const quitReason = new Error('app quit')
  let queuedStarted = false
  let activeSignal: AbortSignal | undefined
  let quitYields = 0
  const activeJob = quitQueue.enqueue(async (signal) => {
    activeSignal = signal
    return copyBufferResponsively(source, signal, {
      chunkBytes: 1024 * 1024,
      yieldToEventLoop: async () => {
        quitYields += 1
        copyBoundary.resolve()
        await resumeCopy.promise
      },
    })
  })
  const queuedJob = quitQueue.enqueue(async () => {
    queuedStarted = true
  })
  const quitSettled = Promise.allSettled([activeJob, queuedJob])
  await copyBoundary.promise
  quitQueue.shutdown(quitReason)
  const queuedResult = await Promise.allSettled([queuedJob])
  check('active media copy receives the quit AbortSignal', activeSignal?.aborted === true && activeSignal.reason === quitReason)
  check(
    'pending work is rejected before the active copy resumes',
    !queuedStarted && queuedResult[0]?.status === 'rejected' && queuedResult[0].reason === quitReason,
  )
  resumeCopy.resolve()
  const quitResults = await quitSettled
  check(
    'shutdown settles active and queued jobs as cancellations',
    quitResults.every(
      (result) => result.status === 'rejected' && result.reason === quitReason,
    ),
  )
  check('shutdown stops the active copy at its first chunk boundary', quitYields === 1)
  let lateStarted = false
  const lateResult = await Promise.allSettled([
    quitQueue.enqueue(async () => { lateStarted = true }),
  ])
  await nextImmediate()
  check(
    'shutdown drains the queue and refuses new work',
    quitQueue.activeCount === 0 && quitQueue.pendingCount === 0 && !quitQueue.isAccepting &&
      !lateStarted && lateResult[0]?.status === 'rejected' && lateResult[0].reason === quitReason,
  )

  console.log('\nCONFIGURED CONCURRENCY AND FAILURE RECOVERY')
  const parallelQueue = new BoundedBackgroundMediaQueue(2)
  const parallelGates = [deferred(), deferred(), deferred()]
  const parallelStarted: number[] = []
  let parallelActive = 0
  let parallelMax = 0
  const jobFailure = new Error('render failed')
  const parallelJobs = parallelGates.map((gate, index) =>
    parallelQueue.enqueue(async () => {
      parallelStarted.push(index)
      parallelActive += 1
      parallelMax = Math.max(parallelMax, parallelActive)
      try {
        await gate.promise
        if (index === 0) throw jobFailure
        return index
      } finally {
        parallelActive -= 1
      }
    }),
  )
  const parallelSettled = Promise.allSettled(parallelJobs)
  await nextImmediate()
  check('configured two-lane queue starts only two jobs', parallelStarted.join(',') === '0,1' && parallelQueue.pendingCount === 1)
  parallelGates[0]?.resolve()
  await nextImmediate()
  check('a failed job releases its slot to the next queued job', parallelStarted.join(',') === '0,1,2' && parallelMax === 2)
  parallelGates[1]?.resolve()
  parallelGates[2]?.resolve()
  const parallelResults = await parallelSettled
  check(
    'a failed job preserves its error without cancelling later results',
    parallelResults[0]?.status === 'rejected' && parallelResults[0].reason === jobFailure &&
      parallelResults[1]?.status === 'fulfilled' && parallelResults[1].value === 1 &&
      parallelResults[2]?.status === 'fulfilled' && parallelResults[2].value === 2,
  )
  await nextImmediate()
  check('configured queue releases every active slot', parallelQueue.activeCount === 0 && parallelQueue.pendingCount === 0)

  const immediateQuitQueue = new BoundedBackgroundMediaQueue(1)
  let immediateStarted = false
  const immediateJob = immediateQuitQueue.enqueue(async () => { immediateStarted = true })
  const immediateSettled = Promise.allSettled([immediateJob])
  immediateQuitQueue.shutdown(quitReason)
  const immediateResults = await immediateSettled
  await nextImmediate()
  check(
    'shutdown before the job microtask prevents its callback from starting',
    !immediateStarted && immediateResults[0]?.status === 'rejected' &&
      immediateResults[0].reason === quitReason && immediateQuitQueue.activeCount === 0,
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
