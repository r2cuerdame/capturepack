// MCP tool registrations (all read-only). Each tool answers with compact JSON
// in a text block (capturepack_frame adds an image block); descriptions are
// written so an LLM can use each tool without any other documentation.
//
// i18n NOTE (GOAL "Internationalization"): tool names, descriptions, and
// response shapes deliberately stay ENGLISH in every UI language — they are an
// LLM-facing API surface (like the SPEC), not app UI, and are never routed
// through shared/i18n.ts.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { Annotation, Manifest, ManifestKeyframe, TimelineEvent } from '../../shared/types'
import {
  annotationDisplayIndex,
  declaredDisplayIndices,
  focusedDisplayIndex,
} from '../../shared/types'
import { captureMediaForMcp, type McpCaptureMedia } from '../../shared/captureMedia'
import { computeDisplayNumbers } from '../../shared/numbering'
import { errorMessage, type PackHandle, type PackStore } from './store'

const MAX_HITS_PER_GROUP = 100
const MAX_JSON_MATCHES = 100
const MAX_PLUGIN_FILE_CHARS = 100_000

export interface ToolOptions {
  logRequests: boolean
}

export function registerTools(server: McpServer, store: PackStore, options: ToolOptions): void {
  const idArg = {
    id: z
      .string()
      .optional()
      .describe(
        'Which pack to read: a pack id from capturepack_history / capturepack_list, or an absolute path to a ' +
          '.capturepack file or extracted pack folder. Omit to use the current default pack ' +
          '(the one pinned by capturepack_open / capturepack_latest, otherwise the most recent ' +
          'pack in the export folder).',
      ),
  }
  const historyInputSchema = {
    limit: z.number().int().min(1).max(100).optional().describe('Maximum matching packs to return (default 20).'),
    query: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Case-insensitive search across id, title, note, focused app and path.'),
    kind: z
      .enum(['image', 'video'])
      .optional()
      .describe('Return only still-image packs or only video packs.'),
  }

  function historyResult(args: {
    limit?: number
    query?: string
    kind?: 'image' | 'video'
  }): CallToolResult {
    const limit = args.limit ?? 20
    const filtered = args.query !== undefined || args.kind !== undefined
    // Without filters only the rows the caller requested are opened. A filtered
    // history has to inspect each manifest because title/note/capture_kind live
    // inside the pack rather than in a filename.
    const { total, packs } = store.list(filtered ? Number.MAX_SAFE_INTEGER : limit)
    const query = args.query?.toLocaleLowerCase()
    const matches: Array<Record<string, unknown>> = []
    for (const entry of packs) {
      try {
        const pack = store.resolve(entry.id)
        const manifest = pack.manifest()
        const captureMedia = captureMediaForMcp(manifest)
        const annotations = annotationList(pack)
        const plugins = pack.plugins()
        const timeline = pack.timeline()
        const events = Array.isArray(timeline?.events) ? timeline.events : []
        const title = manifest?.title ?? entry.title
        const note = manifest?.note ?? null
        const app = manifest?.environment?.app ?? null
        const haystack = [entry.id, title, note, app, entry.path]
          .filter((value): value is string => typeof value === 'string')
          .join('\n')
          .toLocaleLowerCase()
        if (args.kind !== undefined && captureMedia.capture_kind !== args.kind) continue
        if (query !== undefined && !haystack.includes(query)) continue
        matches.push({
          id: entry.id,
          path: entry.path,
          captured_at: manifest?.created_at ?? entry.capturedAt,
          kind: captureMedia.capture_kind,
          capture_kind: captureMedia.capture_kind,
          capture_kind_inferred: captureMedia.legacy_inferred,
          storage_kind: entry.kind,
          title,
          note,
          focused_app: app,
          counts: {
            annotations: annotations.length,
            plugins: plugins.length,
            ...(captureMedia.capture_kind === 'video' ? { timeline_events: events.length } : {}),
          },
          ...(entry.warning !== null ? { warning: entry.warning } : {}),
        })
      } catch (err) {
        const haystack = [entry.id, entry.title, entry.path]
          .filter((value): value is string => typeof value === 'string')
          .join('\n')
          .toLocaleLowerCase()
        if (args.kind !== undefined || (query !== undefined && !haystack.includes(query))) continue
        matches.push({
          id: entry.id,
          path: entry.path,
          captured_at: entry.capturedAt,
          kind: null,
          capture_kind: null,
          storage_kind: entry.kind,
          title: entry.title,
          note: null,
          counts: null,
          warning: entry.warning ?? `unreadable pack: ${errorMessage(err)}`,
        })
      }
    }
    const returned = matches.slice(0, limit).map((pack, index) => ({ n: index + 1, ...pack }))
    return jsonResult({
      output_dir: store.outputDir,
      total,
      matched_total: filtered ? matches.length : total,
      returned: returned.length,
      packs: returned,
      next: 'Pass a pack id to capturepack_open, or as id to any capturepack_* reader.',
    })
  }

  async function run(
    name: string,
    args: Record<string, unknown>,
    fn: () => CallToolResult | Promise<CallToolResult>,
  ): Promise<CallToolResult> {
    if (options.logRequests) console.log(`capturepack: mcp ${name}(${JSON.stringify(args)})`)
    try {
      return await fn()
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: errorMessage(err) }) }],
      }
    }
  }

  server.registerTool(
    'capturepack_latest',
    {
      title: 'Latest CapturePack',
      description:
        'Summary of the MOST RECENT CapturePack in the export folder, and pin it as the default ' +
        'pack for all other capturepack_* tools. Use capturepack_history when the requested pack ' +
        'may not be newest. A CapturePack is a user-created local still-image or video context ' +
        'capture with annotations. Video packs may have an event timeline; image packs do not.',
      inputSchema: {},
    },
    (args) => run('capturepack_latest', args, () => jsonResult(summarize(store.latest()))),
  )

  server.registerTool(
    'capturepack_history',
    {
      title: 'Browse CapturePack history',
      description:
        'Browse saved CapturePacks newest first without changing the current pack. Returns stable ' +
        'id/path/captured_at, image-or-video kind, title, note, focused app and situational counts. ' +
        'Filter by text or capture kind, then pass an id to capturepack_open or any other tool.',
      inputSchema: historyInputSchema,
    },
    (args) => run('capturepack_history', args, () => historyResult(args)),
  )

  server.registerTool(
    'capturepack_list',
    {
      title: 'List CapturePacks',
      description:
        'Alias of capturepack_history for compatibility. Lists saved packs newest first with ' +
        'search/kind filters, notes and counts; use capturepack_open on the selected id.',
      inputSchema: historyInputSchema,
    },
    (args) => run('capturepack_list', args, () => historyResult(args)),
  )

  server.registerTool(
    'capturepack_open',
    {
      title: 'Open a CapturePack',
      description:
        'Open a specific CapturePack by id (from capturepack_history / capturepack_list) or absolute path (.capturepack ' +
        'zip file or extracted pack folder), pin it as the default pack for subsequent ' +
        'capturepack_* calls in this session, and return its summary.',
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe('Pack id from capturepack_history / capturepack_list, or an absolute path to a .capturepack file or pack folder.'),
      },
    },
    (args) => run('capturepack_open', args, () => jsonResult(summarize(store.open(args.id)))),
  )

  server.registerTool(
    'capturepack_summary',
    {
      title: 'Pack summary',
      description:
        'Compact summary of a CapturePack: title, note, capture time, environment (OS, screens, ' +
        'focused app), explicit/inferred capture_kind, snapshot scope/crop provenance, annotations ' +
        'and plugin list; video summaries also include replay/timeline details. Does not ' +
        'change the pinned default pack.',
      inputSchema: idArg,
    },
    (args) => run('capturepack_summary', args, () => jsonResult(summarize(store.resolve(args.id)))),
  )

  server.registerTool(
    'capturepack_manifest',
    {
      title: 'Raw manifest.json',
      description:
        'The raw manifest.json of a CapturePack: format version, pack id, capture time, generator, ' +
        'environment, media inventory (snapshot/replay) and declared plugins.',
      inputSchema: idArg,
    },
    (args) =>
      run('capturepack_manifest', args, () => {
        const pack = store.resolve(args.id)
        const text = pack.manifestText()
        if (text === null) return errorResult(`manifest.json not found in pack "${pack.id}" (${pack.path})`)
        return textResult(text)
      }),
  )

  server.registerTool(
    'capturepack_report',
    {
      title: 'Human-readable report',
      description:
        'The report.md of a CapturePack: a human-written/generated Markdown report describing the ' +
        'capture (title, note, environment, annotation list). The best single document to read ' +
        'when analyzing a pack.',
      inputSchema: idArg,
    },
    (args) =>
      run('capturepack_report', args, () => {
        const pack = store.resolve(args.id)
        const text = pack.report()
        if (text === null) return errorResult(`report.md not found in pack "${pack.id}" (${pack.path})`)
        return textResult(text)
      }),
  )

  server.registerTool(
    'capturepack_timeline',
    {
      title: 'Event timeline',
      description:
        'Machine-readable timeline events of a VIDEO CapturePack (capture trigger, annotations added, ' +
        'plugin events, export). Each event has t_ms (milliseconds since capture start t0), type, ' +
        'source, and optional data. Optionally slice by from_ms/to_ms. Explicit still-image packs ' +
        'intentionally have no timeline and return an explanatory empty result.',
      inputSchema: {
        ...idArg,
        from_ms: z.number().min(0).optional().describe('Only events with t_ms >= from_ms.'),
        to_ms: z.number().min(0).optional().describe('Only events with t_ms <= to_ms.'),
      },
    },
    (args) =>
      run('capturepack_timeline', args, () => {
        const pack = store.resolve(args.id)
        const timeline = pack.timeline()
        if (!timeline) {
          const captureMedia = captureMediaForMcp(pack.manifest())
          if (captureMedia.capture_kind === 'image' && !captureMedia.legacy_inferred) {
            return jsonResult({
              pack: pack.id,
              capture_kind: 'image',
              available: false,
              message:
                'This is a still-image CapturePack. timeline.json is intentionally absent; read snapshot.png, annotations and plugin context.',
            })
          }
          return errorResult(`timeline.json missing or malformed in video pack "${pack.id}"`)
        }
        const all = Array.isArray(timeline.events) ? timeline.events : []
        const events = all.filter(
          (e) => (args.from_ms === undefined || e.t_ms >= args.from_ms) && (args.to_ms === undefined || e.t_ms <= args.to_ms),
        )
        return jsonResult({ pack: pack.id, t0: timeline.t0, total_events: all.length, returned: events.length, events })
      }),
  )

  server.registerTool(
    'capturepack_annotations',
    {
      title: 'Annotations',
      description:
        'All annotation boxes of a CapturePack as data: annotation_id, bounds {x, y, width, height} ' +
        'in snapshot pixels, text, numbered/blur flags, optional lifetime (start_ms..end_ms on the ' +
        'replay clock, both or neither; the representative instant is the midpoint), optional ' +
        'style.color, and z stacking order. A box MAY also carry "target": the real UI object it ' +
        'was placed on, e.g. {source:"uia", name:"Save", control_type:"Button", automation_id, ' +
        'class_name} from Windows UI Automation at the capture instant — that is the box\'s ' +
        'meaning ("the Save button"), while its geometry always comes from bounds alone. ' +
        'reference_width/reference_height describe the FOCUSED display\'s snapshot.png and nothing ' +
        'else — they are not the size of the desk and not the frame of a box on another screen. ' +
        'MULTI-DISPLAY: when the capture froze more than one screen, every box also reports the ' +
        'display it was drawn on. The stored field is "display" (1-based manifest ' +
        'media.displays[].index, ABSENT = the focused display); each returned box additionally ' +
        'carries a resolved "display_index", the "display_snapshot" file its bounds are pixels ' +
        'in, and that file\'s own "display_width"/"display_height" — bounds are ALWAYS in that ' +
        'display\'s own snapshot, never the focused one\'s, so measure them against those. ' +
        'Format 0.7.0 makes manifest.media.displays REQUIRED, so ask it how many screens the pack ' +
        'holds; a pack older than 0.7.0 omits it and is one display, the focused one. ' +
        'Display numbers are computed, never stored, and run as ONE sequence across all displays.',
      inputSchema: idArg,
    },
    (args) =>
      run('capturepack_annotations', args, () => {
        const pack = store.resolve(args.id)
        const file = pack.annotations()
        if (!file) return errorResult(`annotations.json missing or malformed in pack "${pack.id}"`)
        const list = Array.isArray(file.annotations) ? file.annotations : []
        return jsonResult({
          pack: pack.id,
          reference_width: file.reference_width,
          reference_height: file.reference_height,
          count: list.length,
          annotations: withDisplayContext(pack, list),
        })
      }),
  )

  server.registerTool(
    'capturepack_find_annotations',
    {
      title: 'Find annotations',
      description:
        'Case-insensitive keyword search over the annotation box texts of a CapturePack. ' +
        'Returns the matching annotations with all their fields.',
      inputSchema: {
        keyword: z.string().min(1).describe('Substring to look for in annotation texts (case-insensitive).'),
        ...idArg,
      },
    },
    (args) =>
      run('capturepack_find_annotations', args, () => {
        const pack = store.resolve(args.id)
        const list = annotationList(pack)
        const kw = args.keyword.toLowerCase()
        const matches = list.filter((a) => {
          const text = annotationText(a)
          return text !== null && text.toLowerCase().includes(kw)
        })
        return jsonResult({
          pack: pack.id,
          keyword: args.keyword,
          count: matches.length,
          annotations: withDisplayContext(pack, matches),
        })
      }),
  )

  server.registerTool(
    'capturepack_frame',
    {
      title: 'Frame at a time',
      description:
        'A frame of the capture as a PNG image. Pass time_s (seconds on the replay timeline) for ' +
        'the moment you want. When the pack has ANNOTATED KEYFRAMES (manifest.media.keyframes — ' +
        'stills rendered at every annotation state change, with blur, borders, number badges and ' +
        'text drawn in), the NEAREST keyframe to time_s is returned; the response lists every ' +
        'keyframe time so you can walk the story image by image. Without keyframes — and whenever ' +
        'time_s is omitted — the exported snapshot.png is returned, with a note stating its frame ' +
        'time. Frames at arbitrary replay times are never decoded out of the video.',
      inputSchema: {
        ...idArg,
        time_s: z.number().min(0).optional().describe('Requested time in seconds on the replay timeline.'),
      },
    },
    (args) =>
      run('capturepack_frame', args, () => {
        const pack = store.resolve(args.id)
        const manifest = pack.manifest()
        const captureMedia = captureMediaForMcp(manifest)
        const keyframes = keyframeList(manifest)
        const times = keyframes.map((k) => `${(k.t_ms / 1000).toFixed(3)}s`).join(', ')

        // Annotated keyframes (SPEC §5.7) answer "what did it look like at t"
        // far better than the snapshot: they carry the annotations themselves.
        if (args.time_s !== undefined && keyframes.length > 0) {
          const wantMs = args.time_s * 1000
          let best = keyframes[0] as ManifestKeyframe
          for (const k of keyframes) {
            if (Math.abs(k.t_ms - wantMs) < Math.abs(best.t_ms - wantMs)) best = k
          }
          const framePng = pack.readBinary(best.file)
          if (framePng) {
            const n = keyframes.indexOf(best) + 1
            const imageBoundary =
              captureMedia.capture_kind === 'image' &&
              captureMedia.snapshot.scope === 'region'
                ? ' It is derived only from the user-selected crop; no outside pixels are stored.'
                : ''
            return {
              content: [
                { type: 'image', data: framePng.toString('base64'), mimeType: 'image/png' },
                {
                  type: 'text',
                  text:
                    `Annotated keyframe ${n}/${keyframes.length} (${best.file}) at ` +
                    `${(best.t_ms / 1000).toFixed(3)}s — the nearest state change to the requested ` +
                    `${args.time_s}s. Annotations (blur, borders, numbers, text) are rendered into ` +
                    `this image; snapshot.png is never annotated. Keyframe times: ${times}.` +
                    imageBoundary,
                },
              ],
            }
          }
        }

        // The current format has exactly one source image name. In particular,
        // never probe for a "context-full" sibling of a region capture.
        const snapshotFile = captureMedia.snapshot.file
        const png = pack.readBinary(snapshotFile)
        if (!png) return errorResult(`${snapshotFile} not found in pack "${pack.id}"`)
        const snapT = manifest?.media?.snapshot_t_ms
        const snapDesc = typeof snapT === 'number' ? `${(snapT / 1000).toFixed(1)}s on the replay timeline` : 'the capture instant'
        const keyframeNote =
          keyframes.length === 0
            ? ' This pack has no annotated keyframes (they render in the background after save), so ' +
              'no frame is available at other times.'
            : ` This pack has ${keyframes.length} annotated keyframe(s) at ${times} — pass time_s to get ` +
              'the nearest one, with the annotations rendered in.'
        const note =
          args.time_s === undefined
            ? `${snapshotDescription(captureMedia)}. Frame time: ${snapDesc} (original pixels, no annotations).${keyframeNote}`
            : `Requested ${args.time_s}s; returned the exported snapshot frame, which is from ${snapDesc}.` +
              keyframeNote
        return {
          content: [
            { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
            { type: 'text', text: note },
          ],
        }
      }),
  )

  server.registerTool(
    'capturepack_replay',
    {
      title: 'Replay metadata',
      description:
        'Metadata about the screen replay video of a CapturePack: filename, duration_ms and ' +
        'size_bytes. Never returns raw video bytes. Screenshot-only packs have no replay.',
      inputSchema: idArg,
    },
    (args) =>
      run('capturepack_replay', args, () => {
        const pack = store.resolve(args.id)
        const manifest = pack.manifest()
        const captureMedia = captureMediaForMcp(manifest)
        const replay = captureMedia.replay
        if (replay === null) {
          return jsonResult({
            pack: pack.id,
            capture_kind: captureMedia.capture_kind,
            replay: null,
            message:
              captureMedia.capture_kind === 'image'
                ? 'Image capture: this user-created pack has no replay video.'
                : 'No valid replay is declared by this pack.',
          })
        }
        return jsonResult({
          pack: pack.id,
          capture_kind: captureMedia.capture_kind,
          replay: {
            filename: replay.filename,
            duration_ms: replay.duration_ms,
            size_bytes: pack.fileSize(replay.filename),
          },
        })
      }),
  )

  server.registerTool(
    'capturepack_dom',
    {
      title: 'DOM / plugin metadata',
      description:
        'Generic plugin metadata of a CapturePack: every JSON file under plugins/*/ parsed and ' +
        'returned as-is. On Windows the "windows-uia" plugin is the usual one: elements.json holds ' +
        'the top-level window list and the UI Automation control trees of the windows the dump ' +
        'reached at the capture instant (name, control_type, automation_id, class_name, bounds in ' +
        'SNAPSHOT pixel coordinates, depth, and window = the z of the owning window) — that is ' +
        'what annotation targets are picked from. Each windows[] entry carries tree: "collected" | ' +
        '"truncated" | "unavailable" | "skipped"; anything but "collected" means no controls were ' +
        'RECORDED for that window, which never means the window had none (Chromium and Electron ' +
        'windows expose no tree unless an assistive client asks). DOM data contributed by the ' +
        'Chrome extension lives under a chrome plugin directory when present. Packs without ' +
        'plugin data return an empty list with a message.',
      inputSchema: idArg,
    },
    (args) =>
      run('capturepack_dom', args, () => {
        const pack = store.resolve(args.id)
        const plugins = pluginJsonContents(pack)
        if (plugins.length === 0) {
          return jsonResult({
            pack: pack.id,
            plugins: [],
            message:
              'No plugin metadata in this pack (no plugins/ directory). Object data appears here as a ' +
              '"windows-uia" plugin when the capture could read the Windows UI Automation tree, and DOM ' +
              'data once a browser plugin contributed it.',
          })
        }
        return jsonResult({ pack: pack.id, plugins })
      }),
  )

  server.registerTool(
    'capturepack_find_dom',
    {
      title: 'Find in DOM / plugin metadata',
      description:
        'Case-insensitive substring search for a CSS selector, element id, text or any string ' +
        'inside the plugin JSON metadata of a CapturePack (plugins/*/*.json). Returns each match ' +
        'with its plugin, file and JSON path.',
      inputSchema: {
        selector: z.string().min(1).describe('Substring to look for (e.g. "#save", "button", "login") — matched case-insensitively against every string value in the plugin JSON.'),
        ...idArg,
      },
    },
    (args) =>
      run('capturepack_find_dom', args, () => {
        const pack = store.resolve(args.id)
        const kw = args.selector.toLowerCase()
        const matches: Array<{ plugin: string; file: string; json_path: string; value: string }> = []
        for (const plugin of pluginJsonContents(pack)) {
          for (const file of plugin.files) {
            if (file.json === undefined) continue
            for (const hit of findStrings(file.json, (s) => s.toLowerCase().includes(kw), MAX_JSON_MATCHES - matches.length)) {
              matches.push({ plugin: plugin.name, file: file.file, json_path: hit.path, value: cap(hit.value, 300) })
            }
            if (matches.length >= MAX_JSON_MATCHES) break
          }
        }
        const message = matches.length === 0 ? 'No matches. This pack may have no DOM/plugin metadata — check capturepack_dom.' : undefined
        return jsonResult({ pack: pack.id, selector: args.selector, count: matches.length, matches, ...(message ? { message } : {}) })
      }),
  )

  server.registerTool(
    'capturepack_windows',
    {
      title: 'Window focus timeline',
      description:
        'Window-related context of a CapturePack: video timeline events whose type or source mentions ' +
        'window/focus — including the observed "input.window.focus", "input.window.move" and ' +
        '"input.window.resize" events a 0.8.0 pack records DURING the replay, each carrying the ' +
        'window title/process and, for a move or resize, its bounds in that display\'s snapshot ' +
        'pixels — plus any window-tracking plugin metadata — on Windows that is the ' +
        '"windows-uia" payload, whose windows[] lists every top-level window at the capture ' +
        'instant (title, process, class_name, bounds in the snapshot pixels of the display in ' +
        '"display" — absent means the focused display — z-order with 0 on top, which one had ' +
        'focus, and whether its control tree was collected). Returns empty lists ' +
        'with a message when the pack has no window data.',
      inputSchema: idArg,
    },
    (args) =>
      run('capturepack_windows', args, () => {
        const pack = store.resolve(args.id)
        const timeline = pack.timeline()
        const all = Array.isArray(timeline?.events) ? timeline.events : []
        const events = all.filter((e) => /window|focus/i.test(`${e.type} ${e.source}`))
        const plugins = pluginJsonContents(pack).filter((p) => /window/i.test(p.name))
        const empty = events.length === 0 && plugins.length === 0
        return jsonResult({
          pack: pack.id,
          window_events: events,
          window_plugins: plugins,
          ...(empty ? { message: 'No window-tracking data in this pack (no window/focus timeline events and no window plugin metadata).' } : {}),
        })
      }),
  )

  server.registerTool(
    'capturepack_search',
    {
      title: 'Search a pack',
      description:
        'Case-insensitive substring search across everything in a CapturePack: report.md lines, ' +
        'annotation texts, video timeline events when present, plugin JSON metadata, and the ' +
        'manifest title/note. Returns hits grouped by source.',
      inputSchema: {
        keyword: z.string().min(1).describe('Substring to search for (case-insensitive).'),
        ...idArg,
      },
    },
    (args) => run('capturepack_search', args, () => jsonResult(searchPack(store.resolve(args.id), args.keyword))),
  )

  server.registerTool(
    'capturepack_export_markdown',
    {
      title: 'Export pack as Markdown',
      description:
        'A single self-contained Markdown document for a CapturePack: report.md followed by an ' +
        'annotations table (with computed display numbers and lifetimes), the plugin inventory, ' +
        'and—for video packs only—the timeline. Returns the Markdown as text; writes no files.',
      inputSchema: idArg,
    },
    (args) => run('capturepack_export_markdown', args, () => textResult(exportMarkdown(store.resolve(args.id)))),
  )
}

// ---------------------------------------------------------------------------
// Result helpers

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] }
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: message }) }] }
}

// ---------------------------------------------------------------------------
// Pack views

function snapshotDescription(media: McpCaptureMedia): string {
  const snapshot = media.snapshot
  if (snapshot.scope === 'region') {
    const bounds = snapshot.crop_bounds
    const placement =
      bounds === undefined
        ? ''
        : ` at (${bounds.x}, ${bounds.y}) ${bounds.width}×${bounds.height} ${bounds.coordinate_space}`
    return `User-selected region image${placement}; only the selected pixels are stored`
  }
  if (snapshot.scope === 'fullscreen') {
    return 'User-requested full-screen image; snapshot.png itself is the complete explicit capture'
  }
  if (snapshot.scope === 'legacy_screenshot') {
    return 'Legacy screenshot-only capture'
  }
  return 'Snapshot frame'
}

function summarize(pack: PackHandle): Record<string, unknown> {
  const manifest = pack.manifest()
  const captureMedia = captureMediaForMcp(manifest)
  const annotations = annotationList(pack)
  const byType: Record<string, number> = {}
  for (const a of annotations) {
    const type = typeof a.type === 'string' ? a.type : 'unknown'
    byType[type] = (byType[type] ?? 0) + 1
  }
  const timeline = pack.timeline()
  const events = Array.isArray(timeline?.events) ? timeline.events : []
  const media = manifest?.media
  const imageCapture =
    captureMedia.capture_kind === 'image' && !captureMedia.legacy_inferred
  const summary: Record<string, unknown> = {
    id: pack.id,
    path: pack.path,
    kind: pack.kind,
    title: manifest?.title ?? null,
    note: manifest?.note ?? null,
    captured_at: manifest?.created_at ?? null,
    capture_kind: captureMedia.capture_kind,
    capture_kind_inferred: captureMedia.legacy_inferred,
    snapshot: captureMedia.snapshot,
    environment: manifest
      ? {
          os: [manifest.environment?.os, manifest.environment?.os_version].filter(Boolean).join(' ') || null,
          screens: manifest.environment?.screens ?? null,
          app: manifest.environment?.app ?? null,
        }
      : null,
    annotation_count: annotations.length,
    annotations_by_type: byType,
    plugins: pack.plugins().map((p) => p.name),
  }
  if (!imageCapture) {
    summary.replay =
      captureMedia.replay !== null
        ? { file: captureMedia.replay.filename, duration_ms: captureMedia.replay.duration_ms }
        : { unavailable: true }
    summary.timeline_event_count = events.length
  }
  if (typeof media?.snapshot_t_ms === 'number') summary.snapshot_t_ms = media.snapshot_t_ms
  // Annotated keyframes (SPEC §5.7): announce them here so a session that only
  // calls latest()/summary() knows images of every annotation state exist and
  // can fetch them with capturepack_frame(time_s).
  const keyframes = keyframeList(manifest)
  if (keyframes.length > 0) {
    summary.keyframes = {
      count: keyframes.length,
      t_ms: keyframes.map((k) => k.t_ms),
      note: 'Annotated stills, one per annotation state change — capturepack_frame(time_s) returns the nearest one.',
    }
  }
  const warnings = pack.warnings()
  if (warnings.length > 0) summary.warnings = warnings
  return summary
}

/**
 * manifest.media.keyframes, entry-validated and ordered by t_ms (SPEC §5.7).
 * External packs are hand-writable, so nothing here trusts the declaration's
 * shape — a malformed entry is skipped, never thrown on.
 */
function keyframeList(manifest: Manifest | null): ManifestKeyframe[] {
  const raw: unknown = manifest?.media?.keyframes
  if (!Array.isArray(raw)) return []
  const frames: ManifestKeyframe[] = []
  for (const item of raw as unknown[]) {
    if (item === null || typeof item !== 'object') continue
    const k = item as Partial<ManifestKeyframe>
    if (
      typeof k.file !== 'string' ||
      !/^frames\/frame-[0-9]{2,}_[0-9]{2,}-[0-9]{2}\.[0-9]{3}\.png$/.test(k.file) ||
      typeof k.t_ms !== 'number' ||
      !Number.isInteger(k.t_ms) ||
      k.t_ms < 0
    ) {
      continue
    }
    frames.push({ file: k.file, t_ms: k.t_ms })
  }
  return frames.sort((a, b) => a.t_ms - b.t_ms)
}

function annotationList(pack: PackHandle): Annotation[] {
  const file = pack.annotations()
  return Array.isArray(file?.annotations) ? file.annotations : []
}

/**
 * Boxes with the display they belong to made EXPLICIT (SPEC §8.8).
 *
 * The stored form is deliberately sparse — `display` is absent on the focused
 * display, which is every box of a single-monitor pack — but an AI reader that
 * receives bare bounds for a multi-display capture has no way to know which
 * screen's pixels they are. So the resolved index and the snapshot file those
 * pixels live in travel with every box, additively; the original `display`
 * field is untouched.
 *
 * A ONE-SCREEN pack is returned exactly as stored: there is one screen, its
 * frame is the reference_width/reference_height already in the response, and
 * naming it on every box would be noise. The test is `< 2` rather than "does
 * the pack declare displays" because from format 0.7.0 every video pack
 * declares them — a one-entry array is a single-display capture, not a
 * multi-display one.
 */
function withDisplayContext(pack: PackHandle, annotations: readonly Annotation[]): Annotation[] {
  const displays = pack.manifest()?.media?.displays
  if (!Array.isArray(displays) || displays.length < 2) return [...annotations]
  const focused = focusedDisplayIndex(displays)
  // A `display` this pack does not declare resolves to the FOCUSED display
  // (SPEC §8.8) — the same screen the editor draws such a box on — so the
  // index and snapshot reported here always name media the pack contains.
  const declared = declaredDisplayIndices(displays)
  const focusedEntry = displays.find(
    (d) => d !== null && typeof d === 'object' && d.index === focused,
  )
  return annotations.map((a) => {
    const index = annotationDisplayIndex(a, focused, declared)
    const entry = displays.find((d) => d !== null && typeof d === 'object' && d.index === index)
    // The resolved index always names a declared entry, so the fallbacks below
    // only fire for a malformed manifest. They name the focused display, which
    // is what an unresolvable `display` resolves to anyway (SPEC §8.8).
    const frame = entry ?? focusedEntry
    return {
      ...a,
      display_index: index,
      display_focused: index === focused,
      display_snapshot: entry?.snapshot ?? 'snapshot.png',
      // The frame these bounds are pixels in, stated (SPEC §5.6, 0.7.0): an AI
      // reader told only the filename has to fetch and decode the image to
      // learn whether a box at y=2000 is on screen.
      ...(typeof frame?.snapshot_width === 'number' && typeof frame.snapshot_height === 'number'
        ? { display_width: frame.snapshot_width, display_height: frame.snapshot_height }
        : {}),
    } as Annotation
  })
}

function annotationText(a: Annotation): string | null {
  return typeof a.text === 'string' && a.text.trim() !== '' ? a.text : null
}

function annotationPosition(a: Annotation): string {
  const b = a.bounds
  if (typeof b?.x !== 'number') return '' // tolerate malformed external packs
  return `(${b.x}, ${b.y}) ${b.width}×${b.height}`
}

function annotationLifetime(a: Annotation): string {
  if (a.start_ms === undefined || a.end_ms === undefined) return 'entire capture'
  return `${a.start_ms}–${a.end_ms} ms`
}

interface PluginJsonFile {
  file: string
  json?: unknown
  error?: string
}

interface PluginJsonContents {
  name: string
  version: string | null
  files: PluginJsonFile[]
}

function pluginJsonContents(pack: PackHandle): PluginJsonContents[] {
  return pack.plugins().map((plugin) => ({
    name: plugin.name,
    version: plugin.version,
    files: plugin.files.map((file): PluginJsonFile => {
      if (!file.toLowerCase().endsWith('.json')) return { file, error: 'not a JSON file (listed only)' }
      const text = pack.readText(file)
      if (text === null) return { file, error: 'unreadable' }
      if (text.length > MAX_PLUGIN_FILE_CHARS) return { file, error: `file too large to inline (${text.length} chars)` }
      try {
        return { file, json: JSON.parse(text) as unknown }
      } catch (err) {
        return { file, error: `invalid JSON: ${errorMessage(err)}` }
      }
    }),
  }))
}

function searchPack(pack: PackHandle, keyword: string): Record<string, unknown> {
  const kw = keyword.toLowerCase()
  const has = (s: unknown): boolean => typeof s === 'string' && s.toLowerCase().includes(kw)

  const manifest = pack.manifest()
  const manifestHits: Array<{ field: string; value: string }> = []
  if (has(manifest?.title)) manifestHits.push({ field: 'title', value: manifest?.title ?? '' })
  if (has(manifest?.note)) manifestHits.push({ field: 'note', value: manifest?.note ?? '' })

  const reportHits: Array<{ line: number; text: string }> = []
  const report = pack.report()
  if (report !== null) {
    report.split(/\r?\n/).forEach((line, i) => {
      if (reportHits.length < MAX_HITS_PER_GROUP && line.toLowerCase().includes(kw)) {
        reportHits.push({ line: i + 1, text: cap(line.trim(), 300) })
      }
    })
  }

  const allAnnotationHits = annotationList(pack).filter((a) => has(annotationText(a)))
  const annotationHits = allAnnotationHits.slice(0, MAX_HITS_PER_GROUP)

  const timelineHits: TimelineEvent[] = []
  const timeline = pack.timeline()
  for (const e of Array.isArray(timeline?.events) ? timeline.events : []) {
    if (timelineHits.length >= MAX_HITS_PER_GROUP) break
    if (has(e.type) || (e.data !== undefined && JSON.stringify(e.data).toLowerCase().includes(kw))) {
      timelineHits.push(e)
    }
  }

  const pluginHits: Array<{ plugin: string; file: string; json_path: string; value: string }> = []
  outer: for (const plugin of pluginJsonContents(pack)) {
    for (const file of plugin.files) {
      if (pluginHits.length >= MAX_JSON_MATCHES) break outer
      if (file.json === undefined) continue
      for (const hit of findStrings(file.json, (s) => s.toLowerCase().includes(kw), MAX_JSON_MATCHES - pluginHits.length)) {
        pluginHits.push({ plugin: plugin.name, file: file.file, json_path: hit.path, value: cap(hit.value, 300) })
      }
    }
  }

  const total = manifestHits.length + reportHits.length + annotationHits.length + timelineHits.length + pluginHits.length
  return {
    pack: pack.id,
    keyword,
    total_hits: total,
    hits: {
      manifest: manifestHits,
      report: reportHits,
      annotations: annotationHits,
      timeline: timelineHits,
      plugins: pluginHits,
    },
    ...(allAnnotationHits.length > annotationHits.length ? { annotations_truncated: true } : {}),
    ...(total === 0 ? { message: `No hits for "${keyword}" anywhere in this pack.` } : {}),
  }
}

function exportMarkdown(pack: PackHandle): string {
  const lines: string[] = []
  const report = pack.report()
  if (report !== null) lines.push(report.trimEnd())
  else {
    const manifest = pack.manifest()
    lines.push(`# CapturePack ${manifest?.title ?? pack.id}`, '', '_report.md missing from this pack._')
  }

  const annotations = annotationList(pack)
  lines.push('', '---', '', `## Annotations (${annotations.length})`, '')
  if (annotations.length === 0) lines.push('No annotations.')
  else {
    // Display numbers come from the ONE shared rule (SPEC §8.5) so MCP output
    // can never disagree with the editor, replay_annotated, or the documents.
    const numbers = computeDisplayNumbers(annotations)
    // Multi-display packs get a Screen column: bounds are pixels in THAT
    // display's snapshot (SPEC §8.8), so a table without it is unreadable.
    const displays = pack.manifest()?.media?.displays
    const multi = Array.isArray(displays) && displays.length > 1
    const focused = focusedDisplayIndex(displays)
    const declared = declaredDisplayIndices(displays)
    lines.push(
      multi
        ? '| Display # | ID | Screen | Lifetime | Bounds | Blur | Text |'
        : '| Display # | ID | Lifetime | Bounds | Blur | Text |',
      multi ? '| --- | --- | --- | --- | --- | --- | --- |' : '| --- | --- | --- | --- | --- | --- |',
    )
    annotations.forEach((a) => {
      const screen = multi ? `d${annotationDisplayIndex(a, focused, declared)} | ` : ''
      lines.push(
        `| ${numbers.get(a.annotation_id) ?? '—'} | ${a.annotation_id} | ${screen}${annotationLifetime(a)} | ` +
          `${annotationPosition(a)} | ${a.blur ? 'yes' : ''} | ${mdCell(annotationText(a) ?? '')} |`,
      )
    })
  }

  const captureMedia = captureMediaForMcp(pack.manifest())
  if (captureMedia.capture_kind !== 'image' || captureMedia.legacy_inferred) {
    const timeline = pack.timeline()
    const events = Array.isArray(timeline?.events) ? timeline.events : []
    lines.push('', `## Timeline (${events.length} events${timeline?.t0 ? `, t0 = ${timeline.t0}` : ''})`, '')
    if (events.length === 0) lines.push('No timeline events.')
    for (const e of events) {
      lines.push(`- ${e.t_ms} ms — \`${e.type}\` (${e.source})${e.data !== undefined ? ' ' + cap(JSON.stringify(e.data), 200) : ''}`)
    }
  }

  const plugins = pack.plugins()
  lines.push('', '## Plugins', '')
  if (plugins.length === 0) lines.push('No plugin metadata in this pack.')
  for (const p of plugins) {
    const files = p.files.length > 0 ? p.files.join(', ') : 'declared in manifest, no files'
    lines.push(`- **${p.name}**${p.version !== null ? ` v${p.version}` : ''}: ${files}`)
  }
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Small utilities

/** Depth-first walk collecting string values that satisfy `match`, with JSON paths. */
function findStrings(value: unknown, match: (s: string) => boolean, budget: number): Array<{ path: string; value: string }> {
  const out: Array<{ path: string; value: string }> = []
  const visit = (node: unknown, nodePath: string): void => {
    if (out.length >= budget) return
    if (typeof node === 'string') {
      if (match(node)) out.push({ path: nodePath || '$', value: node })
    } else if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, `${nodePath}[${i}]`))
    } else if (node !== null && typeof node === 'object') {
      for (const [key, item] of Object.entries(node)) visit(item, nodePath === '' ? key : `${nodePath}.${key}`)
    }
  }
  visit(value, '')
  return out
}

function cap(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

function mdCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}
