// Pure placement for editor-only annotation chrome.
//
// These rectangles are not annotation geometry. They may sit outside the media
// viewport; moving/clamping an Annotation to make room for them is forbidden.
export interface FloatingRect {
  x: number
  y: number
  width: number
  height: number
}

export interface FloatingChromePlacement {
  x: number
  y: number
  side: 'above' | 'below'
  /** Value copy proving the source anchor was not rewritten. */
  anchor: FloatingRect
}

export interface FloatingChromeRequest {
  anchor: Readonly<FloatingRect>
  chrome: Readonly<{ width: number; height: number }>
  preferredSide: 'above' | 'below'
  gap: number
}

export function placeFloatingChrome(
  request: FloatingChromeRequest,
): FloatingChromePlacement {
  const anchor = {
    x: request.anchor.x,
    y: request.anchor.y,
    width: request.anchor.width,
    height: request.anchor.height,
  }
  const gap = Number.isFinite(request.gap) ? Math.max(0, request.gap) : 0
  const height =
    Number.isFinite(request.chrome.height) ? Math.max(0, request.chrome.height) : 0
  const belowY = anchor.y + anchor.height + gap
  const aboveY = anchor.y - gap - height
  const side = request.preferredSide
  return {
    x: anchor.x,
    y: side === 'above' ? aboveY : belowY,
    side,
    anchor,
  }
}
