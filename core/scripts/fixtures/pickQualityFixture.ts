// THE PICK-QUALITY FIXTURE (#134): the #58 container shape, written out as a
// real pack folder.
//
// WHY A PACK ON DISK AND NOT AN IN-MEMORY OBSERVATION. The measurement it feeds
// is only worth anything if it goes through the same door a user's pack goes
// through — manifest, plugins/windows-uia/elements.json, the snapshot raster,
// `readPackObjectContext`. A fixture handed straight to ObjectIndex would keep
// passing while the pack reader rotted, which is precisely the class of bug
// ("the data is there, the answer is useless") this whole check exists for.
//
// WHAT IT CONTAINS, and why each piece is there:
//
//   - a 1920x1080 window with an anonymous `Pane` covering 1600x740 of it —
//     55.4% of the window, which is the SAME ratio measured on the real capture
//     in issue #58 (1.58 Mpx of a 2.87 Mpx window). This is the rectangle that
//     was being offered to every hover inside that window. It must be dropped
//     by the frame filter and never reach the control level.
//   - one 240x40 toolbar and one 24x24 button inside it: a real target at the
//     smallest size the sweep can see, so "everything is filtered" cannot pass
//     as a fix.
//   - a second, small dialog window with no controls at all, so the window rung
//     is exercised as the honest floor it is.
//
// It is deliberately NOT a sample of picking quality — nothing synthetic can
// be. It is a regression shape, and the number it produces moves by a factor of
// ~40 between a filtered and an unfiltered client-area pane.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { greyPng } from './greyPng'

const WIDTH = 1920
const HEIGHT = 1080

const manifest = {
  format: 'capturepack',
  format_version: '0.7.0',
  capture_kind: 'image',
  id: 'pick-quality-fixture',
  created_at: '2026-08-02T00:00:00+09:00',
  generator: { name: 'capturepack', version: '0.0.0-check' },
  environment: {
    os: 'windows',
    os_version: '10.0.26200',
    screens: [{ width: WIDTH, height: HEIGHT, scale: 1 }],
  },
  media: {
    snapshot: 'snapshot.png',
    replay: null,
    image_scope: 'fullscreen',
  },
  plugins: [{ name: 'windows-uia', version: '0.4.0', path: 'plugins/windows-uia/' }],
}

const elements = {
  captured_at: '2026-08-02T00:00:00+09:00',
  budget_ms: 3000,
  truncated: false,
  windows: [
    {
      hwnd: '4001',
      title: 'Fixture app',
      process: 'fixture.exe',
      class_name: 'FixtureWindow',
      bounds: { x: 160, y: 120, width: 1600, height: 800 },
      focused: true,
      z: 0,
      tree: 'collected',
      element_count: 4,
    },
    {
      hwnd: '4002',
      title: 'Fixture dialog',
      process: 'fixture.exe',
      class_name: '#32770',
      bounds: { x: 1400, y: 780, width: 420, height: 240 },
      focused: false,
      z: 1,
      tree: 'skipped',
      element_count: 0,
    },
  ],
  elements: [
    // The client-area pane: 1600x740 of a 1600x800 window = 92.5% of it. This
    // is #58's rectangle. Offered, it swallows every hover inside the window.
    {
      name: '',
      control_type: 'Pane',
      automation_id: '',
      class_name: 'FixtureClient',
      bounds: { x: 160, y: 180, width: 1600, height: 740 },
      depth: 0,
      window: 0,
    },
    // ...and a half-window container inside it, at exactly the ratio measured
    // in #58 (55% of its window): the shape that clears a 0.95 threshold and
    // fails a 0.35 one.
    //
    // DELIBERATELY NOT FULL-WIDTH. A container that spans ~all of one axis is
    // caught by WINDOW_FRAME_SIDE_FRACTION whatever the area rule says, so a
    // full-width pane here would keep passing with the area test disabled and
    // the fixture would prove nothing about it. 1180x600 is 55.3% of its
    // window's area on 73.8% of its width and 75% of its height: under every
    // other guard, and over WINDOW_FRAME_FRACTION alone.
    {
      name: '',
      control_type: 'Pane',
      automation_id: '',
      class_name: 'FixtureContent',
      bounds: { x: 300, y: 280, width: 1180, height: 600 },
      depth: 1,
      window: 0,
    },
    {
      name: 'Toolbar',
      control_type: 'ToolBar',
      automation_id: 'fixture-toolbar',
      class_name: 'FixtureToolbar',
      bounds: { x: 180, y: 200, width: 1560, height: 40 },
      depth: 2,
      window: 0,
    },
    {
      name: 'Save',
      control_type: 'Button',
      automation_id: 'fixture-save',
      class_name: 'FixtureButton',
      bounds: { x: 200, y: 208, width: 24, height: 24 },
      depth: 3,
      window: 0,
    },
    {
      name: 'Sidebar item',
      control_type: 'ListItem',
      automation_id: 'fixture-list-item',
      class_name: 'FixtureItem',
      bounds: { x: 200, y: 300, width: 260, height: 36 },
      depth: 3,
      window: 0,
    },
  ],
}

/**
 * Writes the fixture pack into a fresh temp folder and returns its path.
 *
 * A temp folder rather than a committed one because the pack is generated
 * evidence, not evidence: regenerating it every run is what keeps the fixture
 * and the writer above it from disagreeing, and it keeps a 2 KB PNG out of git.
 */
export function writeFixturePack(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'capturepack-pick-quality-'))
  mkdirSync(path.join(dir, 'plugins', 'windows-uia'), { recursive: true })
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  writeFileSync(path.join(dir, 'snapshot.png'), greyPng(WIDTH, HEIGHT))
  writeFileSync(
    path.join(dir, 'plugins', 'windows-uia', 'meta.json'),
    JSON.stringify({ name: 'windows-uia', version: '0.4.0' }, null, 2),
  )
  writeFileSync(
    path.join(dir, 'plugins', 'windows-uia', 'elements.json'),
    JSON.stringify(elements, null, 2),
  )
  writeFileSync(path.join(dir, 'annotations.json'), JSON.stringify({ annotations: [] }, null, 2))
  return dir
}
