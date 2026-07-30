'use strict'

/**
 * Converts the field case's capture target into the fixture's start request.
 *
 * `primary` is resolved by the fixture after Electron has enumerated the
 * physical desktop. An all-display case also starts on primary so its primary
 * recorder calibrates against moving pixels instead of a static neighbour.
 */
function requestedFixtureStartDisplayId(target) {
  return target === 'all' ? 'primary' : String(target)
}

/**
 * Returns a rotated VIEW used only by the moving target.
 *
 * The original Electron array remains the layout/index authority. Rotating it
 * in place would renumber negative-origin/portrait/mixed-DPI displays in the
 * fixture evidence and make the test repair its own expected coordinates.
 */
function movementDisplayOrder(displays, primaryDisplayId, requestedStartDisplayId) {
  if (!Array.isArray(displays) || displays.length === 0) {
    throw new Error('cannot resolve movement order without displays')
  }
  const requested =
    requestedStartDisplayId === null
    || requestedStartDisplayId === undefined
    || String(requestedStartDisplayId).trim() === ''
      ? null
      : String(requestedStartDisplayId)
  const startDisplayId =
    requested === null
      ? String(displays[0].id)
      : requested === 'primary'
        ? String(primaryDisplayId)
        : requested
  const startIndex = displays.findIndex((display) => String(display.id) === startDisplayId)
  if (startIndex < 0) {
    throw new Error(
      `start display ${startDisplayId} is not connected; `
      + `available: ${displays.map((display) => String(display.id)).join(', ')}`,
    )
  }
  return {
    startDisplayId,
    startIndex,
    displays: [
      ...displays.slice(startIndex),
      ...displays.slice(0, startIndex),
    ],
  }
}

module.exports = {
  movementDisplayOrder,
  requestedFixtureStartDisplayId,
}
