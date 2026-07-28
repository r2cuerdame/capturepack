// The entry the harness bundles. Re-exports the shipping timeline so the checks
// can never run against a copy of it.
export { SurfaceTimeline } from '../src/shared/context/surfaces'
export type { SurfaceInfo, SurfaceSample } from '../src/shared/context/protocol'
