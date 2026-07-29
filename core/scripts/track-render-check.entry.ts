// The entry the harness bundles. Re-exports the shipping resolver so the checks
// can never run against a copy of it.
export { annotationAt, renderedAnnotationAt, trackedBoundsAt } from '../src/shared/track'
