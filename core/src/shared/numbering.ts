// Display-number computation (SPEC §8.5) — the ONE shared implementation.
// Import from here (or from ./types, which hosts the implementation): the
// editor canvas, the annotated-replay renderer, report/README/skills
// generators, and MCP responses all must use this exact function so numbers
// in the video and numbers in the documents can never differ.
export { computeDisplayNumbers } from './types'
