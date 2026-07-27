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
`mcpAutoStart` is `false`, the server does not start.

## Connecting a client

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

### stdio-only clients

Clients that only speak stdio can bridge to the HTTP endpoint with the
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote) npm package — configure the client
to run:

```
npx -y mcp-remote http://127.0.0.1:39393/mcp
```

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
folder, as shown by `capturepack_list` — e.g. `2026-07-27/capture-140309`; the plain base
name is also accepted and resolves to the newest match) or an absolute path to a
`.capturepack` file or an extracted pack directory. Optional `id` defaults to the current
pack as described above.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `capturepack_latest` | — | Summary of the newest pack; re-pins it as the current pack |
| `capturepack_list` | `limit?` | Recent packs (newest first, default 20 — `total` reports the full count): id, title, capture time |
| `capturepack_open` | `id` — pack id or absolute path (folder and ZIP both supported) | The pack's summary; pins it as the current pack for subsequent calls |
| `capturepack_summary` | `id?` | Title, note, captured_at, environment (os/screens/app), replay duration (or screenshot-only), `snapshot_t_ms` when present, annotation count (+ per-type), timeline event count, plugin list |
| `capturepack_manifest` | `id?` | Raw `manifest.json` |
| `capturepack_report` | `id?` | Raw `report.md` |
| `capturepack_timeline` | `id?`, `from_ms?`, `to_ms?` | Full timeline, or the slice between `from_ms` and `to_ms` |
| `capturepack_annotations` | `id?` | The annotation list |
| `capturepack_find_annotations` | `keyword`, `id?` | Annotations matching the keyword |
| `capturepack_frame` | `time_s?`, `id?` | The frame at `time_s` (omitted = the snapshot frame) — **v0 limitation, see below** |
| `capturepack_replay` | `id?` | Replay **metadata** only: filename, duration_ms, size_bytes — never raw video bytes |
| `capturepack_dom` | `id?` | Generic plugin metadata under `plugins/*/` (DOM-ish data lives under a chrome plugin dir when present) |
| `capturepack_find_dom` | `selector`, `id?` | Plugin/DOM entries matching the selector |
| `capturepack_windows` | `id?` | Window/focus timeline events plus window-related plugin metadata, when present |
| `capturepack_search` | `keyword`, `id?` | Case-insensitive substring search across `report.md`, annotation labels/text, timeline event types + data, plugin JSON, and manifest title/note — hits grouped by source |
| `capturepack_export_markdown` | `id?` | One Markdown document: `report.md` + annotations table (with `t_ms` / lifetimes) + timeline listing + plugin inventory. Returned as text; **writes no files** |

Plugin metadata is exposed generically — the MCP server never special-cases plugin kinds.
If a pack has no plugin data, the plugin-reading tools return empty results with a clear
message; that is expected today.

### `capturepack_frame` — v0 limitation

v0 returns `snapshot.png` as MCP image content (base64) plus a text note stating the
snapshot's frame time versus the requested `time_s`. True frame extraction from the replay
video is a documented future enhancement.

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

- **What counts as a pack:** `*.capturepack` files (standard ZIPs) and extracted pack
  **directories** (a directory containing a `manifest.json`), found in the export folder
  itself or one subfolder level below it — the app saves into `YYYY-MM-DD` date folders.
  A `.capturepack` file and its extracted directory sitting side by side count as **one**
  pack (the ZIP).
- **Order:** most recently modified first. **Id:** the pack's path relative to the export
  folder, without the `.capturepack` extension (e.g. `2026-07-27/capture-140309`). The
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
| `mcpEnabled` | `true` | Master switch — `false` means the server never starts |
| `mcpPort` | `39393` | Port for `http://127.0.0.1:<port>/mcp` |
| `mcpAutoStart` | `true` | Start the server with the app — `false` means not started |
| `mcpReadOnly` | `true` | Read-only mode. This version is **always** read-only — setting `false` is ignored (a startup log line says so); the key reserves the name for a future opt-in write mode |
| `mcpWatchExportFolder` | `true` | Watch `outputDir` and keep the pack index fresh |
| `mcpLogRequests` | `false` | Log one console line per tool call |

## Troubleshooting

**Port already in use** — the app logs a clear one-line error and keeps running (it never
crashes and never takes a different port on its own). Free the port or change `mcpPort`,
then restart CapturePack.

**New packs not showing up** — check that `mcpWatchExportFolder` is `true` and that the pack
actually lands in the configured `outputDir` (or the `--output-dir` you launched with).
Filesystem watching can be unreliable on network drives; a restart forces a full rescan.

**A pack exists but isn't listed** — the index scans the export folder and **one subfolder
level** below it (the app's `YYYY-MM-DD` date folders). A pack nested deeper, or an
extracted directory without a `manifest.json`, is not indexed. An extracted directory whose
sibling `.capturepack` file has the same name is listed once, as the ZIP. Malformed packs
appear as warning entries rather than disappearing silently.

**Client can't connect** — the server only listens on `127.0.0.1`; connect from the same
machine, confirm CapturePack is running, and confirm `mcpEnabled` and `mcpAutoStart` are both
`true`.
