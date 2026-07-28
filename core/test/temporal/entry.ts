// What the temporal picking harness (check.mjs) runs against: the SHIPPING
// modules, bundled for plain Node.
//
// The point of this file is that the harness measures the real thing. #58's
// numbers — median offered rectangle 23,912 px, 66.9% precise offers — are an
// assertion about `ObjectIndex` and the Surface Resolver as the editor actually
// uses them, and a harness that re-implemented either would assert nothing.
// Nothing below reaches for Electron, which is what makes that possible
// (context/session.ts and context/legacyPack.ts are deliberately Electron-free).
export { ContextSession } from '../../src/main/context/session'
export type { ContextDisplayTarget } from '../../src/main/context/session'
export type { ContextObservation } from '../../src/main/context/buffer'
export { editorUiaElements, editorUiaWindows } from '../../src/main/context/legacyPack'
export { ObjectIndex, objectHoverLabel, objectLabel } from '../../src/renderer/editor/objects'
export type { PickableObject } from '../../src/renderer/editor/objects'
export { resolveCandidates, compareCandidates } from '../../src/shared/context/resolver'
export { SurfaceTimeline, subtractRect, visibleRegionOf } from '../../src/shared/context/surfaces'
export { CONTEXT_PROTOCOL_VERSION, STALENESS_CEILING_MS } from '../../src/shared/context/protocol'
export type { ContextFrame, SurfaceInfo } from '../../src/shared/context/protocol'
