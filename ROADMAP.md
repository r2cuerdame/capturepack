# Roadmap

This file maps the path from [GOAL.md](GOAL.md) to shippable milestones. The format itself is
defined in [SPEC.md](SPEC.md) — spec before code, always. This roadmap tracks sequence and honest
status; it never overrides either document.

**Status legend:** `Done` · `In progress` · `Not started`. The app typechecks, builds, and
smoke-runs; the end-to-end capture flow has not yet been verified by daily use, and **no GitHub
Release has shipped yet.**

The guiding constraint for every milestone: **never sacrifice the 5-second workflow.**

```
Ctrl+Alt+C  →  capture  →  5-second annotation  →  export .capturepack  →  drop anywhere
```

---

## Where things stand

| Milestone | Scope | Status |
|---|---|---|
| Format spec 0.1.0 | SPEC.md + JSON Schemas (`docs/schemas/`) | Done (draft) |
| **V1 — MVP + release** | Capture, annotate (scrub timeline), export + installable auto-updating Windows release | In progress (implemented; first release pending) |
| **V1.5 — MCP server** | Always-on read-only MCP so any AI reads packs natively | Implemented (live-usage verification pending) |
| **V2 — Context depth** | Timeline input events + Plugin API, Chrome extension, Plugin Manager | Extension scaffolded; rest not started |
| **V3 — Semantic layer** | Tracked elements, object picking, AI-assisted annotation | Not started |

What exists today: SPEC.md (format 0.1.0, draft) with validating schemas; a valid example pack
and dependency-free validator (`tools/`); the full Electron app under `core/` (replay ring
buffer, snapshot, Ctrl+Alt+C, annotation editor, exporter, tray, settings, GitHub-Releases
updater, always-on MCP server) passing typecheck/build/smoke; CI + tag-triggered release
workflows; the landing page
live at **[capturepack.dev](https://capturepack.dev)**; the Chrome extension Phase 1 scaffold
(`extensions/chrome/`) and protocol v1 (`shared/protocol/`).

---

## V1 — MVP + installable, self-updating release

V1 is two halves, and **both are required**. The tool half is the MVP workflow from GOAL.md. The
release half is deployment infrastructure: **auto-update is required in V1, not optional** — the
creator uses CapturePack daily while fixing it frequently, and hand-replacing files breaks the
usage habit that the whole project is measured by.

### Capture — Implemented (field verification pending)

- [x] 30-second rolling replay buffer (two staggered recorders; exported as `replay.webm`)
- [x] Screenshot (`snapshot.png` at native resolution)
- [x] Global hotkey `Ctrl+Alt+C` triggers capture from anywhere

### Annotation — Implemented; scrub timeline in progress

- [x] Pin, Arrow, Rectangle, Blur, Text — exactly the five types of format 0.1.0 (SPEC §8)
- [x] Keyboard-first, instant undo, editable data — never burned into the replay video
- [ ] **Scrub-timeline editor** (GOAL "Editor Input System"): wheel ±100 ms / Shift ±1 s /
      Alt ±1 frame (up = past, invert option), Ctrl+wheel zoom, Space+drag pan, timeline drag,
      right-click-drag rect with immediate description — the chosen frame becomes the snapshot
      (`media.snapshot_t_ms`)
- [ ] **Annotation lifetime** (GOAL "Annotation Timeline & Lifetime"): manual annotations get a
      default 1.0 s duration (±0.5 s, clamped), duration label + editor with presets, × delete,
      lifetime bars on the timeline (`t_start_ms` / `t_end_ms`)

### Export — Implemented

- [x] Valid `.capturepack` per SPEC: manifest + snapshot + replay + annotations + report.md
- [x] Blur applied destructively to `snapshot.png`; unredacted frame never ships (SPEC §9)
- [x] Blur + replay warning with one-step replay exclusion (SPEC §9.4)
- [x] `report.md` generated from the SPEC §12 template — LLM-readable with no tooling
- [x] `timeline.json` with `core.*` events; `input.*` recording is V2

### Release & auto-update — Pipeline ready, unproven until a release ships

The V1 completion criteria from GOAL.md, verbatim:

- [ ] **Installable Windows release**
- [ ] **GitHub Releases-based updater** — no separate update server, ever
- [ ] **Update notification and restart-to-update UX**
- [ ] **Rollback-safe installation**
- [ ] **Automatic build and release workflow** (written: tag → build → SHA-256 → Release)

Supporting: sha512-verified updates from `latest.yml` + published `SHA256SUMS.txt`; auto-check
toggle in settings; code signing when possible; channels later. Landing page: **done** —
[capturepack.dev](https://capturepack.dev) with Download pointing at the latest Release.

### V1 exit test

Tag `v0.1.x`, watch CI publish the installer, install it once, use it daily, and receive at
least one update through restart-to-update — **a full month with no manual reinstall.**

---

## V1.5 — Always-On MCP Server (read-only) — Implemented (live-usage verification pending)

Implemented ahead of the first release (GOAL "Always-On MCP Server"). The MCP server lives
inside CapturePack.exe (Streamable HTTP at `http://127.0.0.1:39393/mcp`, localhost only),
watches the export folder, and lets any AI analyze packs without the user explaining
anything — "Analyze the latest CapturePack." is the whole prompt. Like the rest of the app,
it has not yet been proven by daily use. Client setup and the full tool reference:
[docs/MCP.md](docs/MCP.md).

- [x] Recent-pack index + export-folder watcher (no manual refresh)
- [x] Read-only tools: `latest` · `list` · `open` (dir or zip) · `summary` · `manifest` ·
      `report` · `timeline(from_ms,to_ms)` · `annotations` · `find_annotations` ·
      `frame(time_s)` · `replay` · `dom` / `find_dom` · `windows` · `search` ·
      `export_markdown` — exposed as `capturepack_*` tool names; every pack-reading tool
      defaults to the latest pack. `frame` is v0: it returns the snapshot frame with a note;
      true replay-frame extraction is future work
- [x] Generic plugin-metadata exposure (MCP never special-cases plugin kinds)
- [x] Settings → MCP (enable, autostart, read-only, watch, port, request log)
- [x] Never creates/edits captures — capture always belongs to the application

---

## V2 — Context depth

`input.*` events land as format **0.2.0** (namespace already reserved in SPEC §10.2; 0.1.0
readers skip unknown event types by design).

### Timeline events — Not started

- [ ] Mouse · Keyboard · Window · Application focus · Window resize

### Plugin API & integrations — Extension scaffolded, rest not started

- [ ] Plugin API — core owns capture; plugins only append metadata under `plugins/<name>/`
- [x] Chrome extension Phase 1 scaffold: element picker, selector generation, protocol v1,
      native-host manifest (`extensions/chrome/`, `shared/protocol/`)
- [ ] Native messaging host in the app + installer registration (registry, cleanup on uninstall)
- [ ] **Plugin Manager** (GOAL "Plugin Manager"): Settings treats every integration identically —
      install/health-check/test-connection/enable/disable per plugin, status icons on the main
      surface, extension auto-update with protocol version check
- [ ] Extension Phase 2: DOM snapshot, Shadow DOM, iframes, SPA route detection
- [ ] Edge/Brave (Chromium reuse), then Firefox
- [ ] Windows UI Automation plugin · Git plugin · Console plugin
- [ ] Unreal plugin · Unity plugin

---

## V3 — Semantic layer

### Tracked elements & object picking — Not started

Click actual UI objects instead of drawing rectangles; CapturePack stores the object, not
coordinates (GOAL "Annotation Timeline & Lifetime"):

- [ ] Tracked Element annotations (`"element"` type): alive while the object exists, bounds
      follow the object frame by frame, auto-end on removal
- [ ] DOM elements (via the extension) · Windows UI Automation (AutomationId, ControlType,
      Name, Bounds) · application objects · engine plugins (Unreal widgets, Unity UI)

### AI-assisted annotation — Not started

- [ ] Prompt builder

Boundary: **No AI Dependency** is a core principle. AI features assist creation; a pack is never
less complete without them, and nothing becomes an AI API integration (a stated non-goal).

---

## Later — noted, not scheduled

- **Replay redaction** — blur applies to the snapshot only in 0.1.0; a future format version
  closes the replay gap (SPEC §9.4).
- **mp4 replay** — optional ffmpeg-based export alongside webm.
- **Open specification adoption** — other tools reading and writing `.capturepack`.
- **Future MCP tools** — compare, merge, diff, statistics, exportPDF/HTML/Issue,
  findByApplication/URL/WindowTitle; true replay-frame extraction for `frame(time_s)`
  (v0 returns the snapshot frame with a note).

---

## Success criteria (from GOAL.md)

| KPI | Criteria | Status |
|---|---|---|
| Primary | The creator naturally uses CapturePack every day. | Not met — first release pending |
| Secondary | Developers begin attaching CapturePack files instead of screenshots. | Not met |
| Operational | Install once from a GitHub Release, then keep using it for a month without any manual reinstall. | Not met — no release exists |
| Long-term | CapturePack becomes an open specification adopted by other tools. | Not met — spec drafted, no external adopters |

---

## Development order (from GOAL.md)

| # | Step | Milestone | Status |
|---|---|---|---|
| 1 | Write SPEC.md | — | Done (draft 0.1.0) |
| 2 | Define CapturePack format | — | Done (SPEC + schemas) |
| 3 | Build replay buffer | V1 | Done (field verification pending) |
| 4 | Screenshot | V1 | Done |
| 5 | Annotation editor | V1 | Done; scrub timeline + lifetime in progress |
| 6 | Export CapturePack | V1 | Done |
| 7 | Plugin API | V2 | Not started |
| 8 | Browser plugin | V2 | Scaffolded (extension + protocol v1) |
| 9 | Windows plugin | V2 | Not started |
| 10 | Public release | V1 | In progress (pipeline ready, first tag pending) |

---

## How this roadmap evolves

GitHub Issues double as a daily **usage journal**
(`.github/ISSUE_TEMPLATE/usage-journal.md`): what was used, what hurt, what's missing. After a
month of real use, the journal — not this file — is the best source of what comes next. This
roadmap gets revised from it, and every public change to the format updates SPEC.md first.

Non-goals stay non-goals: no cloud, no accounts, no sync, no subscriptions, no analytics, no
collaboration features, no marketing features, no issue tracker, no AI API integration.
