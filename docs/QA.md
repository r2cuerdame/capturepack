# Release-candidate QA

`core/scripts/qa-gate.mjs` is the deterministic, sequential release-candidate
gate. It discovers every `check:*` script in `core/package.json`, runs
`typecheck`, runs each regression in package order, and finishes with the
production build plus the built app's Electron smoke mode. A failing check
does not hide later failures unless fail-fast is requested.
The smoke process uses a unique temporary Electron profile, disables
supervision, terminates its whole process tree, and removes that profile; it
does not read or rewrite the owner's installed CapturePack settings.

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

# Gate a pack produced by the RC: schema, media references, timeline bounds,
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
`check:pack-forensics` proves that the rc.36 failure shape — a control target
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
| A second child in the same window cannot be selected after the first | Two controls share one `surfaceId` but have different object identities; only the exact same child may be treated as a duplicate. | `check:pick` |
| Past frames lose windows/controls after save and reopen | The Windows context codec exports, parses as untrusted JSON, and reconstructs every temporal observation deeply equal, including HWND and no-op instants. The surface ring restores historical motion after checkpoints and bounded pruning, while temporal/index fixtures probe early, middle, and final replay times. | `check:ring-prune`, `check:surface-restore`, `check:windows-context`, `check:past`, `check:temporal` |
| History Edit appears dead or reopens without its replay | The accepted/busy IPC result, detached pack I/O, manifest-declared replay bytes, `editMode`, context deadline, and show ordering are pinned. Native-close fallback is exercised with a fake scheduler. | `check:editor-lifecycle`, `check:plugins` |
| `Ctrl+Alt+C` or `Ctrl+Alt+S` stops working after the other shortcut changes or conflicts | A fake OS shortcut backend proves video and image registrations coexist, one change releases only its own prior binding, conflict/invalid syntax is contained, and Settings can restore only the failed action. | `check:hotkeys`, `check:settings` |
| Header popovers obscure each other, the unsaved prompt is lost on a dark desktop, or the editor loses native caption buttons | The two header panels must dismiss each other before opening, share the same layer above the selected-box header, clamp inside the stage, and keep the unsaved prompt centered. The editor title/native overlay contract is pinned to `CapturePack` with Windows caption controls. | `check:editor-ux` |
| Moving either trim handle moves the playhead or selected box | Start/out/crossing/native-now plans must request no preview seek and resolve the box at the unchanged playhead. | `check:trim` |
| Manual keyframes do not interpolate, or cannot cross monitors | Authored midpoint interpolation is checked in desktop DIP space across the exact 1x/1.5x board, then JSON-round-tripped. Observed UIA samples remain nearest-sample only. | `check:motion`, `check:render` |
| Annotated replay scales a stored bound before resolving its timed position | The shared production renderer resolver must choose the timed authored/observed position first, then scale that rectangle into encoded-video pixels without mutating stored native pixels. | `check:motion`, `check:render` |
| The focused recorder fails while a secondary recorder succeeds, leaving an unclocked and untrimmable secondary replay | The capture policy must discard every display replay when the focused replay clock is unavailable. The resulting pack remains an honest multi-display screenshot-only capture instead of retaining an oversized orphan replay. | `check:display-clock` |
| Save toast/MCP exposes a zero-annotation save-first shell for minutes while trim/render is running | The production flow must atomically publish annotations, timeline, manifest, report, README, skills, and plugin source before derived work starts. A gated slow render and a forced render failure both leave the immediately MCP-readable source revision intact. | `check:source-first-save` |
| Saving a multi-display 4K capture closes the editor but freezes the remaining app windows while background rendering starts | Replay/snapshot IPC copies yield in bounded chunks and happen only after a job owns the single global media lane. Three gated jobs must never exceed one active decoder/encoder; quit aborts the active job, rejects queued jobs without starting them, and cannot invoke the source fallback rewrite. | `check:background-media` |
| Window change capture still scans every top-level window for each move event | The real PowerShell context host receives 300 synthetic dirty-HWND events, proves that only the named HWND is read, coalesces a 100-event storm to one read, and performs a full enumeration only for structural reconciliation. | `check:context-host-dirty` |
| Capture helpers/encoders/providers accumulate or escape their resource budgets after repeated use | The Provider Host is exercised with hung, throwing, protocol-invalid, and over-budget providers. Fake process schedulers prove one Lane-A helper, bounded restart/backoff, stop-is-final, one tick owner, bounded recorder retention, one MediaRecorder path on MP4-capable systems, a bounded WebM fallback, monotonic MP4 reassembly, editor cleanup, and descendant process-tree termination. | `check:provider-host`, `check:controls`, `check:tick-owner`, `check:chrome-lifecycle`, `check:editor-lifecycle`, `check:recorder-ring`, `check:recorder-retention`, `check:qa-process-tree` |

The `_223519` fixture is a distilled copy of the relevant numeric evidence, not
the owner's private pack. The strict forensic gate can additionally audit the
real folder when it is present. That historical failing pack is expected to fail with
`control_target_geometry_contradiction`; the corrected RC must not:

```powershell
npm run qa:video -- --pack C:\_CapturePack\CapturePack_2026-07-29_223519 --pack-strict
```

## Manual RC smoke still required

The deterministic gate proves coordinate, persistence, scheduling, and media
assembly contracts. The optional field-MP4 fixture in `check:recorder-ring`
is reported as skipped when no local fixture is supplied; that skip is not
evidence of a real Chromium encode/decode. The gate also cannot prove Windows
compositor timing, real UI Automation provider behavior, GPU encoder
throughput, or actual CPU percentage. Before owner confirmation, run one
headed RC smoke manually, one application window at a time:

1. Record 30 seconds across the 1x portrait monitor and 1.5x primary monitor.
   At early, middle, and final frames, select two sibling controls in one
   window; save, reopen from History, and repeat the same picks.
2. With the playhead inside the retained range, drag the start handle and the
   end handle separately. The displayed time and selected box must remain
   unchanged.
3. Move one manual box from display 1 to display 2 with an intermediate
   keyframe. Compare editor midpoint, saved/reopened midpoint, annotated replay,
   and keyframe still geometry.
4. Repeat capture/open/close cycles while recording the process tree, working
   set, idle CPU, capture CPU, and helper counts. Counts must return to baseline
   and must not grow per cycle. CPU needs a measured RC baseline before a
   numeric release budget can be claimed.
5. After a fresh build, run `node scripts/chrome-bridge-check.mjs` once. It
   isolates its pipe from the installed app, launches one temporary app at a
   time, drives the real manifest-style native-host launcher, records every
   display, then probes and fully decodes every new MP4 with `ffprobe` and
   `ffmpeg -xerror`. Header/box parsing alone is not sufficient release
   evidence. Verify there are zero `capturepack-chrome-*` processes and zero
   `%TEMP%\capturepack-chrome-*` profile directories afterwards.
6. Inspect the produced pack with `qa:video -- --pack <path> --pack-strict` and
   retain `qa-report.json`, `qa-junit.xml`, the process sample, and the pack path
   as the RC evidence bundle.
