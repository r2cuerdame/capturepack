// Display-number computation (SPEC §8.5) — the ONE shared implementation.
// Import from here (or from ./types, which hosts the implementation): the
// editor canvas, the annotated-replay renderer, report/README/skills
// generators, and MCP responses all must use this exact function so numbers
// in the video and numbers in the documents can never differ.
//
// EXACTLY ONE EXPORT, and that is the point of the file. Assigning a number is
// a different job from rendering one — the editor's side of #51 lives in
// ./types as nextDisplayNumber and planNumberPins — and it stays out of here so
// that "everything that draws a number imports numbering" keeps meaning one
// thing to read.
export { computeDisplayNumbers } from './types'
