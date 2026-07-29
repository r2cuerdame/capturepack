# Roadmap

This file maps the path from [GOAL.md](GOAL.md) to shippable milestones. The format itself is
defined in [SPEC.md](SPEC.md) — spec before code, always. This roadmap tracks sequence and honest
status; it never overrides either document.

**Status legend:** `Done` · `In progress` · `Not started`.
**Shipping since 2026-07-27:** the auto-update chain was first verified end to
end on a real install (0.1.0 → 0.1.1 → 0.1.2). The active source and
documentation baseline is **0.3.1**; public binaries remain whatever
[GitHub Releases](https://github.com/r2cuerdame/capturepack/releases/latest)
actually exposes until the manually dispatched release workflow completes.
What is *not* yet proven is the long-run habit — the one-month
no-manual-reinstall criterion is still running.

The guiding constraint for every milestone: **never sacrifice the 5-second workflow.**

```
Ctrl+Alt+C  →  capture  →  5-second annotation  →  export .capturepack  →  drop anywhere
```

---

## Current baseline — 0.3.1

The milestone narrative below is preserved as the product's design and
verification history. These are the current additions and next gates:

- Video context uses `Ctrl+Alt+C`; explicit cross-monitor region or complete
  virtual-desktop image context uses independently configurable `Ctrl+Alt+S`.
  Capture rate is 1–30 fps.
- Past-frame/reopened-pack Object Pick uses captured Windows surface/control
  history, built-in UI Automation, optional Chrome DOM preview observations and
  an HWND fallback. Observed motion is never interpolated; authored manual-box
  keyframes may interpolate across displays.
- Image packs and video packs have distinct storage contracts. Image packs
  contain no replay or top-level `timeline.json`.
- MCP is optional, loopback-only and read-only. It reads already-saved packs
  and cannot start a capture.
- 0.3.1 gates mixed-DPI Chrome DOM geometry, regeneration after late plugin
  context, and guidance that names only manifest-declared derived artifacts.
- Next: continue physical mixed-DPI/long-running recording, save/reopen,
  installer/update and Chrome reconnection QA; harden the preview integration;
  and design an explicit sanitized-sharing path.

---

## Where things stand

The table and milestone sections below record what each historical phase meant
at the time. Current shipped behavior is summarized above and in
[README.md](README.md); unresolved work is tracked in GitHub Issues.

| Milestone | Scope | Status |
|---|---|---|
| Format spec 0.1.0 | SPEC.md + JSON Schemas (`docs/schemas/`) | Done (draft) |
| **V1 — MVP + release** | Capture, annotate (scrub timeline), export + installable auto-updating Windows release | **Done — shipped v0.1.0 → v0.1.2** |
| **V1.5 — MCP server** | Always-on read-only MCP so any AI reads packs natively | Shipped in v0.1.1 (daily-use verification ongoing) |
| **V1.6 — Working with saved packs** | History (browse/re-edit/re-render/package), replay trim, 9 languages, configurable hotkey | Shipped in v0.1.2 |
| **V1.7 — Truth** | A recorder that proves frames before claiming them, picking that offers the thing under the cursor, an app that leaves a record and does not stay gone | Shipped in v0.1.6 → v0.1.7 |
| **V2 — Temporal plugin system** | Providers that restore the PAST at any buffered time (one clock, checkpoints + deltas), a platform surface timeline that decides what the user was actually looking at, after-save actions that can never cost a capture, Chrome extension as the first web provider | Designed (GOAL.md); UIA and the extension are the two first consumers |
| **V3 — Semantic layer** | Tracked annotations following their object through the replay, AI-assisted annotation | Not started |

Historical v0.1.x snapshot: SPEC.md (format 0.1.0, draft) with validating schemas; a valid example pack
and dependency-free validator (`tools/`); the full Electron app under `core/` — replay ring
buffer, snapshot, global hotkey, unified-box annotation editor with scrub timeline,
folder-first exporter with README/skills/annotated replay, History screen, tray, settings GUI,
GitHub-Releases updater, always-on MCP server — **released and auto-updating**; CI +
tag-triggered release workflows proven twice; the landing page live at
**[capturepack.dev](https://capturepack.dev)**; the Chrome extension Phase 1 scaffold
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

### Release & auto-update — PROVEN (v0.1.0 → v0.1.1 update delivered end-to-end, 2026-07-27)

The V1 completion criteria from GOAL.md, verbatim:

- [x] **Installable Windows release** (v0.1.0 and v0.1.1 on GitHub Releases)
- [x] **GitHub Releases-based updater** — the installed 0.1.0 detected and
      background-downloaded 0.1.1 by itself; no separate update server
- [x] **Update notification and restart-to-update UX** (tray item + notification)
- [x] **Rollback-safe installation** (old version stays until the new one installs)
- [x] **Automatic build and release workflow** (tag → CI → installer + latest.yml +
      SHA256SUMS, twice)

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

## V2 — Temporal plugin system

The plugin model V2 was originally scoped for — call a context provider once, at the capture
instant — does not survive contact with the product: the user scrubs thirty seconds into the
past, and a structural context collected at one moment cannot answer a question about second 7.
Confirmed in live use of v0.1.6, and fixed honestly rather than fully in v0.1.7 (picking is
refused away from the capture instant instead of quietly answering for the wrong moment).

So V2 is the redesign in GOAL.md > "Plugin System, redesigned": **temporal context providers**
on the app's own monotonic clock, storing checkpoints plus deltas rather than a tree per frame;
a **Platform Surface Timeline** in Core deciding which window was on top at time T, because a
numeric priority cannot settle a Notepad window in front of a windowed Unreal game; and **after
save actions**, the half that gets the stable public API, because that is where a third party's
mistake lands visibly on whoever wrote it.

Windows UI Automation moves onto that protocol as its reference implementation — same clock,
same claims, same hitTest, no private path into Core — and the Chrome extension becomes the
first web provider. `input.*` events land as format **0.2.0** alongside (namespace already
reserved in SPEC §10.2; 0.1.0 readers skip unknown event types by design).

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

### Tracked elements — Not started

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

- **Sanitized sharing** — an export option that leaves the unredacted original replay and
  snapshot out of the shared ZIP (blur already renders into `replay_annotated` only).
- **mp4 replay** — optional ffmpeg-based export alongside webm.
- **Open specification adoption** — other tools reading and writing `.capturepack`.
- **Future MCP tools** — compare, merge, diff, statistics, exportPDF/HTML/Issue,
  findByApplication/URL/WindowTitle; true replay-frame extraction for `frame(time_s)`
  (v0 returns the snapshot frame with a note).

---

## Success criteria (from GOAL.md)

| KPI | Criteria | Status |
|---|---|---|
| Primary | The creator naturally uses CapturePack every day. | In progress — installed and in daily use since 2026-07-27 |
| Secondary | Developers begin attaching CapturePack files instead of screenshots. | Not met — no outside users yet |
| Operational | Install once from a GitHub Release, then keep using it for a month without any manual reinstall. | In progress — installed 2026-07-27, one auto-update received; the month is running |
| Long-term | CapturePack becomes an open specification adopted by other tools. | Not met — spec drafted, no external adopters |

---

## Development order (from GOAL.md)

| # | Step | Milestone | Status |
|---|---|---|---|
| 1 | Write SPEC.md | — | Done (draft 0.1.0) |
| 2 | Define CapturePack format | — | Done (SPEC + schemas) |
| 3 | Build replay buffer | V1 | Done (shipped) |
| 4 | Screenshot | V1 | Done (shipped) |
| 5 | Annotation editor | V1 | Done — unified box editor with scrub timeline and lifetimes (shipped) |
| 6 | Export CapturePack | V1 | Done — folder-first packs with README/skills/annotated replay (shipped) |
| 7 | Plugin API | V2 | Not started |
| 8 | Browser plugin | V2 | Scaffolded (extension + protocol v1) |
| 9 | Windows plugin | V2 | Not started |
| 10 | Public release | V1 | Done (v0.1.1 live; auto-update chain proven) |

---

## How this roadmap evolves

GitHub Issues double as a daily **usage journal**
(`.github/ISSUE_TEMPLATE/usage-journal.md`): what was used, what hurt, what's missing. After a
month of real use, the journal — not this file — is the best source of what comes next. This
roadmap gets revised from it, and every public change to the format updates SPEC.md first.

Non-goals stay non-goals: no cloud, no accounts, no sync, no subscriptions, no analytics, no
collaboration features, no marketing features, no issue tracker, no AI API integration.
