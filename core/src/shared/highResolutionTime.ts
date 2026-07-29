/**
 * Turns a renderer-local DOMHighResTimeStamp into an epoch-based timestamp.
 *
 * `performance.now()` and `VideoFrameCallbackMetadata.presentationTime` are
 * monotonic only inside one renderer. CapturePack owns one hidden renderer per
 * display, so their raw values are not comparable. `performance.timeOrigin`
 * gives each renderer's matching epoch origin; adding it preserves the
 * high-resolution offset while putting every renderer on one shared axis.
 */
export function wallComparableTimeMs(timeOriginMs: number, localTimeMs: number): number {
  return timeOriginMs + localTimeMs
}
