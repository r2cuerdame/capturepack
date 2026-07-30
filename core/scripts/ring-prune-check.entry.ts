// The entry the harness bundles. Re-exports the shipping ring so the checks can
// never run against a copy of it.
export {
  SurfaceTimeline,
  surfaceTimelineBudgetForRetention,
} from '../src/main/context/timeline'
