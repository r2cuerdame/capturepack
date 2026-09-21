// MCP image/video read-semantics regression.
//
// This exercises the registered tools, not only the shared classifier. A region
// pack has no API path by which MCP can ask for pixels outside snapshot.png.
import { registerTools } from '../src/main/mcp/tools'
import type { Annotation } from '../src/shared/types'

type ToolResult = {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
  isError?: boolean
}
type ToolCallback = (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>

let failed = 0
function check(ok: boolean, message: string): void {
  if (!ok) failed += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${message}`)
}

function textJson(result: ToolResult): Record<string, unknown> {
  const block = result.content.find((item) => item.type === 'text')
  return JSON.parse(block?.text ?? '{}') as Record<string, unknown>
}

function annotation(
  id: string,
  text: string,
  createdAt: string,
  numbered: boolean,
  display?: number,
): Annotation {
  return {
    annotation_id: id,
    type: 'box',
    ...(display === undefined ? {} : { display }),
    bounds: { x: 10, y: 20, width: 100, height: 40 },
    text,
    numbered,
    blur: false,
    tracking: { enabled: false },
    created_at: createdAt,
    z: 1,
  }
}

async function main(): Promise<void> {
  const callbacks = new Map<string, ToolCallback>()
  const server = {
    registerTool(name: string, _definition: unknown, callback: ToolCallback): void {
      callbacks.set(name, callback)
    },
  }
  const reads: string[] = []
  const singleAnnotations = [
    annotation('single-numbered', 'Prompt button', '2026-07-29T00:00:00Z', true),
    annotation('single-plain', 'Context label', '2026-07-29T00:00:01Z', false),
  ]
  const multiAnnotations = [
    annotation('multi-first', 'Launch button', '2026-07-29T00:00:00Z', true, 1),
    annotation('multi-second', 'Save button', '2026-07-29T00:00:01Z', true, 2),
    annotation('multi-plain', 'Save label', '2026-07-29T00:00:02Z', false, 2),
  ]
  const singlePack = {
    id: 'single-annotations-pack',
    path: 'C:\\packs\\single-annotations-pack',
    kind: 'dir',
    manifest: () => ({
      media: {
        displays: [{ index: 1, focused: true, snapshot: 'snapshot.png' }],
      },
    }),
    annotations: () => ({ reference_width: 800, reference_height: 600, annotations: singleAnnotations }),
  }
  const multiPack = {
    id: 'multi-annotations-pack',
    path: 'C:\\packs\\multi-annotations-pack',
    kind: 'dir',
    manifest: () => ({
      media: {
        displays: [
          { index: 1, focused: false, snapshot: 'snapshot-d1.png', snapshot_width: 1_920, snapshot_height: 1_080 },
          { index: 2, focused: true, snapshot: 'snapshot.png', snapshot_width: 2_560, snapshot_height: 1_440 },
        ],
      },
    }),
    annotations: () => ({ reference_width: 2_560, reference_height: 1_440, annotations: multiAnnotations }),
  }
  const manifest = {
    capture_kind: 'image',
    id: 'region-pack',
    title: 'Clipboard crop',
    note: 'Prompt copy menu',
    created_at: '2026-07-29T22:30:00+09:00',
    environment: { os: 'windows', screens: [{ width: 1200, height: 1920, scale: 1 }] },
    media: {
      snapshot: 'snapshot.png',
      replay: null,
      image_scope: 'region',
      crop_bounds: {
        x: -1100,
        y: 100,
        width: 500,
        height: 320,
        coordinate_space: 'virtual-desktop-dip',
      },
      keyframes: [
        { file: 'frames/frame-01_00-00.000.png', t_ms: 0 },
        { file: 'context-full.png', t_ms: 1_000 },
      ],
    },
    plugins: [],
  }
  const pack = {
    id: 'region-pack',
    path: 'C:\\packs\\region-pack',
    kind: 'dir',
    manifest: () => manifest,
    manifestText: () => JSON.stringify(manifest),
    report: () => null,
    annotations: () => ({ reference_width: 500, reference_height: 320, annotations: [] }),
    timeline: () => null,
    plugins: () => [],
    readText: () => null,
    readBinary: (file: string) => {
      reads.push(file)
      if (file === 'snapshot.png') return Buffer.from('selected-region')
      if (file === 'frames/frame-01_00-00.000.png') return Buffer.from('annotated-region')
      return null
    },
    fileSize: () => null,
    listFiles: () => ['manifest.json', 'snapshot.png'],
    warnings: () => [],
  }
  const reportText = '# CapturePack with report\n\nFull generated report.\n'
  const reportPack = {
    ...pack,
    id: 'pack-with-report',
    path: 'C:\\packs\\pack-with-report',
    report: () => reportText,
  }
  const store = {
    outputDir: 'C:\\packs',
    latest: () => pack,
    resolve: (id?: string) => {
      if (id === singlePack.id) return singlePack
      if (id === multiPack.id) return multiPack
      if (id === reportPack.id) return reportPack
      return pack
    },
    list: () => ({
      total: 1,
      packs: [{
        id: pack.id,
        path: pack.path,
        kind: 'dir',
        mtimeMs: 1,
        title: manifest.title,
        capturedAt: manifest.created_at,
        warning: null,
      }],
    }),
  }
  registerTools(server as never, store as never, { logRequests: false })

  console.log('SUMMARY')
  const latest = await callbacks.get('capturepack_latest')?.({})
  check(latest !== undefined, 'capturepack_latest is registered')
  const summary = textJson(latest as ToolResult)
  check(summary.capture_kind === 'image', 'latest reports capture_kind=image')
  const snapshot = summary.snapshot as Record<string, unknown>
  check(snapshot.scope === 'region', 'latest reports region scope')
  check(
    JSON.stringify(snapshot.crop_bounds) === JSON.stringify(manifest.media.crop_bounds),
    'latest returns crop placement provenance',
  )
  check(!('full_context' in snapshot), 'latest exposes no full-context image field')
  check(!('timeline_event_count' in summary), 'image summary does not pretend to have a video timeline')
  check(!('replay' in summary), 'image summary contains no video replay section')

  console.log('REPORT')
  const missingReport = await callbacks.get('capturepack_report')?.({})
  const missingReportText = missingReport?.content.find((item) => item.type === 'text')?.text ?? ''
  check(
    missingReport !== undefined && missingReport.isError !== true,
    'missing optional report.md returns a non-error response',
  )
  check(
    missingReportText.includes('report.md is absent from this pack') &&
      missingReportText.includes('optional audience view'),
    'missing report response clearly explains the optional audience view is absent',
  )
  const presentReport = await callbacks.get('capturepack_report')?.({ id: reportPack.id })
  const presentReportText = presentReport?.content.find((item) => item.type === 'text')?.text ?? ''
  check(
    presentReport?.isError !== true && presentReportText === reportText,
    'present report.md continues to return its full text unchanged',
  )

  console.log('HISTORY')
  const history = await callbacks.get('capturepack_history')?.({
    query: 'prompt copy',
    kind: 'image',
    limit: 5,
  })
  check(history !== undefined && history.isError !== true, 'capturepack_history is registered')
  const historyJson = textJson(history as ToolResult)
  const historyPacks = historyJson.packs as Array<Record<string, unknown>>
  check(
    historyJson.matched_total === 1 &&
      historyPacks[0]?.id === 'region-pack' &&
      historyPacks[0]?.kind === 'image' &&
      historyPacks[0]?.note === manifest.note,
    'history searches notes and returns stable id/kind/title/note metadata',
  )
  const historyCounts = historyPacks[0]?.counts as Record<string, unknown>
  check(
    historyCounts.annotations === 0 &&
      historyCounts.plugins === 0 &&
      !('timeline_events' in historyCounts),
    'image history counts only still-image sources',
  )
  const listAlias = await callbacks.get('capturepack_list')?.({ kind: 'video' })
  check(
    textJson(listAlias as ToolResult).matched_total === 0,
    'capturepack_list remains a filterable history alias',
  )

  console.log('TIMELINE SHAPE')
  const timeline = await callbacks.get('capturepack_timeline')?.({})
  const timelineJson = textJson(timeline as ToolResult)
  check(
    timeline?.isError !== true &&
      timelineJson.capture_kind === 'image' &&
      timelineJson.available === false,
    'timeline reader explains the intentional absence for a still-image pack',
  )
  const markdown = await callbacks.get('capturepack_export_markdown')?.({})
  const markdownText = markdown?.content.find((item) => item.type === 'text')?.text ?? ''
  check(!markdownText.includes('## Timeline'), 'image Markdown export omits the video timeline section')

  console.log('FRAME')
  const frame = await callbacks.get('capturepack_frame')?.({})
  check(frame !== undefined && frame.isError !== true, 'capturepack_frame returns the selected image')
  check(
    reads.length === 1 && reads[0] === 'snapshot.png',
    `frame reads only snapshot.png — reads: ${reads.join(', ')}`,
  )
  const frameNote = frame?.content.find((item) => item.type === 'text')?.text ?? ''
  check(
    frameNote.includes('only the selected pixels are stored'),
    'frame text makes the privacy boundary explicit',
  )
  reads.length = 0
  const annotatedFrame = await callbacks.get('capturepack_frame')?.({ time_s: 0 })
  check(
    reads.length === 1 && reads[0] === 'frames/frame-01_00-00.000.png',
    'time_s reads only the manifest-declared derived still',
  )
  const annotatedNote =
    annotatedFrame?.content.find((item) => item.type === 'text')?.text ?? ''
  check(
    annotatedNote.includes('derived only from the user-selected crop'),
    'derived image analysis still states the crop privacy boundary',
  )
  reads.length = 0
  await callbacks.get('capturepack_frame')?.({ time_s: 1 })
  check(
    reads.length === 1 && reads[0] === 'frames/frame-01_00-00.000.png',
    'a forged context-full keyframe declaration is ignored',
  )

  console.log('REPLAY')
  const replay = await callbacks.get('capturepack_replay')?.({})
  const replayJson = textJson(replay as ToolResult)
  check(replayJson.capture_kind === 'image' && replayJson.replay === null, 'image replay is explicitly null')

  console.log('ANNOTATIONS')
  const singleResult = await callbacks.get('capturepack_annotations')?.({ id: singlePack.id })
  const singleRows = (textJson(singleResult as ToolResult).annotations ?? []) as Array<Record<string, unknown>>
  check(
    singleRows.length === 2 &&
      singleRows[0]?.display_number === 1 &&
      singleRows[1]?.display_number === null,
    'single-display annotations expose computed numbers and null for unnumbered boxes',
  )

  const multiResult = await callbacks.get('capturepack_annotations')?.({ id: multiPack.id })
  const multiRows = (textJson(multiResult as ToolResult).annotations ?? []) as Array<Record<string, unknown>>
  check(
    JSON.stringify(
      multiRows.map((row) => [row.annotation_id, row.display_number, row.display_index, row.display_snapshot]),
    ) ===
      JSON.stringify([
        ['multi-first', 1, 1, 'snapshot-d1.png'],
        ['multi-second', 2, 2, 'snapshot.png'],
        ['multi-plain', null, 2, 'snapshot.png'],
      ]),
    'multi-display annotations keep one computed sequence across displays',
  )

  const foundResult = await callbacks.get('capturepack_find_annotations')?.({
    id: multiPack.id,
    keyword: 'save',
  })
  const foundRows = (textJson(foundResult as ToolResult).annotations ?? []) as Array<Record<string, unknown>>
  check(
    foundRows.length === 2 &&
      foundRows[0]?.display_number === 2 &&
      foundRows[1]?.display_number === null,
    'annotation search returns the same computed display_number fields',
  )

  console.log(failed === 0 ? '\nmcp-image-pack-check ok' : `\nmcp-image-pack-check FAILED (${failed})`)
  process.exitCode = failed === 0 ? 0 : 1
}

void main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
