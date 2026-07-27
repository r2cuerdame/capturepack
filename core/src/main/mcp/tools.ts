// MCP tool registrations (all read-only). Each tool answers with compact JSON
// in a text block (capturepack_frame adds an image block); descriptions are
// written so an LLM can use each tool without any other documentation.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { Annotation, TimelineEvent } from '../../shared/types'
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
        'Which pack to read: a pack id from capturepack_list, or an absolute path to a ' +
          '.capturepack file or extracted pack folder. Omit to use the current default pack ' +
          '(the one pinned by capturepack_open / capturepack_latest, otherwise the most recent ' +
          'pack in the export folder).',
      ),
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
        'pack for all other capturepack_* tools. Start here: most sessions only need this, then ' +
        'capturepack_report / capturepack_timeline / capturepack_annotations without arguments. ' +
        'A CapturePack is a local context capture (screenshot + optional screen replay + ' +
        'annotations + event timeline) exported by the CapturePack app.',
      inputSchema: {},
    },
    (args) => run('capturepack_latest', args, () => jsonResult(summarize(store.latest()))),
  )

  server.registerTool(
    'capturepack_list',
    {
      title: 'List CapturePacks',
      description:
        'List recent CapturePacks in the export folder, newest first: id, title, capture time, ' +
        'kind (zip or extracted folder) and absolute path. Use an id from this list as the "id" ' +
        'argument of any other capturepack_* tool, or pass it to capturepack_open to pin it.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('Maximum packs to return (default 20).'),
      },
    },
    (args) =>
      run('capturepack_list', args, () => {
        const { total, packs } = store.list(args.limit ?? 20)
        return jsonResult({
          output_dir: store.outputDir,
          total,
          packs: packs.map((e, i) => ({
            n: i + 1,
            id: e.id,
            title: e.title,
            captured_at: e.capturedAt,
            kind: e.kind,
            path: e.path,
            ...(e.warning !== null ? { warning: e.warning } : {}),
          })),
        })
      }),
  )

  server.registerTool(
    'capturepack_open',
    {
      title: 'Open a CapturePack',
      description:
        'Open a specific CapturePack by id (from capturepack_list) or absolute path (.capturepack ' +
        'zip file or extracted pack folder), pin it as the default pack for subsequent ' +
        'capturepack_* calls in this session, and return its summary.',
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe('Pack id from capturepack_list, or an absolute path to a .capturepack file or pack folder.'),
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
        'focused app), replay duration or screenshot-only, snapshot frame time, annotation count ' +
        'per type, timeline event count and plugin list. Does not change the pinned default pack.',
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
        'Machine-readable timeline events of a CapturePack (capture trigger, annotations added, ' +
        'plugin events, export). Each event has t_ms (milliseconds since capture start t0), type, ' +
        'source, and optional data. Optionally slice by from_ms/to_ms.',
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
        if (!timeline) return errorResult(`timeline.json missing or malformed in pack "${pack.id}"`)
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
        'style.color, and z stacking order. Display numbers are computed, never stored.',
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
          annotations: list,
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
        return jsonResult({ pack: pack.id, keyword: args.keyword, count: matches.length, annotations: matches })
      }),
  )

  server.registerTool(
    'capturepack_frame',
    {
      title: 'Frame at a time',
      description:
        'The captured frame as a PNG image. Pass time_s (seconds on the replay timeline) for the ' +
        'frame you want. NOTE (v0): this always returns the exported snapshot.png — the frame the ' +
        'user chose when exporting; a text note states the snapshot frame time vs the requested ' +
        'time. True frame extraction from the replay video is a planned future enhancement.',
      inputSchema: {
        ...idArg,
        time_s: z.number().min(0).optional().describe('Requested time in seconds on the replay timeline.'),
      },
    },
    (args) =>
      run('capturepack_frame', args, () => {
        const pack = store.resolve(args.id)
        const manifest = pack.manifest()
        const snapshotFile = manifest?.media?.snapshot ?? 'snapshot.png'
        const png = pack.readBinary(snapshotFile)
        if (!png) return errorResult(`${snapshotFile} not found in pack "${pack.id}"`)
        const snapT = manifest?.media?.snapshot_t_ms
        const snapDesc = typeof snapT === 'number' ? `${(snapT / 1000).toFixed(1)}s on the replay timeline` : 'the capture instant'
        const note =
          args.time_s === undefined
            ? `Snapshot frame from ${snapDesc}.`
            : `Requested ${args.time_s}s; v0 returns the exported snapshot frame, which is from ${snapDesc}. ` +
              'Frame extraction at arbitrary replay times is a future enhancement.'
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
        const replay = manifest?.media?.replay
        if (typeof replay !== 'string' || replay === '') {
          return jsonResult({ pack: pack.id, replay: null, message: 'Screenshot-only capture: this pack has no replay video.' })
        }
        return jsonResult({
          pack: pack.id,
          replay: {
            filename: replay,
            duration_ms: manifest?.media?.replay_duration_ms ?? null,
            size_bytes: pack.fileSize(replay),
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
        'returned as-is (DOM data contributed by the Chrome extension lives under a chrome plugin ' +
        'directory when present). Packs without plugin data return an empty list with a message.',
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
            message: 'No plugin metadata in this pack (no plugins/ directory). DOM data appears here once a browser plugin contributed it.',
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
        'Window-related context of a CapturePack: timeline events whose type or source mentions ' +
        'window/focus, plus any window-tracking plugin metadata. Returns empty lists with a ' +
        'message when the pack has no window data.',
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
        'annotation texts, timeline event types and data, plugin JSON metadata, and the ' +
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
        'annotations table (with computed display numbers and lifetimes), the full timeline ' +
        'listing, and the plugin inventory. Returns the Markdown as text; writes no files.',
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

function summarize(pack: PackHandle): Record<string, unknown> {
  const manifest = pack.manifest()
  const annotations = annotationList(pack)
  const byType: Record<string, number> = {}
  for (const a of annotations) {
    const type = typeof a.type === 'string' ? a.type : 'unknown'
    byType[type] = (byType[type] ?? 0) + 1
  }
  const timeline = pack.timeline()
  const events = Array.isArray(timeline?.events) ? timeline.events : []
  const media = manifest?.media
  const summary: Record<string, unknown> = {
    id: pack.id,
    path: pack.path,
    kind: pack.kind,
    title: manifest?.title ?? null,
    note: manifest?.note ?? null,
    captured_at: manifest?.created_at ?? null,
    environment: manifest
      ? {
          os: [manifest.environment?.os, manifest.environment?.os_version].filter(Boolean).join(' ') || null,
          screens: manifest.environment?.screens ?? null,
          app: manifest.environment?.app ?? null,
        }
      : null,
    replay:
      typeof media?.replay === 'string' && media.replay !== ''
        ? { file: media.replay, duration_ms: media.replay_duration_ms ?? null }
        : { screenshot_only: true },
    annotation_count: annotations.length,
    annotations_by_type: byType,
    timeline_event_count: events.length,
    plugins: pack.plugins().map((p) => p.name),
  }
  if (typeof media?.snapshot_t_ms === 'number') summary.snapshot_t_ms = media.snapshot_t_ms
  const warnings = pack.warnings()
  if (warnings.length > 0) summary.warnings = warnings
  return summary
}

function annotationList(pack: PackHandle): Annotation[] {
  const file = pack.annotations()
  return Array.isArray(file?.annotations) ? file.annotations : []
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
    lines.push(
      '| Display # | ID | Lifetime | Bounds | Blur | Text |',
      '| --- | --- | --- | --- | --- | --- |',
    )
    annotations.forEach((a) => {
      lines.push(
        `| ${numbers.get(a.annotation_id) ?? '—'} | ${a.annotation_id} | ${annotationLifetime(a)} | ` +
          `${annotationPosition(a)} | ${a.blur ? 'yes' : ''} | ${mdCell(annotationText(a) ?? '')} |`,
      )
    })
  }

  const timeline = pack.timeline()
  const events = Array.isArray(timeline?.events) ? timeline.events : []
  lines.push('', `## Timeline (${events.length} events${timeline?.t0 ? `, t0 = ${timeline.t0}` : ''})`, '')
  if (events.length === 0) lines.push('No timeline events.')
  for (const e of events) {
    lines.push(`- ${e.t_ms} ms — \`${e.type}\` (${e.source})${e.data !== undefined ? ' ' + cap(JSON.stringify(e.data), 200) : ''}`)
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
