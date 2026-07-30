# Release QA

`core/scripts/qa-gate.mjs` is the deterministic, sequential release gate.
The public script name remains `qa:rc` for compatibility. It discovers every
`check:*` script in `core/package.json`, runs
`typecheck`, runs each regression in package order, and finishes with the
production build plus the built app's Electron smoke mode. A failing check
does not hide later failures unless fail-fast is requested.
The smoke process uses a unique temporary Electron profile, disables
supervision, terminates its whole process tree, and removes that profile; it
does not read or rewrite the owner's installed CapturePack settings.

A check that needs hardware the gate cannot promise does not belong in the
gate — it belongs under a `qa:` script that says what it needs. `qa:chrome-bridge`
is the browser-to-pack end-to-end run and records the desktop for twelve
seconds; the gate runs its wire half as `check:chrome-bridge --wire-only`, which
prints the skip rather than quietly running less. That harness spent a release
cycle wired to nothing and failing, so a silent shortening is the exact failure
this convention exists to prevent.
Use Node.js 22.12 or newer. Electron 42+ no longer downloads its development
binary during `npm ci`; the smoke resolves the package so its supported,
first-run download path is exercised before the isolated app starts.

```powershell
cd C:\_Project\capturepack\core
npm run qa:rc
```

Every run writes both `qa-report.json` and `qa-junit.xml`. The default artifact
directory is `%TEMP%\capturepack-qa`, so QA never adds generated files to the
repository. Override it without shell-specific syntax:

```powershell
npm run qa:rc -- --artifacts C:\temp\capturepack-qa-rc
```

Useful variants:

```powershell
# All type and regression checks, without the production build.
npm run qa:checks

# Video-core checks only, without image-capture/site checks or a build.
npm run qa:video

# Stop after the first failing gate.
npm run qa:rc -- --fail-fast

# Audit an existing pack. Findings are reported but do not gate legacy packs.
npm run qa:rc -- --pack C:\_CapturePack\CapturePack_YYYY-MM-DD_HHMMSS

# Gate a pack produced by the candidate build: schema, media references, timeline bounds,
# and proven UIA target/bounds contradictions must all be clean.
npm run qa:rc -- --pack C:\_CapturePack\CapturePack_YYYY-MM-DD_HHMMSS --pack-strict
```

The same configuration is available to CI and other automation through
environment variables:

| Variable | Meaning |
|---|---|
| `CAPTUREPACK_QA_ARTIFACT_DIR` | Output directory for JSON and JUnit |
| `CAPTUREPACK_QA_PACK` | Optional CapturePack directory to inspect |
| `CAPTUREPACK_QA_PACK_STRICT=1` | Make pack forensic findings gate the run |
| `CAPTUREPACK_QA_FAIL_FAST=1` | Skip remaining checks after the first failure |
| `CAPTUREPACK_QA_SKIP_BUILD=1` | Run checks without `npm run build` |
| `CAPTUREPACK_QA_PROFILE=all\|video` | Select the full or video-core regression profile |
| `CAPTUREPACK_QA_TIMEOUT_MS` | Per-command timeout; default 2 minutes |

When no pack is supplied, the JSON/JUnit reports contain an explicit skipped
`pack-forensics` section. CI therefore needs no private user capture. The
synthetic `check:past` regression remains part of every run, and
`check:pack-forensics` proves that a historical pre-0.3.0 failure shape — a control target
saved with its owner window's rectangle — is detected.

Each forensic finding declares `gating: true|false` in JSON. Strict mode gates
structural/schema/timeline errors and the proven owner-window/control
contradiction. Unmatched historical controls, absent optional capture-instant
UIA evidence, and media probe uncertainty remain diagnostic: a control that
existed in an earlier Lane-A frame may legitimately be absent from the final
`elements.json`.

## Video-core regression matrix

`npm run qa:video` runs type checking and the checks below sequentially. All
fixtures are deterministic and operate on repository code or temporary files.
They do not synthesize hotkeys, start the installed application, or write to a
user CapturePack.

| Reported failure | Automated evidence | Gate |
|---|---|---|
| `_223519` saved the left-monitor Google control as `330,77 230x36` although UIA recorded `620,51 153x24` | `check:pack-forensics` builds the exact 1x-left/1.5x-primary field shape. Strict mode must reject the 1.5x contradiction and accept the corrected rectangle. | `check:pack-forensics` |
| Controls move or reopen at the wrong mixed-DPI/negative-origin coordinate | The production Lane-A projection is exercised with physical global `(-580,51 153x24)` on a monitor at `x=-1200`; it must become local `(620,51 153x24)`. | `check:controls` |
| A Chrome DOM element keeps its old monitor scale after a 2x-to-1x move, or treats simultaneous window resize as DPI | The production DOM provider resolves the owner window at the requested instant and uses the owning display's scale ratio independently of client resize. Same-scale monitor moves preserve the real resize instead of scaling the element twice. | `check:dom` (16/16), `check:past`, `check:surface-restore` |
| Missing display scale or hostile negative DOM geometry creates a plausible-looking box | Cross-display placement without scale metadata and invalid negative width/height candidates must fail closed rather than fabricate geometry. | `check:dom` (16/16) |
| Same-millisecond same-selector DOM picks collide, or every candidate inherits the nearest pick's accuracy | Distinct picks retain distinct object ids and every candidate reports its own temporal error/accuracy. | `check:dom` (16/16) |
| A browser spans displays and its claim uses a different slice from the candidate | Candidate and claims must preserve the same visible display slice and display id. | `check:dom` (16/16) |
| A second child in the same window cannot be selected after the first | Two controls share one `surfaceId` but have different object identities; only the exact same child may be treated as a duplicate. | `check:pick` |
| Past frames lose windows/controls after save and reopen | The Windows context codec exports, parses as untrusted JSON, and reconstructs every temporal observation deeply equal, including HWND and no-op instants. The surface ring restores historical motion after checkpoints and bounded pruning, while temporal/index fixtures probe early, middle, and final replay times. | `check:ring-prune`, `check:surface-restore`, `check:windows-context`, `check:past`, `check:temporal` |
| History Edit appears dead, reopens without its replay, or reveals a blank editor before decode | The accepted/busy IPC result, detached pack I/O, manifest-declared replay bytes, `editMode`, context deadline, renderer success/failure acknowledgement, paint boundary, and show ordering are pinned. Native-close fallback is exercised with a fake scheduler. | `check:editor-lifecycle`, `check:plugins` |
| `Ctrl+Alt+C` or `Ctrl+Alt+S` stops working after the other shortcut changes or conflicts | A fake OS shortcut backend proves video and image registrations coexist, one change releases only its own prior binding, conflict/invalid syntax is contained, and Settings can restore only the failed action. | `check:hotkeys`, `check:settings` |
| Header popovers obscure each other, the unsaved prompt is lost on a dark desktop, or the editor loses native caption buttons | The two header panels must dismiss each other before opening, share the same layer above the selected-box header, clamp inside the stage, and keep the unsaved prompt centered. The editor title/native overlay contract is pinned to `CapturePack` with Windows caption controls. | `check:editor-ux` |
| Moving either trim handle moves the playhead or selected box | Start/out/crossing/native-now plans must request no preview seek and resolve the box at the unchanged playhead. | `check:trim` |
| Manual keyframes do not interpolate, or cannot cross monitors | Authored midpoint interpolation is checked in desktop DIP space across the exact 1x/1.5x board, then JSON-round-tripped. Observed UIA samples remain nearest-sample only. | `check:motion`, `check:render` |
| Annotated replay scales a stored bound before resolving its timed position | The shared production renderer resolver must choose the timed authored/observed position first, then scale that rectangle into encoded-video pixels without mutating stored native pixels. | `check:motion`, `check:render` |
| Manual and picked boxes lose their red/blue meaning, a reopened DOM pick becomes draggable, rejected resize handles/move cursors remain visible, or editor/video disagree | One shared production resolver makes manual rectangles red, semantic/tracked objects blue, and preserves every explicit legacy/custom colour. Picked provider identity persists as a semantic target, and semantic geometry exposes neither manual move/resize paths nor misleading geometry affordances. Creation, selection chrome, cursor choice, editor canvas, timebar, annotated replay and keyframe stills are pinned to that resolver; the removed picker cannot return as hidden state or dead UI. | `check:annotation-style` |
| The focused recorder fails while a secondary recorder succeeds, leaving an unclocked and untrimmable secondary replay | The capture policy must discard every display replay when the focused replay clock is unavailable. The result remains an honest `capture_kind: "video"` pack with `replay: null` instead of being mislabeled as an explicit image capture or retaining an oversized orphan replay. | `check:display-clock` |
| Save toast/MCP exposes a zero-annotation save-first shell for minutes while trim/render is running | The production flow must atomically publish annotations, timeline, manifest, report, README, skills, and plugin source before derived work starts. A gated slow render and a forced render failure both leave the immediately MCP-readable source revision intact. | `check:source-first-save` |
| Late UIA/DOM/plugin context leaves README, report or skills describing the earlier manifest | A late plugin declaration is raced against the final save. The final manifest must preserve every plugin and regenerate semantic documents and counts; strict forensic QA rejects a document that denies manifest-declared plugin data. | `check:plugins`, `check:source-first-save`, `check:pack-forensics` |
| Generated guidance recommends `replay_annotated` or keyframes that were never produced | Source-first and render-failure fixtures require generated documents to omit undeclared derived artifacts and remain usable from source media plus structured JSON. Site/docs validation pins the same public promise. | `check:source-first-save`, `check:site` |
| Saving a multi-display 4K capture closes the editor but freezes the remaining app windows while background rendering starts | Replay/snapshot IPC copies yield in bounded chunks and happen only after a job owns the single global media lane. Three gated jobs must never exceed one active decoder/encoder; quit aborts the active job, rejects queued jobs without starting them, and cannot invoke the source fallback rewrite. | `check:background-media` |
| Window change capture still scans every top-level window for each move event | The real PowerShell context host receives 300 synthetic dirty-HWND events, proves that only the named HWND is read, coalesces a 100-event storm to one read, and performs a full enumeration only for structural reconciliation. | `check:context-host-dirty` |
| Capture helpers/encoders/providers accumulate or escape their resource budgets after repeated use | The Provider Host is exercised with hung, throwing, protocol-invalid, and over-budget providers. Fake process schedulers prove one Lane-A helper, bounded restart/backoff, stop-is-final, one tick owner, bounded recorder retention, one MediaRecorder path on MP4-capable systems, a bounded WebM fallback, monotonic MP4 reassembly, editor cleanup, and descendant process-tree termination. | `check:provider-host`, `check:controls`, `check:tick-owner`, `check:chrome-lifecycle`, `check:editor-lifecycle`, `check:recorder-ring`, `check:recorder-retention`, `check:qa-process-tree` |

The `_223519` fixture is a distilled copy of the relevant numeric evidence, not
the owner's private pack. The strict forensic gate can additionally audit the
real folder when it is present. That historical failing pack is expected to fail with
`control_target_geometry_contradiction`; the corrected build must not:

```powershell
npm run qa:video -- --pack C:\_CapturePack\CapturePack_2026-07-29_223519 --pack-strict
```

## Image-capture regression matrix

The full `npm run qa:checks`/`npm run qa:rc` profile also gates the still-image
workflow. Image packs are not video packs with a missing encoder: the requested
capture kind, storage layout and MCP behavior are separate contracts.

| Reported failure | Automated evidence | Gate |
|---|---|---|
| A cross-monitor region drag stops at one display, loses the lower part of a portrait display, native resize edges steal seam clicks, or mixed-DPI pixels map to the wrong crop | The pure selector contract accepts one virtual-desktop rectangle across display boundaries and converts each DIP segment through its owning display scale. Selector HWNDs keep the construction path that avoids the work-area clamp but remove the native thick-frame hit zone. Real Electron windows must prove that every overlay exactly covers its display while hidden, after reveal and after each display receives focus, including the portrait tail below the primary work area. | `check:image-region-selector`, `check:image-region-window`, `check:image-desktop` |
| Full screen captures only the toolbar's display | The desktop compositor requires every enumerated display and produces one explicit virtual-desktop image. | `check:image-desktop`, `check:image-flow` |
| A region capture secretly retains the whole desktop | The flow discards the temporary full-desktop composition and persists only the selected raster plus crop provenance. | `check:image-flow`, `check:image-pack-writer` |
| An image reuses the video timeline/replay shape | A declared image pack has `capture_kind: "image"`, `image_scope`, no replay and no top-level `timeline.json`; region captures require `crop_bounds`. | `check:image-pack`, `check:image-pack-writer`, `check:spec` |
| MCP treats an image as a broken video or exposes undeclared context pixels | MCP reports image scope/crop provenance, returns no replay/timeline, and serves only the declared image. | `check:mcp-image-pack` |
| Image editing is stretched to fill instead of opening at native scale when practical | The image/editor flow contract keeps source pixel dimensions and uses the ordinary zoom/pan path rather than changing stored geometry. | `check:image-flow`, `check:editor-ux` |
| A landscape region selected from a portrait monitor opens on the wrong display | Region ownership is chosen by largest overlap, with shortcut focus used only as a tie-breaker, and Main places the editor on that selected display. | `check:image-region-selector`, `check:image-flow` |
| A still-image editor opens as an empty dark page and native caption buttons cover its toolbar | The preload owns the one-shot init listener before renderer subscription and replays an early init exactly once. Main temporarily disables hidden-window throttling, reveals the native window only after renderer decode, two paint boundaries and success acknowledgement, then restores normal background throttling; initialization failure remains hidden and closes. A real Electron probe exercises the hidden paint boundary, and the HTML reserves windowed caption space before initialization. | `check:editor-lifecycle`, `check:image-region-window` |

## Manual Windows smoke still required

The deterministic gate proves coordinate, persistence, scheduling, and media
assembly contracts. The optional field-MP4 fixture in `check:recorder-ring`
is reported as skipped when no local fixture is supplied; that skip is not
evidence of a real Chromium encode/decode. The gate also cannot prove Windows
compositor timing, real UI Automation provider behavior, GPU encoder
throughput, actual CPU percentage, Windows installer handoff, or a physical
mixed-DPI desktop. Before a public release, run one headed Windows smoke
manually, one application window at a time:

1. Record 30 seconds across the 1x portrait monitor and 1.5x primary monitor.
   At early, middle, and final frames, select two sibling controls in one
   window; save, reopen from History, and repeat the same picks.
2. With the playhead inside the retained range, drag the start handle and the
   end handle separately. The displayed time and selected box must remain
   unchanged.
3. Move one manual box from display 1 to display 2 with an intermediate
   keyframe. Compare editor midpoint, saved/reopened midpoint, annotated replay,
   and keyframe still geometry.
4. Press `Ctrl+Alt+S` and drag one region from a 1x negative-origin display
   across the boundary into a 1.5x display. Confirm native pixel placement,
   annotate, save, and reopen. Verify `capture_kind: "image"`, `image_scope:
   "region"`, crop provenance, and the absence of replay and top-level
   `timeline.json`.
5. Press `Ctrl+Alt+S` again and choose **Full screen capture**. Confirm every
   attached display is present in one virtual-desktop image, the editor opens at
   100% when the desktop fits its supported scale range, and MCP reports an
   image rather than a failed video.
6. Repeat capture/open/close cycles while recording the process tree, working
   set, idle CPU, capture CPU, and helper counts. Counts must return to baseline
   and must not grow per cycle. CPU needs a measured build baseline before a
   numeric release budget can be claimed.
7. After a fresh build, run `node scripts/chrome-bridge-check.mjs` once. It
   isolates its pipe from the installed app, launches one temporary app at a
   time, drives the real manifest-style native-host launcher, records every
   display, then probes and fully decodes every new MP4 with `ffprobe` and
   `ffmpeg -xerror`. Header/box parsing alone is not sufficient release
   evidence. Verify there are zero `capturepack-chrome-*` processes and zero
   `%TEMP%\capturepack-chrome-*` profile directories afterwards.
8. Install/update the packaged build while CapturePack and the Chrome integration
   are active. Verify the installer closes only the owned app instance, completes
   without the “cannot be closed” retry loop, and restores the expected
   per-user startup/native-host state. Cancel once as a separate test.
9. Inspect the produced video pack with `qa:video -- --pack <path> --pack-strict` and
   retain `qa-report.json`, `qa-junit.xml`, the process sample, and the pack path
   as the release evidence bundle.
