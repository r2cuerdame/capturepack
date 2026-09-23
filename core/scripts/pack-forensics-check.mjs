import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectPack } from './pack-forensics.mjs'

const temporaryRoot = mkdtempSync(join(tmpdir(), 'capturepack-pack-qa-'))
let checks = 0

function check(message, condition) {
  checks += 1
  assert.ok(condition, message)
  console.log(`  PASS ${message}`)
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function pngHeader(width, height) {
  const bytes = Buffer.alloc(24)
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes, 0)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

function makePack(name, annotationBounds = { x: 10, y: 10, width: 50, height: 20 }) {
  const root = join(temporaryRoot, name)
  mkdirSync(join(root, 'skills'), { recursive: true })
  mkdirSync(join(root, 'plugins', 'windows-uia'), { recursive: true })
  writeFileSync(join(root, 'README.md'), '# fixture\n', 'utf8')
  writeFileSync(join(root, 'report.md'), '# report\n', 'utf8')
  writeFileSync(join(root, 'skills', 'overview.md'), '# overview\n', 'utf8')
  writeFileSync(join(root, 'snapshot.png'), pngHeader(1_000, 800))
  writeJson(join(root, 'timeline.json'), { events: [] })
  writeJson(join(root, 'manifest.json'), {
    format: 'capturepack',
    format_version: '0.3.0',
    id: `qa-${name}`,
    generator: { name: 'pack-forensics-check', version: '1' },
    environment: { screens: [{ width: 1_000, height: 800, scale: 1 }] },
    media: {
      snapshot: 'snapshot.png',
      replay: null,
      replay_duration_ms: null,
    },
    plugins: [{ name: 'windows-uia', path: 'plugins/windows-uia/' }],
  })
  writeJson(join(root, 'annotations.json'), {
    reference_width: 1_000,
    reference_height: 800,
    annotations: [{
      annotation_id: 'ann_qa0001',
      type: 'box',
      bounds: annotationBounds,
      text: 'Save',
      numbered: false,
      blur: false,
      tracking: { enabled: true },
      target: {
        source: 'uia',
        level: 'control',
        name: 'Save',
        control_type: 'Button',
        automation_id: 'save-button',
        process: 'fixture.exe',
      },
      created_at: '2026-07-29T00:00:00.000Z',
      z: 1,
    }],
  })
  writeJson(join(root, 'plugins', 'windows-uia', 'elements.json'), {
    captured_at: '2026-07-29T00:00:00.000Z',
    windows: [{
      hwnd: '1',
      title: 'Fixture',
      process: 'fixture',
      class_name: 'FixtureWindow',
      bounds: { x: 0, y: 0, width: 1_000, height: 800 },
      z: 1,
      tree: 'collected',
    }],
    elements: [{
      name: 'Save',
      control_type: 'Button',
      automation_id: 'save-button',
      class_name: 'Button',
      bounds: { x: 10, y: 10, width: 50, height: 20 },
      depth: 1,
      window: 1,
    }],
  })
  return root
}

function makeMultiDisplayPack(name) {
  const root = makePack(name)
  writeFileSync(join(root, 'snapshot-d1.png'), pngHeader(1_200, 1_920))
  writeFileSync(join(root, 'snapshot.png'), pngHeader(3_840, 2_160))
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
  manifest.environment.screens = [
    { width: 1_200, height: 1_920, scale: 1 },
    { width: 3_840, height: 2_160, scale: 1.5 },
  ]
  manifest.media.displays = [
    {
      index: 1,
      snapshot: 'snapshot-d1.png',
      replay: null,
      replay_duration_ms: null,
      bounds: { x: -1_200, y: 0, width: 1_200, height: 1_920 },
      scale: 1,
      focused: false,
    },
    {
      index: 2,
      snapshot: 'snapshot.png',
      replay: null,
      replay_duration_ms: null,
      bounds: { x: 0, y: 0, width: 2_560, height: 1_440 },
      scale: 1.5,
      focused: true,
    },
  ]
  writeJson(join(root, 'manifest.json'), manifest)
  const annotations = JSON.parse(readFileSync(join(root, 'annotations.json'), 'utf8'))
  annotations.reference_width = 3_840
  annotations.reference_height = 2_160
  writeJson(join(root, 'annotations.json'), annotations)
  return root
}

function makeGoogleButtonPack(name, annotationBounds, elementDisplay = 1) {
  const root = makeMultiDisplayPack(name)
  const annotations = JSON.parse(readFileSync(join(root, 'annotations.json'), 'utf8'))
  annotations.annotations[0] = {
    annotation_id: 'ann_2171f2',
    type: 'box',
    bounds: annotationBounds,
    display: 1,
    text: 'Google에 물어보기',
    numbered: false,
    blur: false,
    tracking: {
      enabled: true,
      picked_at_ms: 25_554,
      // The first recorded observation is the nearest one in the real pack too.
      samples: [{ t_ms: 25_663, ...annotationBounds }],
    },
    target: {
      source: 'uia',
      level: 'control',
      name: 'Google에 물어보기',
      control_type: 'Button',
      class_name: 'PageActionView',
      process: 'chrome.exe',
    },
    created_at: '2026-07-29T13:36:59.378Z',
    z: 3,
  }
  writeJson(join(root, 'annotations.json'), annotations)

  writeJson(join(root, 'plugins', 'windows-uia', 'elements.json'), {
    captured_at: '2026-07-29T22:35:19+09:00',
    windows: [{
      hwnd: '918516',
      title: 'Issues · r2cuerdame/capturepack - Chrome',
      process: 'chrome',
      class_name: 'Chrome_WidgetWin_1',
      bounds: { x: -8, y: -8, width: 1_216, height: 1_888 },
      focused: false,
      z: 3,
      tree: 'collected',
      element_count: 1,
      display: elementDisplay,
    }],
    elements: [{
      name: 'Google에 물어보기',
      control_type: 'Button',
      automation_id: '',
      class_name: 'PageActionView',
      bounds: { x: 620, y: 51, width: 153, height: 24 },
      depth: 9,
      window: 3,
      display: elementDisplay,
    }],
  })
  return root
}

try {
  console.log('pack forensics regression')

  const validPack = makePack('valid')
  const valid = inspectPack(validPack)
  check('a structurally valid pack has no errors', valid.counts.errors === 0)
  check('a control-sized annotation does not resemble its owner window',
    valid.metrics.owner_window_bound_contradictions === 0)
  check('non-strict clean pack passes', valid.gate_status === 'passed')

  const imagePack = makePack('still-image')
  const imageManifest = JSON.parse(readFileSync(join(imagePack, 'manifest.json'), 'utf8'))
  imageManifest.capture_kind = 'image'
  imageManifest.media.image_scope = 'region'
  imageManifest.media.crop_bounds = {
    x: 10,
    y: 10,
    width: 1_000,
    height: 800,
    coordinate_space: 'virtual-desktop-dip',
  }
  writeJson(join(imagePack, 'manifest.json'), imageManifest)
  rmSync(join(imagePack, 'timeline.json'), { force: true })
  const stillImage = inspectPack(imagePack, { strict: true })
  check('a still-image pack is complete without timeline.json',
    !stillImage.findings.some((finding) => finding.code === 'required_file_missing'))
  check('a situational still-image pack passes the strict forensic gate',
    stillImage.gate_status === 'passed')

  writeJson(join(imagePack, 'timeline.json'), { events: [] })
  const imageWithTimeline = inspectPack(imagePack, { strict: true })
  check('a still-image pack with a top-level timeline is rejected',
    imageWithTimeline.findings.some((finding) => finding.code === 'image_timeline_present'))

  const legacyPack = makePack('legacy-owner-bounds', { x: 0, y: 0, width: 1_000, height: 800 })
  const legacy = inspectPack(legacyPack)
  check('the rc.36 owner-window/control contradiction is detected',
    legacy.findings.some((finding) => finding.code === 'control_matches_owner_window_bounds'))
  check('legacy forensic findings remain non-gating by default', legacy.gate_status === 'passed')
  const legacyStrict = inspectPack(legacyPack, { strict: true })
  check('strict mode gates the same contradiction', legacyStrict.gate_status === 'failed')
  check('the proven owner-window contradiction is marked as gating evidence',
    legacyStrict.findings.some((finding) =>
      finding.code === 'control_matches_owner_window_bounds' && finding.gating === true))

  const staleControlPack = makePack('stale-control')
  const staleAnnotations = JSON.parse(
    readFileSync(join(staleControlPack, 'annotations.json'), 'utf8'),
  )
  staleAnnotations.annotations[0].target.automation_id = 'control-that-no-longer-exists'
  writeJson(join(staleControlPack, 'annotations.json'), staleAnnotations)
  const staleControl = inspectPack(staleControlPack, { strict: true })
  check('an unmatched historical control remains diagnostic in strict mode',
    staleControl.findings.some((finding) =>
      finding.code === 'control_target_not_found' && finding.gating === false))
  check('missing optional capture-instant evidence does not reject an otherwise valid RC pack',
    staleControl.gate_status === 'passed')

  // Distilled verbatim from CapturePack_2026-07-29_223519 (rc.37): display 1
  // is the 1200x1920 1x monitor at virtual x=-1200, while display 2 is the
  // 3840x2160 1.5x primary. The picked control was saved as 230x36, exactly
  // 1.5x its UIA evidence (153x24). Keeping the field numbers in a synthetic
  // pack makes this deterministic in CI without copying the owner's capture.
  const googlePack = makeGoogleButtonPack(
    'google-button-scale-contradiction',
    { x: 330, y: 77, width: 230, height: 36 },
  )
  const google = inspectPack(googlePack, { strict: true })
  const googleContradiction = google.findings.find((finding) =>
    finding.code === 'control_target_geometry_contradiction')
  check('ann_2171f2 target-vs-plugin geometry contradiction is detected',
    googleContradiction !== undefined)
  check('the contradiction records the exact picked and plugin rectangles',
    googleContradiction?.detail?.geometry_source === 'tracking.samples[0]'
      && googleContradiction.detail.geometry_display === 1
      && googleContradiction.detail.picked_at_ms === 25_554
      && googleContradiction.detail.geometry_t_ms === 25_663
      && googleContradiction.detail.annotation_bounds.width === 230
      && googleContradiction.detail.matched_element_bounds.width === 153)
  check('strict mode gates the ann_2171f2 semantic geometry contradiction',
    google.gate_status === 'failed')

  const exactGooglePack = makeGoogleButtonPack(
    'google-button-exact',
    { x: 620, y: 51, width: 153, height: 24 },
  )
  const exactGoogle = inspectPack(exactGooglePack, { strict: true })
  check('the corrected _223519 control geometry is clean in strict mode',
    !exactGoogle.findings.some((finding) =>
      finding.code === 'control_target_geometry_contradiction'))
  check('the corrected _223519 shape passes the strict pack gate',
    exactGoogle.gate_status === 'passed')

  const movedPack = makeGoogleButtonPack(
    'google-button-window-moved',
    { x: 330, y: 77, width: 153, height: 24 },
  )
  const moved = inspectPack(movedPack, { strict: true })
  check('same-display window translation is not a geometry contradiction',
    !moved.findings.some((finding) =>
      finding.code === 'control_target_geometry_contradiction'))
  check('legitimate movement remains non-gating in strict mode',
    moved.gate_status === 'passed')

  const otherDisplayPack = makeGoogleButtonPack(
    'google-button-other-display',
    { x: 330, y: 77, width: 230, height: 36 },
    2,
  )
  const otherDisplay = inspectPack(otherDisplayPack, { strict: true })
  check('an identical semantic target on another display is not compared',
    !otherDisplay.findings.some((finding) =>
      finding.code === 'control_target_geometry_contradiction'))
  check('cross-display movement still matches the semantic target without a stale-target warning',
    !otherDisplay.findings.some((finding) =>
      finding.code === 'control_target_not_found'))

  const mixedKeyframePack = makeMultiDisplayPack('mixed-display-keyframe')
  const mixedKeyframeAnnotations = JSON.parse(
    readFileSync(join(mixedKeyframePack, 'annotations.json'), 'utf8'),
  )
  mixedKeyframeAnnotations.annotations[0].keyframes = [
    { t_ms: 0, x: 10, y: 10, width: 50, height: 20 },
    {
      t_ms: 1,
      display: 1,
      x: 1_100,
      y: 1_800,
      width: 50,
      height: 50,
    },
  ]
  writeJson(join(mixedKeyframePack, 'annotations.json'), mixedKeyframeAnnotations)
  const mixedKeyframe = inspectPack(mixedKeyframePack, { strict: true })
  check('a mixed-display authored keyframe is checked in its own display geometry',
    !mixedKeyframe.findings.some((finding) =>
      finding.code === 'annotation_bounds_outside_snapshot'
      && finding.detail?.bounds?.x === 1_100))
  check('a declared mixed-display authored keyframe passes strict mode',
    mixedKeyframe.gate_status === 'passed')

  const invalidClockPack = makeMultiDisplayPack('invalid-display-clock')
  const invalidClockManifest = JSON.parse(
    readFileSync(join(invalidClockPack, 'manifest.json'), 'utf8'),
  )
  writeFileSync(join(invalidClockPack, 'replay.webm'), Buffer.alloc(0))
  writeFileSync(join(invalidClockPack, 'replay-d1.webm'), Buffer.alloc(0))
  invalidClockManifest.media.replay = 'replay.webm'
  invalidClockManifest.media.replay_duration_ms = 1_000
  invalidClockManifest.media.displays[0].replay = 'replay-d1.webm'
  invalidClockManifest.media.displays[0].replay_duration_ms = 975
  invalidClockManifest.media.displays[0].replay_clock_offset_ms = 12.5
  invalidClockManifest.media.displays[1].replay = 'replay.webm'
  invalidClockManifest.media.displays[1].replay_duration_ms = 1_000
  invalidClockManifest.media.displays[1].replay_clock_offset_ms = 7
  writeJson(join(invalidClockPack, 'manifest.json'), invalidClockManifest)
  const invalidClock = inspectPack(invalidClockPack, { strict: true })
  check('a persisted display clock must use integer milliseconds',
    invalidClock.findings.some((finding) =>
      finding.code === 'replay_clock_offset_invalid'))
  check('the focused display clock must remain zero',
    invalidClock.findings.some((finding) =>
      finding.code === 'focused_replay_clock_nonzero'))
  check('invalid per-display clocks gate strict mode',
    invalidClock.gate_status === 'failed')

  const replaylessClockPack = makeMultiDisplayPack('replayless-display-clock')
  const replaylessClockManifest = JSON.parse(
    readFileSync(join(replaylessClockPack, 'manifest.json'), 'utf8'),
  )
  replaylessClockManifest.media.displays[0].replay_clock_offset_ms = 10
  writeJson(join(replaylessClockPack, 'manifest.json'), replaylessClockManifest)
  const replaylessClock = inspectPack(replaylessClockPack, { strict: true })
  check('a display without replay cannot declare a replay clock',
    replaylessClock.findings.some((finding) =>
      finding.code === 'replay_clock_without_replay'))

  const invalidKeyframePack = makeMultiDisplayPack('invalid-keyframe-display')
  const invalidKeyframeAnnotations = JSON.parse(
    readFileSync(join(invalidKeyframePack, 'annotations.json'), 'utf8'),
  )
  invalidKeyframeAnnotations.annotations[0].keyframes = [{
    t_ms: 0,
    display: 3,
    x: 10,
    y: 10,
    width: 50,
    height: 20,
  }, {
    t_ms: 1,
    display: 1.5,
    x: 10,
    y: 10,
    width: 50,
    height: 20,
  }]
  writeJson(join(invalidKeyframePack, 'annotations.json'), invalidKeyframeAnnotations)
  const invalidKeyframe = inspectPack(invalidKeyframePack, { strict: true })
  check('an undeclared authored keyframe display is rejected',
    invalidKeyframe.findings.some((finding) =>
      finding.code === 'annotation_keyframe_display_unknown'))
  check('a non-integer authored keyframe display is rejected',
    invalidKeyframe.findings.some((finding) =>
      finding.code === 'annotation_keyframe_display_invalid'))
  check('invalid authored keyframe displays gate strict mode',
    invalidKeyframe.gate_status === 'failed')

  const latePack = makePack('late-annotation')
  writeFileSync(join(latePack, 'replay.mp4'), Buffer.alloc(0))
  const lateManifest = JSON.parse(readFileSync(join(latePack, 'manifest.json'), 'utf8'))
  lateManifest.media.replay = 'replay.mp4'
  lateManifest.media.replay_duration_ms = 1_000
  writeJson(join(latePack, 'manifest.json'), lateManifest)
  const lateAnnotations = JSON.parse(readFileSync(join(latePack, 'annotations.json'), 'utf8'))
  lateAnnotations.annotations[0].start_ms = 900
  lateAnnotations.annotations[0].end_ms = 1_200
  writeJson(join(latePack, 'annotations.json'), lateAnnotations)
  const late = inspectPack(latePack, { strict: true })
  check('annotation times after the declared replay are rejected',
    late.findings.some((finding) => finding.code === 'annotation_time_after_replay'))
  check('timeline schema errors gate in strict mode', late.gate_status === 'failed')

  const stalePluginDocsPack = makePack('stale-plugin-docs')
  writeFileSync(
    join(stalePluginDocsPack, 'skills', 'dom.md'),
    'No plugin contributed semantic object data (there is no `plugins/` payload).',
    'utf8',
  )
  writeFileSync(
    join(stalePluginDocsPack, 'skills', 'overview.md'),
    '# overview\n\nCounts: one annotation box, 0 timeline events, 0 plugins.\n',
    'utf8',
  )
  const stalePluginDocs = inspectPack(stalePluginDocsPack, { strict: true })
  check('a generated document cannot deny a manifest-declared plugin',
    stalePluginDocs.findings.some((finding) =>
      finding.code === 'generated_docs_plugin_contradiction'))
  check('a manifest/document plugin contradiction gates strict pack QA',
    stalePluginDocs.gate_status === 'failed')

  const omittedViewsPack = makePack('omitted-views')
  rmSync(join(omittedViewsPack, 'README.md'), { force: true })
  rmSync(join(omittedViewsPack, 'report.md'), { force: true })
  rmSync(join(omittedViewsPack, 'skills'), { recursive: true, force: true })
  const omittedViews = inspectPack(omittedViewsPack, { strict: true })
  check('a pack omitting optional README.md, report.md, and skills/ passes strict QA',
    omittedViews.gate_status === 'passed')
  check('omitting README.md does not emit required_file_missing',
    !omittedViews.findings.some((f) => f.code === 'required_file_missing' && f.message.includes('README.md')))
  check('omitting report.md does not emit required_file_missing',
    !omittedViews.findings.some((f) => f.code === 'required_file_missing' && f.message.includes('report.md')))
  check('omitting skills/ does not emit skills_directory_missing',
    !omittedViews.findings.some((f) => f.code === 'skills_directory_missing'))
  check('omitted audience views pack has no structural errors',
    !omittedViews.findings.some((f) => f.category === 'structure' && f.severity === 'error'))

  const minimalSpecPack = makePack('minimal-spec-14')
  const minimalManifest = JSON.parse(readFileSync(join(minimalSpecPack, 'manifest.json'), 'utf8'))
  minimalManifest.capture_kind = 'image'
  writeJson(join(minimalSpecPack, 'manifest.json'), minimalManifest)
  rmSync(join(minimalSpecPack, 'README.md'), { force: true })
  rmSync(join(minimalSpecPack, 'report.md'), { force: true })
  rmSync(join(minimalSpecPack, 'skills'), { recursive: true, force: true })
  rmSync(join(minimalSpecPack, 'timeline.json'), { force: true })
  const minimalResult = inspectPack(minimalSpecPack, { strict: true })
  check('minimal pack omitting optional views passes strict inspection without structural errors',
    minimalResult.gate_status === 'passed'
    && !minimalResult.findings.some((f) => f.category === 'structure' && f.severity === 'error'))

  const emptySkillsPack = makePack('empty-skills')
  rmSync(join(emptySkillsPack, 'skills', 'overview.md'), { force: true })
  const emptySkills = inspectPack(emptySkillsPack, { strict: true })
  check('present skills/ directory without Markdown documents is rejected',
    emptySkills.findings.some((f) => f.code === 'skills_documents_missing'))
  check('empty skills/ directory fails strict gate', emptySkills.gate_status === 'failed')

  const stillImageTimelineSkillPack = makePack('still-image-timeline-skill')
  const stillManifest = JSON.parse(readFileSync(join(stillImageTimelineSkillPack, 'manifest.json'), 'utf8'))
  stillManifest.capture_kind = 'image'
  writeJson(join(stillImageTimelineSkillPack, 'manifest.json'), stillManifest)
  rmSync(join(stillImageTimelineSkillPack, 'timeline.json'), { force: true })
  writeFileSync(join(stillImageTimelineSkillPack, 'skills', 'timeline.md'), '# timeline\n', 'utf8')
  const stillTimelineSkill = inspectPack(stillImageTimelineSkillPack, { strict: true })
  check('explicit still-image pack must not include skills/timeline.md',
    stillTimelineSkill.findings.some((f) => f.code === 'image_timeline_skill_present'))
  check('still-image pack with skills/timeline.md fails strict gate', stillTimelineSkill.gate_status === 'failed')

  const notDirSkillsPack = makePack('skills-not-a-dir')
  rmSync(join(notDirSkillsPack, 'skills'), { recursive: true, force: true })
  writeFileSync(join(notDirSkillsPack, 'skills'), 'not a directory', 'utf8')
  const notDirSkills = inspectPack(notDirSkillsPack, { strict: true })
  check('skills existing as a non-directory is rejected with skills_directory_missing',
    notDirSkills.findings.some((f) => f.code === 'skills_directory_missing'))

  // Issue #226: inspectPack allows omitting optional annotations.json, timeline.json, and optional box properties
  const omittedTimelinePack = makePack('omitted-timeline')
  rmSync(join(omittedTimelinePack, 'timeline.json'), { force: true })
  const omittedTimeline = inspectPack(omittedTimelinePack, { strict: true })
  check('omitting optional timeline.json does not emit required_file_missing',
    !omittedTimeline.findings.some((f) => f.code === 'required_file_missing' && f.message.includes('timeline.json')))
  check('video pack omitting optional timeline.json passes strict inspection',
    omittedTimeline.gate_status === 'passed' && omittedTimeline.counts.errors === 0)

  const omittedAnnotationsPack = makePack('omitted-annotations')
  rmSync(join(omittedAnnotationsPack, 'annotations.json'), { force: true })
  const omittedAnnotations = inspectPack(omittedAnnotationsPack, { strict: true })
  check('omitting optional annotations.json does not emit required_file_missing',
    !omittedAnnotations.findings.some((f) => f.code === 'required_file_missing' && f.message.includes('annotations.json')))
  check('pack omitting optional annotations.json passes strict inspection',
    omittedAnnotations.gate_status === 'passed' && omittedAnnotations.counts.errors === 0)
  check('pack omitting optional annotations.json records zero annotations',
    omittedAnnotations.metrics.annotation_count === 0)

  const unannotatedNoTimelinePack = makePack('unannotated-no-timeline')
  rmSync(join(unannotatedNoTimelinePack, 'annotations.json'), { force: true })
  rmSync(join(unannotatedNoTimelinePack, 'timeline.json'), { force: true })
  const unannotatedNoTimeline = inspectPack(unannotatedNoTimelinePack, { strict: true })
  check('pack omitting both annotations.json and timeline.json emits no required_file_missing',
    !unannotatedNoTimeline.findings.some((f) => f.code === 'required_file_missing'))
  check('pack omitting both annotations.json and timeline.json passes strict inspection',
    unannotatedNoTimeline.gate_status === 'passed' && unannotatedNoTimeline.counts.errors === 0)

  const minimalBoxPack = makePack('minimal-box')
  writeJson(join(minimalBoxPack, 'annotations.json'), {
    reference_width: 1_000,
    reference_height: 800,
    annotations: [{
      annotation_id: 'ann_min001',
      type: 'box',
      bounds: { x: 10, y: 10, width: 50, height: 20 },
    }],
  })
  const minimalBox = inspectPack(minimalBoxPack, { strict: true })
  check('box omitting optional properties (text, numbered, blur, z, created_at, tracking) passes strict inspection',
    minimalBox.gate_status === 'passed' && minimalBox.counts.errors === 0)
  check('minimal box annotation does not emit schema errors for omitted optional properties',
    !minimalBox.findings.some((f) => [
      'annotation_text_invalid',
      'annotation_flags_invalid',
      'annotation_z_invalid',
      'annotation_created_at_invalid',
      'annotation_tracking_missing',
    ].includes(f.code)))

  const malformedBoxPack = makePack('malformed-box')
  writeJson(join(malformedBoxPack, 'annotations.json'), {
    reference_width: 1_000,
    reference_height: 800,
    annotations: [{
      annotation_id: 'ann_bad001',
      type: 'box',
      bounds: { x: 10, y: 10, width: 50, height: 20 },
      text: 12345,
      numbered: 'yes',
      blur: 'no',
      z: 'high',
      created_at: 'not-a-valid-timestamp',
      tracking: 'invalid-tracking-not-object',
    }],
  })
  const malformedBox = inspectPack(malformedBoxPack, { strict: true })
  check('malformed present text is rejected with annotation_text_invalid',
    malformedBox.findings.some((f) => f.code === 'annotation_text_invalid'))
  check('malformed present flags are rejected with annotation_flags_invalid',
    malformedBox.findings.some((f) => f.code === 'annotation_flags_invalid'))
  check('malformed present z is rejected with annotation_z_invalid',
    malformedBox.findings.some((f) => f.code === 'annotation_z_invalid'))
  check('malformed present created_at is rejected with annotation_created_at_invalid',
    malformedBox.findings.some((f) => f.code === 'annotation_created_at_invalid'))
  check('malformed present tracking is rejected with annotation_tracking_missing',
    malformedBox.findings.some((f) => f.code === 'annotation_tracking_missing'))
  check('pack with malformed present annotation properties fails strict gate',
    malformedBox.gate_status === 'failed')

  const missing = inspectPack(join(temporaryRoot, 'does-not-exist'))
  check('an explicitly supplied missing pack is a configuration failure', missing.configuration_error === true)
  check('a missing configured pack always fails the gate', missing.gate_status === 'failed')

  console.log(`\n${checks}/${checks} pack-forensics checks passed`)
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
