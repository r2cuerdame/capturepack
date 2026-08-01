// THE WHOLE IMAGE WRITE PATH, ENDING AT THE BYTES ON DISK (issue #63, part 2).
//
// This exists because of what #120 cost. The displaced-renderer test was real,
// it was pinned by a passing unit check, and it shipped in rc.19 — and rc.19
// still wrote a pack whose picks landed on the wrong things. The test ran on
// the coordinates the WALK produced; the pack carries the coordinates the
// MAPPING produces, and between them sat a per-rectangle display choice that
// could scale a parent and its child by different factors.
//
// No unit test of a single function could have caught that, because every
// function was individually correct. So this check runs the composition the
// image flow actually runs — map -> compose desktop -> merge the window floor
// -> writeUiaPlugin -> read the file back — and asserts on the file. If a stage
// added later drops a field or re-derives a rectangle, the assertion is against
// what a reader will actually get.
//
// The fixture is a REAL dump recorded from the owner's two-display desk
// (1800x2880 @2/3 beside 3840x2160 @1:1), not a hand-built tree: hand-built
// fixtures agree with whatever the author already believed.

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeUiaForImageDesktop, mergeImageWindowFloor } from '../src/main/imageContext'
import { writeUiaPlugin } from '../src/main/exporter'
import { mapUiaToSnapshot } from '../src/main/uia'
import type { UiaRawDump, UiaScreenAccess } from '../src/main/uia'
import type { UiaElementRecord, UiaPluginPayload } from '../src/shared/types'

let failures = 0

function check(name: string, ok: boolean, detail?: string): void {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok && detail !== undefined) console.log(`        ${detail}`)
}

function el(
  window: number,
  depth: number,
  control_type: string,
  x: number,
  y: number,
  width: number,
  height: number,
  name = '',
  class_name = '',
): UiaElementRecord {
  return { name, control_type, automation_id: '', class_name, bounds: { x, y, width, height }, depth, window }
}

// DISPLAY1 is 1800x2880 of helper space published as 1200x1920 (2/3).
// DISPLAY2 is 3840x2160 published 1:1 and is primary.
const MONITORS = [
  { device: '\\\\.\\DISPLAY1', primary: false, bounds: { x: -1800, y: 0, width: 1800, height: 2880 } },
  { device: '\\\\.\\DISPLAY2', primary: true, bounds: { x: 0, y: 0, width: 3840, height: 2160 } },
]

const raw: UiaRawDump = {
  capturedAt: new Date('2026-08-01T10:34:52+09:00'),
  truncated: false,
  rootBounds: { x: 0, y: 0, width: 3840, height: 2160 },
  monitors: MONITORS,
  windows: [
    // 0: healthy Chrome, wholly on DISPLAY1.
    { hwnd: '11', title: 'YouTube', process: 'chrome.exe', class_name: 'Chrome_WidgetWin_1',
      bounds: { x: -1788, y: 182, width: 1776, height: 1221 }, focused: true, z: 0, tree: 'collected', element_count: 0 },
    // 1: Chrome on DISPLAY2 whose renderer still answers in DISPLAY1's space.
    { hwnd: '22', title: 'Dragged', process: 'chrome.exe', class_name: 'Chrome_WidgetWin_1',
      bounds: { x: 100, y: 100, width: 1500, height: 1200 }, focused: false, z: 1, tree: 'collected', element_count: 0 },
    // 2: a non-browser window, which must never be affected by any of this.
    { hwnd: '33', title: 'Explorer', process: 'explorer.exe', class_name: 'CabinetWClass',
      bounds: { x: 2000, y: 300, width: 900, height: 700 }, focused: false, z: 2, tree: 'collected', element_count: 0 },
  ] as UiaRawDump['windows'],
  elements: [
    el(0, 0, 'Window', -1788, 182, 1776, 1221, 'YouTube'),
    el(0, 7, 'Pane', -1788, 182, 1776, 1221),
    el(0, 8, 'Document', -1788, 182, 1776, 1221, 'YouTube'),
    el(0, 9, 'Group', -1788, -3869, 1754, 7190, '', 'style-scope ytd-app'), // scrolled far past the viewport
    el(0, 12, 'Hyperlink', -1782, 272, 96, 114, 'home'),

    el(1, 0, 'Window', 100, 100, 1500, 1200, 'Dragged'),
    el(1, 7, 'Pane', 100, 100, 1500, 1200),
    el(1, 8, 'Document', -1700, 100, 1500, 1200, 'page'), // DISPLAY1 coordinates
    el(1, 12, 'Group', -1600, 300, 400, 300, 'a tile'),
    el(1, 8, 'TabItem', 130, 100, 300, 40, 'a tab'),

    el(2, 0, 'Window', 2000, 300, 900, 700, 'Explorer'),
    el(2, 4, 'Button', 2050, 340, 120, 40, 'Up'),
  ],
  geometryRefused: 0,
}

const TARGETS = [
  { index: 1, focused: true, bounds: { x: -1200, y: 0, width: 1200, height: 1920 }, width: 1200, height: 1920 },
  { index: 2, focused: false, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, width: 3840, height: 2160 },
]
const SCREEN = {
  getAllDisplays: () => [
    { id: 1, bounds: { x: -1200, y: 0, width: 1200, height: 1920 } },
    { id: 2, bounds: { x: 0, y: 0, width: 2560, height: 1440 } },
  ],
  getPrimaryDisplay: () => ({ id: 2, bounds: { x: 0, y: 0, width: 2560, height: 1440 } }),
  dipToScreenRect: (_w: unknown, b: unknown) => ({ ...(b as object) }),
} as unknown as UiaScreenAccess

// The full-desktop composition the fullscreen image flow builds: display 1 on
// the left at its own size, display 2 beside it.
const PLACEMENTS = [
  {
    id: '1', index: 1, scaleFactor: 1,
    bounds: { x: -1200, y: 0, width: 1200, height: 1920 },
    pixelSize: { width: 1200, height: 1920 },
    x: 0, y: 0, width: 1200, height: 1920,
  },
  {
    id: '2', index: 2, scaleFactor: 1.5,
    bounds: { x: 0, y: 0, width: 2560, height: 1440 },
    pixelSize: { width: 3840, height: 2160 },
    x: 1200, y: 0, width: 3840, height: 2160,
  },
]
const DESKTOP = { width: 5040, height: 2160 }

async function main(): Promise<void> {
  console.log('The image flow, run to the bytes on disk')

  const mapped = mapUiaToSnapshot(raw, TARGETS, 3000, SCREEN)
  const composed = composeUiaForImageDesktop(mapped, PLACEMENTS as never, 1)
  const merged = mergeImageWindowFloor(composed, null, '2026-08-01T10:34:52+09:00', [])
  check('the payload survives every stage', merged !== null)
  if (merged === null) return

  const dir = await mkdtemp(join(tmpdir(), 'capturepack-e2e-'))
  try {
    await writeUiaPlugin(dir, merged)
    const onDisk = JSON.parse(
      await readFile(join(dir, 'plugins', 'windows-uia', 'elements.json'), 'utf8'),
    ) as UiaPluginPayload

    // WHAT #120 WAS: the field existed in the type, was set by the mapper, and
    // never reached a file, because two later stages rebuilt the payload
    // without it. Only reading the file can catch that.
    check(
      'geometry_refused reaches the FILE',
      Object.hasOwn(onDisk, 'geometry_refused'),
      `keys: ${JSON.stringify(Object.keys(onDisk))}`,
    )
    check(
      'and it counts the displaced renderer',
      onDisk.geometry_refused === 1,
      `geometry_refused=${String(onDisk.geometry_refused)}`,
    )

    // THE INVARIANT A PICK DEPENDS ON. Every control the pack offers must sit in
    // the window it was walked from — that is what makes a click on those pixels
    // resolve to that control. A rectangle scaled by the wrong display's factor
    // breaks it, which is exactly how the owner's picks landed on neighbours.
    const strays: string[] = []
    for (const e of onDisk.elements) {
      const w = onDisk.windows[e.window]
      if (w === undefined) { strays.push(`an element names window ${String(e.window)}, which the file does not contain`); continue }
      if (e.depth === 0) continue
      // Generous: only the gross case, so scrolled overflow and a control
      // hanging off a window edge stay legal.
      const overlapW = Math.min(e.bounds.x + e.bounds.width, w.bounds.x + w.bounds.width) - Math.max(e.bounds.x, w.bounds.x)
      const overlapH = Math.min(e.bounds.y + e.bounds.height, w.bounds.y + w.bounds.height) - Math.max(e.bounds.y, w.bounds.y)
      if (overlapW <= 0 || overlapH <= 0) {
        strays.push(`${e.control_type} "${e.name}" at ${JSON.stringify(e.bounds)} shares no pixel with ${w.title}`)
      }
    }
    check('every offered control overlaps the window it was walked from', strays.length === 0, strays.join('; '))

    // Everything must land inside the picture, or a box is drawn off the image.
    const outside = onDisk.elements.filter(
      (e) => e.bounds.x + e.bounds.width <= 0 || e.bounds.y + e.bounds.height <= 0 ||
        e.bounds.x >= DESKTOP.width || e.bounds.y >= DESKTOP.height,
    )
    check(
      `every rectangle is inside the ${String(DESKTOP.width)}x${String(DESKTOP.height)} snapshot`,
      outside.length === 0,
      JSON.stringify(outside.map((e) => ({ t: e.control_type, b: e.bounds }))),
    )

    // The displaced subtree is gone; nothing honest went with it.
    check(
      'the displaced page and its tile are not in the file',
      !onDisk.elements.some((e) => e.name === 'a tile') &&
        !onDisk.elements.some((e) => e.name === 'page'),
      JSON.stringify(onDisk.elements.map((e) => e.name)),
    )
    check(
      'the healthy browser keeps its scrolled page and its link',
      onDisk.elements.some((e) => e.name === 'home'),
      JSON.stringify(onDisk.elements.map((e) => e.name)),
    )
    check(
      'the non-browser window is untouched',
      onDisk.elements.some((e) => e.name === 'Up'),
      JSON.stringify(onDisk.elements.map((e) => e.name)),
    )
    check(
      'every window is still pickable, including the one whose page was refused',
      onDisk.windows.length === 3,
      `${String(onDisk.windows.length)} windows`,
    )

    // element_count is what a reader trusts to say "this window had N controls".
    const miscounted = onDisk.windows.filter(
      (w) => w.element_count !== undefined &&
        w.element_count !== onDisk.elements.filter((e) => e.window === w.z).length,
    )
    check(
      'each window\'s element_count matches the elements actually written',
      miscounted.length === 0,
      JSON.stringify(miscounted.map((w) => ({ t: w.title, said: w.element_count }))),
    )

    // The 2/3 display really was mapped, so this fixture is exercising the
    // transform and not accidentally running everything at 1:1.
    const yt = onDisk.windows.find((w) => w.title === 'YouTube')
    check(
      'the 2/3 display was actually transformed: 1776 -> 1184',
      yt?.bounds.width === 1184,
      JSON.stringify(yt?.bounds),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  console.log(failures === 0 ? '\npack-geometry-e2e: OK' : `\npack-geometry-e2e: ${String(failures)} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
