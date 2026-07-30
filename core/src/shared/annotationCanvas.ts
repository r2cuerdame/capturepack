// Pure annotation canvas geometry shared by the editor preview, annotated
// stills and annotated replay frames.
//
// Annotation bounds are source evidence. Drawing a label or badge must never
// translate/clamp/mutate that rectangle. A text label keeps its below-box
// anchor too; derived renderers add a result-only bottom gutter when the source
// frame has no room for it.

export interface AnnotationRect {
  x: number
  y: number
  width: number
  height: number
}

export interface AnnotationCanvasContext {
  readonly canvas: { width: number; height: number }
  strokeStyle: string | CanvasGradient | CanvasPattern
  fillStyle: string | CanvasGradient | CanvasPattern
  lineWidth: number
  font: string
  textAlign: CanvasTextAlign
  textBaseline: CanvasTextBaseline
  save(): void
  restore(): void
  beginPath(): void
  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
  ): void
  fill(): void
  stroke(): void
  strokeRect(x: number, y: number, width: number, height: number): void
  fillRect(x: number, y: number, width: number, height: number): void
  fillText(text: string, x: number, y: number): void
  measureText(text: string): { width: number }
}

export interface AnnotationBadgeStyle {
  text: string
  radius: number
  borderWidth: number
  font: string
  baselineOffset: number
}

export interface AnnotationLabelStyle {
  text: string
  font: string
  lineHeight: number
  /** Horizontal inset per side; total vertical inset matches legacy output. */
  padding: number
  /** Clear distance between the label background and its box edge. */
  gap: number
}

export interface AnnotationBoxStyle {
  color: string
  borderWidth: number
  badge: AnnotationBadgeStyle | null
  label: AnnotationLabelStyle | null
}

export interface AnnotationLabelPlacement {
  side: 'below' | 'above'
  text: string
  truncated: boolean
  background: AnnotationRect
  textX: number
  textY: number
}

export interface AnnotationDrawResult {
  /** An immutable value copy, useful to prove the source rectangle survived. */
  box: AnnotationRect
  label: AnnotationLabelPlacement | null
}

interface FittedText {
  text: string
  width: number
  truncated: boolean
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (maximum <= minimum) return minimum
  return Math.max(minimum, Math.min(value, maximum))
}

/** Extra derived-canvas rows that contain a label anchored below a bottom box. */
export function annotationLabelBottomOutset(
  style: Readonly<Pick<AnnotationLabelStyle, 'lineHeight' | 'padding' | 'gap'>>,
): number {
  return (
    finiteNonNegative(style.gap) +
    finiteNonNegative(style.lineHeight) +
    finiteNonNegative(style.padding)
  )
}

/**
 * Fits one single-line label without allowing a too-wide fillRect/text command
 * to escape the output canvas. Code points, not UTF-16 halves, are removed.
 */
export function fitAnnotationLabelText(
  text: string,
  maximumWidth: number,
  measure: (candidate: string) => number,
): FittedText {
  const source = text.trim()
  const limit = finiteNonNegative(maximumWidth)
  if (source === '' || limit <= 0) return { text: '', width: 0, truncated: source !== '' }
  const fullWidth = finiteNonNegative(measure(source))
  if (fullWidth <= limit) return { text: source, width: fullWidth, truncated: false }

  const ellipsis = '…'
  const ellipsisWidth = finiteNonNegative(measure(ellipsis))
  if (ellipsisWidth > limit) return { text: '', width: 0, truncated: true }
  const points = [...source]
  let low = 0
  let high = points.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const candidate = `${points.slice(0, middle).join('').trimEnd()}${ellipsis}`
    if (finiteNonNegative(measure(candidate)) <= limit) low = middle
    else high = middle - 1
  }
  const fitted = `${points.slice(0, low).join('').trimEnd()}${ellipsis}`
  return {
    text: fitted,
    width: finiteNonNegative(measure(fitted)),
    truncated: true,
  }
}

/**
 * Places a measured label in one display-local output canvas.
 *
 * The label is always anchored below. It may lie below the source viewport;
 * the annotated output owns the result-only gutter that makes those pixels
 * visible. Horizontal clamping/ellipsis keeps one-line text inside the output
 * width, but neither the box nor its vertical label anchor is rewritten.
 */
export function placeAnnotationLabel(
  box: Readonly<AnnotationRect>,
  canvas: Readonly<{ width: number; height: number }>,
  textWidth: number,
  lineHeight: number,
  padding: number,
  gap: number,
): Omit<AnnotationLabelPlacement, 'text' | 'truncated'> | null {
  const canvasWidth = finiteNonNegative(canvas.width)
  const canvasHeight = finiteNonNegative(canvas.height)
  if (canvasWidth <= 0 || canvasHeight <= 0) return null

  const safePadding = finiteNonNegative(padding)
  const horizontalPadding = Math.min(safePadding, canvasWidth / 2)
  const outerWidth = Math.min(
    canvasWidth,
    finiteNonNegative(textWidth) + horizontalPadding * 2,
  )
  const outerHeight = Math.min(
    canvasHeight,
    finiteNonNegative(lineHeight) + safePadding,
  )
  if (outerWidth <= 0 || outerHeight <= 0) return null

  const safeGap = finiteNonNegative(gap)
  const belowY = box.y + box.height + safeGap
  const background = {
    x: clamp(box.x - horizontalPadding, 0, canvasWidth - outerWidth),
    y: belowY,
    width: outerWidth,
    height: outerHeight,
  }
  return {
    side: 'below',
    background,
    textX: background.x + horizontalPadding,
    textY: background.y + Math.min(safePadding / 2, outerHeight),
  }
}

export function drawAnnotationLabel(
  ctx: AnnotationCanvasContext,
  box: Readonly<AnnotationRect>,
  style: Readonly<AnnotationLabelStyle>,
  surface: Readonly<{ width: number; height: number }> = ctx.canvas,
): AnnotationLabelPlacement | null {
  const padding = finiteNonNegative(style.padding)
  const horizontalPadding = Math.min(
    padding,
    finiteNonNegative(surface.width) / 2,
  )
  const maximumTextWidth = Math.max(
    0,
    finiteNonNegative(surface.width) - horizontalPadding * 2,
  )
  ctx.font = style.font
  const fitted = fitAnnotationLabelText(
    style.text,
    maximumTextWidth,
    (candidate) => ctx.measureText(candidate).width,
  )
  if (fitted.text === '') return null
  const placed = placeAnnotationLabel(
    box,
    surface,
    fitted.width,
    style.lineHeight,
    padding,
    style.gap,
  )
  if (placed === null) return null
  const placement: AnnotationLabelPlacement = {
    ...placed,
    text: fitted.text,
    truncated: fitted.truncated,
  }
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillStyle = 'rgba(0, 0, 0, 0.65)'
  ctx.fillRect(
    placement.background.x,
    placement.background.y,
    placement.background.width,
    placement.background.height,
  )
  ctx.fillStyle = '#ffffff'
  ctx.fillText(placement.text, placement.textX, placement.textY)
  return placement
}

/**
 * Draws the original rectangle exactly, then derived badge/label chrome.
 * There is deliberately no "fit box to label" or edge-avoidance write.
 */
export function drawAnnotationBox(
  ctx: AnnotationCanvasContext,
  box: Readonly<AnnotationRect>,
  style: Readonly<AnnotationBoxStyle>,
  surface: Readonly<{ width: number; height: number }> = ctx.canvas,
): AnnotationDrawResult {
  const original = { x: box.x, y: box.y, width: box.width, height: box.height }
  ctx.save()
  ctx.strokeStyle = style.color
  ctx.lineWidth = style.borderWidth
  ctx.strokeRect(original.x, original.y, original.width, original.height)

  if (style.badge !== null) {
    ctx.beginPath()
    ctx.arc(original.x, original.y, style.badge.radius, 0, Math.PI * 2)
    ctx.fillStyle = style.color
    ctx.fill()
    ctx.lineWidth = style.badge.borderWidth
    ctx.strokeStyle = '#ffffff'
    ctx.stroke()
    ctx.fillStyle = '#ffffff'
    ctx.font = style.badge.font
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(
      style.badge.text,
      original.x,
      original.y + style.badge.baselineOffset,
    )
  }

  const label =
    style.label === null
      ? null
      : drawAnnotationLabel(ctx, original, style.label, surface)
  ctx.restore()
  return { box: original, label }
}
