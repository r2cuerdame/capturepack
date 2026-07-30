// Where a rectangle measured inside an iframe lands in the frame above it.
//
// This is the whole of the cross-frame arithmetic for element picking (#104),
// kept as ONE PURE FUNCTION on purpose: the picker runs inside pages the tests
// cannot open, so the only way this can be checked is by handing it numbers.
// `scripts/frame-geometry-check.mjs` does exactly that.
//
// Loaded ahead of `content-script.js` by the same `executeScript` call, so both
// share one isolated world and this is simply already there.
;(() => {
  const MIN_FRAME_SCALE = 0.05
  const MAX_FRAME_SCALE = 20

  /**
   * A child frame's rectangle in the host frame's viewport, or null.
   *
   * `scale` is a RATIO OF TWO MEASUREMENTS — the iframe's rendered content
   * width against the width the child says its own viewport has — so it folds
   * every reason the two coordinate spaces differ: a CSS transform on the
   * frame, a zoomed sub-document, a frame sized in one space and painted in
   * another. Nothing here is a constant.
   *
   * Returning null is a refusal, and refusing is the point: a scale far from
   * anything physical means the two measurements are not describing the same
   * box, and a rectangle derived from them would be confidently wrong.
   *
   * @param {{
   *   hostRect: { x: number, y: number, width: number, height: number },
   *   hostInsets: { left: number, top: number, right: number, bottom: number },
   *   childViewportWidth: number,
   *   bounds: { x: number, y: number, width: number, height: number },
   * }} input
   */
  function translateFrameRect(input) {
    const rect = input && input.hostRect
    const insets = input && input.hostInsets
    const bounds = input && input.bounds
    const childViewportWidth = input && input.childViewportWidth
    if (!rect || !insets || !bounds) return null
    const finite = (v) => typeof v === 'number' && Number.isFinite(v)
    if (![rect.x, rect.y, rect.width, rect.height].every(finite)) return null
    if (![insets.left, insets.top, insets.right, insets.bottom].every(finite)) return null
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(finite)) return null
    if (!finite(childViewportWidth) || childViewportWidth <= 0) return null
    if (rect.width <= 0 || rect.height <= 0) return null
    if (bounds.width <= 0 || bounds.height <= 0) return null

    const contentWidth = rect.width - insets.left - insets.right
    const contentHeight = rect.height - insets.top - insets.bottom
    if (contentWidth <= 0 || contentHeight <= 0) return null

    const scale = contentWidth / childViewportWidth
    if (!Number.isFinite(scale) || scale < MIN_FRAME_SCALE || scale > MAX_FRAME_SCALE) return null

    return {
      x: rect.x + insets.left + bounds.x * scale,
      y: rect.y + insets.top + bounds.y * scale,
      width: bounds.width * scale,
      height: bounds.height * scale,
      scale,
    }
  }

  const api = { translateFrameRect, MIN_FRAME_SCALE, MAX_FRAME_SCALE }
  if (typeof window !== 'undefined') window.__capturepackFrameGeometry = api
  if (typeof globalThis !== 'undefined') globalThis.__capturepackFrameGeometry = api
})()
