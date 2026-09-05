# Release QA

`core/scripts/qa-gate.mjs` is the deterministic, sequential release gate.
The public script name remains `qa:rc` for compatibility. It discovers every
`check:*` script in `core/package.json`, runs
`typecheck`, runs each regression in package order, and finishes with the
production build plus the built app's Electron smoke mode. A failing check
does not hide later failures unless fail-fast is requested.
The smoke process uses a unique temporary Electron profile, terminates its whole
process tree, and removes that profile; it does not read or rewrite the owner's
installed CapturePack settings.

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
`pack-forensics` section. CI therefore needs no private user capture:
`check:pack-forensics` proves on a distilled fixture that a historical pre-0.3.0
failure shape — a control target saved with its owner window's rectangle — is
still detected.

`check:past` was named here until 0.4.x and is gone. It went with its subject:
object picking became a still-image affordance, past-frame picking was removed,
and the script was removed with it. What a video still has to survive — windows
and controls readable at an arbitrary earlier instant after save and reopen — is
held by `check:temporal`, `check:windows-context` and `check:surface-restore`,
and the still's half by `check:still-context`.

Each forensic finding declares `gating: true|false` in JSON. Strict mode gates
structural/schema/timeline errors and the proven owner-window/control
contradiction. Unmatched historical controls, absent optional capture-instant
UIA evidence, and media probe uncertainty remain diagnostic: a control that
existed in an earlier Lane-A frame may legitimately be absent from the final
`elements.json`.

## Video-core regression matrix

The tables in this document map a reported failure to the check that would now
catch it. They are a map, not an inventory: the gate discovers 86 checks and
only some of them have ever had a defect worth naming.

`npm run qa:video` runs type checking plus a subset — 59 of the 86 — so some
rows below are outside it and only `qa:checks`/`qa:rc` reach them:
`check:video-no-picking`, `check:site`, `check:input-events`,
`check:storage-retention`, `check:update-notice`, and `check:actions`. A row
that names one says so. That subset is a
literal list of names inside `qa-gate.mjs`, and the gate throws when one of them
resolves to nothing. It did: the list kept naming `check:past` after the script
was deleted, so `npm run qa:video` threw before running anything and the whole
video profile ran never. Edit that list in the same commit that adds or deletes
a check.

All fixtures are deterministic and operate on repository code or temporary
files. They do not synthesize hotkeys, start the installed application, or write
to a user CapturePack.

| Reported failure | Automated evidence | Gate |
|---|---|---|
| `_223519` saved the left-monitor Google control as `330,77 230x36` although UIA recorded `620,51 153x24` | `check:pack-forensics` builds the exact 1x-left/1.5x-primary field shape. Strict mode must reject the 1.5x contradiction and accept the corrected rectangle. | `check:pack-forensics` |
| Controls move or reopen at the wrong mixed-DPI/negative-origin coordinate | The production Lane-A projection is exercised with physical global `(-580,51 153x24)` on a monitor at `x=-1200`; it must become local `(620,51 153x24)`. | `check:controls` |
| A Chrome DOM element keeps its old monitor scale after a 2x-to-1x move, or treats simultaneous window resize as DPI | The production DOM provider resolves the owner window at the requested instant and uses the owning display's scale ratio independently of client resize. Same-scale monitor moves preserve the real resize instead of scaling the element twice. | `check:dom`, `check:surface-restore` |
| Missing display scale or hostile negative DOM geometry creates a plausible-looking box | Cross-display placement without scale metadata and invalid negative width/height candidates must fail closed rather than fabricate geometry. | `check:dom` |
| Same-millisecond same-selector DOM picks collide, or every candidate inherits the nearest pick's accuracy | Distinct picks retain distinct object ids and every candidate reports its own temporal error/accuracy. | `check:dom` |
| A browser spans displays and its claim uses a different slice from the candidate | Candidate and claims must preserve the same visible display slice and display id. | `check:dom` |
| A second child in the same window cannot be selected after the first | Two controls share one `surfaceId` but have different object identities; only the exact same child may be treated as a duplicate. | `check:pick` |
| A video offers object picking again, or its help sheet promises a pick a replay cannot make | `objectPickingApplies()` must remain the whole rule (`captureKind === 'image'`), and every way in — index build, index hand-out, the hint path and the help sheet — must route through it. The same check pins what a video KEEPS: right-drag boxes, and lane A still recording control geometry into the pack's windows-context timeline. Full-profile only. | `check:video-no-picking` |
| Past frames lose windows/controls after save and reopen | The Windows context codec exports, parses as untrusted JSON, and reconstructs every temporal observation deeply equal, including HWND and no-op instants. The surface ring restores historical motion after checkpoints and bounded pruning, while temporal/index fixtures probe early, middle, and final replay times. | `check:ring-prune`, `check:surface-restore`, `check:windows-context`, `check:temporal` |
| A pack written while the app still followed objects through a replay stops opening | The app stopped WRITING tracks in 0.4.0 and must not stop READING them: SPEC §13.1 says a pack written in 2026-07 opens in 2027. The editor, main's context session and the IPC surface are all pinned to have no track request, projection or re-anchor path — which is also why a lifetime edit now has nothing to drag the box's anchor along. | `check:still-context` |
| Extending a box's lifetime moves the start it was supposed to keep | `lifetime.ts` states the anchor rule three times and it survived in one function and not the other: a ten-second window box on a 14656 ms replay came back as 4656..14656, its start pulled 7.3 s earlier into frames where the window had not been picked yet. Both the shortening and the extending path are now held to the same anchor. | `check:lifetime` |
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
| Generated guidance recommends `replay_annotated` or keyframes that were never produced | Source-first and render-failure fixtures require generated documents to omit undeclared derived artifacts and remain usable from source media plus structured JSON. Site/docs validation pins the same public promise; `check:site` is full-profile only. | `check:source-first-save`, `check:site` |
| Share Copy review shows source-container pixels that differ from the outbound PNG, omits a display lane, or overwrites a destination that appears during rename/publication | The canonical reader used by review and creation must produce byte-identical ZIP media, every still must have an exact-canonical thumbnail plus lazy 1:1 inspection, malformed/partial display layouts must fail closed, and the Windows no-replace primitive must preserve both sides of file/directory collisions. | `check:share-bundle` |
| Saving a multi-display 4K capture closes the editor but freezes the remaining app windows while background rendering starts | Replay/snapshot IPC copies yield in bounded chunks and happen only after a job owns the single global media lane. Three gated jobs must never exceed one active decoder/encoder; quit aborts the active job, rejects queued jobs without starting them, and cannot invoke the source fallback rewrite. | `check:background-media` |
| Window change capture still scans every top-level window for each move event | The real PowerShell context host receives 300 synthetic dirty-HWND events, proves that only the named HWND is read, coalesces a 100-event storm to one read, and performs a full enumeration only for structural reconciliation. | `check:context-host-dirty` |
| Capture helpers/encoders/providers accumulate or escape their resource budgets after repeated use | The Provider Host is exercised with hung, throwing, protocol-invalid, and over-budget providers. Fake process schedulers prove one Lane-A helper, bounded restart/backoff, stop-is-final, one tick owner, bounded recorder retention, one MediaRecorder path on MP4-capable systems, a bounded WebM fallback, monotonic MP4 reassembly, editor cleanup, and descendant process-tree termination. | `check:provider-host`, `check:controls`, `check:tick-owner`, `check:chrome-lifecycle`, `check:editor-lifecycle`, `check:recorder-ring`, `check:recorder-retention`, `check:qa-process-tree` |
| A reader follows `media.snapshot` and silently gets one screen of a multi-monitor desk, or a box carrying `display: 2` is measured against display 1's frame | The writer (`buildManifest`) must declare every display it froze and the validator must fail the packs that used to slip through, including a box that leaves the frame of the display it names. Every pack in this section is synthesized, so no machine needs three monitors to run it. | `check:n-display-format`, `check:validator`, `check:spec` |
| A three-monitor desk lays out as a strip, its screens are numbered differently in three places, or the wrong screen is named when one recorder dies | One synthetic desk holds four risks at once — a portrait screen between two landscapes, three scale factors, three vertical offsets, focus on index 3, and the middle recorder dead. Board layout keeps physical proportion and resolves gutters to no display; manifest index, the framing key, `report.md` and `environment.screens` agree even on a deranged array order; a capture focused on display 3 writes no `snapshot-d3.png`; and partial recorder failure names the right screen in the pack. Each assertion was proven to catch its regression by sabotaging the production rule it guards, not the fixture's expected value. | `check:n-display-format` |
| `timeline.json` grows a keystroke, or the `input.*` events it carries disagree with SPEC §10.2 | The five emitted types are pinned against the schema and the validator, and the ring that holds them is bounded. The no-keystrokes promise is hunted rather than asserted: no keyboard event type, no keyboard hook and no keyboard virtual-key code, across the source that runs and the format that is written. `input.key.*` stays reserved, and the validator fails a pack carrying one at any version. Full-profile only. | `check:input-events`, `check:validator`, `check:spec` |
| Turning a box's number off and on puts it back in the middle of the sequence, or a pack's numbers are not 1..N | Assignment order (`nextDisplayNumber` + `planNumberPins`, exercised exactly as the editor calls them) and contiguity over every arrangement of pins a pack can arrive carrying, because the documents and the video both cite these numbers. The one-implementation rule is pinned too: a second copy of the numbering rule is how the video and the documents come to disagree, and three stale copies were found the last time. | `check:number-assignment`, `check:numbering` |
| Automatic cleanup deletes packs of a user who never touched the setting | The retention rule is kept pure — no disk, no clock, no Electron — and run to exhaustion, plus the wiring that decides whether the pure rule is the one consulted. The failure it exists for: manual "purge older than 0 days" means everything and automatic "retention 0 days" means keep everything, and they are the same number in the same application. Full-profile only. | `check:storage-retention` |
| A downloaded update waits unnoticed forever, nags every launch, or notifies on a locked screen | Announcement policy is held pure and without stubs: a downloaded update is announced on download and at most once a day thereafter, a newer download announces at once without serving out the old timer, notifications defer across locked sessions, and backwards clock changes cannot satisfy the interval. Full-profile only. | `check:update-notice` |
| An After Save Action failure costs the saved pack, blocks UI, or reads non-existent manifest fields | The pipeline runs only after the pack is durable on disk, handles non-Error/hung actions without unhandled rejections, enforces encrypted loopback/HTTPS webhook secrets, and holds summary properties strictly against the manifest schema. Full-profile only. | `check:actions` |
| CI reports that it made a pack, and the pack proves nothing | `--save-now`'s argv parsing, its verdicts over a sequence of flow events, and its person-less export payload are pinned — including that main and the capture flow actually call into it, since an unwired flag runs never. Separately, every assertion `assert-capturepack.mjs` makes is exercised against a pack that must pass and a mutant that must not, because an assertion that cannot fail is a green tick over a broken build. | `check:save-now`, `check:pack-assertions` |

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
| Picking answers a hover with a rectangle covering a fifth of the screen, or capture-to-candidates drifts past the five-second promise, and every check stays green | Presence of picking data is not quality of it: a half-window container once passed every filter and then won by being the smallest rectangle containing the point, for months, until a user said hover select felt wrong. The real editor assembly (`readPackObjectContext` + `ObjectIndex.forDisplay`, the same path re-edit and the renderer use) is swept on a grid and the CONTROL rung's offered area is measured — the window rung is not ours to judge, since a maximized window legitimately is most of the frame. Four privacy-safe, geometry-only distillations of actual saved packs now run on every machine: mixed-DPI browser/native, overlay/dense document, honest window-only Electron/native, and dense Electron/native. Each pins its measured capture-to-painted-editor time below 5 s, requires this build to reopen into candidates within 1 s, and gates median/p90 control size plus precise-target availability. Neutral regenerated pixels keep a visual baseline change separate from a selection/capture regression; the reviewed geometry hash must still match. The optional local root (`CAPTUREPACK_PACK_ROOT`, default `C:\_CapturePack`) remains a broader diagnostic sweep, never the CI corpus. Full-profile only. | `check:pick-quality` |
| A saved pack has a page, a viewport and a matching window, and can place none of it | Measured before the check existed: 12 packs, 6,091 of 6,092 rectangles on disk unrecoverable, while live capture was fine the whole time. A pack is written through the REAL writers and read through the REAL reader, then rectangles on disk are counted against rectangles recovered. A hand-built fixture cannot catch this class — the wire spelling and the on-disk spelling disagreed, and a fixture agrees with whatever spelling its author typed. Full-profile only. | `check:pack-readback` |

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
   At early, middle, and final frames, confirm the video editor offers **no
   object pick at all**: a left click selects only an existing box, no outline
   follows the cursor, and the shortcut sheet never names a pick. Right-drag one
   box at an early frame and one at a final frame, describe both, save, reopen
   from History, and confirm both survive with their lifetimes. Then open the
   saved `timeline.json` and confirm it carries `input.mouse.*` and
   `input.window.*` events for what you actually did, and no `input.key.*`
   whatsoever — the gate proves the app cannot emit one, and this proves the run
   you just made did not.
2. With the playhead inside the retained range, drag the start handle and the
   end handle separately. The displayed time and selected box must remain
   unchanged. `check:trim` pins the plans behind this; what only a person can
   see is whether the rendered editor is wired to them.
3. Move one manual box from display 1 to display 2 with an intermediate
   keyframe. Compare editor midpoint, saved/reopened midpoint, annotated replay,
   and keyframe still geometry.
4. Press `Ctrl+Alt+S` and drag one region from a 1x negative-origin display
   across the boundary into a 1.5x display. Confirm native pixel placement,
   annotate, save, and reopen. Verify `capture_kind: "image"`, `image_scope:
   "region"`, crop provenance, and the absence of replay and top-level
   `timeline.json`. Object picking is a still-image affordance, so this is where
   it is proved: select two sibling controls in one window, and one element in a
   visible Chrome window, then reopen from History and repeat the same picks.
   The reopen is the load-bearing half. `check:pack-readback` proves the writer
   and the reader agree on a pack it builds itself; only a real capture of a real
   Chrome window proves that what an actual browser sent survives to disk and
   comes back placeable. If the reopened pack offers the page's elements where
   the live capture did, that is the evidence.
5. Press `Ctrl+Alt+S` again and choose **Full screen capture**. Confirm every
   attached display is present in one virtual-desktop image, the editor opens at
   100% when the desktop fits its supported scale range, and MCP reports an
   image rather than a failed video.
6. **On three physical screens, if you have them — this is the one thing on this
   page that nothing else can reach.** The desk
   [#76](https://github.com/r2cuerdame/capturepack/issues/76) asks for is one
   portrait, one scaled, and focus on the third. `check:n-display-format` covers
   four of its five risks on a desk written to disk by hand; a fixture has no
   encoders, so the fifth — three hardware encoders and three UIA temporal
   buffers running at once — is a measurement and stays unmade until somebody
   with that hardware records a real capture. Record one, then check the
   fixture's four claims against the real thing: the editor board holds the desk
   rather than falling back to a strip, manifest index and framing key and
   `report.md` and `environment.screens` all name the same screen, a capture
   focused on the third display writes no snapshot for it, and the pack names the
   right screen when one recorder dies. While you are there, verify what the TRAY
   and the TOAST say about the dead screen: they identify the dead screen by
   name and focused state across all locales ([#137](https://github.com/r2cuerdame/capturepack/issues/137)).
   Record encoder throughput, CPU and helper counts alongside, since that is the
   fifth risk. Report this unverified, never passed, if the hardware is not
   available.
7. Repeat capture/open/close cycles while recording the process tree, working
   set, idle CPU, capture CPU, and helper counts. Counts must return to baseline
   and must not grow per cycle. CPU needs a measured build baseline before a
   numeric release budget can be claimed.
8. After a fresh build, run `npm run qa:chrome-bridge` once. It isolates its pipe
   from the installed app, launches one temporary app at a time, drives the real
   manifest-style native-host launcher, records every display, then probes and
   fully decodes every new MP4 with `ffprobe` and `ffmpeg -xerror`. Header/box
   parsing alone is not sufficient release evidence. Verify there are zero
   `capturepack-chrome-*` processes and zero `%TEMP%\capturepack-chrome-*`
   profile directories afterwards.
9. Install/update the packaged build while CapturePack and the Chrome integration
   are active. Verify the installer closes only the owned app instance, completes
   without the “cannot be closed” retry loop, and restores the expected
   per-user startup/native-host state. Cancel once as a separate test.
10. Inspect the produced video pack with `qa:video -- --pack <path> --pack-strict` and
    retain `qa-report.json`, `qa-junit.xml`, the process sample, and the pack path
    as the release evidence bundle.

CI now records its own capture with nobody at the machine and asserts on the
resulting pack, so "we could not get a pack to look at" is no longer a reason to
skip a step here. What CI cannot supply is this desk: its runner has one
synthetic display, no GPU encoder worth measuring, no installer handoff and no
browser a person has granted.
