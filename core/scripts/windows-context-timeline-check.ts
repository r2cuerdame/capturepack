// DOES A FRESH WINDOWS CONTEXT REOPEN AS THE SAME WINDOWS CONTEXT?
//
// The live editor receives a time series built from Lane S (windows) and Lane A
// (controls). Historically the pack kept only the final UIA dump, so reopening
// a capture silently changed every earlier frame into that one final instant.
// This check drives the real mixed-DPI projection, serialises its output as one
// checkpoint plus deltas, parses the JSON as an untrusted pack would, and
// requires byte-for-byte-equivalent observations after reopening.
//
// Run: node scripts/windows-context-timeline-check.mjs
import {
  decodeWindowsContextTimeline,
  exportWindowsContextTimeline,
  importWindowsContextTimeline,
  loadWindowsContextHistory,
  restoreWindowsContextTimeline,
  trimWindowsContextTimeline,
  WINDOWS_CONTEXT_MAX_FILE_BYTES,
  WINDOWS_CONTEXT_TIMELINE_LIMITS,
  WINDOWS_CONTEXT_TIMELINE_PACK_PATH,
} from '../src/main/context/windowsContextTimeline'
import { frozenRingObservations } from '../src/main/context/ringObservations'
import { ContextSession } from '../src/main/context/session'
import { editorUiaWindows } from '../src/main/context/legacyPack'
import {
  savePack,
  updateInitialPack,
  updatePack,
  WINDOWS_CONTEXT_PLUGIN_NAME,
} from '../src/main/exporter'
import { openPack } from '../src/main/mcp/store'
import { ObjectIndex } from '../src/renderer/editor/objects'
import type { ContextObservation } from '../src/main/context/buffer'
import type { HostMonitor } from '../src/main/context/surfaceLane'
import type { TrackedControl } from '../src/main/context/controlLane'
import type { SurfaceInfo } from '../src/shared/context/protocol'
import type { UiaPluginPayload } from '../src/shared/types'
import AdmZip from 'adm-zip'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

let failures = 0
function check(what: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) {
    console.log(`         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`)
  }
}

const monitors: HostMonitor[] = [
  {
    device: 'LEFT-1X',
    primary: false,
    bounds: { x: -1200, y: 0, width: 1200, height: 1920 },
  },
  {
    device: 'PRIMARY-1.5X',
    primary: true,
    bounds: { x: 0, y: 0, width: 3840, height: 2160 },
  },
]

const times = Array.from({ length: 181 }, (_, index) => index * 10)

function leftX(tMs: number): number {
  return -1100 + Math.floor(tMs / 10)
}

function surfacesAt(tMs: number): { surfaces: SurfaceInfo[] } {
  const foregroundChanged = tMs >= 1600
  return {
    surfaces: [
      {
        surfaceId: 'chrome-left',
        // The unsigned 32-bit maximum used to be dropped by one UIA path when
        // it was interpreted as a signed integer. The persisted form is the
        // decimal string observed from Windows and must survive unchanged.
        hwnd: '4294967295',
        bounds: { x: leftX(tMs), y: 0, width: 1000, height: 900 },
        clientBounds: { x: leftX(tMs) + 8, y: 80, width: 984, height: 812 },
        zOrder: foregroundChanged ? 1 : 0,
        visible: true,
        minimized: false,
        foreground: !foregroundChanged,
        executableName: 'chrome.exe',
        windowTitle: 'CapturePack',
        className: 'Chrome_WidgetWin_1',
      },
      {
        surfaceId: 'explorer-primary',
        hwnd: '778899',
        bounds: { x: 300, y: 120, width: 1500, height: 1000 },
        clientBounds: { x: 312, y: 190, width: 1476, height: 918 },
        zOrder: foregroundChanged ? 0 : 1,
        visible: true,
        minimized: false,
        foreground: foregroundChanged,
        executableName: 'explorer.exe',
        windowTitle: 'Files',
        className: 'CabinetWClass',
      },
    ],
  }
}

function control(
  x: number,
  y: number,
  index: number,
  prefix: string,
): TrackedControl {
  return {
    x,
    y,
    width: 90,
    height: 24,
    name: `${prefix} ${String(index)}`,
    controlType: index % 2 === 0 ? 'Button' : 'Text',
    automationId: `${prefix.toLowerCase()}-${String(index)}`,
    className: index % 2 === 0 ? 'Button' : 'TextBlock',
  }
}

function controlsAt(tMs: number): ReadonlyMap<string, readonly TrackedControl[]> {
  const chromeX = leftX(tMs)
  const chrome: TrackedControl[] = [
    {
      x: chromeX + 520,
      y: 51,
      width: 153,
      height: 24,
      name: 'Google에 물어보기',
      controlType: 'Button',
      automationId: '',
      className: 'PageActionView',
    },
  ]
  for (let index = 1; index <= 80; index += 1) {
    const column = index % 8
    const row = Math.floor(index / 8)
    chrome.push(control(
      chromeX + 24 + column * 110,
      110 + row * 42 + (index === 7 && tMs >= 900 ? 35 : 0),
      index,
      'Chrome',
    ))
  }
  // A dead held reference changes the array shape. Keeping the deletion near
  // the tail avoids making the fixture's compression ratio depend on an
  // artificial full-array reorder.
  if (tMs >= 1200) chrome.pop()
  if (tMs >= 1400 && chrome[3] !== undefined) chrome[3].name = 'Renamed control'

  const explorer: TrackedControl[] = []
  for (let index = 0; index < 40; index += 1) {
    const column = index % 5
    const row = Math.floor(index / 5)
    explorer.push(control(340 + column * 180, 220 + row * 70, index, 'Explorer'))
  }
  return new Map([
    ['4294967295', chrome],
    ['778899', explorer],
  ])
}

function cloneAt(observation: ContextObservation, tMs: number): ContextObservation {
  return {
    tMs,
    windows: observation.windows.map((window) => ({
      ...window,
      bounds: { ...window.bounds },
      ...(window.client_bounds === undefined
        ? {}
        : { client_bounds: { ...window.client_bounds } }),
    })),
    elements: observation.elements.map((element) => ({
      ...element,
      bounds: { ...element.bounds },
    })),
  }
}

async function main(): Promise<void> {
  console.log('Windows context timeline: fresh -> JSON -> reopen\n')

  const fresh = frozenRingObservations(
    (tMs) => surfacesAt(tMs),
    monitors,
    [
      { index: 1, focused: false, width: 1200, height: 1920 },
      { index: 2, focused: true, width: 3840, height: 2160 },
    ],
    times[times.length - 1] ?? 0,
    times,
    (tMs) => controlsAt(tMs),
  )
  const google = fresh[0]?.elements.find((element) => element.name === 'Google에 물어보기')
  check(
    'negative-origin 1x control keeps the exact mixed-DPI projection',
    google?.bounds,
    { x: 620, y: 51, width: 153, height: 24 },
  )
  check('the high unsigned HWND reaches the editor observation', fresh[0]?.windows[0]?.hwnd, '4294967295')
  const dumpWithHandle: UiaPluginPayload = {
    captured_at: '2026-07-29T00:00:00.000Z',
    budget_ms: 1,
    truncated: false,
    windows: [{
      hwnd: '4294967295',
      title: 'CapturePack',
      process: 'capturepack',
      class_name: 'Chrome_WidgetWin_1',
      display: 1,
      bounds: { x: 1, y: 2, width: 3, height: 4 },
      focused: true,
      z: 0,
      tree: 'collected',
      element_count: 0,
    }],
    elements: [],
  }
  check(
    'capture-instant UIA conversion no longer drops HWND',
    editorUiaWindows(dumpWithHandle, 1)[0]?.hwnd,
    '4294967295',
  )

  const exported = exportWindowsContextTimeline(fresh)
  check('a non-empty fresh timeline exports', exported !== null, true)
  if (exported === null) {
    process.exitCode = 1
    return
  }
  const json = JSON.stringify(exported)
  const reopened = importWindowsContextTimeline(JSON.parse(json) as unknown)
  check('untrusted JSON parses as a Windows context timeline', reopened !== null, true)
  check('every fresh observation reopens deeply equal', reopened, fresh)
  check(
    'HWND is preserved through the machine-readable JSON',
    reopened?.[0]?.windows[0]?.hwnd,
    '4294967295',
  )
  check(
    'no-op observation times remain present for temporal accuracy',
    exported.deltas.length,
    fresh.length - 1,
  )

  // The persisted payload is not useful merely because its JSON is equal. It
  // must survive the shipping resolver and the exact index a pointer hovers.
  // Compare the two ContextSessions at early/mid/end, then pick the same child
  // control from both indexes.
  const contextDisplays = [
    { index: 1, focused: false, width: 1200, height: 1920 },
    { index: 2, focused: true, width: 3840, height: 2160 },
  ]
  const freshSession = new ContextSession('fresh-context', {
    displays: contextDisplays,
    replayDurationMs: 1800,
    observation: null,
    dropped: false,
  })
  const reopenedSession = new ContextSession('reopened-context', {
    displays: contextDisplays,
    replayDurationMs: 1800,
    observation: null,
    dropped: false,
  })
  freshSession.adoptAll(fresh)
  reopenedSession.adoptAll(reopened ?? [])
  const frameView = (frame: Awaited<ReturnType<ContextSession['frameAt']>>): unknown => ({
    accuracy: frame.accuracy,
    claims: frame.claims,
    displays: frame.displays,
  })
  for (const tMs of [0, 900, 1800]) {
    const freshFrame = await freshSession.frameAt(tMs)
    const reopenedFrame = await reopenedSession.frameAt(tMs)
    check(
      `shipping candidates are identical after reopen at t=${String(tMs)}`,
      frameView(reopenedFrame),
      frameView(freshFrame),
    )
    const freshSlice = freshFrame.displays.find((slice) => slice.display === 1)
    const reopenedSlice = reopenedFrame.displays.find((slice) => slice.display === 1)
    const target = freshSlice?.candidates.find(
      (candidate) => candidate.name === 'Google에 물어보기',
    )
    if (target === undefined) {
      check(`fresh child target exists at t=${String(tMs)}`, false, true)
      continue
    }
    const makeIndex = (
      slice: typeof freshSlice,
      frame: typeof freshFrame,
    ): ObjectIndex => ObjectIndex.build(
      slice?.candidates ?? [],
      slice?.surfaces ?? [],
      slice?.coverage ?? [],
      frame.claims,
      1200,
      1920,
    )
    const x = target.bounds.x + Math.floor(target.bounds.width / 2)
    const y = target.bounds.y + Math.floor(target.bounds.height / 2)
    const freshPick = makeIndex(freshSlice, freshFrame).pick(x, y)
    const reopenedPick = makeIndex(reopenedSlice, reopenedFrame).pick(x, y)
    check(
      `pointer pick is identical after reopen at t=${String(tMs)}`,
      reopenedPick === null
        ? null
        : {
            level: reopenedPick.level,
            name: reopenedPick.candidate.name,
            bounds: reopenedPick.candidate.bounds,
          },
      freshPick === null
        ? null
        : {
            level: freshPick.level,
            name: freshPick.candidate.name,
            bounds: freshPick.candidate.bounds,
          },
    )
  }

  const fullBytes = Buffer.byteLength(JSON.stringify(fresh), 'utf8')
  const compactBytes = Buffer.byteLength(json, 'utf8')
  const ratio = compactBytes / fullBytes
  check(
    '121 moving controls are represented by a window transform, not 121 rectangles per frame',
    ratio < 0.08,
    true,
  )
  console.log(
    `         ${String(fresh.length)} observations: ${String(fullBytes)} B full, ` +
    `${String(compactBytes)} B timeline (${(ratio * 100).toFixed(2)}%)`,
  )

  const restored = restoreWindowsContextTimeline(exported, 503)
  const expectedAt500 = fresh.find((observation) => observation.tMs === 500) ?? null
  check('direct restore uses the editor nearest-sample rule', restored, expectedAt500)

  const trimmed = trimWindowsContextTimeline(exported, 505, 1295)
  check('a valid range trims and rebases', trimmed !== null, true)
  if (trimmed !== null) {
    const decodedTrim = importWindowsContextTimeline(
      JSON.parse(JSON.stringify(trimmed)) as unknown,
    )
    const boundary = fresh.find((observation) => observation.tMs === 500)
    const expectedTrim = boundary === undefined
      ? []
      : [
          cloneAt(boundary, 0),
          ...fresh
            .filter((observation) => observation.tMs > 505 && observation.tMs <= 1295)
            .map((observation) => cloneAt(observation, observation.tMs - 505)),
        ]
    check('trim materialises the nearest boundary then preserves every later sample', decodedTrim, expectedTrim)
    check('trim rebases the persisted range to zero', trimmed.range, { start_ms: 0, end_ms: 790 })
  }

  const malformed = JSON.parse(json) as {
    deltas?: Array<{ t_ms?: number }>
  }
  if (malformed.deltas?.[1] !== undefined) malformed.deltas[1].t_ms = -1
  check('an invalid/unordered pack timeline is rejected', importWindowsContextTimeline(malformed), null)
  check('an inverted trim range is rejected', trimWindowsContextTimeline(exported, 900, 100), null)

  console.log()
  console.log('Windows context timeline: hostile-pack budgets')
  const baseWindow = exported.checkpoint.windows[0]
  const baseElement = exported.checkpoint.elements[0]
  if (baseWindow === undefined || baseElement === undefined) {
    check('the security fixture has a window and control', false, true)
  } else {
    const timeline = (
      windows: typeof exported.checkpoint.windows,
      elements: typeof exported.checkpoint.elements,
      deltas: unknown[],
      endMs = deltas.length,
    ): unknown => ({
      schema: exported.schema,
      version: exported.version,
      range: { start_ms: 0, end_ms: endMs },
      checkpoint: { t_ms: 0, windows, elements },
      deltas,
    })

    check(
      'a history longer than the supported ten-minute replay is rejected',
      decodeWindowsContextTimeline(
        timeline(
          [baseWindow],
          [baseElement],
          [],
          WINDOWS_CONTEXT_TIMELINE_LIMITS.maxDurationMs + 1,
        ),
      ),
      null,
    )

    const tooManyObservations = Array.from(
      { length: WINDOWS_CONTEXT_TIMELINE_LIMITS.maxObservations },
      (_, index) => ({ t_ms: index + 1 }),
    )
    check(
      'the 30fps-by-ten-minute observation envelope is a hard limit',
      decodeWindowsContextTimeline(
        timeline(
          [baseWindow],
          [baseElement],
          tooManyObservations,
          tooManyObservations.length,
        ),
      ),
      null,
    )

    const manyWindows = Array.from(
      { length: WINDOWS_CONTEXT_TIMELINE_LIMITS.maxWindowsPerObservation },
      (_, index) => ({
        ...baseWindow,
        hwnd: String(index + 1),
        surface_id: `surface-${String(index + 1)}`,
        z: index,
        bounds: { ...baseWindow.bounds },
        ...(baseWindow.client_bounds === undefined
          ? {}
          : { client_bounds: { ...baseWindow.client_bounds } }),
      }),
    )
    const windowSet = manyWindows.map(
      (window, index): [number, typeof window] => [index, window],
    )
    const tooManyWindowRecords = Array.from({ length: 39 }, (_, index) => ({
      t_ms: index + 1,
      windows: { set: windowSet },
    }))
    check(
      'full-window records have an aggregate budget across all deltas',
      decodeWindowsContextTimeline(
        timeline(manyWindows, [], tooManyWindowRecords),
      ),
      null,
    )

    const manyElements = Array.from(
      { length: WINDOWS_CONTEXT_TIMELINE_LIMITS.maxElementsPerObservation },
      (_, index) => ({
        ...baseElement,
        name: `control-${String(index)}`,
        automation_id: `control-${String(index)}`,
        bounds: { ...baseElement.bounds },
      }),
    )
    const elementSet = manyElements.map(
      (element, index): [number, typeof element] => [index, element],
    )
    const tooManyElementRecords = Array.from({ length: 8 }, (_, index) => ({
      t_ms: index + 1,
      elements: { set: elementSet },
    }))
    check(
      'full-control records have an aggregate budget across all deltas',
      decodeWindowsContextTimeline(
        timeline([baseWindow], manyElements, tooManyElementRecords),
      ),
      null,
    )

    const elementPatches = manyElements.map(
      (element, index): [number, { bounds: typeof element.bounds }] => [
        index,
        { bounds: { ...element.bounds } },
      ],
    )
    const tooManyDeltaEntries = Array.from({ length: 17 }, (_, index) => ({
      t_ms: index + 1,
      elements: { patch: elementPatches },
    }))
    check(
      'set, patch and transform entries share one aggregate delta budget',
      decodeWindowsContextTimeline(
        timeline([baseWindow], manyElements, tooManyDeltaEntries),
      ),
      null,
    )

    const longString = 'x'.repeat(
      WINDOWS_CONTEXT_TIMELINE_LIMITS.maxStringCodeUnits,
    )
    const stringsToOverflow =
      Math.floor(
        WINDOWS_CONTEXT_TIMELINE_LIMITS.maxStringBytes
          / WINDOWS_CONTEXT_TIMELINE_LIMITS.maxStringCodeUnits,
      ) + 1
    const stringHeavyElements = Array.from(
      { length: stringsToOverflow },
      (_, index) => ({
        ...baseElement,
        name: longString,
        automation_id: String(index),
        bounds: { ...baseElement.bounds },
      }),
    )
    check(
      'UTF-8 string bytes have one aggregate budget, not only a per-field cap',
      decodeWindowsContextTimeline(
        timeline([baseWindow], stringHeavyElements, []),
      ),
      null,
    )
  }

  console.log()
  console.log('Windows context plugin: save-first -> cancel trim -> final trim -> reopen')
  const packRoot = await mkdtemp(path.join(tmpdir(), 'capturepack-windows-context-pack-'))
  try {
    const capturedAt = new Date('2026-07-29T12:34:56.000Z')
    const rawContext = exportWindowsContextTimeline(fresh, {
      startMs: 0,
      endMs: 1800,
      rebaseToMs: 200,
    })
    check('the raw recorder clock can offset the checkpoint', rawContext?.range, {
      start_ms: 200,
      end_ms: 2000,
    })
    const initial = {
      snapshotPng: Buffer.from('snapshot'),
      width: 3840,
      height: 2160,
      capturedAt,
      replayWebm: Buffer.from('raw replay'),
      replayFile: 'replay.webm',
      replayDurationMs: 2000,
      timeline: {
        t0: '2026-07-29T12:34:54.000Z',
        events: [],
      },
      outputDir: packRoot,
      screens: [
        { width: 1200, height: 1920, scale: 1 },
        { width: 2560, height: 1440, scale: 1.5 },
      ],
      windowsContext: rawContext,
    }
    const handle = await savePack(initial)
    const savedFirst = openPack(handle.dirPath, 'dir', path.basename(handle.dirPath))
    const firstManifest = savedFirst.manifest()
    check(
      'save-first declares windows-context only after its payload lands',
      firstManifest?.plugins?.some((plugin) => plugin.name === WINDOWS_CONTEXT_PLUGIN_NAME),
      true,
    )
    const savedMeta = savedFirst.readText(
      `plugins/${WINDOWS_CONTEXT_PLUGIN_NAME}/meta.json`,
    )
    check(
      'save-first writes an explicit machine-readable timeline contract',
      savedMeta === null
        ? null
        : (() => {
            const meta = JSON.parse(savedMeta) as Record<string, unknown>
            return {
              name: meta['name'],
              schema: meta['schema'],
              clock: meta['clock'],
              timeline: meta['timeline'],
            }
          })(),
      {
        name: WINDOWS_CONTEXT_PLUGIN_NAME,
        schema: 'capturepack.windows-context.timeline',
        clock: 'pack_ms',
        timeline: 'timeline.json',
      },
    )
    const firstTimelineText = savedFirst.readText(
      `plugins/${WINDOWS_CONTEXT_PLUGIN_NAME}/timeline.json`,
    )
    const boundedFirst = loadWindowsContextHistory(savedFirst, 2000)
    check(
      'the bounded pack loader accepts the normal persisted history',
      boundedFirst.status,
      'loaded',
    )
    const firstReopen =
      firstTimelineText === null
        ? null
        : importWindowsContextTimeline(JSON.parse(firstTimelineText) as unknown)
    check(
      'save-first reopens on the raw media clock with HWND and every observation',
      firstReopen,
      fresh.map((observation) => cloneAt(observation, observation.tMs + 200)),
    )

    if (firstTimelineText !== null) {
      const firstBytes = Buffer.byteLength(firstTimelineText, 'utf8')
      let attemptedOversizeRead = false
      const defaultCapDrop = loadWindowsContextHistory(
        {
          fileSize: () => WINDOWS_CONTEXT_MAX_FILE_BYTES + 1,
          readText: () => {
            attemptedOversizeRead = true
            throw new Error('the byte preflight must run before this read')
          },
        },
        2000,
      )
      check(
        'an oversized declared entry is rejected before any directory/ZIP read',
        {
          status: defaultCapDrop.status,
          reason:
            defaultCapDrop.status === 'dropped' ? defaultCapDrop.reason : null,
          readAttempted: attemptedOversizeRead,
        },
        { status: 'dropped', reason: 'too-large', readAttempted: false },
      )

      const boundedDir = path.join(packRoot, 'hostile-directory')
      await mkdir(
        path.join(boundedDir, path.dirname(WINDOWS_CONTEXT_TIMELINE_PACK_PATH)),
        { recursive: true },
      )
      await writeFile(
        path.join(boundedDir, WINDOWS_CONTEXT_TIMELINE_PACK_PATH),
        firstTimelineText,
        'utf8',
      )
      const directoryDrop = loadWindowsContextHistory(
        openPack(boundedDir, 'dir', 'hostile-directory'),
        2000,
        { maxFileBytes: Math.max(0, firstBytes - 1) },
      )

      const boundedZipPath = path.join(packRoot, 'hostile-archive.zip')
      const boundedZip = new AdmZip()
      boundedZip.addFile(
        WINDOWS_CONTEXT_TIMELINE_PACK_PATH,
        Buffer.from(firstTimelineText, 'utf8'),
      )
      boundedZip.writeZip(boundedZipPath)
      const zipDrop = loadWindowsContextHistory(
        openPack(boundedZipPath, 'zip', 'hostile-archive'),
        2000,
        { maxFileBytes: Math.max(0, firstBytes - 1) },
      )
      check(
        'the same pre-read byte cap protects directory and ZIP PackHandles',
        {
          directory:
            directoryDrop.status === 'dropped' ? directoryDrop.reason : directoryDrop.status,
          zip: zipDrop.status === 'dropped' ? zipDrop.reason : zipDrop.status,
        },
        { directory: 'too-large', zip: 'too-large' },
      )

      const historyDrop = loadWindowsContextHistory(
        savedFirst,
        2000,
        { maxFileBytes: Math.max(0, firstBytes - 1) },
      )
      check(
        'dropping hostile history leaves the manifest and editor pixels readable',
        {
          history: historyDrop.status,
          manifest: savedFirst.manifest()?.id,
          snapshot: savedFirst.readBinary('snapshot.png')?.toString('utf8'),
        },
        {
          history: 'dropped',
          manifest: handle.id,
          snapshot: 'snapshot',
        },
      )
    }

    const cancelledContext =
      rawContext === null ? null : trimWindowsContextTimeline(rawContext, 200, 2000)
    await updateInitialPack(handle, {
      ...initial,
      replayWebm: Buffer.from('cut replay'),
      replayDurationMs: 1800,
      timeline: {
        t0: '2026-07-29T12:34:54.200Z',
        events: [],
      },
      windowsContext: cancelledContext,
    })
    const cancelledPack = openPack(handle.dirPath, 'dir', path.basename(handle.dirPath))
    const cancelledText = cancelledPack.readText(
      `plugins/${WINDOWS_CONTEXT_PLUGIN_NAME}/timeline.json`,
    )
    check(
      'cancel finalization trims/rebases its save-first context instead of leaving raw-clock data',
      cancelledText === null
        ? null
        : importWindowsContextTimeline(JSON.parse(cancelledText) as unknown),
      fresh,
    )

    const finalContext =
      cancelledContext === null
        ? null
        : trimWindowsContextTimeline(cancelledContext, 505, 1295)
    const finalInput = {
      snapshotPng: Buffer.from('edited snapshot'),
      width: 3840,
      height: 2160,
      capturedAt,
      replayWebm: null,
      replayFile: 'replay.webm',
      replayDurationMs: 790,
      annotations: [],
      title: 'Temporal context check',
      note: '',
      snapshotTMs: 0,
      trimOffsetMs: 705,
      timeline: {
        t0: '2026-07-29T12:34:54.705Z',
        events: [],
      },
      windowsContext: finalContext,
      screens: initial.screens,
      clipboardAfterSave: 'off' as const,
    }
    await updatePack(handle, finalInput, { keepReplay: true })
    const finalPack = openPack(handle.dirPath, 'dir', path.basename(handle.dirPath))
    const finalText = finalPack.readText(
      `plugins/${WINDOWS_CONTEXT_PLUGIN_NAME}/timeline.json`,
    )
    const expectedFinal = cancelledContext === null
      ? null
      : importWindowsContextTimeline(
          trimWindowsContextTimeline(cancelledContext, 505, 1295),
        )
    check(
      'normal final save reopens with the exact user-trimmed observations',
      finalText === null
        ? null
        : importWindowsContextTimeline(JSON.parse(finalText) as unknown),
      expectedFinal,
    )
    check(
      'normal manifest still declares the context payload',
      finalPack.manifest()?.plugins?.some(
        (plugin) => plugin.name === WINDOWS_CONTEXT_PLUGIN_NAME,
      ),
      true,
    )

    await updatePack(
      handle,
      { ...finalInput, windowsContext: null },
      { keepReplay: true },
    )
    const degradedPack = openPack(handle.dirPath, 'dir', path.basename(handle.dirPath))
    check(
      'an explicit context degradation cannot fail the media save',
      degradedPack.manifest()?.id,
      handle.id,
    )
    check(
      'a stale context declaration is removed with its payload',
      {
        declared: degradedPack.manifest()?.plugins?.some(
          (plugin) => plugin.name === WINDOWS_CONTEXT_PLUGIN_NAME,
        ) ?? false,
        timeline: degradedPack.readText(
          `plugins/${WINDOWS_CONTEXT_PLUGIN_NAME}/timeline.json`,
        ),
      },
      { declared: false, timeline: null },
    )
  } finally {
    await rm(packRoot, { recursive: true, force: true })
  }

  console.log(
    failures === 0
      ? '\nPASS — temporal Windows context survives compact persistence'
      : `\nFAIL — ${String(failures)} assertion(s)`,
  )
  process.exitCode = failures === 0 ? 0 : 1
}

void main()
