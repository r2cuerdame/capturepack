// Annotation box/label placement regression.
//
// The reported RC bug is an annotation at a display's bottom edge: opening its
// label/header or rendering the saved label must never move the box. This check
// executes the same pure canvas helper used by editor preview, annotated stills
// and annotated replay frames. The fake context records deterministic drawing
// commands, so this is geometry verification rather than a source-text check.
import {
  annotationLabelBottomOutset,
  drawAnnotationBox,
  type AnnotationBoxStyle,
  type AnnotationCanvasContext,
  type AnnotationRect,
} from '../src/shared/annotationCanvas'
import { placeFloatingChrome } from '../src/renderer/editor/chromePlacement'
import { readFileSync } from 'node:fs'
import path from 'node:path'

let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${condition || detail === '' ? '' : ` — ${detail}`}`)
  if (!condition) failed += 1
}

function close(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.001
}

interface Command {
  name: string
  values: Array<number | string>
}

class FakeContext implements AnnotationCanvasContext {
  readonly commands: Command[] = []
  canvas: { width: number; height: number }
  strokeStyle: string | CanvasGradient | CanvasPattern = '#000'
  fillStyle: string | CanvasGradient | CanvasPattern = '#000'
  lineWidth = 1
  font = ''
  textAlign: CanvasTextAlign = 'start'
  textBaseline: CanvasTextBaseline = 'alphabetic'

  constructor(width: number, height: number, private readonly glyphWidth = 10) {
    this.canvas = { width, height }
  }

  save(): void {
    this.commands.push({ name: 'save', values: [] })
  }

  restore(): void {
    this.commands.push({ name: 'restore', values: [] })
  }

  beginPath(): void {
    this.commands.push({ name: 'beginPath', values: [] })
  }

  arc(x: number, y: number, radius: number): void {
    this.commands.push({ name: 'arc', values: [x, y, radius] })
  }

  fill(): void {
    this.commands.push({ name: 'fill', values: [] })
  }

  stroke(): void {
    this.commands.push({ name: 'stroke', values: [] })
  }

  strokeRect(x: number, y: number, width: number, height: number): void {
    this.commands.push({ name: 'strokeRect', values: [x, y, width, height] })
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    this.commands.push({ name: 'fillRect', values: [x, y, width, height] })
  }

  fillText(text: string, x: number, y: number): void {
    this.commands.push({ name: 'fillText', values: [text, x, y] })
  }

  measureText(text: string): { width: number } {
    return { width: [...text].length * this.glyphWidth }
  }
}

function style(scale = 1, text = 'bottom label'): AnnotationBoxStyle {
  return {
    color: '#FF3B30',
    borderWidth: 3 * scale,
    badge: {
      text: '1',
      radius: 14 * scale,
      borderWidth: 2 * scale,
      font: `700 ${Math.round(14 * scale)}px "Segoe UI"`,
      baselineOffset: scale,
    },
    label: {
      text,
      font: `700 ${Math.round(16 * scale)}px "Segoe UI"`,
      lineHeight: 20 * scale,
      padding: 6 * scale,
      gap: 3 * scale,
    },
  }
}

console.log('\nBOTTOM EDGE — THE BOX AND LABEL ANCHORS ARE IMMUTABLE')
{
  const label = style().label!
  const sourceHeight = 1080
  const gutter = annotationLabelBottomOutset(label)
  const ctx = new FakeContext(1920, sourceHeight + gutter)
  const box: AnnotationRect = { x: 140, y: 980, width: 480, height: 100 }
  const before = JSON.stringify(box)
  const drawn = drawAnnotationBox(ctx, box, style())
  const stroke = ctx.commands.find((command) => command.name === 'strokeRect')
  check('drawing did not mutate annotation bounds', JSON.stringify(box) === before)
  check(
    'the saved-render border uses the exact stored rectangle',
    JSON.stringify(stroke?.values) === JSON.stringify([140, 980, 480, 100]),
    JSON.stringify(stroke?.values),
  )
  check('the bottom-edge label stays below', drawn.label?.side === 'below')
  check(
    'the label keeps its exact below-box anchor',
    drawn.label !== null &&
      close(
        drawn.label.background.y,
        box.y + box.height + label.gap,
      ),
  )
  check(
    'the derived render gutter contains the label without moving source pixels',
    drawn.label !== null &&
      drawn.label.background.x >= 0 &&
      drawn.label.background.x + drawn.label.background.width <= ctx.canvas.width &&
      close(
        drawn.label.background.y + drawn.label.background.height,
        ctx.canvas.height,
      ),
  )
}

console.log('\nRIGHT EDGE, LONG TEXT, NEGATIVE DISPLAY-LOCAL ORIGIN')
{
  const right = new FakeContext(1920, 1080)
  const box: AnnotationRect = { x: 1800, y: 200, width: 120, height: 80 }
  const drawn = drawAnnotationBox(right, box, style(1, 'a label wider than the remaining right edge'))
  check(
    'right-edge label is horizontally clamped without moving the box',
    drawn.box.x === 1800 &&
      drawn.box.width === 120 &&
      drawn.label !== null &&
      drawn.label.background.x + drawn.label.background.width <= 1920,
  )

  const boardContext = new FakeContext(3840, 1080)
  const local = drawAnnotationBox(
    boardContext,
    box,
    style(1, 'display-local label'),
    { width: 1920, height: 1080 },
  )
  check(
    'multi-display preview clamps against its local display, not the board canvas',
    local.label !== null &&
      local.label.background.x + local.label.background.width <= 1920,
    JSON.stringify(local.label?.background),
  )

  const fullHeightStyle = style(1, 'no side has spare height')
  const fullHeight = new FakeContext(
    800,
    600 + annotationLabelBottomOutset(fullHeightStyle.label!),
  )
  const top = drawAnnotationBox(
    fullHeight,
    { x: 40, y: 0, width: 300, height: 600 },
    fullHeightStyle,
  )
  check(
    'a full-height box keeps its label below the source frame',
    top.box.y === 0 &&
      top.box.height === 600 &&
      top.label !== null &&
      top.label.side === 'below' &&
      top.label.background.y === 603,
  )

  const narrow = new FakeContext(120, 300)
  const long = drawAnnotationBox(
    narrow,
    { x: -30, y: 40, width: 90, height: 50 },
    style(1, '0123456789 this text cannot fit'),
  )
  const textCommand = [...narrow.commands]
    .reverse()
    .find((command) => command.name === 'fillText')
  check(
    'a label wider than the canvas is ellipsized',
    typeof textCommand?.values[0] === 'string' &&
      String(textCommand.values[0]).endsWith('…'),
    String(textCommand?.values[0]),
  )
  check(
    'negative display-local x clamps only the label',
    long.box.x === -30 &&
      long.label !== null &&
      long.label.background.x === 0 &&
      long.label.background.width <= 120,
  )
}

console.log('\nMIXED DPI AND EDITOR FLOATING CHROME')
{
  const mixedStyle = style(1.5, '1.5x display')
  const ctx = new FakeContext(
    2560,
    1440 + annotationLabelBottomOutset(mixedStyle.label!),
    15,
  )
  const box: AnnotationRect = { x: 190, y: 1275, width: 600, height: 165 }
  const drawn = drawAnnotationBox(ctx, box, mixedStyle)
  check(
    '1.5x label uses the scaled exact gap',
    drawn.label !== null &&
      drawn.label.side === 'below' &&
      close(
        drawn.label.background.y,
        box.y + box.height + 4.5,
      ),
  )

  const header = placeFloatingChrome({
    anchor: { x: 100, y: 0, width: 320, height: 90 },
    chrome: { width: 260, height: 34 },
    preferredSide: 'above',
    gap: 4,
  })
  check(
    'top-edge header stays anchored above and may overflow media viewport',
    header.side === 'above' && header.x === 100 && header.y === -38,
    JSON.stringify(header),
  )
  const input = placeFloatingChrome({
    anchor: { x: 100, y: 980, width: 320, height: 100 },
    chrome: { width: 180, height: 28 },
    preferredSide: 'below',
    gap: 6,
  })
  check(
    'bottom-edge text input keeps an exact outside anchor without moving the box',
    input.side === 'below' &&
      input.x === 100 &&
      input.y === 1086 &&
      input.anchor.x === 100 &&
      input.anchor.y === 980,
    JSON.stringify(input),
  )
}

console.log('\nPRODUCTION PATHS USE THE TESTED GEOMETRY')
{
  const read = (relative: string): string =>
    readFileSync(path.resolve(process.cwd(), relative), 'utf8')
  const preview = read('src/renderer/editor/render.ts')
  const output = read('src/renderer/render/render.ts')
  const editor = read('src/renderer/editor/editor.ts')
  const html = read('src/renderer/editor/editor.html')
  const css = read('src/renderer/editor/editor.css')
  check(
    'editor preview delegates box and label commands to the shared helper',
    preview.includes("from '../../shared/annotationCanvas'") &&
      /drawAnnotationBox\(\s*ctx,\s*a\.bounds,/u.test(preview) &&
      preview.includes('drawAnnotationLabel') &&
      editor.includes('drawDisplayLabels'),
  )
  check(
    'annotated still/video delegates box and label commands to the shared helper',
    output.includes("from '../../shared/annotationCanvas'") &&
      /drawAnnotationBox\(\s*ctx,\s*a\.bounds,/u.test(output) &&
      output.includes('annotationLabelBottomOutset') &&
      output.includes('renderedCanvasHeight'),
  )
  check(
    'image still and video frame both use that one overlay command path',
    output.includes('drawOverlay(ctx, canvas, overlay, null)') &&
      output.includes('drawOverlay(ctx, canvas, overlay, tMs)'),
  )
  check(
    'text input and toolbar share stage-space placement',
    editor.includes("from './chromePlacement'") &&
      (editor.match(/placeFloatingChrome\(/gu) ?? []).length >= 2,
  )
  check(
    'text input is a stage-space sibling rather than a transformed frame child',
    /<\/div>\s*<input id="textEditor"/u.test(html),
  )
  check(
    'media clipping and editor chrome overflow are separate layers',
    /#mediaViewport\s*\{[\s\S]*?overflow:\s*clip;/u.test(css) &&
      /#stage\s*\{[\s\S]*?overflow:\s*visible;/u.test(css) &&
      editor.includes('resizeOverlayForLabelOverflow'),
  )
  check(
    'the taller result overlay cannot distort pointer-to-board Y coordinates',
    editor.includes('const scale = r.width / board.width') &&
      editor.includes('y: (e.clientY - r.top) / scale'),
  )
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} annotation placement (${failed} failed)`)
if (failed !== 0) process.exitCode = 1
