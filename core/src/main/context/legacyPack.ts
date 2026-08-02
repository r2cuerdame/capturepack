// The LEGACY PACK ADAPTER (design §10.1): a v0.1.x capture-instant
// plugins/windows-uia/elements.json turned into the shape the temporal path
// consumes.
//
// WHY THIS IS ITS OWN FILE. Opening a pack written before v0.2.0 must still
// pick at the capture instant and must SAY that is all it has. The way to get
// that without a legacy branch in the editor, the resolver or the index is to
// adapt the old payload into a one-sample temporal buffer here — so the only
// legacy code in the system is the adapter, which is where it belongs.
//
// It also has to run OUTSIDE Electron: the #58 regression harness rebuilds the
// editor index from real packs in plain Node, and a module that reaches for
// app/screen at import time cannot be measured. Nothing here does.
import type { EditorUiaElement, EditorUiaWindow } from '../../shared/ipc'
import type { UiaPluginPayload } from '../../shared/types'
/**
 * The pickable CONTROLS the editor receives (SPEC §8.7 target fields).
 *
 * `focusedIndex` is the pack's focused display index (SPEC §5.6) — what an
 * entry WITHOUT a `display` field means. Resolving it here rather than in the
 * editor keeps one rule in one place: a payload written before the dump was
 * mapped per-display was mapped into the focused display's space and nowhere
 * else, so that is the only honest answer for it.
 */
export function editorUiaElements(
  payload: UiaPluginPayload | null,
  focusedIndex: number,
): EditorUiaElement[] {
  if (payload === null) return []
  return payload.elements.map((e) => ({
    name: e.name,
    control_type: e.control_type,
    automation_id: e.automation_id,
    class_name: e.class_name,
    bounds: { ...e.bounds },
    display: displayIndexOf(e.display, focusedIndex),
    window: e.window,
  }))
}

/** A payload `display` field resolved against the focused display (SPEC §8.8). */
function displayIndexOf(value: number | undefined, focusedIndex: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : focusedIndex
}

/**
 * The pickable WINDOWS the editor receives — the floor of object picking (GOAL:
 * "windows are always selectable").
 *
 * `hasControls` is derived from the elements that actually came back rather
 * than from the recorded tree status, so it stays true for a pack written
 * before per-window statuses existed: in such a pack every element belongs to
 * the foreground window, which is exactly the legacy branch below.
 *
 * `tree` travels UNCHANGED alongside it. The two answer different questions and
 * SPEC §11.3 requires both: hasControls says whether anything was recorded HERE,
 * `tree` says whether the window's tree was READ at all — and a reader must
 * report a window that was never walked as *no data recorded*, never as *no
 * objects*.
 */
export function editorUiaWindows(
  payload: UiaPluginPayload | null,
  focusedIndex: number,
): EditorUiaWindow[] {
  if (payload === null) return []
  const legacy = payload.elements.length > 0 && payload.elements.every((e) => e.window < 0)
  const counts = new Map<number, number>()
  for (const e of payload.elements) {
    if (e.window < 0) continue
    counts.set(e.window, (counts.get(e.window) ?? 0) + 1)
  }
  return payload.windows.map((w, index) => {
    const z = Number.isInteger(w.z) && w.z >= 0 ? w.z : index
    const controls = (counts.get(z) ?? 0) + (legacy && w.focused ? payload.elements.length : 0)
    return {
      ...(w.hwnd === undefined ? {} : { hwnd: w.hwnd }),
      title: w.title,
      process: w.process,
      class_name: w.class_name,
      bounds: { ...w.bounds },
      // The client rectangle, when the pack carries one (payload 0.5.0, #136).
      // It is the ONLY route by which a reopened pack can place a browser
      // document: viewport CSS pixels become snapshot pixels through
      // `client.width / viewport.width`, and nothing else in this payload
      // measures a drawable area. Absent for every pack written before 0.5.0
      // and for a window only the UI Automation dump ever saw — in both cases
      // the document rung declines, as it always did.
      ...(w.client_bounds === undefined ? {} : { client_bounds: { ...w.client_bounds } }),
      display: displayIndexOf(w.display, focusedIndex),
      focused: w.focused,
      z,
      hasControls: controls > 0,
      tree: w.tree,
    }
  })
}

