// The "analyze this" prompts CapturePack hands to the user for pasting into an
// AI conversation (GOAL "Always-On MCP Server": the user says one sentence and
// the AI chains the rest itself).
//
// FIXED CONTRACT — do not reword. Deliberately NOT localized: these strings are
// pasted into an LLM conversation, so they are an LLM-facing surface like the
// MCP tool descriptions, and they stay English in every UI language.
//
// WHY THEY LIVE IN shared/: the save toast and History produce the pack-path
// form from the main process, while Settings > MCP produces the connected-server
// form in a renderer (issue #56). Two copies of the same instructions would
// drift the moment one of them was improved, so both are built from ONE body
// sentence below and the whole thing is imported by both sides.

/** The reading order every form of the prompt teaches (SPEC §5, GOAL "Export"). */
const READING_ORDER =
  'Read README.md first, then skills/ and report.md; annotations.json is the ' +
  'machine-readable source.'

/**
 * The save toast / History "Copy Prompt" text: a pack that is already on disk,
 * named by its absolute folder path.
 */
export function analyzePackPrompt(folderPath: string): string {
  return (
    `Analyze the CapturePack at ${folderPath}. ${READING_ORDER} If a CapturePack MCP ` +
    'server is connected, call capturepack_latest instead.'
  )
}

/**
 * The Settings > MCP "Copy prompt" text (issue #56): the sentence to give an AI
 * once the server is connected, so no path has to be pasted at all. Same
 * reading order as above — that is the point of sharing the sentence.
 */
export function analyzeLatestPrompt(): string {
  return (
    'Analyze the latest CapturePack. Call capturepack_latest on the CapturePack MCP ' +
    `server to open it. ${READING_ORDER}`
  )
}
