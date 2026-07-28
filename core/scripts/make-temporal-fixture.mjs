// Builds the checked-in temporal picking fixture from real CapturePacks.
//
// READ-ONLY on every pack it is given. It copies GEOMETRY AND IDENTITY ONLY —
// window rectangles, z-order, control bounds, names and ids — and never a
// pixel: the fixture is evidence about picking, not a copy of somebody's
// screen. Run it again whenever new evidence arrives:
//
//   node scripts/make-temporal-fixture.mjs <pack-dir> [<pack-dir> ...]
//
// Packs are written into test/fixtures/temporal/evidence.json in capture order.
// Each entry carries the pack's clock (t0 and the capture instant on it), its
// captured displays, and the capture-instant Windows UI Automation observation
// exactly as the editor would have received it — which is what lets the harness
// assemble several packs of one session into ONE ring and ask picking about a
// time that is genuinely in the past.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

const packs = process.argv.slice(2)
if (packs.length === 0) {
  console.error('usage: node scripts/make-temporal-fixture.mjs <pack-dir> [<pack-dir> ...]')
  process.exit(2)
}

const entries = []
for (const dir of packs) {
  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  const timeline = JSON.parse(readFileSync(path.join(dir, 'timeline.json'), 'utf8'))
  const uia = JSON.parse(
    readFileSync(path.join(dir, 'plugins', 'windows-uia', 'elements.json'), 'utf8'),
  )
  const media = manifest.media ?? {}
  const replayDurationMs = typeof media.replay_duration_ms === 'number' ? media.replay_duration_ms : 0
  const t0Ms = Date.parse(timeline.t0)
  // Every captured display, with the PIXEL size of its snapshot — which is the
  // annotation coordinate space (SPEC §8.2) the payload's bounds are already in.
  const displays = Array.isArray(media.displays) && media.displays.length > 0
    ? media.displays.map((d) => ({
        index: d.index,
        focused: d.focused === true,
        width: Math.round(d.bounds.width * (typeof d.scale === 'number' ? d.scale : 1)),
        height: Math.round(d.bounds.height * (typeof d.scale === 'number' ? d.scale : 1)),
      }))
    : [
        {
          index: 1,
          focused: true,
          width: manifest.environment?.screens?.[0]?.width ?? 0,
          height: manifest.environment?.screens?.[0]?.height ?? 0,
        },
      ]
  entries.push({
    pack: path.basename(dir),
    created_at: manifest.created_at,
    generator: manifest.generator?.version ?? null,
    // The pack clock (SPEC §10.1): t0 is the start of the declared replay and
    // the capture instant sits at replay_duration_ms on it.
    t0_ms: t0Ms,
    capture_instant_ms: t0Ms + replayDurationMs,
    replay_duration_ms: replayDurationMs,
    snapshot_t_ms: typeof media.snapshot_t_ms === 'number' ? media.snapshot_t_ms : null,
    displays,
    uia: {
      captured_at: uia.captured_at ?? '',
      truncated: uia.truncated === true,
      windows: uia.windows ?? [],
      elements: uia.elements ?? [],
    },
  })
}
entries.sort((a, b) => a.capture_instant_ms - b.capture_instant_ms)

const outDir = path.join(process.cwd(), 'test', 'fixtures', 'temporal')
mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, 'evidence.json')
writeFileSync(outFile, JSON.stringify({ packs: entries }))
const totalWindows = entries.reduce((n, e) => n + e.uia.windows.length, 0)
const totalElements = entries.reduce((n, e) => n + e.uia.elements.length, 0)
console.log(
  `wrote ${outFile}: ${entries.length} packs, ${totalWindows} windows, ${totalElements} elements`,
)
for (const e of entries) {
  console.log(
    `  ${e.pack}  t0=${new Date(e.t0_ms).toISOString()}  ` +
      `instant=+${e.replay_duration_ms}ms  windows=${e.uia.windows.length}  ` +
      `elements=${e.uia.elements.length}`,
  )
}
