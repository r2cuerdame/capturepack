// Optional persisted history for the Windows context provider.
//
// The format begins AFTER Lane S and Lane A have been projected into the
// editor's per-display snapshot spaces. That seam is deliberate: a live
// capture and a reopened capture must consume the exact same observations,
// instead of rerunning monitor/DPI projection through a subtly different path.
//
// The checkpoint + delta shape is also deliberate. A recent real capture held
// 604 observations and 478 controls; writing every observation in full was
// roughly 97 MB. During a window drag almost all of those controls undergo the
// same translation, so `element_transforms` records that observed translation
// once and the element patches retain only genuine internal changes.
import type { EditorUiaElement, EditorUiaWindow } from '../../shared/ipc'
import type { ContextObservation } from './buffer'

export const WINDOWS_CONTEXT_TIMELINE_SCHEMA = 'capturepack.windows-context.timeline'
export const WINDOWS_CONTEXT_TIMELINE_VERSION = 1

interface PersistedRect {
  x: number
  y: number
  width: number
  height: number
}

export interface PersistedWindowPatch {
  hwnd?: string | null
  surface_id?: string | null
  title?: string
  process?: string
  class_name?: string
  bounds?: PersistedRect
  client_bounds?: PersistedRect | null
  display?: number
  focused?: boolean
  z?: number
  hasControls?: boolean
  tree?: EditorUiaWindow['tree']
  control_geometry_invalidated?: true | null
}

export interface PersistedElementPatch {
  name?: string
  control_type?: string
  automation_id?: string
  class_name?: string
  bounds?: PersistedRect
  display?: number
  window?: number
}

export interface PersistedArrayDelta<T, P> {
  /** New array length. Absent when it did not change. */
  length?: number
  /** Whole entries, used for additions or when shorter than a field patch. */
  set?: Array<[index: number, value: T]>
  /** Field-only changes for entries that retained their array identity. */
  patch?: Array<[index: number, value: P]>
}

export interface PersistedElementTransform {
  /** Owner coordinates in the observation immediately before this delta. */
  display: number
  from_z: number
  /** Owner z-order in this delta's observation. */
  to_z: number
  dx: number
  dy: number
}

export interface PersistedWindowsContextDelta {
  t_ms: number
  windows?: PersistedArrayDelta<EditorUiaWindow, PersistedWindowPatch>
  /**
   * One observed owner-window translation applied before element patches.
   * There is no interpolation: the transform takes effect at exactly `t_ms`.
   */
  element_transforms?: PersistedElementTransform[]
  elements?: PersistedArrayDelta<EditorUiaElement, PersistedElementPatch>
}

export interface WindowsContextTimelineV1 {
  schema: typeof WINDOWS_CONTEXT_TIMELINE_SCHEMA
  version: typeof WINDOWS_CONTEXT_TIMELINE_VERSION
  range: {
    start_ms: number
    end_ms: number
  }
  checkpoint: {
    t_ms: number
    windows: EditorUiaWindow[]
    elements: EditorUiaElement[]
  }
  /**
   * One entry for EVERY later observation, including an empty entry when
   * nothing changed. Sample instants carry temporal accuracy and may not be
   * collapsed merely because their payloads compare equal.
   */
  deltas: PersistedWindowsContextDelta[]
}

export interface WindowsContextExportRange {
  /** Boundary in the input observations' pack clock. */
  startMs?: number
  /** Inclusive boundary in the input observations' pack clock. */
  endMs?: number
  /** Where `startMs` lands in the exported clock. `0` rebases a trim. */
  rebaseToMs?: number
}

/**
 * Hard ceilings for an UNTRUSTED persisted history.
 *
 * CapturePack records 30 seconds by default and Settings permits at most ten
 * minutes. 18,001 observations is therefore the absolute 30 fps envelope for
 * the longest supported replay, while the per-observation object caps remain
 * comfortably above the resident helpers' real limits (24/64 windows and
 * 3,000 controls). Aggregate budgets matter as much as the array caps: a tiny
 * delta can still ask the decoder to clone a large live tree thousands of
 * times.
 */
export const WINDOWS_CONTEXT_TIMELINE_LIMITS = Object.freeze({
  maxFileBytes: 32 * 1024 * 1024,
  maxDurationMs: 10 * 60 * 1000,
  maxObservations: 30 * 60 * 10 + 1,
  maxWindowsPerObservation: 512,
  maxElementsPerObservation: 6_000,
  maxWindowRecords: 20_000,
  maxElementRecords: 50_000,
  maxDeltaEntries: 100_000,
  maxStringBytes: 8 * 1024 * 1024,
  maxStringCodeUnits: 65_536,
  maxWindowDecodeWork: 500_000,
  maxElementDecodeWork: 2_000_000,
})

export const WINDOWS_CONTEXT_MAX_FILE_BYTES =
  WINDOWS_CONTEXT_TIMELINE_LIMITS.maxFileBytes

const MAX_WINDOWS = WINDOWS_CONTEXT_TIMELINE_LIMITS.maxWindowsPerObservation
const MAX_ELEMENTS = WINDOWS_CONTEXT_TIMELINE_LIMITS.maxElementsPerObservation
const MAX_DELTAS = WINDOWS_CONTEXT_TIMELINE_LIMITS.maxObservations - 1
const TREE_STATUSES = new Set<EditorUiaWindow['tree']>([
  'collected',
  'truncated',
  'unavailable',
  'skipped',
])

type UnknownRecord = Record<string, unknown>

interface TimelineBudget {
  windowRecords: number
  elementRecords: number
  deltaEntries: number
  stringBytes: number
  windowDecodeWork: number
  elementDecodeWork: number
}

function emptyBudget(): TimelineBudget {
  return {
    windowRecords: 0,
    elementRecords: 0,
    deltaEntries: 0,
    stringBytes: 0,
    windowDecodeWork: 0,
    elementDecodeWork: 0,
  }
}

function charge(
  budget: TimelineBudget,
  key: keyof TimelineBudget,
  amount: number,
  maximum: number,
): boolean {
  if (!Number.isSafeInteger(amount) || amount < 0) return false
  const next = budget[key] + amount
  if (!Number.isSafeInteger(next) || next > maximum) return false
  budget[key] = next
  return true
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeInteger(value: unknown, minimum = Number.MIN_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function stringValue(value: unknown, budget?: TimelineBudget): value is string {
  if (
    typeof value !== 'string'
    || value.length > WINDOWS_CONTEXT_TIMELINE_LIMITS.maxStringCodeUnits
  ) {
    return false
  }
  if (budget === undefined) return true
  return charge(
    budget,
    'stringBytes',
    Buffer.byteLength(value, 'utf8'),
    WINDOWS_CONTEXT_TIMELINE_LIMITS.maxStringBytes,
  )
}

function readRect(value: unknown): PersistedRect | null {
  if (!isRecord(value)) return null
  const x = value['x']
  const y = value['y']
  const width = value['width']
  const height = value['height']
  if (
    !finiteNumber(x)
    || !finiteNumber(y)
    || !finiteNumber(width)
    || !finiteNumber(height)
    || width < 0
    || height < 0
  ) {
    return null
  }
  return { x, y, width, height }
}

function cloneRect(rect: PersistedRect): PersistedRect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}

function sameRect(left: PersistedRect, right: PersistedRect): boolean {
  return (
    left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height
  )
}

function readWindow(
  value: unknown,
  budget?: TimelineBudget,
): EditorUiaWindow | null {
  if (!isRecord(value)) return null
  const hwnd = value['hwnd']
  const surfaceId = value['surface_id']
  const title = value['title']
  const processName = value['process']
  const className = value['class_name']
  const bounds = readRect(value['bounds'])
  const rawClient = value['client_bounds']
  const clientBounds = rawClient === undefined ? undefined : readRect(rawClient)
  const display = value['display']
  const focused = value['focused']
  const z = value['z']
  const hasControls = value['hasControls']
  const tree = value['tree']
  const controlGeometryInvalidated = value['control_geometry_invalidated']
  if (
    (hwnd !== undefined && !stringValue(hwnd, budget))
    || (surfaceId !== undefined && !stringValue(surfaceId, budget))
    || !stringValue(title, budget)
    || !stringValue(processName, budget)
    || !stringValue(className, budget)
    || bounds === null
    || (rawClient !== undefined && clientBounds === null)
    || !safeInteger(display, 1)
    || typeof focused !== 'boolean'
    || !safeInteger(z)
    || typeof hasControls !== 'boolean'
    || !stringValue(tree, budget)
    || !TREE_STATUSES.has(tree as EditorUiaWindow['tree'])
    || (
      controlGeometryInvalidated !== undefined
      && controlGeometryInvalidated !== true
    )
  ) {
    return null
  }
  return {
    ...(surfaceId === undefined ? {} : { surface_id: surfaceId }),
    ...(hwnd === undefined ? {} : { hwnd }),
    title,
    process: processName,
    class_name: className,
    bounds,
    ...(rawClient === undefined ? {} : { client_bounds: clientBounds as PersistedRect }),
    display,
    focused,
    z,
    hasControls,
    tree: tree as EditorUiaWindow['tree'],
    ...(controlGeometryInvalidated === true
      ? { control_geometry_invalidated: true }
      : {}),
  }
}

function readElement(
  value: unknown,
  budget?: TimelineBudget,
): EditorUiaElement | null {
  if (!isRecord(value)) return null
  const name = value['name']
  const controlType = value['control_type']
  const automationId = value['automation_id']
  const className = value['class_name']
  const bounds = readRect(value['bounds'])
  const display = value['display']
  const window = value['window']
  if (
    !stringValue(name, budget)
    || !stringValue(controlType, budget)
    || !stringValue(automationId, budget)
    || !stringValue(className, budget)
    || bounds === null
    || !safeInteger(display, 1)
    || !safeInteger(window)
  ) {
    return null
  }
  return {
    name,
    control_type: controlType,
    automation_id: automationId,
    class_name: className,
    bounds,
    display,
    window,
  }
}

function cloneWindow(window: EditorUiaWindow): EditorUiaWindow {
  // Re-read to keep optional-field ordering canonical after a delete/re-add.
  return readWindow(window) as EditorUiaWindow
}

function cloneElement(element: EditorUiaElement): EditorUiaElement {
  return readElement(element) as EditorUiaElement
}

function readObservation(value: ContextObservation): ContextObservation | null {
  if (!safeInteger(value.tMs, 0)) return null
  if (value.windows.length > MAX_WINDOWS || value.elements.length > MAX_ELEMENTS) return null
  const windows: EditorUiaWindow[] = []
  const elements: EditorUiaElement[] = []
  for (const item of value.windows) {
    const window = readWindow(item)
    if (window === null) return null
    windows.push(window)
  }
  for (const item of value.elements) {
    const element = readElement(item)
    if (element === null) return null
    elements.push(element)
  }
  return { tMs: value.tMs, windows, elements }
}

function sameWindow(left: EditorUiaWindow, right: EditorUiaWindow): boolean {
  return (
    left.hwnd === right.hwnd
    && left.surface_id === right.surface_id
    && left.title === right.title
    && left.process === right.process
    && left.class_name === right.class_name
    && sameRect(left.bounds, right.bounds)
    && (
      left.client_bounds === undefined
        ? right.client_bounds === undefined
        : right.client_bounds !== undefined && sameRect(left.client_bounds, right.client_bounds)
    )
    && left.display === right.display
    && left.focused === right.focused
    && left.z === right.z
    && left.hasControls === right.hasControls
    && left.tree === right.tree
    && left.control_geometry_invalidated === right.control_geometry_invalidated
  )
}

function sameElement(left: EditorUiaElement, right: EditorUiaElement): boolean {
  return (
    left.name === right.name
    && left.control_type === right.control_type
    && left.automation_id === right.automation_id
    && left.class_name === right.class_name
    && sameRect(left.bounds, right.bounds)
    && left.display === right.display
    && left.window === right.window
  )
}

function windowPatch(
  previous: EditorUiaWindow,
  next: EditorUiaWindow,
): PersistedWindowPatch | null {
  const patch: PersistedWindowPatch = {}
  if (previous.hwnd !== next.hwnd) patch.hwnd = next.hwnd ?? null
  if (previous.surface_id !== next.surface_id) patch.surface_id = next.surface_id ?? null
  if (previous.title !== next.title) patch.title = next.title
  if (previous.process !== next.process) patch.process = next.process
  if (previous.class_name !== next.class_name) patch.class_name = next.class_name
  if (!sameRect(previous.bounds, next.bounds)) patch.bounds = cloneRect(next.bounds)
  if (
    previous.client_bounds === undefined
      ? next.client_bounds !== undefined
      : next.client_bounds === undefined || !sameRect(previous.client_bounds, next.client_bounds)
  ) {
    patch.client_bounds =
      next.client_bounds === undefined ? null : cloneRect(next.client_bounds)
  }
  if (previous.display !== next.display) patch.display = next.display
  if (previous.focused !== next.focused) patch.focused = next.focused
  if (previous.z !== next.z) patch.z = next.z
  if (previous.hasControls !== next.hasControls) patch.hasControls = next.hasControls
  if (previous.tree !== next.tree) patch.tree = next.tree
  if (
    previous.control_geometry_invalidated
    !== next.control_geometry_invalidated
  ) {
    patch.control_geometry_invalidated =
      next.control_geometry_invalidated === true ? true : null
  }
  return Object.keys(patch).length === 0 ? null : patch
}

function elementPatch(
  previous: EditorUiaElement,
  next: EditorUiaElement,
): PersistedElementPatch | null {
  const patch: PersistedElementPatch = {}
  if (previous.name !== next.name) patch.name = next.name
  if (previous.control_type !== next.control_type) patch.control_type = next.control_type
  if (previous.automation_id !== next.automation_id) patch.automation_id = next.automation_id
  if (previous.class_name !== next.class_name) patch.class_name = next.class_name
  if (!sameRect(previous.bounds, next.bounds)) patch.bounds = cloneRect(next.bounds)
  if (previous.display !== next.display) patch.display = next.display
  if (previous.window !== next.window) patch.window = next.window
  return Object.keys(patch).length === 0 ? null : patch
}

function windowIdentity(window: EditorUiaWindow): string | null {
  const stable = window.surface_id === undefined
    ? (window.hwnd === undefined ? null : `h:${window.hwnd}`)
    : `s:${window.surface_id}`
  return stable === null ? null : `${stable}|d:${String(window.display)}`
}

function ownerTransforms(
  previous: readonly EditorUiaWindow[],
  next: readonly EditorUiaWindow[],
): PersistedElementTransform[] {
  const priorByIdentity = new Map<string, EditorUiaWindow | null>()
  const priorOwnerCounts = new Map<string, number>()
  for (const window of previous) {
    const identity = windowIdentity(window)
    if (identity === null) continue
    priorByIdentity.set(identity, priorByIdentity.has(identity) ? null : window)
    const owner = `${String(window.display)}:${String(window.z)}`
    priorOwnerCounts.set(owner, (priorOwnerCounts.get(owner) ?? 0) + 1)
  }
  const nextByIdentity = new Map<string, EditorUiaWindow | null>()
  for (const window of next) {
    const identity = windowIdentity(window)
    if (identity === null) continue
    nextByIdentity.set(identity, nextByIdentity.has(identity) ? null : window)
  }
  const transforms: PersistedElementTransform[] = []
  for (const [identity, before] of priorByIdentity) {
    const after = nextByIdentity.get(identity)
    if (before === null || after === undefined || after === null) continue
    if (priorOwnerCounts.get(`${String(before.display)}:${String(before.z)}`) !== 1) continue
    const dx = after.bounds.x - before.bounds.x
    const dy = after.bounds.y - before.bounds.y
    if (dx === 0 && dy === 0 && before.z === after.z) continue
    transforms.push({
      display: before.display,
      from_z: before.z,
      to_z: after.z,
      dx,
      dy,
    })
  }
  return transforms
}

function applyElementTransforms(
  elements: readonly EditorUiaElement[],
  transforms: readonly PersistedElementTransform[],
): readonly EditorUiaElement[] {
  // Immutable structural sharing is important for a long quiet history. A
  // no-op observation costs one timestamp, not another full control tree.
  if (transforms.length === 0) return elements
  const byOwner = new Map<string, PersistedElementTransform>()
  for (const transform of transforms) {
    byOwner.set(`${String(transform.display)}:${String(transform.from_z)}`, transform)
  }
  return elements.map((element) => {
    const transform = byOwner.get(`${String(element.display)}:${String(element.window)}`)
    if (transform === undefined) return element
    return {
      ...element,
      bounds: {
        x: element.bounds.x + transform.dx,
        y: element.bounds.y + transform.dy,
        width: element.bounds.width,
        height: element.bounds.height,
      },
      window: transform.to_z,
    }
  })
}

function preferWholeValue<T, P>(
  index: number,
  value: T,
  patch: P,
  sets: Array<[number, T]>,
  patches: Array<[number, P]>,
): void {
  // JSON byte length, not field count, is the persisted cost that matters.
  if (JSON.stringify([index, value]).length <= JSON.stringify([index, patch]).length) {
    sets.push([index, value])
  } else {
    patches.push([index, patch])
  }
}

function windowsDelta(
  previous: readonly EditorUiaWindow[],
  next: readonly EditorUiaWindow[],
): PersistedArrayDelta<EditorUiaWindow, PersistedWindowPatch> | undefined {
  const set: Array<[number, EditorUiaWindow]> = []
  const patch: Array<[number, PersistedWindowPatch]> = []
  const shared = Math.min(previous.length, next.length)
  for (let index = 0; index < shared; index += 1) {
    const before = previous[index]
    const after = next[index]
    if (before === undefined || after === undefined || sameWindow(before, after)) continue
    const change = windowPatch(before, after)
    if (change !== null) preferWholeValue(index, cloneWindow(after), change, set, patch)
  }
  for (let index = shared; index < next.length; index += 1) {
    const value = next[index]
    if (value !== undefined) set.push([index, cloneWindow(value)])
  }
  if (previous.length === next.length && set.length === 0 && patch.length === 0) return undefined
  return {
    ...(previous.length === next.length ? {} : { length: next.length }),
    ...(set.length === 0 ? {} : { set }),
    ...(patch.length === 0 ? {} : { patch }),
  }
}

function elementsDelta(
  previous: readonly EditorUiaElement[],
  next: readonly EditorUiaElement[],
): PersistedArrayDelta<EditorUiaElement, PersistedElementPatch> | undefined {
  const set: Array<[number, EditorUiaElement]> = []
  const patch: Array<[number, PersistedElementPatch]> = []
  const shared = Math.min(previous.length, next.length)
  for (let index = 0; index < shared; index += 1) {
    const before = previous[index]
    const after = next[index]
    if (before === undefined || after === undefined || sameElement(before, after)) continue
    const change = elementPatch(before, after)
    if (change !== null) preferWholeValue(index, cloneElement(after), change, set, patch)
  }
  for (let index = shared; index < next.length; index += 1) {
    const value = next[index]
    if (value !== undefined) set.push([index, cloneElement(value)])
  }
  if (previous.length === next.length && set.length === 0 && patch.length === 0) return undefined
  return {
    ...(previous.length === next.length ? {} : { length: next.length }),
    ...(set.length === 0 ? {} : { set }),
    ...(patch.length === 0 ? {} : { patch }),
  }
}

function deltaOf(
  previous: ContextObservation,
  next: ContextObservation,
): PersistedWindowsContextDelta {
  const transforms = ownerTransforms(previous.windows, next.windows)
  const predictedElements = applyElementTransforms(previous.elements, transforms)
  const windows = windowsDelta(previous.windows, next.windows)
  const elements = elementsDelta(predictedElements, next.elements)
  return {
    t_ms: next.tMs,
    ...(windows === undefined ? {} : { windows }),
    ...(transforms.length === 0 ? {} : { element_transforms: transforms }),
    ...(elements === undefined ? {} : { elements }),
  }
}

function nearestObservation(
  observations: readonly ContextObservation[],
  tMs: number,
): ContextObservation | null {
  let best: ContextObservation | null = null
  let distance = Number.POSITIVE_INFINITY
  for (const observation of observations) {
    const candidateDistance = Math.abs(observation.tMs - tMs)
    // Same tie-break as ContextBuffer.restore: the earlier sorted sample wins.
    if (candidateDistance < distance) {
      best = observation
      distance = candidateDistance
    }
  }
  return best
}

/**
 * Export the exact observation stream consumed by the fresh editor.
 *
 * Supplying a range materialises the editor-nearest observation at `startMs`
 * as the new checkpoint. Later observed samples remain discrete deltas; no
 * observed position is interpolated or inferred.
 */
export function exportWindowsContextTimeline(
  input: readonly ContextObservation[],
  range: WindowsContextExportRange = {},
): WindowsContextTimelineV1 | null {
  if (input.length === 0 || input.length > MAX_DELTAS + 1) return null
  const observations: ContextObservation[] = []
  for (const raw of input) {
    const observation = readObservation(raw)
    if (observation === null) return null
    observations.push(observation)
  }
  observations.sort((left, right) => left.tMs - right.tMs)
  for (let index = 1; index < observations.length; index += 1) {
    const previous = observations[index - 1]
    const current = observations[index]
    if (previous === undefined || current === undefined || current.tMs <= previous.tMs) return null
  }

  const first = observations[0]
  const last = observations[observations.length - 1]
  if (first === undefined || last === undefined) return null
  const startMs = range.startMs ?? first.tMs
  const endMs = range.endMs ?? last.tMs
  const rebaseToMs = range.rebaseToMs ?? startMs
  if (
    !safeInteger(startMs, 0)
    || !safeInteger(endMs, 0)
    || !safeInteger(rebaseToMs, 0)
    || endMs < startMs
    || endMs - startMs > WINDOWS_CONTEXT_TIMELINE_LIMITS.maxDurationMs
  ) {
    return null
  }
  const base = nearestObservation(observations, startMs)
  if (base === null) return null
  const shift = rebaseToMs - startMs
  const rebasedEndMs = endMs + shift
  if (!safeInteger(rebasedEndMs, rebaseToMs)) return null
  const checkpoint: ContextObservation = {
    tMs: rebaseToMs,
    windows: base.windows.map(cloneWindow),
    elements: base.elements.map(cloneElement),
  }
  const selected = observations
    .filter((observation) => observation.tMs > startMs && observation.tMs <= endMs)
    .map((observation) => ({
      tMs: observation.tMs + shift,
      windows: observation.windows.map(cloneWindow),
      elements: observation.elements.map(cloneElement),
    }))
  const deltas: PersistedWindowsContextDelta[] = []
  let previous = checkpoint
  for (const observation of selected) {
    if (!safeInteger(observation.tMs, 0) || observation.tMs <= previous.tMs) return null
    deltas.push(deltaOf(previous, observation))
    previous = observation
  }
  return {
    schema: WINDOWS_CONTEXT_TIMELINE_SCHEMA,
    version: WINDOWS_CONTEXT_TIMELINE_VERSION,
    range: {
      start_ms: rebaseToMs,
      end_ms: rebasedEndMs,
    },
    checkpoint: {
      t_ms: checkpoint.tMs,
      windows: checkpoint.windows.map(cloneWindow),
      elements: checkpoint.elements.map(cloneElement),
    },
    deltas,
  }
}

function readWindowPatch(
  value: unknown,
  budget?: TimelineBudget,
): PersistedWindowPatch | null {
  if (!isRecord(value)) return null
  const patch: PersistedWindowPatch = {}
  let fields = 0
  const optionalString = (key: 'hwnd' | 'surface_id'): boolean => {
    if (!(key in value)) return true
    const item = value[key]
    if (item !== null && !stringValue(item, budget)) return false
    patch[key] = item
    fields += 1
    return true
  }
  const requiredString = (
    key: 'title' | 'process' | 'class_name',
  ): boolean => {
    if (!(key in value)) return true
    const item = value[key]
    if (!stringValue(item, budget)) return false
    patch[key] = item
    fields += 1
    return true
  }
  if (
    !optionalString('hwnd')
    || !optionalString('surface_id')
    || !requiredString('title')
    || !requiredString('process')
    || !requiredString('class_name')
  ) {
    return null
  }
  if ('bounds' in value) {
    const bounds = readRect(value['bounds'])
    if (bounds === null) return null
    patch.bounds = bounds
    fields += 1
  }
  if ('client_bounds' in value) {
    const item = value['client_bounds']
    const bounds = item === null ? null : readRect(item)
    if (item !== null && bounds === null) return null
    patch.client_bounds = bounds
    fields += 1
  }
  if ('display' in value) {
    if (!safeInteger(value['display'], 1)) return null
    patch.display = value['display']
    fields += 1
  }
  if ('focused' in value) {
    if (typeof value['focused'] !== 'boolean') return null
    patch.focused = value['focused']
    fields += 1
  }
  if ('z' in value) {
    if (!safeInteger(value['z'])) return null
    patch.z = value['z']
    fields += 1
  }
  if ('hasControls' in value) {
    if (typeof value['hasControls'] !== 'boolean') return null
    patch.hasControls = value['hasControls']
    fields += 1
  }
  if ('tree' in value) {
    const tree = value['tree']
    if (
      !stringValue(tree, budget)
      || !TREE_STATUSES.has(tree as EditorUiaWindow['tree'])
    ) {
      return null
    }
    patch.tree = tree as EditorUiaWindow['tree']
    fields += 1
  }
  if ('control_geometry_invalidated' in value) {
    const invalidated = value['control_geometry_invalidated']
    if (invalidated !== true && invalidated !== null) return null
    patch.control_geometry_invalidated = invalidated
    fields += 1
  }
  return fields === 0 ? null : patch
}

function readElementPatch(
  value: unknown,
  budget?: TimelineBudget,
): PersistedElementPatch | null {
  if (!isRecord(value)) return null
  const patch: PersistedElementPatch = {}
  let fields = 0
  for (const key of ['name', 'control_type', 'automation_id', 'class_name'] as const) {
    if (!(key in value)) continue
    const item = value[key]
    if (!stringValue(item, budget)) return null
    patch[key] = item
    fields += 1
  }
  if ('bounds' in value) {
    const bounds = readRect(value['bounds'])
    if (bounds === null) return null
    patch.bounds = bounds
    fields += 1
  }
  if ('display' in value) {
    if (!safeInteger(value['display'], 1)) return null
    patch.display = value['display']
    fields += 1
  }
  if ('window' in value) {
    if (!safeInteger(value['window'])) return null
    patch.window = value['window']
    fields += 1
  }
  return fields === 0 ? null : patch
}

function readArrayEntries<T>(
  value: unknown,
  readValue: (item: unknown) => T | null,
  limit: number,
  budget: TimelineBudget,
  recordKey?: 'windowRecords' | 'elementRecords',
): Array<[number, T]> | null {
  if (!Array.isArray(value) || value.length > limit) return null
  if (
    !charge(
      budget,
      'deltaEntries',
      value.length,
      WINDOWS_CONTEXT_TIMELINE_LIMITS.maxDeltaEntries,
    )
    || (
      recordKey !== undefined
      && !charge(
        budget,
        recordKey,
        value.length,
        recordKey === 'windowRecords'
          ? WINDOWS_CONTEXT_TIMELINE_LIMITS.maxWindowRecords
          : WINDOWS_CONTEXT_TIMELINE_LIMITS.maxElementRecords,
      )
    )
  ) {
    return null
  }
  const out: Array<[number, T]> = []
  const seen = new Set<number>()
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2 || !safeInteger(item[0], 0)) return null
    const index = item[0]
    const parsed = readValue(item[1])
    if (parsed === null || index >= limit || seen.has(index)) return null
    seen.add(index)
    out.push([index, parsed])
  }
  return out
}

function readArrayDelta<T, P>(
  value: unknown,
  readValue: (item: unknown) => T | null,
  readPatch: (item: unknown) => P | null,
  limit: number,
  budget: TimelineBudget,
  recordKey: 'windowRecords' | 'elementRecords',
): PersistedArrayDelta<T, P> | null {
  if (!isRecord(value)) return null
  const rawLength = value['length']
  if (rawLength !== undefined && (!safeInteger(rawLength, 0) || rawLength > limit)) return null
  const rawSet = value['set']
  const rawPatch = value['patch']
  const set =
    rawSet === undefined
      ? undefined
      : readArrayEntries(rawSet, readValue, limit, budget, recordKey)
  const patch =
    rawPatch === undefined
      ? undefined
      : readArrayEntries(rawPatch, readPatch, limit, budget)
  if (set === null || patch === null) return null
  if (rawLength === undefined && set === undefined && patch === undefined) return null
  const touched = new Set(set?.map(([index]) => index) ?? [])
  if (patch?.some(([index]) => touched.has(index)) === true) return null
  return {
    ...(rawLength === undefined ? {} : { length: rawLength }),
    ...(set === undefined ? {} : { set }),
    ...(patch === undefined ? {} : { patch }),
  }
}

function readTransforms(
  value: unknown,
  budget: TimelineBudget,
): PersistedElementTransform[] | null {
  if (!Array.isArray(value) || value.length > MAX_WINDOWS) return null
  if (
    !charge(
      budget,
      'deltaEntries',
      value.length,
      WINDOWS_CONTEXT_TIMELINE_LIMITS.maxDeltaEntries,
    )
  ) {
    return null
  }
  const transforms: PersistedElementTransform[] = []
  const owners = new Set<string>()
  for (const item of value) {
    if (!isRecord(item)) return null
    const display = item['display']
    const fromZ = item['from_z']
    const toZ = item['to_z']
    const dx = item['dx']
    const dy = item['dy']
    if (
      !safeInteger(display, 1)
      || !safeInteger(fromZ)
      || !safeInteger(toZ)
      || !finiteNumber(dx)
      || !finiteNumber(dy)
    ) {
      return null
    }
    const owner = `${String(display)}:${String(fromZ)}`
    if (owners.has(owner)) return null
    owners.add(owner)
    transforms.push({ display, from_z: fromZ, to_z: toZ, dx, dy })
  }
  return transforms
}

function applyWindowPatch(
  value: EditorUiaWindow,
  patch: PersistedWindowPatch,
): EditorUiaWindow | null {
  const next: UnknownRecord = {
    ...value,
    bounds: cloneRect(value.bounds),
    ...(value.client_bounds === undefined
      ? {}
      : { client_bounds: cloneRect(value.client_bounds) }),
  }
  for (const [key, item] of Object.entries(patch)) {
    if (item === null) delete next[key]
    else next[key] = item
  }
  return readWindow(next)
}

function applyElementPatch(
  value: EditorUiaElement,
  patch: PersistedElementPatch,
): EditorUiaElement | null {
  return readElement({
    ...value,
    ...patch,
    bounds: patch.bounds === undefined ? cloneRect(value.bounds) : cloneRect(patch.bounds),
  })
}

function applyArrayDelta<T, P>(
  previous: readonly T[],
  delta: PersistedArrayDelta<T, P> | undefined,
  clone: (value: T) => T,
  applyPatch: (value: T, patch: P) => T | null,
  limit: number,
): readonly T[] | null {
  if (delta === undefined) return previous
  const next: Array<T | undefined> = previous.slice()
  if (delta.length !== undefined) next.length = delta.length
  for (const [index, value] of delta.set ?? []) {
    if (index >= next.length) return null
    next[index] = clone(value)
  }
  for (const [index, patch] of delta.patch ?? []) {
    const value = next[index]
    if (value === undefined) return null
    const changed = applyPatch(value, patch)
    if (changed === null) return null
    next[index] = changed
  }
  if (next.length > limit || next.some((value) => value === undefined)) return null
  return next as T[]
}

function decodeParsed(
  timeline: WindowsContextTimelineV1,
  budget: TimelineBudget,
): ContextObservation[] | null {
  if (
    !charge(
      budget,
      'windowDecodeWork',
      timeline.checkpoint.windows.length,
      WINDOWS_CONTEXT_TIMELINE_LIMITS.maxWindowDecodeWork,
    )
    || !charge(
      budget,
      'elementDecodeWork',
      timeline.checkpoint.elements.length,
      WINDOWS_CONTEXT_TIMELINE_LIMITS.maxElementDecodeWork,
    )
  ) {
    return null
  }
  const observations: ContextObservation[] = [{
    tMs: timeline.checkpoint.t_ms,
    windows: timeline.checkpoint.windows.map(cloneWindow),
    elements: timeline.checkpoint.elements.map(cloneElement),
  }]
  for (const delta of timeline.deltas) {
    const previous = observations[observations.length - 1]
    if (previous === undefined) return null
    const transforms = delta.element_transforms ?? []
    if (
      (
        delta.windows !== undefined
        && !charge(
          budget,
          'windowDecodeWork',
          previous.windows.length,
          WINDOWS_CONTEXT_TIMELINE_LIMITS.maxWindowDecodeWork,
        )
      )
      || (
        transforms.length > 0
        && !charge(
          budget,
          'elementDecodeWork',
          previous.elements.length,
          WINDOWS_CONTEXT_TIMELINE_LIMITS.maxElementDecodeWork,
        )
      )
    ) {
      return null
    }
    const transformed = applyElementTransforms(
      previous.elements,
      transforms,
    )
    if (
      delta.elements !== undefined
      && !charge(
        budget,
        'elementDecodeWork',
        transformed.length,
        WINDOWS_CONTEXT_TIMELINE_LIMITS.maxElementDecodeWork,
      )
    ) {
      return null
    }
    const windows = applyArrayDelta(
      previous.windows,
      delta.windows,
      cloneWindow,
      applyWindowPatch,
      MAX_WINDOWS,
    )
    const elements = applyArrayDelta(
      transformed,
      delta.elements,
      cloneElement,
      applyElementPatch,
      MAX_ELEMENTS,
    )
    if (windows === null || elements === null) return null
    observations.push({ tMs: delta.t_ms, windows, elements })
  }
  return observations
}

/**
 * Parse a timeline from an untrusted pack. The returned value is canonical and
 * has already been replayed once, so sparse additions and invalid patches
 * cannot defer a failure until the editor consumes it.
 */
function readWindowsContextTimeline(
  value: unknown,
  budget: TimelineBudget,
): WindowsContextTimelineV1 | null {
  if (!isRecord(value)) return null
  if (
    value['schema'] !== WINDOWS_CONTEXT_TIMELINE_SCHEMA
    || value['version'] !== WINDOWS_CONTEXT_TIMELINE_VERSION
  ) {
    return null
  }
  const rawRange = value['range']
  const rawCheckpoint = value['checkpoint']
  const rawDeltas = value['deltas']
  if (!isRecord(rawRange) || !isRecord(rawCheckpoint) || !Array.isArray(rawDeltas)) return null
  const startMs = rawRange['start_ms']
  const endMs = rawRange['end_ms']
  const checkpointMs = rawCheckpoint['t_ms']
  if (
    !safeInteger(startMs, 0)
    || !safeInteger(endMs, 0)
    || endMs < startMs
    || endMs - startMs > WINDOWS_CONTEXT_TIMELINE_LIMITS.maxDurationMs
    || checkpointMs !== startMs
    || rawDeltas.length > MAX_DELTAS
    || !charge(
      budget,
      'deltaEntries',
      rawDeltas.length,
      WINDOWS_CONTEXT_TIMELINE_LIMITS.maxDeltaEntries,
    )
  ) {
    return null
  }
  const rawWindows = rawCheckpoint['windows']
  const rawElements = rawCheckpoint['elements']
  if (
    !Array.isArray(rawWindows)
    || rawWindows.length > MAX_WINDOWS
    || !Array.isArray(rawElements)
    || rawElements.length > MAX_ELEMENTS
    || !charge(
      budget,
      'windowRecords',
      rawWindows.length,
      WINDOWS_CONTEXT_TIMELINE_LIMITS.maxWindowRecords,
    )
    || !charge(
      budget,
      'elementRecords',
      rawElements.length,
      WINDOWS_CONTEXT_TIMELINE_LIMITS.maxElementRecords,
    )
  ) {
    return null
  }
  const windows: EditorUiaWindow[] = []
  const elements: EditorUiaElement[] = []
  for (const item of rawWindows) {
    const window = readWindow(item, budget)
    if (window === null) return null
    windows.push(window)
  }
  for (const item of rawElements) {
    const element = readElement(item, budget)
    if (element === null) return null
    elements.push(element)
  }
  const deltas: PersistedWindowsContextDelta[] = []
  let previousMs = startMs
  for (const rawDelta of rawDeltas) {
    if (!isRecord(rawDelta)) return null
    const tMs = rawDelta['t_ms']
    if (!safeInteger(tMs, 0) || tMs <= previousMs || tMs > endMs) return null
    const rawWindowDelta = rawDelta['windows']
    const rawElementDelta = rawDelta['elements']
    const rawTransforms = rawDelta['element_transforms']
    const windowDelta = rawWindowDelta === undefined
      ? undefined
      : readArrayDelta(
          rawWindowDelta,
          (item) => readWindow(item, budget),
          (item) => readWindowPatch(item, budget),
          MAX_WINDOWS,
          budget,
          'windowRecords',
        )
    const elementDelta = rawElementDelta === undefined
      ? undefined
      : readArrayDelta(
          rawElementDelta,
          (item) => readElement(item, budget),
          (item) => readElementPatch(item, budget),
          MAX_ELEMENTS,
          budget,
          'elementRecords',
        )
    const transforms =
      rawTransforms === undefined ? undefined : readTransforms(rawTransforms, budget)
    if (windowDelta === null || elementDelta === null || transforms === null) return null
    deltas.push({
      t_ms: tMs,
      ...(windowDelta === undefined ? {} : { windows: windowDelta }),
      ...(transforms === undefined ? {} : { element_transforms: transforms }),
      ...(elementDelta === undefined ? {} : { elements: elementDelta }),
    })
    previousMs = tMs
  }
  const parsed: WindowsContextTimelineV1 = {
    schema: WINDOWS_CONTEXT_TIMELINE_SCHEMA,
    version: WINDOWS_CONTEXT_TIMELINE_VERSION,
    range: { start_ms: startMs, end_ms: endMs },
    checkpoint: {
      t_ms: startMs,
      windows,
      elements,
    },
    deltas,
  }
  return parsed
}

export function parseWindowsContextTimeline(value: unknown): WindowsContextTimelineV1 | null {
  const budget = emptyBudget()
  const parsed = readWindowsContextTimeline(value, budget)
  return parsed === null || decodeParsed(parsed, budget) === null ? null : parsed
}

/** Parse and materialise once when a caller needs both metadata and frames. */
export function decodeWindowsContextTimeline(
  value: unknown,
): { timeline: WindowsContextTimelineV1; observations: ContextObservation[] } | null {
  const budget = emptyBudget()
  const timeline = readWindowsContextTimeline(value, budget)
  if (timeline === null) return null
  const observations = decodeParsed(timeline, budget)
  return observations === null ? null : { timeline, observations }
}

export const WINDOWS_CONTEXT_TIMELINE_PACK_PATH =
  'plugins/windows-context/timeline.json'

export type WindowsContextHistoryLoad =
  | {
      status: 'loaded'
      timeline: WindowsContextTimelineV1
      observations: ContextObservation[]
      bytes: number
    }
  | {
      status: 'dropped'
      reason:
        | 'missing'
        | 'too-large'
        | 'read-error'
        | 'invalid-json'
        | 'invalid-timeline'
        | 'outside-replay-clock'
      bytes: number | null
    }

/**
 * Reads one persisted history through the existing directory/ZIP PackHandle
 * abstraction without ever inflating/reading an entry whose declared size is
 * above the cap. A post-read byte check closes the directory replacement race
 * and protects against a dishonest archive header.
 *
 * Every failure is data-local: callers drop only this optional history and
 * continue opening the editor with the pack's pixels and static object data.
 */
export function loadWindowsContextHistory(
  pack: {
    fileSize(rel: string): number | null
    readText(rel: string): string | null
  },
  declaredReplayDurationMs: number,
  options: { maxFileBytes?: number } = {},
): WindowsContextHistoryLoad {
  const requestedMax = options.maxFileBytes
  const maxFileBytes =
    typeof requestedMax === 'number'
    && Number.isSafeInteger(requestedMax)
    && requestedMax >= 0
      ? Math.min(requestedMax, WINDOWS_CONTEXT_MAX_FILE_BYTES)
      : WINDOWS_CONTEXT_MAX_FILE_BYTES
  let declaredBytes: number | null = null
  let text: string | null = null
  try {
    declaredBytes = pack.fileSize(WINDOWS_CONTEXT_TIMELINE_PACK_PATH)
    if (declaredBytes === null) {
      return { status: 'dropped', reason: 'missing', bytes: null }
    }
    if (
      !Number.isSafeInteger(declaredBytes)
      || declaredBytes < 0
      || declaredBytes > maxFileBytes
    ) {
      return { status: 'dropped', reason: 'too-large', bytes: declaredBytes }
    }
    text = pack.readText(WINDOWS_CONTEXT_TIMELINE_PACK_PATH)
  } catch {
    return { status: 'dropped', reason: 'read-error', bytes: declaredBytes }
  }
  if (text === null) {
    return { status: 'dropped', reason: 'missing', bytes: declaredBytes }
  }
  const actualBytes = Buffer.byteLength(text, 'utf8')
  if (actualBytes > maxFileBytes) {
    return { status: 'dropped', reason: 'too-large', bytes: actualBytes }
  }
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    return { status: 'dropped', reason: 'invalid-json', bytes: actualBytes }
  }
  const decoded = decodeWindowsContextTimeline(value)
  if (decoded === null) {
    return { status: 'dropped', reason: 'invalid-timeline', bytes: actualBytes }
  }
  if (
    !finiteNumber(declaredReplayDurationMs)
    || declaredReplayDurationMs < 0
    || decoded.timeline.range.start_ms < 0
    || decoded.timeline.range.end_ms > declaredReplayDurationMs
  ) {
    return {
      status: 'dropped',
      reason: 'outside-replay-clock',
      bytes: actualBytes,
    }
  }
  return {
    status: 'loaded',
    timeline: decoded.timeline,
    observations: decoded.observations,
    bytes: actualBytes,
  }
}

/** Import an untrusted JSON value into the exact observation stream. */
export function importWindowsContextTimeline(value: unknown): ContextObservation[] | null {
  return decodeWindowsContextTimeline(value)?.observations ?? null
}

/**
 * Restore with the same nearest-observation and earlier-on-tie rule as
 * ContextBuffer. Observed rectangles remain stepwise; this does not interpolate.
 */
export function restoreWindowsContextTimeline(
  value: unknown,
  tMs: number,
): ContextObservation | null {
  if (!finiteNumber(tMs)) return null
  const observations = importWindowsContextTimeline(value)
  if (observations === null) return null
  return nearestObservation(observations, tMs)
}

/** Trim an existing timeline and rebase its selected range to pack time zero. */
export function trimWindowsContextTimeline(
  value: unknown,
  startMs: number,
  endMs: number,
): WindowsContextTimelineV1 | null {
  if (!safeInteger(startMs, 0) || !safeInteger(endMs, 0) || endMs < startMs) return null
  const observations = importWindowsContextTimeline(value)
  if (observations === null) return null
  return exportWindowsContextTimeline(observations, {
    startMs,
    endMs,
    rebaseToMs: 0,
  })
}
