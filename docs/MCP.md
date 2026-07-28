# CapturePack MCP Server

CapturePack ships an official, always-running **MCP (Model Context Protocol) server** so any
AI can read CapturePacks in a standard way. It never creates captures — it reads, explores,
and analyzes them.

```
CapturePack        → creates Context
CapturePack Format → stores Context      (a data format, AI-independent)
CapturePack MCP    → serves Context      (the standard read interface)
Any AI             → consumes Context    (ChatGPT, Claude, Gemini, Cursor, VSCode, Codex, …)
```

After saving a CapturePack the user does nothing. The workflow is Capture → Annotate → Save →
done. The AI finds and analyzes the latest pack through MCP on its own — the user never
explains the file structure, never unzips, never pastes `report.md`.
"Analyze the latest CapturePack." is the whole prompt.

## Always on

The server lives **inside the CapturePack app** (the Electron main process) and starts
automatically with it:

- **Endpoint:** `http://127.0.0.1:39393/mcp`
- **Transport:** MCP Streamable HTTP
- **Binding:** `127.0.0.1` only — never reachable from the network
- **Access:** read-only, always
- **DNS-rebinding protection:** requests whose `Host` header is not
  `127.0.0.1`/`localhost` (on the MCP port), or whose `Origin` header is present and not a
  local `http(s)://127.0.0.1`/`localhost` page, are rejected with `403`

The port comes from the `mcpPort` setting (default `39393`). If `mcpEnabled` or
`mcpAutoStart` is `false`, the server does not start with the app — Settings → MCP shows
which of the two it is.

**Settings → MCP → Enable MCP server is the live on/off switch.** Unchecking it stops the
running server immediately (the status row then reads *Not running — the MCP server is
turned off*); checking it starts one immediately and reports where it bound. Nothing here
waits for an app restart. `mcpAutoStart` is not consulted when you flip that switch by
hand — flipping it *is* the manual start `mcpAutoStart` says the app must not perform on
its own.

**Restart** applies a changed port, output folder or watch setting to the server in place,
without restarting the app. It is greyed out while the server is switched off; when
`mcpEnabled` is `true` but `mcpAutoStart` is `false`, it is the on-demand start.

## Connecting a client

Settings → MCP does this for you: pick your client from the dropdown and press
**Copy setup command**. The snippet is built from the endpoint the server *actually bound*,
so it is already correct even if you changed the port. **Copy prompt** copies the sentence
to give the AI once it is connected. The forms below are the same ones that button
produces.

### Claude Code

```
claude mcp add --transport http capturepack http://127.0.0.1:39393/mcp
```

### Cursor

Add to `~/.cursor/mcp.json` (or the project's `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "capturepack": { "url": "http://127.0.0.1:39393/mcp" }
  }
}
```

### VS Code

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "capturepack": { "type": "http", "url": "http://127.0.0.1:39393/mcp" }
  }
}
```

### Claude Desktop

Settings → Developer → Edit Config (`claude_desktop_config.json`). Claude Desktop speaks
stdio, so bridge with `mcp-remote`:

```json
{
  "mcpServers": {
    "capturepack": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:39393/mcp"]
    }
  }
}
```

### ChatGPT

ChatGPT Desktop: Settings → Connectors → Add connector → paste
`http://127.0.0.1:39393/mcp` (developer mode must be enabled for localhost
connectors).

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "capturepack": { "serverUrl": "http://127.0.0.1:39393/mcp" }
  }
}
```

### Codex CLI

Add to `~/.codex/config.toml` (Codex speaks stdio — bridge with `mcp-remote`):

```toml
[mcp_servers.capturepack]
command = "npx"
args = ["-y", "mcp-remote", "http://127.0.0.1:39393/mcp"]
```

### Gemini CLI

Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "capturepack": { "httpUrl": "http://127.0.0.1:39393/mcp" }
  }
}
```

### Cline

Cline (VS Code) → MCP Servers → Configure (`cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "capturepack": { "url": "http://127.0.0.1:39393/mcp", "type": "streamableHttp" }
  }
}
```

### Zed

`settings.json`:

```json
{
  "context_servers": {
    "capturepack": {
      "source": "custom",
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:39393/mcp"]
    }
  }
}
```

### Any other stdio-only client

Bridge to the HTTP endpoint with the
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote) npm package — configure the client
to run:

```
npx -y mcp-remote http://127.0.0.1:39393/mcp
```

Exact config formats evolve with each client — when in doubt, the server is plain
MCP Streamable HTTP at `http://127.0.0.1:39393/mcp`, and `mcp-remote` covers every
stdio-only client.

## The default pack: latest, unless you open one

Every pack-reading tool takes an **optional** `id` argument — a pack id or an absolute path.
When omitted (the normal case), the tool reads the **current** pack:

- The current pack starts as the **most recent** pack in the export folder.
- `capturepack_open` pins a specific pack as the current one for the rest of the app session.
- `capturepack_latest` re-pins the current pack to the newest one.

Most sessions never pass an argument: `capturepack_latest` → `capturepack_summary` →
`capturepack_timeline` → `capturepack_annotations` → … all just work on the newest pack.

## Tools

All tools are read-only. `id` always means: pack id (the pack's path relative to the export
folder, as shown by `capturepack_list` — e.g. `CapturePack_2026-07-27_140309`; the plain base
name is also accepted and resolves to the newest match) or an absolute path to a
`.capturepack` file or an extracted pack directory. Optional `id` defaults to the current
pack as described above.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `capturepack_latest` | — | Summary of the newest pack; re-pins it as the current pack |
| `capturepack_list` | `limit?` | Recent packs (newest first, default 20 — `total` reports the full count): id, title, capture time |
| `capturepack_open` | `id` — pack id or absolute path (folder and ZIP both supported) | The pack's summary; pins it as the current pack for subsequent calls |
| `capturepack_summary` | `id?` | Title, note, captured_at, environment (os/screens/app), replay duration (or screenshot-only), `snapshot_t_ms` when present, annotated-keyframe count + times when present, annotation count (+ per-type), timeline event count, plugin list |
| `capturepack_manifest` | `id?` | Raw `manifest.json` |
| `capturepack_report` | `id?` | Raw `report.md` |
| `capturepack_timeline` | `id?`, `from_ms?`, `to_ms?` | Full timeline, or the slice between `from_ms` and `to_ms` |
| `capturepack_annotations` | `id?` | The annotation list — including each box's optional `target` (the real UI object it was placed on, e.g. `{source:"uia", name:"Save", control_type:"Button"}`) and, on a multi-display capture, **which screen it is on** (`display_index` + `display_snapshot`, see below) |
| `capturepack_find_annotations` | `keyword`, `id?` | Annotations matching the keyword |
| `capturepack_frame` | `time_s?`, `id?` | An image of the capture: the **nearest annotated keyframe** to `time_s` when the pack has them, else `snapshot.png` — **see below** |
| `capturepack_replay` | `id?` | Replay **metadata** only: filename, duration_ms, size_bytes — never raw video bytes |
| `capturepack_dom` | `id?` | Generic plugin metadata under `plugins/*/` — on Windows usually `windows-uia` (the capture-instant window list + the control trees the dump reached); DOM-ish data lives under a chrome plugin dir when present |
| `capturepack_find_dom` | `selector`, `id?` | Plugin/DOM entries matching the selector — e.g. an `automation_id` or a control name in the `windows-uia` dump |
| `capturepack_windows` | `id?` | Window/focus timeline events plus window-related plugin metadata (the `windows-uia` window list), when present |
| `capturepack_search` | `keyword`, `id?` | Case-insensitive substring search across `report.md`, annotation texts, timeline event types + data, plugin JSON, and manifest title/note — hits grouped by source |
| `capturepack_export_markdown` | `id?` | One Markdown document: `report.md` + annotations table (with computed display numbers / lifetimes) + timeline listing + plugin inventory. Returned as text; **writes no files** |

Plugin metadata is exposed generically — the MCP server never special-cases plugin kinds.
If a pack has no plugin data, the plugin-reading tools return empty results with a clear
message; that is expected today.

### Object context (`windows-uia` + annotation `target`)

A Windows capture usually carries `plugins/windows-uia/elements.json`
([SPEC §11.3](../SPEC.md)): the top-level window list and the UI Automation control trees of
the windows the dump reached **as they were at the capture instant**, with every rectangle
already in `snapshot.png` pixel coordinates — the same space as the annotations. Read it with
`capturepack_dom`, search it with `capturepack_find_dom`, and get just the windows from
`capturepack_windows`.

Two fields decide how to read it. `windows[].z` is the z-order (`0` = top-most), so a question
like *"what is at (x, y)?"* is answered by the lowest-`z` window containing the point, never by
a control of a window that another window covers there. `windows[].tree` says what happened to
that window's tree — `collected`, `truncated`, `unavailable`, `skipped`. **Anything but
`collected` means no controls were recorded for that window, which is never the claim that it
has none:** Chromium and Electron windows expose no tree until an assistive client asks, and
the walk is budgeted. Report such a window as "no object data", not as an empty application.

When the user placed a box on one of those objects, that box also carries `target`
([SPEC §8.7](../SPEC.md)) in `capturepack_annotations`:

```json
"target": { "source": "uia", "level": "control", "name": "Save", "control_type": "Button", "automation_id": "saveButton" }
```

A box placed on a window rather than on a control carries the same `source` at the coarser
level — a complete answer, not a degraded one:

```json
"target": { "source": "uia", "level": "window", "title": "Untitled - Notepad", "process": "notepad" }
```

That is the difference between *"a box at (2140, 1236)"* and *"the Save button"*. Two rules
never change: the box's geometry always comes from `bounds` alone, and both the dump and the
target describe **one instant** — they say nothing about any other position in the replay.
A pack without either (a non-Windows capture, a dump that ran out of budget) is complete and
valid; the tools then simply report that there is no object data.

### Which screen a box is on

A capture may have frozen several displays at once ([SPEC §5.6](../SPEC.md)), and **every one of
them can carry annotations**. A box names its screen in the stored field `display` (the 1-based
`manifest.media.displays[].index`); an **absent `display` means the focused display**, which is
what a single-monitor pack and every box on the focused screen write — so nothing about an
existing pack changed.

Because that stored form is sparse, `capturepack_annotations` and `capturepack_find_annotations`
resolve it for you on a multi-display pack — additively, alongside the untouched `display`:

```json
{ "annotation_id": "ann_44a1c9", "display": 1, "bounds": { "x": 220, "y": 640, "width": 300, "height": 120 },
  "display_index": 1, "display_focused": false, "display_snapshot": "snapshot-d1.png" }
```

**`bounds` are pixels in `display_snapshot`, never in `snapshot.png`.** Reading a second screen's
box against `snapshot.png` puts it in the wrong place at coordinates that mean nothing there.
Display numbers stay one global sequence across every screen, so box ② is ② wherever it sits.
A single-display pack returns the annotations exactly as stored — one screen needs no label.

### `capturepack_frame` — annotated keyframes

`capturepack_frame` always answers with MCP image content (base64 PNG) plus a text note.
Which image depends on the pack:

- **The pack has annotated keyframes** (`manifest.media.keyframes`, [SPEC §5.7](../SPEC.md)) —
  stills rendered at every annotation state change, with blur, borders, number badges and text
  drawn into the pixels. `capturepack_frame(time_s)` returns the **nearest** one, and the note
  states which keyframe it is, its exact time, and **every** keyframe time in the pack — so a
  model can walk the whole story image by image (`0.0s, 3.2s, 5.4s, …`).
- **No keyframes, or `time_s` omitted** — `snapshot.png` is returned (original pixels, never
  annotated), with a note giving its frame time (`media.snapshot_t_ms`, or the capture instant)
  and, when keyframes exist, the times available. Keyframes render in the background right
  after a save, so a pack saved seconds ago may not have them yet.

Frames are never decoded out of the replay video at arbitrary times: what a pack ships as
images is what MCP serves. `capturepack_summary` (and `capturepack_latest`) announce the
keyframe count and times, so a session usually knows the stills exist before asking.

## Read-only by design

The initial version supports Read / Search / Summary / Export only. Intentionally
unsupported — no tool will ever:

- create, modify, or delete packs, annotations, or any other file
- create captures (capture always belongs to the application)
- write export output to disk (`capturepack_export_markdown` returns text)
- return raw replay video bytes (`capturepack_replay` returns metadata only)

## The pack index

The server keeps an index of the export folder (`outputDir` setting) and watches it —
no manual refresh, ever:

- **What counts as a pack:** `*.capturepack` files (standard ZIPs) and pack **directories**
  (a directory containing a `manifest.json`), found in the export folder itself or one
  subfolder level below it — the app saves flat `CapturePack_YYYY-MM-DD_HHMMSS` folders
  directly into the export folder; the extra scan level covers user-organized subfolders
  (and pre-release date folders). A pack directory and a same-stem sibling `.capturepack`
  file count as **one** pack: the **directory**. The ZIP is an on-demand distribution copy
  made by the save toast's [Create ZIP] button and may be stale (e.g. created before the
  background annotated-replay render finished); a ZIP with no sibling directory is still a
  pack of its own.
- **Order:** most recently modified first. **Id:** the pack's path relative to the export
  folder, without the `.capturepack` extension (e.g. `CapturePack_2026-07-27_140309`). The
  plain base name is accepted anywhere an id is, and resolves to the newest match.
- **Freshness:** a recursive filesystem watcher triggers a debounced rescan on any change,
  and the index also rescans on access when it is more than a few seconds old (so a dead
  watcher — e.g. on network-redirected folders — cannot freeze it).
- **Tolerance:** malformed packs are skipped with a warning entry instead of breaking the
  index, and `capturepack_latest` prefers the newest **readable** pack over a malformed one.

For testing and power use, launch the app with `--output-dir=<path>` to use a different
export folder for that run without persisting it to settings.

## Settings

Flat keys in the app's `settings.json` (validated like every other setting):

| Key | Default | Meaning |
| --- | --- | --- |
| `mcpEnabled` | `true` | Master switch — `false` means no server runs. Toggling it in Settings starts/stops the server **immediately**, no app restart |
| `mcpPort` | `39393` | Port for `http://127.0.0.1:<port>/mcp`. Changing it applies on **Settings → MCP → Restart**, no app restart |
| `mcpAutoStart` | `true` | Start an enabled server with the app — `false` means it is not started at launch (Restart, or re-ticking Enable, starts it on demand) |
| `mcpReadOnly` | `true` | Read-only mode. This version is **always** read-only — setting `false` is ignored (a startup log line says so); the key reserves the name for a future opt-in write mode |
| `mcpWatchExportFolder` | `true` | Watch `outputDir` and keep the pack index fresh |
| `mcpLogRequests` | `false` | Log one console line per tool call |

## Troubleshooting

**Is it even running?** Settings → MCP shows the LIVE state, read from the server rather
than from the settings: *Running on http://127.0.0.1:PORT/mcp*, *Starting…*, or *Not
running* with the reason (turned off, automatic start off, port in use, bind error). The
same live endpoint is what the About and welcome windows print.

**Port already in use** — the app logs a clear one-line error and keeps running (it never
crashes and never takes a different port on its own), and Settings → MCP says so. Free the
port or change `mcpPort`, then press **Restart** — the server rebinds in place and reports
the outcome. The capture buffer, the hotkey and any open editor are untouched.

**New packs not showing up** — check that `mcpWatchExportFolder` is `true` and that the pack
actually lands in the configured `outputDir` (or the `--output-dir` you launched with).
Filesystem watching can be unreliable on network drives; **Restart** rebuilds the index
from scratch (and is also how a newly chosen output folder gets indexed).

**A pack exists but isn't listed** — the index scans the export folder and **one subfolder
level** below it (for user-organized subfolders). A pack nested deeper, or a directory
without a `manifest.json`, is not indexed. A pack directory whose sibling `.capturepack`
file has the same stem is listed once, as the **directory** (the ZIP is treated as a
possibly-stale distribution copy). Malformed packs appear as warning entries rather than
disappearing silently.

**Client can't connect** — the server only listens on `127.0.0.1`; connect from the same
machine, and check the live status line in Settings → MCP before anything else — it names
the reason when nothing is listening.
