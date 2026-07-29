// The entry the harness bundles: the REAL editor-side session, which is
// Electron-free precisely so it can be run like this, plus the REAL index the
// editor hovers over — the two halves of the chain the user's report is about.
export { ContextSession } from '../src/main/context/session'
export { ObjectIndex } from '../src/renderer/editor/objects'
export { projectControlTrack } from '../src/renderer/editor/objectTrack'
