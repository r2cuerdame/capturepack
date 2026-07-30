// DOES A CONTROL LAND WHERE THE CONTROL IS? (#111)
//
// Reported as two symptoms at once: hovering a Chrome extension card named the
// right control — "컨트롤 · Ghostery 개인정보 보호용 광고 차단기" — while drawing
// its outline in the BOTTOM-LEFT of the window over blank space, and small
// elements could not be picked at all.
//
// The chip and the outline cannot disagree by construction: editor.ts paints
// both from ONE `hoverObject`, taking the rectangle from `hoverObject.x/y/w/h`
// and the text from `hoverChipLabel(hoverObject)`. So a chip naming a control
// whose outline is somewhere else means the OBJECT's rectangle is already
// wrong by the time the editor has it — upstream of any drawing.
//
// This drives the REAL provider and the REAL ObjectIndex over a REAL dump
// (CapturePack_2026-07-29_184934, the capture the screenshot came from: Chrome
// on chrome://extensions, display 1, 230 elements) and asks the only question
// that matters — probe a point inside a control, and is the object you get back
// that control, at that rectangle?
//
// Run: npm run check:pick
import { existsSync, readFileSync } from 'node:fs'
import {
  ContextBuffer,
  mintSurfaceIds,
  surfaceSamplesOf,
  windowCandidatesFromSurfaces,
} from '../src/main/context/buffer'
import type { ContextObservation } from '../src/main/context/buffer'
import { WindowsUiaProvider } from '../src/main/context/provider'
import {
  ObjectIndex,
  pickIdentityOf,
  samePickIdentity,
} from '../src/renderer/editor/objects'
import type { PickableObject } from '../src/renderer/editor/objects'
import {
  annotationAlreadyAnnotatesPick,
  boundedObservedPickFallback,
  existingAnnotationForPick,
  pickBeatsBoxPolicy,
} from '../src/renderer/editor/objectPickPolicy'
import type { EditorUiaElement, EditorUiaWindow } from '../src/shared/ipc'
import type { Annotation, AnnotationTarget } from '../src/shared/types'

const PACK = 'C:/Users/recue/OneDrive/Desktop/CapturePack/CapturePack_2026-07-29_184934'

interface DumpWindow {
  z: number
  title: string
  process: string
  class_name: string
  bounds: { x: number; y: number; width: number; height: number }
  focused?: boolean
  display?: number
  hwnd?: string
  tree?: string
}
interface DumpElement {
  window: number
  bounds: { x: number; y: number; width: number; height: number }
  control_type: string
  name: string
  automation_id: string
  class_name: string
  depth?: number
  display?: number
}

// A deterministic 18x18 target keeps the small-control regression non-vacuous
// even when the owner's original CapturePack fixture is not present in CI.
// It is placed inside the Chrome window, away from the two larger fixture
// controls, and participates in the exact same provider/index path as they do.
const syntheticSmallControl: DumpElement = {
  window: 0,
  bounds: { x: 600, y: 160, width: 18, height: 18 },
  control_type: 'Button',
  name: 'Synthetic 18px control',
  automation_id: 'synthetic-small-control',
  class_name: 'Button',
  depth: 20,
  display: 1,
}

const fixturePath = `${PACK}/plugins/windows-uia/elements.json`
const syntheticDump = {
  windows: [
    {
      z: 0,
      title: '확장 프로그램 - Chrome',
      process: 'chrome',
      class_name: 'Chrome_WidgetWin_1',
      bounds: { x: 0, y: 0, width: 1200, height: 1800 },
      focused: true,
      display: 1,
      hwnd: '1000',
      tree: 'collected',
    },
    {
      z: 1,
      title: 'Skipped window with no controls',
      process: 'other',
      class_name: 'OtherWindow',
      bounds: { x: 900, y: 1400, width: 240, height: 240 },
      focused: false,
      display: 1,
      hwnd: '1001',
      tree: 'skipped',
    },
  ],
  elements: [
    {
      window: 0,
      bounds: { x: 100, y: 120, width: 240, height: 48 },
      control_type: 'Button',
      name: 'Ghostery 개인정보 보호용 광고 차단기',
      automation_id: 'ghostery',
      class_name: 'Button',
      display: 1,
    },
    {
      window: 0,
      bounds: { x: 380, y: 120, width: 180, height: 48 },
      control_type: 'Button',
      name: '다른 확장 프로그램',
      automation_id: 'another-extension',
      class_name: 'Button',
      display: 1,
    },
  ],
}
const dump = (existsSync(fixturePath)
  ? JSON.parse(readFileSync(fixturePath, 'utf8'))
  : syntheticDump) as {
  windows: DumpWindow[]
  elements: DumpElement[]
}
if (!existsSync(fixturePath)) {
  console.log(`fixture missing: ${fixturePath}\nusing the equivalent built-in control fixture`)
}

// The Chrome window from the screenshot, and the display it is on.
const found = dump.windows.find((w) => /확장 프로그램/.test(w.title))
if (found === undefined) throw new Error('the screenshot window is not in this dump')
const chrome: DumpWindow = found
const DISPLAY = chrome.display ?? 1
// Display 1 of this desk (manifest.environment.screens[0]).
const SNAP_W = 1200
const SNAP_H = 1920

const els = [
  ...dump.elements.filter((e) => e.window === chrome.z),
  { ...syntheticSmallControl, window: chrome.z, display: DISPLAY },
]

/**
 * One observation, exactly the shape session.rebuild() produces: RING windows
 * (already in this display's snapshot space) carrying the DUMP's elements.
 * `dx` moves the window, so the anchoring path can be exercised too.
 */
const observationAt = (tMs: number, dx: number, withElements: boolean): ContextObservation => ({
  tMs,
  windows: dump.windows.map((w) => ({
    surface_id: `s${w.z}`,
    hwnd: `${1000 + w.z}`,
    title: w.title,
    process: w.process,
    class_name: w.class_name,
    bounds: { x: w.bounds.x + dx, y: w.bounds.y, width: w.bounds.width, height: w.bounds.height },
    display: w.display ?? DISPLAY,
    focused: w.focused === true,
    z: w.z,
    hasControls: (w.tree === 'collected' || w.tree === 'truncated'),
    tree: (w.tree ?? 'skipped') as EditorUiaWindow['tree'],
  })) as EditorUiaWindow[],
  elements: withElements ? (els.map((e) => ({ ...e })) as unknown as EditorUiaElement[]) : [],
})

const observations = [
  observationAt(0, 0, true),
  observationAt(500, 0, false),
  observationAt(1000, 300, false),
]
const ids = mintSurfaceIds(observations)
const buffer = new ContextBuffer(observations, 'ring', { startMs: 0, endMs: 1000 })
const provider = new WindowsUiaProvider(buffer, ids)
const samples = surfaceSamplesOf(observations, ids)

/** Every control candidate this pipeline offers on DISPLAY at `tMs`. */
async function indexAt(tMs: number): Promise<ObjectIndex> {
  const sample = samples.find((s) => s.tMs === tMs)
  if (sample === undefined) throw new Error(`no sample at ${tMs}`)
  const surfaces = sample.surfaces.filter((s) => s.display === DISPLAY)
  const frame = await provider.frame({
    sessionId: 'pick-check',
    timeMs: tMs,
    surfaces: sample.surfaces,
    maxCandidates: 5000,
  } as never)
  return ObjectIndex.build(frame.candidates, surfaces, frame.coverage, frame.claims, SNAP_W, SNAP_H)
}

/**
 * One deliberately large child control.
 *
 * A Document/List or a named Pane routinely occupies most of its owner window.
 * It is still a semantic child (the content the user is trying to point at),
 * not the anonymous client-area wrapper that the window level replaces.
 */
async function largeControlIndex(
  controlType: string,
  name: string,
  automationId: string,
): Promise<ObjectIndex> {
  const observation: ContextObservation = {
    tMs: 0,
    windows: [
      {
        surface_id: 'large-semantic-owner',
        hwnd: '1900',
        title: 'Large semantic control',
        process: 'semantic-app',
        class_name: 'SemanticWindow',
        bounds: { x: 0, y: 0, width: 1000, height: 800 },
        display: 1,
        focused: true,
        z: 0,
        hasControls: true,
        tree: 'collected',
      },
    ],
    elements: [
      {
        name,
        control_type: controlType,
        automation_id: automationId,
        class_name: '',
        // 85.1% of a maximized owner/snapshot: this crosses the independent
        // whole-display 80%-area and both-axes 70% container guards as well as
        // WINDOW_FRAME_FRACTION (35%).
        bounds: { x: 40, y: 30, width: 920, height: 740 },
        display: 1,
        window: 0,
      },
    ],
  }
  const ownIds = mintSurfaceIds([observation])
  const ownBuffer = new ContextBuffer([observation], 'single-instant', {
    startMs: 0,
    endMs: 0,
  })
  const ownProvider = new WindowsUiaProvider(ownBuffer, ownIds)
  const surfaceSample = surfaceSamplesOf([observation], ownIds)[0]
  if (surfaceSample === undefined) throw new Error('large-control fixture has no surface sample')
  const frame = await ownProvider.frame({
    sessionId: 'large-control-pick-check',
    timeMs: 0,
    surfaces: surfaceSample.surfaces,
    maxCandidates: 10,
  } as never)
  const windowCandidates = windowCandidatesFromSurfaces(surfaceSample.surfaces, {
    requestedTimeMs: 0,
    materializedTimeMs: 0,
    errorMs: 0,
    exact: true,
    coverage: 'covered',
  })
  return ObjectIndex.build(
    [...frame.candidates, ...windowCandidates],
    surfaceSample.surfaces,
    frame.coverage,
    frame.claims,
    1000,
    800,
    1,
  )
}

/** A deliberately small two-window observation for temporal fallback checks. */
function regressionObservation(
  tMs: number,
  options: {
    readonly aX: number
    readonly aElements: boolean
    readonly bElements: boolean
    readonly bTree?: EditorUiaWindow['tree']
    readonly bX?: number
    readonly aDisplay?: number
    readonly aName?: string
    readonly aTree?: EditorUiaWindow['tree']
    readonly aExtraName?: string
    readonly aClientX?: number
    readonly aWidth?: number
    readonly aRepeatedCount?: number
  },
): ContextObservation {
  const a: EditorUiaWindow = {
    surface_id: 'regression-a',
    hwnd: '2001',
    title: 'Partial A',
    process: 'app-a',
    class_name: 'AppA',
    bounds: { x: options.aX, y: 40, width: options.aWidth ?? 800, height: 700 },
    ...(options.aClientX === undefined
      ? {}
      : {
          client_bounds: {
            x: options.aClientX,
            y: 70,
            width: 780,
            height: 660,
          },
        }),
    display: options.aDisplay ?? 1,
    focused: false,
    z: 0,
    hasControls: options.aElements,
    tree: options.aTree ?? (options.aElements ? 'collected' : 'skipped'),
  }
  const b: EditorUiaWindow = {
    surface_id: 'regression-b',
    hwnd: '2002',
    title: 'Missing B',
    process: 'app-b',
    class_name: 'AppB',
    bounds: { x: options.bX ?? 900, y: 40, width: 800, height: 700 },
    display: 1,
    focused: false,
    z: 1,
    hasControls: options.bElements,
    tree: options.bTree ?? (options.bElements ? 'collected' : 'skipped'),
  }
  const elements: EditorUiaElement[] = []
  if (options.aElements) {
    if (options.aRepeatedCount !== undefined) {
      for (let index = 0; index < options.aRepeatedCount; index += 1) {
        elements.push({
          window: 0,
          bounds: {
            x: options.aX + 20 + (index % 8) * 90,
            y: 80 + Math.floor(index / 8) * 70,
            width: 60,
            height: 30,
          },
          control_type: 'Button',
          name: `Repeated row ${index + 1}`,
          automation_id: 'row-action',
          class_name: 'Button',
          display: options.aDisplay ?? 1,
        })
      }
    } else {
      elements.push({
        window: 0,
        bounds: { x: options.aX + 120, y: 140, width: 80, height: 40 },
        control_type: 'Button',
        name: options.aName ?? 'A control',
        automation_id: 'a-control',
        class_name: 'Button',
        display: options.aDisplay ?? 1,
      })
      if (options.aExtraName !== undefined) {
        elements.push({
          window: 0,
          bounds: { x: options.aX + 240, y: 140, width: 80, height: 40 },
          control_type: 'Button',
          name: options.aExtraName,
          automation_id: 'a-extra-control',
          class_name: 'Button',
          display: options.aDisplay ?? 1,
        })
      }
    }
  }
  if (options.bElements) {
    elements.push({
      window: 1,
      bounds: { x: (options.bX ?? 900) + 120, y: 140, width: 80, height: 40 },
      control_type: 'Button',
      name: 'B control',
      automation_id: 'b-control',
      class_name: 'Button',
      display: 1,
    })
  }
  return { tMs, windows: [a, b], elements }
}

async function regressionIndexAt(
  observations: readonly ContextObservation[],
  tMs: number,
  width = 2400,
  height = 900,
  display = 1,
): Promise<{ index: ObjectIndex; candidates: number; claims: number }> {
  const ids = mintSurfaceIds(observations)
  const buffer = new ContextBuffer(observations, 'ring', {
    startMs: observations[0]?.tMs ?? 0,
    endMs: observations[observations.length - 1]?.tMs ?? 0,
  })
  const provider = new WindowsUiaProvider(buffer, ids)
  const sample = surfaceSamplesOf(observations, ids).find((entry) => entry.tMs === tMs)
  if (sample === undefined) throw new Error(`no regression sample at ${tMs}`)
  const frame = await provider.frame({
    sessionId: 'pick-check-regression',
    timeMs: tMs,
    surfaces: sample.surfaces,
    maxCandidates: 5000,
  } as never)
  return {
    index: ObjectIndex.build(
      frame.candidates,
      sample.surfaces.filter((surface) => surface.display === display),
      frame.coverage,
      frame.claims,
      width,
      height,
      display,
    ),
    candidates: frame.candidates.length,
    claims: frame.claims.length,
  }
}

let failed = 0
const check = (ok: boolean, line: string): void => {
  if (!ok) failed += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${line}`)
}

const storedBox = (
  annotationId: string,
  target: AnnotationTarget,
): Annotation => ({
  annotation_id: annotationId,
  type: 'box',
  bounds: { x: 100, y: 120, width: 240, height: 48 },
  text: '',
  numbered: false,
  blur: false,
  tracking: { enabled: false },
  target,
  created_at: '2026-07-30T00:00:00.000Z',
  z: 1,
})

async function main(): Promise<void> {
  console.log(`dump: ${els.length} elements in "${chrome.title.slice(0, 30)}" at ${JSON.stringify(chrome.bounds)}, display ${DISPLAY}\n`)

  // --- The reported control, probed at its own centre -----------------------
  const target = els.find((e) => /Ghostery 개인정보/.test(e.name))
  if (target === undefined) throw new Error('the Ghostery control is not in this dump')
  const px = Math.round(target.bounds.x + target.bounds.width / 2)
  const py = Math.round(target.bounds.y + target.bounds.height / 2)
  console.log(`THE REPORTED CONTROL — "${target.name.slice(0, 34)}" at ${JSON.stringify(target.bounds)}`)
  console.log(`probing its centre (${px}, ${py})`)

  const idx = await indexAt(0)
  const got = idx.pick(px, py)
  check(got !== null, `something is offered at the control's own centre — got ${got === null ? 'NOTHING' : got.level}`)
  if (got !== null) {
    const inside = px >= got.x && py >= got.y && px <= got.x + got.width && py <= got.y + got.height
    check(inside, `the offered object CONTAINS the probe point — rect (${got.x},${got.y},${got.width},${got.height})`)
    check(
      got.level === 'control',
      `it is a CONTROL, not the window fallback — got ${got.level} "${String(got.candidate.name).slice(0, 30)}"`,
    )
    if (got.level === 'control') {
      const exact =
        got.x === target.bounds.x &&
        got.y === target.bounds.y &&
        got.width === target.bounds.width &&
        got.height === target.bounds.height
      check(
        exact,
        `its rectangle is the control's — want (${target.bounds.x},${target.bounds.y},${target.bounds.width},${target.bounds.height}) got (${got.x},${got.y},${got.width},${got.height})`,
      )
    }
  }

  // --- Every control, not just the reported one ----------------------------
  console.log('\nEVERY CONTROL IN THE DUMP, probed at its own centre')
  let offered = 0
  let containing = 0
  let displaced = 0
  const worst: string[] = []
  for (const e of els) {
    const cx = Math.round(e.bounds.x + e.bounds.width / 2)
    const cy = Math.round(e.bounds.y + e.bounds.height / 2)
    if (cx < 0 || cy < 0 || cx >= SNAP_W || cy >= SNAP_H) continue
    const o = idx.pick(cx, cy)
    if (o === null) continue
    offered += 1
    const inside = cx >= o.x && cy >= o.y && cx <= o.x + o.width && cy <= o.y + o.height
    if (inside) containing += 1
    else {
      displaced += 1
      if (worst.length < 5) {
        worst.push(`probe (${cx},${cy}) -> rect (${o.x},${o.y},${o.width},${o.height}) "${String(o.candidate.name).slice(0, 24)}"`)
      }
    }
  }
  console.log(`  ${offered} probes answered, ${containing} contained the point, ${displaced} did NOT`)
  for (const w of worst) console.log(`     ${w}`)
  check(displaced === 0, `no offered object is ever displaced from its probe point (${displaced} were)`)

  // --- Small elements ------------------------------------------------------
  console.log('\nSMALL ELEMENTS ("작은 엘레멘트 선택이 안되고")')
  const small = els.filter((e) => e.bounds.width < 32 || e.bounds.height < 32)
  let smallOffered = 0
  for (const e of small) {
    const cx = Math.round(e.bounds.x + e.bounds.width / 2)
    const cy = Math.round(e.bounds.y + e.bounds.height / 2)
    if (cx < 0 || cy < 0 || cx >= SNAP_W || cy >= SNAP_H) continue
    const o = idx.pick(cx, cy)
    if (o !== null && o.level === 'control') smallOffered += 1
  }
  console.log(`  ${small.length} controls are under 32 px on one axis; ${smallOffered} are offered as controls`)
  check(small.length > 0 && smallOffered > 0, 'the non-empty small-control fixture can be picked')

  // --- Large semantic children ---------------------------------------------
  console.log('\nLARGE SEMANTIC CHILD CONTROLS')
  for (const fixture of [
    { type: 'Document', name: 'Editor contents', id: '' },
    { type: 'List', name: 'Issue list', id: '' },
    { type: 'Pane', name: 'Contents', id: 'contents-pane' },
    { type: 'Contents', name: 'Document contents', id: '' },
  ]) {
    const semantic = await largeControlIndex(fixture.type, fixture.name, fixture.id)
    const firstClick = semantic.pick(500, 380)
    check(
      firstClick?.level === 'window',
      `${fixture.type} stays deferred on the first click instead of covering the whole app`,
    )
    const picked = semantic.stackAt(500, 380, false, 0, true).offered[0] ?? null
    check(
      picked?.level === 'control' && picked.candidate.objectType === fixture.type,
      `${fixture.type} becomes the selectable window refinement even above 35% of its owner — got ${
        picked === null ? 'NOTHING' : `${picked.level} ${picked.candidate.objectType}`
      }`,
    )
  }
  const anonymousPane = await largeControlIndex('Pane', '', '')
  const anonymousPick = anonymousPane.pick(500, 380)
  check(
    anonymousPick?.level === 'window',
    `an anonymous client-area Pane still falls through to its window — got ${
      anonymousPick === null ? 'NOTHING' : `${anonymousPick.level} ${anonymousPick.candidate.objectType}`
    }`,
  )
  const windowWrapper = await largeControlIndex('Window', 'Embedded wrapper', 'wrapper')
  const wrapperPick = windowWrapper.pick(500, 380)
  check(
    wrapperPick?.level === 'window' && wrapperPick.providerId === 'core',
    `a provider Window wrapper still falls through to Core's window — got ${
      wrapperPick === null ? 'NOTHING' : `${wrapperPick.level} ${wrapperPick.providerId}`
    }`,
  )

  // A semantic window box is selected as soon as it is created. Its large
  // Document/Contents child can occupy far more than half of that window and
  // is still a real refinement, so the old 50%-area gate must not swallow it.
  console.log('\nSEMANTIC WINDOW BOX VS LARGE CHILD PICK')
  const largeChildPolicy = {
    selectedManualBox: false,
    repeat: false,
    onEdge: false,
    alreadyAnnotatesPick: false,
    boxTargetLevel: 'window' as const,
    pickedLevel: 'control' as const,
    pickedArea: 70,
    boxArea: 100,
  }
  check(
    pickBeatsBoxPolicy(largeChildPolicy),
    'a semantic window box yields its interior to a control even when the child is over 50%',
  )
  check(
    !pickBeatsBoxPolicy({ ...largeChildPolicy, selectedManualBox: true }),
    'a selected manual box keeps its interior drag gesture',
  )
  check(
    !pickBeatsBoxPolicy({ ...largeChildPolicy, repeat: true }),
    'a repeat click still selects the existing box',
  )
  check(
    !pickBeatsBoxPolicy({ ...largeChildPolicy, onEdge: true }),
    'a click on the existing box edge still selects that box',
  )
  check(
    !pickBeatsBoxPolicy({ ...largeChildPolicy, alreadyAnnotatesPick: true }),
    'a box that already annotates this exact pick keeps the click',
  )
  check(
    !pickBeatsBoxPolicy({ ...largeChildPolicy, boxTargetLevel: 'control' }),
    'the 50% refinement gate still applies between ordinary overlapping controls',
  )

  // --- Owner motion is not child evidence ----------------------------------
  console.log('\nAFTER THE WINDOW MOVES 300 px RIGHT')
  const moved = await indexAt(1000)
  const mx = px + 300
  const observedAtOldPoint = moved.pick(px, py)
  const atProjectedPoint = moved.pick(mx, py)
  check(
    observedAtOldPoint?.candidate.name !== target.name,
    'a stale observed control is not detached from its current owner surface',
  )
  check(
    atProjectedPoint?.candidate.name !== target.name,
    `owner motion does not project that control to (${mx}, ${py})`,
  )

  // A PARTIAL TREE IN APP A MUST NOT HIDE A FULL FALLBACK FOR APP B.
  //
  // Lane A can finish one window while another is skipped or quarantined. The
  // capture-instant dump still holds B, and the provider must choose its source
  // per surface rather than treating ANY current element as proof that every
  // window has fresh data. Otherwise B vanishes on past frames precisely when
  // A happens to expose a single child.
  console.log('\nPARTIAL A MUST NOT SILENCE B\'S CAPTURE-INSTANT FALLBACK')
  const partialA = [
    regressionObservation(0, { aX: 0, aElements: true, bElements: false, bTree: 'skipped' }),
    regressionObservation(1000, { aX: 0, aElements: true, bElements: true }),
  ]
  const partialAAtPast = await regressionIndexAt(partialA, 0)
  const bAtPast = partialAAtPast.index.pick(1060, 160)
  check(
    bAtPast !== null && bAtPast.level === 'control' && bAtPast.candidate.name === 'B control',
    `B is selectable at the past frame despite A's partial tree — got ${bAtPast === null ? 'NOTHING' : `${bAtPast.level} ${bAtPast.candidate.name}`}`,
  )

  console.log('\nA PARTIAL PAST TREE MUST NOT BE REPLACED BY FUTURE CONTENT')
  const temporalPrefix = [
    regressionObservation(0, {
      aX: 0,
      aElements: true,
      aTree: 'truncated',
      aName: 'Old action',
      bElements: false,
    }),
    regressionObservation(5000, {
      aX: 0,
      aElements: true,
      aTree: 'collected',
      aName: 'New action',
      bElements: false,
    }),
  ]
  const temporalPrefixAtPast = await regressionIndexAt(temporalPrefix, 0)
  const oldAtPast = temporalPrefixAtPast.index.pick(160, 160)
  check(
    oldAtPast !== null &&
      oldAtPast.level === 'control' &&
      oldAtPast.candidate.name === 'Old action' &&
      oldAtPast.candidate.accuracy.exact,
    `the past keeps its observed prefix and exact provenance — got ${
      oldAtPast === null
        ? 'NOTHING'
        : `${oldAtPast.candidate.name}, exact=${String(oldAtPast.candidate.accuracy.exact)}`
    }`,
  )

  console.log('\nA PAST PREFIX IS SUPPLEMENTED WITHOUT OVERWRITING IT')
  const supplementedPrefix = [
    regressionObservation(0, {
      aX: 0,
      aElements: true,
      aTree: 'truncated',
      aName: 'Exact first action',
      bElements: false,
    }),
    regressionObservation(5000, {
      aX: 0,
      aElements: true,
      aTree: 'collected',
      aName: 'Future first action',
      aExtraName: 'Fallback action 33',
      bElements: false,
    }),
  ]
  const supplementedAtPast = await regressionIndexAt(supplementedPrefix, 0)
  const exactFirst = supplementedAtPast.index.pick(160, 160)
  const fallbackThirtyThird = supplementedAtPast.index.pick(280, 160)
  check(
    exactFirst?.candidate.name === 'Exact first action' &&
      exactFirst.candidate.accuracy.exact &&
      exactFirst.candidate.accuracy.interpolated !== true,
    `the exact prefix wins duplicate identity — got ${
      exactFirst === null ? 'NOTHING' : String(exactFirst.candidate.name)
    }`,
  )
  check(
    fallbackThirtyThird?.candidate.name === 'Fallback action 33' &&
      fallbackThirtyThird.candidate.accuracy.interpolated === true,
    `control 33+ is restored with fallback provenance — got ${
      fallbackThirtyThird === null
        ? 'NOTHING'
        : `${String(fallbackThirtyThird.candidate.name)}, interpolated=${String(
            fallbackThirtyThird.candidate.accuracy.interpolated,
          )}`
    }`,
  )

  console.log('\nREPEATED AUTOMATION IDS DO NOT HIDE THE FALLBACK SUFFIX')
  const repeatedPrefix = [
    regressionObservation(0, {
      aX: 0,
      aElements: true,
      aTree: 'truncated',
      aRepeatedCount: 32,
      bElements: false,
    }),
    regressionObservation(5000, {
      aX: 0,
      aElements: true,
      aTree: 'collected',
      aRepeatedCount: 40,
      bElements: false,
    }),
  ]
  const repeatedAtPast = await regressionIndexAt(repeatedPrefix, 0)
  const repeatedFortieth = repeatedAtPast.index.pick(680, 375)
  check(
    repeatedFortieth?.candidate.name === 'Repeated row 40' &&
      repeatedFortieth.candidate.accuracy.interpolated === true,
    `same-id occurrence 40 survives the 32-item prefix — got ${
      repeatedFortieth === null ? 'NOTHING' : String(repeatedFortieth.candidate.name)
    }`,
  )

  // Claims and candidates must remain on the same observed geometry. Moving
  // only the claim would make an unobserved projected control pickable.
  console.log('\nOWNER MOTION DOES NOT MOVE AN OBSERVED CONTROL CLAIM')
  const movedFar = [
    regressionObservation(0, { aX: 0, aElements: true, bElements: false }),
    regressionObservation(1000, { aX: 1200, aElements: false, bElements: false }),
  ]
  const movedFarAtEnd = await regressionIndexAt(movedFar, 1000)
  const movedFarPick = movedFarAtEnd.index.pick(1360, 160)
  check(
    movedFarPick?.candidate.name !== 'A control',
    'a far owner move does not create a projected child at the destination',
  )

  console.log('\nOWNER MOTION DOES NOT MOVE AN OBSERVED CONTROL ACROSS DISPLAYS')
  const movedDisplay = [
    regressionObservation(0, {
      aX: 0,
      aDisplay: 1,
      aElements: true,
      bElements: false,
    }),
    regressionObservation(1000, {
      aX: 0,
      aDisplay: 2,
      aElements: false,
      bElements: false,
    }),
  ]
  const movedDisplayAtEnd = await regressionIndexAt(
    movedDisplay,
    1000,
    2400,
    900,
    2,
  )
  const movedDisplayPick = movedDisplayAtEnd.index.pick(160, 160)
  check(
    movedDisplayPick?.candidate.name !== 'A control',
    'an owner display change does not rewrite the child observation display',
  )

  console.log('\nA STRADDLING WINDOW DOES NOT PROJECT CHILD GEOMETRY')
  const movedFromSeam = [
    regressionObservation(0, {
      aX: 0,
      aClientX: -920,
      aDisplay: 2,
      aElements: true,
      bElements: false,
    }),
    regressionObservation(1000, {
      aX: 300,
      aClientX: 300,
      // The later window is no longer clipped by the display seam. Its full
      // claim must contain the control translated from the old, un-clipped
      // client origin.
      aWidth: 1720,
      aDisplay: 2,
      aElements: false,
      bElements: false,
    }),
  ]
  const movedFromSeamAtEnd = await regressionIndexAt(
    movedFromSeam,
    1000,
    2400,
    900,
    2,
  )
  const seamMovedPick = movedFromSeamAtEnd.index.pick(1380, 160)
  check(
    seamMovedPick?.candidate.name !== 'A control',
    'an unclipped owner origin does not invent a child rectangle across the seam',
  )

  // A LOST TREE STATUS MUST NOT SILENCE DATA THAT SURVIVED.
  //
  // A ring window that failed to match its dump counterpart in
  // session.rebuild() can keep ringObservations' own `skipped` while the dump's
  // elements survive. Those elements are direct evidence that UIA read their
  // owner window, so claimsOf() must retain the minimum claim for that exact
  // owner. Otherwise the provider emits candidates and the resolver discards
  // all of them as UNCLAIMED — indistinguishable from "this app has no
  // controls" despite the controls sitting in memory.
  console.log('\nA WINDOW WHOSE TREE STATUS WAS LOST')
  const silenced = observationAt(0, 0, true)
  silenced.windows = silenced.windows.map((w) => ({
    ...w,
    tree: 'skipped',
    hasControls: false,
  })) as typeof silenced.windows
  const sIds = mintSurfaceIds([silenced])
  const sProvider = new WindowsUiaProvider(
    new ContextBuffer([silenced], 'ring', { startMs: 0, endMs: 0 }),
    sIds,
  )
  const sSample = surfaceSamplesOf([silenced], sIds)[0]
  if (sSample !== undefined) {
    const sFrame = await sProvider.frame({
      sessionId: 'silent',
      timeMs: 0,
      surfaces: sSample.surfaces,
      maxCandidates: 5000,
    } as never)
    const sIdx = ObjectIndex.build(
      sFrame.candidates,
      sSample.surfaces.filter((s) => s.display === DISPLAY),
      sFrame.coverage,
      sFrame.claims,
      SNAP_W,
      SNAP_H,
    )
    const picked = sIdx.pick(px, py)
    check(sFrame.candidates.length > 0, `the provider still offers ${sFrame.candidates.length} candidates`)
    check(sFrame.claims.length === 1, `claimsOf retains the one owner claim (${sFrame.claims.length})`)
    check(
      picked !== null && picked.level === 'control',
      `the surviving control remains pickable — got ${picked === null ? 'NOTHING' : picked.level}`,
    )
  }

  // ONE WINDOW CAN CONTAIN MANY DIFFERENT CONTROLS.
  //
  // The editor's duplicate guard used only surfaceId, so after one child
  // control was selected every sibling in that same window was treated as the
  // already-annotated object. The second click selected the first box instead
  // of creating a box for the second control.
  console.log('\nTWO DIFFERENT CONTROLS IN THE SAME WINDOW')
  const siblingA = idx.pick(px, py)
  const siblingTarget = els.find((e) => e !== target)
  if (siblingA !== null && siblingTarget !== undefined) {
    const siblingB = idx.pick(
      Math.round(siblingTarget.bounds.x + siblingTarget.bounds.width / 2),
      Math.round(siblingTarget.bounds.y + siblingTarget.bounds.height / 2),
    )
    if (siblingB !== null) {
      const aIdentity = pickIdentityOf(siblingA)
      const bIdentity = pickIdentityOf(siblingB)
      check(
        aIdentity.surfaceId === bIdentity.surfaceId,
        'the fixture really places both controls in the same owner surface',
      )
      check(
        !samePickIdentity(aIdentity, bIdentity),
        'different child objectIds on one surface are not duplicate picks',
      )
      check(
        samePickIdentity(aIdentity, pickIdentityOf(siblingA)),
        'the exact same child remains a duplicate pick',
      )

      // A STATIC-START SOURCE CAN HAVE AN AMBIGUOUS VIDEO↔CONTEXT LATENCY.
      //
      // The displayed frame can therefore contain the control at the bounds
      // from one adjacent *observed* context sample even though the exact
      // ContextFrame resolves that same identity at its next position. The
      // editor may bridge that uncertainty only inside two real video frame
      // intervals, without interpolating, and only while the exact frame proves
      // that the same semantic object is still alive.
      console.log('\nBOUNDED OBSERVED CONTROL PICK FALLBACK')
      const frameIntervalMs = 1000 / 15
      const accuracyAt = (
        requestedTimeMs: number,
        materializedTimeMs = requestedTimeMs,
        coverage: 'covered' | 'before-start' = 'covered',
        interpolated = false,
      ) => ({
        requestedTimeMs,
        materializedTimeMs,
        errorMs: Math.abs(materializedTimeMs - requestedTimeMs),
        exact: requestedTimeMs === materializedTimeMs,
        coverage,
        ...(interpolated ? { interpolated: true } : {}),
      })
      const observed = (
        source: PickableObject,
        requestedTimeMs: number,
        materializedTimeMs = requestedTimeMs,
        interpolated = false,
      ): PickableObject => ({
        ...source,
        candidate: {
          ...source.candidate,
          accuracy: accuracyAt(
            requestedTimeMs,
            materializedTimeMs,
            'covered',
            interpolated,
          ),
        },
      })
      const exactAnchor = observed(siblingA, 1000)
      const priorSameIdentity = observed(siblingA, 933)
      const safeFallback = boundedObservedPickFallback({
        requestedTimeMs: 1000,
        frameIntervalMs,
        exactPointPick: siblingA,
        exactControls: [exactAnchor],
        observations: [
          {
            coverage: 'covered',
            pointPicks: [priorSameIdentity],
          },
        ],
      })
      check(
        safeFallback === null,
        'an exact semantic point hit always wins; fallback never replaces it',
      )
      const adjacentFallback = boundedObservedPickFallback({
        requestedTimeMs: 1000,
        frameIntervalMs,
        exactPointPick: null,
        exactControls: [exactAnchor],
        observations: [
          {
            coverage: 'covered',
            pointPicks: [priorSameIdentity],
          },
        ],
      })
      check(
        adjacentFallback !== null &&
          samePickIdentity(pickIdentityOf(adjacentFallback.picked), aIdentity) &&
          adjacentFallback.observedAtMs === 933,
        `one adjacent observed sample of the same live identity is selectable — got ${
          adjacentFallback === null
            ? 'NOTHING'
            : `${adjacentFallback.picked.candidate.name}@${adjacentFallback.observedAtMs}`
        }`,
      )
      if (wrapperPick !== null) {
        const movedOffPointFallback = boundedObservedPickFallback({
          requestedTimeMs: 1000,
          frameIntervalMs,
          // At the exact context time the target window has moved away. The
          // point now belongs to a different background window, but target A
          // remains alive elsewhere in the same exact frame.
          exactPointPick: wrapperPick,
          exactControls: [exactAnchor],
          observations: [
            {
              coverage: 'covered',
              pointPicks: [priorSameIdentity],
            },
          ],
        })
        check(
          movedOffPointFallback !== null &&
            samePickIdentity(
              pickIdentityOf(movedOffPointFallback.picked),
              aIdentity,
            ) &&
            !samePickIdentity(
              pickIdentityOf(movedOffPointFallback.picked),
              pickIdentityOf(wrapperPick),
            ),
          'a moved-away target is recovered from all exact-frame live identities, not the background window at the point',
        )
      }
      check(
        boundedObservedPickFallback({
          requestedTimeMs: 1000,
          frameIntervalMs,
          exactPointPick: null,
          exactControls: [exactAnchor],
          observations: [
            {
              coverage: 'covered',
              pointPicks: [priorSameIdentity, observed(siblingB, 934)],
            },
          ],
        }) === null,
        'two different semantic identities competing at the point are refused',
      )
      check(
        boundedObservedPickFallback({
          requestedTimeMs: 1000,
          frameIntervalMs,
          exactPointPick: null,
          exactControls: [exactAnchor],
          observations: [
            {
              coverage: 'covered',
              pointPicks: [observed(siblingA, 800)],
            },
          ],
        }) === null,
        'an observation beyond two video frame intervals is refused',
      )
      check(
        boundedObservedPickFallback({
          requestedTimeMs: 1000,
          frameIntervalMs,
          exactPointPick: null,
          exactControls: [exactAnchor],
          observations: [
            {
              coverage: 'before-start',
              pointPicks: [priorSameIdentity],
            },
          ],
        }) === null,
        'a coverage gap is refusal, never permission to borrow another frame',
      )
      check(
        boundedObservedPickFallback({
          requestedTimeMs: 1000,
          frameIntervalMs,
          exactPointPick: null,
          exactControls: [exactAnchor],
          observations: [
            {
              coverage: 'covered',
              pointPicks: [observed(siblingA, 933, 933, true)],
            },
          ],
        }) === null,
        'interpolated geometry is never accepted as an observed fallback',
      )
      check(
        boundedObservedPickFallback({
          requestedTimeMs: 1000,
          frameIntervalMs,
          exactPointPick: null,
          exactControls: [],
          observations: [
            {
              coverage: 'covered',
              pointPicks: [priorSameIdentity],
            },
          ],
        }) === null,
        'an adjacent object outside its exact-frame lifetime is refused',
      )

      const savedUia = storedBox('ann_000001', {
        source: 'uia',
        level: 'control',
        automation_id: siblingA.candidate.identity?.['automation_id'] ?? '',
        control_type: siblingA.candidate.identity?.['control_type'] ?? '',
        name: siblingA.candidate.identity?.['name'] ?? '',
        class_name: siblingA.candidate.identity?.['class_name'] ?? '',
        process: siblingA.candidate.identity?.['process'] ?? '',
      })
      const remembered = new Map([['ann_000001', aIdentity]])
      check(
        existingAnnotationForPick([savedUia], remembered, siblingA, () => true)
          ?.annotation_id === 'ann_000001',
        'the same live child selects its existing box',
      )
      check(
        existingAnnotationForPick([savedUia], remembered, siblingB, () => true)
          === null,
        'a different child in the same window remains a new pick',
      )
      const sameGeometryWindow = storedBox('ann_000005', {
        source: 'uia',
        level: 'window',
        title: 'Same rectangle is not same identity',
        process: 'semantic-app',
        class_name: 'SemanticWindow',
      })
      sameGeometryWindow.bounds = {
        x: siblingA.x,
        y: siblingA.y,
        width: siblingA.width,
        height: siblingA.height,
      }
      check(
        !annotationAlreadyAnnotatesPick(
          sameGeometryWindow,
          new Map(),
          siblingA,
        ),
        'identical geometry does not make a window target equal its child control',
      )
      check(
        pickBeatsBoxPolicy({
          ...largeChildPolicy,
          pickedArea: largeChildPolicy.boxArea,
          alreadyAnnotatesPick: annotationAlreadyAnnotatesPick(
            sameGeometryWindow,
            new Map(),
            siblingA,
          ),
        }),
        'a same-rectangle child still refines a semantic window by level',
      )
      const manualExact: Annotation = {
        ...savedUia,
        bounds: { ...sameGeometryWindow.bounds },
      }
      delete manualExact.target
      check(
        annotationAlreadyAnnotatesPick(manualExact, new Map(), siblingA),
        'a manual box keeps the established same-geometry fallback',
      )
      const reusedAutomationIdSibling: PickableObject = {
        ...siblingB,
        candidate: {
          ...siblingB.candidate,
          identity: siblingA.candidate.identity,
        },
      }
      check(
        existingAnnotationForPick(
          [savedUia],
          remembered,
          reusedAutomationIdSibling,
          () => true,
        ) === null,
        'a live sibling objectId wins over a reused AutomationId',
      )

      // Save/reopen clears the in-memory identity map. The persisted target is
      // the only durable identity available to duplicate prevention.
      const reopened = new Map()
      check(
        existingAnnotationForPick([savedUia], reopened, siblingA, () => true)
          ?.annotation_id === 'ann_000001',
        'after reopen, the same UIA automation target selects its stored box',
      )
      check(
        existingAnnotationForPick([savedUia], reopened, siblingA, () => false)
          === null,
        'a matching target outside its lifetime does not block a new annotation',
      )
      check(
        existingAnnotationForPick([savedUia], reopened, siblingB, () => true)
          === null,
        'after reopen, a different UIA target creates a new pick',
      )
      const weakUia = storedBox('ann_000002', {
        source: 'uia',
        level: 'control',
        name: siblingA.candidate.identity?.['name'] ?? 'Save',
      })
      check(
        existingAnnotationForPick([weakUia], reopened, siblingA, () => true)
          === null,
        'a descriptive UIA label without AutomationId is not treated as identity',
      )

      const domPick: PickableObject = {
        ...siblingA,
        providerId: 'chrome-dom',
        candidate: {
          ...siblingA.candidate,
          providerId: 'chrome-dom',
          objectId: 'dom:save-button',
        },
      }
      const savedDom = storedBox('ann_000003', {
        source: 'chrome-dom',
        level: 'control',
        object_id: 'dom:save-button',
      })
      check(
        existingAnnotationForPick([savedDom], reopened, domPick, () => true)
          ?.annotation_id === 'ann_000003',
        'after reopen, a provider object_id selects its stored box',
      )
      check(
        existingAnnotationForPick(
          [savedDom],
          reopened,
          {
            ...domPick,
            candidate: {
              ...domPick.candidate,
              objectId: 'dom:other-button',
            },
          },
          () => true,
        ) === null,
        'after reopen, a different provider object_id remains a new pick',
      )

      const pickedWindow = wrapperPick
      if (pickedWindow !== null) {
        const savedWindow = storedBox('ann_000004', {
          source: 'uia',
          level: 'window',
          title: pickedWindow.candidate.identity?.['title'] ?? '',
          process: pickedWindow.candidate.identity?.['process'] ?? '',
          class_name: pickedWindow.candidate.identity?.['class_name'] ?? '',
        })
        check(
          existingAnnotationForPick(
            [savedWindow],
            reopened,
            pickedWindow,
            () => true,
          )?.annotation_id === 'ann_000004',
          'after reopen, the same complete UIA window target selects its stored box',
        )
        const otherWindow: PickableObject = {
          ...pickedWindow,
          surfaceId: 'another-window-surface',
          candidate: {
            ...pickedWindow.candidate,
            surfaceId: 'another-window-surface',
            objectId: 'another-window',
            identity: {
              ...pickedWindow.candidate.identity,
              title: 'Another window',
              process: 'another-app',
              class_name: 'AnotherWindow',
            },
          },
        }
        check(
          existingAnnotationForPick(
            [savedWindow],
            reopened,
            otherWindow,
            () => true,
          ) === null,
          'after reopen, another window remains a new pick',
        )
      }
    }
  }

  console.log(failed === 0 ? '\ncontrol-pick-check ok' : `\ncontrol-pick-check FAILED (${failed})`)
  process.exitCode = failed === 0 ? 0 : 1
}

void main()
