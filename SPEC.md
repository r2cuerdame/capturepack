# CapturePack Format Specification

| | |
|---|---|
| **Format** | `capturepack` |
| **Version** | `0.1.0` |
| **Status** | Draft |
| **Date** | 2026-07-27 |
| **License** | MIT (same as the repository) |

> Capture context, not screenshots.

This document is the source of truth for the CapturePack file format. The specification matters
more than any implementation: **any language must be able to produce and consume a valid
CapturePack from this document alone.** Every implementation — including the reference toolkit in
this repository — follows this spec, never the other way around.

---

## Table of contents

1. [Overview](#1-overview)
2. [Conformance and terminology](#2-conformance-and-terminology)
3. [Container format — folder first](#3-container-format--folder-first)
4. [Pack layout](#4-pack-layout)
5. [manifest.json](#5-manifestjson)
6. [snapshot.png](#6-snapshotpng)
7. [Replay video](#7-replay-video)
8. [annotations.json](#8-annotationsjson)
9. [Blur and privacy](#9-blur-and-privacy)
10. [timeline.json](#10-timelinejson)
11. [plugins/](#11-plugins)
12. [report.md, README.md, and skills/](#12-reportmd-readmemd-and-skills)
13. [Versioning and compatibility](#13-versioning-and-compatibility)
14. [Minimal valid pack](#14-minimal-valid-pack)
- [Appendix A: JSON Schemas](#appendix-a-json-schemas)

---

## 1. Overview

A **CapturePack** is a small, self-contained package that explains a visual situation — usually a
bug — to another human or to an LLM. It bundles what a screenshot cannot:

- **snapshot.png** — the captured frame (pixels). Original, never modified.
- **replay video** — the last ~30 seconds before capture (motion). Original evidence, never
  modified.
- **replay_annotated video** — the replay with annotations rendered in: instantly understandable
  in any video player, and always regenerable from the originals.
- **annotations.json** — annotation **boxes**: bounded regions with text, a lifetime, an optional
  number, and an optional blur, stored as editable data (intent). The true source that
  `replay_annotated` is rendered from.
- **timeline.json** — a machine-readable, replayable event log (time).
- **manifest.json** — identity, environment, and an inventory of the pack (structure).
- **report.md** — a generated narrative of all of the above (understanding).
- **README.md** — the first document a *human* reads: what happened, what's in the folder, how to
  use it.
- **skills/** — context structured for *LLMs*: small focused documents an AI can read directly,
  with no CapturePack-specific tooling and no MCP server.
- **plugins/** — optional structured metadata appended by plugins (extra context).

### Design goals

These follow directly from the project principles in `GOAL.md`:

- **Local first, offline, forever readable.** A pack is plain files in a folder (optionally
  zipped for distribution). No cloud, no login, no database, no proprietary runtime. A file
  manager plus a text editor is a valid viewer.
- **Folder first.** The save unit is a **directory**; a `.capturepack` ZIP is a distribution
  package made from it on demand, never the original ([§3](#3-container-format--folder-first)).
- **Open and language-neutral.** A shell script, a Rust CLI, or a browser extension can all write
  valid packs. Nothing in this format requires a specific library.
- **Data over pixels.** Annotations are structured data, editable forever, and are **never**
  burned into the original media — not even blur ([§9](#9-blur-and-privacy)). Rendered artifacts
  like `replay_annotated.webm` are derived views, regenerable from the originals at any time.
- **Two audiences, one pack.** A person should understand the situation from
  `replay_annotated.webm` (or `snapshot.png`) alone; an AI should understand it from `README.md`
  + `skills/` + the JSON files alone. One pack carries complete context for both.
- **Plugin-based, core-owned.** Core owns capture. Plugins only append metadata under `plugins/`
  and can never alter core files.
- **Never sacrifice the 5-second workflow.** The format imposes nothing that would slow down
  `Ctrl+Alt+C → annotate → save`.

### What this spec is not

This spec defines a **file format**, not an application. Hotkeys, editors, replay buffers,
background renderers, auto-update, and UI are implementation concerns and appear here only as
context.

---

## 2. Conformance and terminology

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**,
**SHOULD NOT**, **RECOMMENDED**, **MAY**, and **OPTIONAL** in this document are to be interpreted
as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) when, and only when, they appear in all
capitals.

| Term | Meaning |
|---|---|
| **Pack** | A CapturePack: a pack **folder**, or a `.capturepack` ZIP made from one. Both forms are valid; the folder is primary (see [§3](#3-container-format--folder-first)). |
| **Writer** (or **exporter**) | Software that produces a pack. The reference app is a writer; so is any script that assembles the files by hand. |
| **Reader** | Software that consumes a pack: viewers, editors, converters, indexers, LLM ingestion pipelines. |
| **Source files** | The files annotations and views are derived *from*: `manifest.json`, `snapshot.png`, the replay video, `annotations.json`, `timeline.json`. |
| **Generated views** | Files derived from the source files for a specific audience: `replay_annotated` (video players), `report.md` (narrative), `README.md` (humans), `skills/` (LLMs). Regenerating any of them from the source files SHOULD produce an equivalent result; none of them is ever authoritative over the source files. |
| **Plugin** | An extension that appends structured metadata under `plugins/<name>/`. Plugins never modify core files. |
| **Snapshot pixel coordinates** | The coordinate space of `snapshot.png`: origin at the top-left pixel, x grows right, y grows down, units are pixels of the snapshot image. |
| **Replay clock** | The millisecond clock of the replay timeline: `0` at the replay's first frame. Annotation lifetimes ([§8.4](#84-lifetime)), `manifest.media.snapshot_t_ms`, and (when `t0` is the replay start) timeline `t_ms` offsets all use it. |

All JSON in a pack MUST be UTF-8 encoded, without a byte-order mark. Writers SHOULD pretty-print
JSON (packs are meant to be opened and read by humans, not only machines). Unless a field is
explicitly documented as nullable, writers MUST omit a field rather than write `null`.

---

## 3. Container format — folder first

The primary form of a CapturePack is a **plain directory**. The ZIP file is a distribution
package created from that directory on demand — packaging, not transformation. Tools MUST accept
both forms wherever a pack is an input; this spec uses "pack" for both and "pack root" for the
directory (or archive root) that contains `manifest.json`.

### 3.1 The pack folder (the save unit)

A directory containing the files of [§4](#4-pack-layout) *is* a CapturePack. Writers save into a
folder; nothing further is required.

- The RECOMMENDED folder name is `CapturePack_YYYY-MM-DD_HHMMSS` (local time of the capture),
  e.g. `CapturePack_2026-07-27_143052`, so packs sort chronologically. On a name collision,
  writers SHOULD append a numeric suffix: `CapturePack_2026-07-27_143052-2`, `-3`, and so on.
- Writers MUST NOT create a ZIP automatically as part of saving. Zipping happens only as an
  explicit, user- or caller-initiated distribution step ([§3.2](#32-the-capturepack-file-distribution)).
- **A folder may be observed mid-save.** Save-first writers create the folder at the moment of
  capture and update its files as the user annotates; generated views — in particular the
  annotated replay, which may render in the background — can appear later than the source files.
  Readers SHOULD tolerate a pack whose declared `replay_annotated` file is not (yet) present
  ([§5.3](#53-media)) and fall back to the source files.

### 3.2 The `.capturepack` file (distribution)

A `.capturepack` file is a **standard ZIP archive** (PKWARE APPNOTE ZIP) of the pack folder's
*contents* — made to travel: attached to issues, dropped into chats, sent to another machine.

- The RECOMMENDED name is the folder name plus the extension, as a sibling of the folder:
  `CapturePack_2026-07-27_143052.capturepack`.
- Entries MUST use compression method **store (0)** or **deflate (8)** only.
- The archive MUST NOT be encrypted, split, or spanned.
- Entry names MUST be UTF-8, use `/` as the path separator, and MUST be relative paths. Entry
  names MUST NOT contain `..` segments or begin with `/` or a drive letter. Readers MUST reject
  entries that would escape the extraction root (zip-slip).
- The pack's files MUST be at the **root** of the archive: `manifest.json` is a top-level entry,
  not nested inside a wrapping folder. Readers MAY, defensively, accept an archive whose entries
  all share a single top-level directory, but writers MUST NOT produce one.
- Explicit directory entries (e.g. `plugins/`) are OPTIONAL.
- The file extension is `.capturepack`. There is no registered media type; `application/zip` is
  accurate where one is needed.

> **Note.** A future *sanitized* ZIP variant — one that deliberately excludes the unredacted
> originals when blur is used — is anticipated but **not defined in 0.1.0**. See
> [§9](#9-blur-and-privacy).

---

## 4. Pack layout

```
CapturePack_2026-07-27_143052/        — or the same tree zipped as a .capturepack
├── manifest.json            REQUIRED   identity, environment, inventory
├── snapshot.png             REQUIRED   the captured frame — original pixels, never modified
├── replay.webm              OPTIONAL   last ~30 s of replay (or replay.mp4) — original evidence,
│                                       never modified
├── replay_annotated.webm    OPTIONAL (RECOMMENDED) annotations rendered in; plays in any player;
│                                       regenerable from replay + annotations.json
├── annotations.json         OPTIONAL   annotation boxes — the true source of annotation data
├── timeline.json            OPTIONAL   machine-readable event log
├── report.md                OPTIONAL (RECOMMENDED) generated narrative
├── README.md                OPTIONAL (RECOMMENDED) human-first entry point
├── skills/                  OPTIONAL (RECOMMENDED) AI-first context documents
│   ├── overview.md                     whole-pack summary
│   ├── timeline.md                     the timeline, narrated
│   ├── annotation.md                   the annotations, narrated
│   ├── dom.md                          DOM/object metadata, when present
│   └── project.md                      what a CapturePack is, for cold-start readers
└── plugins/                 OPTIONAL   one subdirectory per plugin (an empty plugins/ is fine)
    └── git/
        ├── meta.json        REQUIRED per plugin directory
        └── state.json       (arbitrary plugin files)
```

| Path | Requirement | Section |
|---|---|---|
| `manifest.json` | REQUIRED | [§5](#5-manifestjson) |
| `snapshot.png` | REQUIRED | [§6](#6-snapshotpng) |
| `replay.webm` **or** `replay.mp4` | OPTIONAL — declared in `manifest.media.replay` | [§7](#7-replay-video) |
| `replay_annotated.webm` **or** `replay_annotated.mp4` | OPTIONAL (RECOMMENDED when annotations exist) — declared in `manifest.media.replay_annotated` | [§7.2](#72-the-annotated-replay) |
| `annotations.json` | OPTIONAL — fixed name, present when annotations exist | [§8](#8-annotationsjson) |
| `timeline.json` | OPTIONAL — fixed name, present when events were recorded | [§10](#10-timelinejson) |
| `report.md` | OPTIONAL (RECOMMENDED) — fixed name | [§12.1](#121-reportmd) |
| `README.md` | OPTIONAL (RECOMMENDED) — fixed name | [§12.2](#122-readmemd) |
| `skills/` | OPTIONAL (RECOMMENDED) — fixed names inside | [§12.3](#123-skills) |
| `plugins/<name>/` | OPTIONAL — each declared in `manifest.plugins` | [§11](#11-plugins) |

The manifest is the pack's entry point. Components whose identity varies are declared there
explicitly: the replay's actual filename and duration in `media`, the annotated replay's filename
in `media.replay_annotated`, and every plugin payload in `plugins`. The remaining optional files
have fixed, well-known names; their presence in the pack is their declaration. Readers MUST NOT
fail because an optional file is absent, and MUST ignore unknown extra files anywhere in the pack
(see [§13](#13-versioning-and-compatibility)).

A **screenshot-only pack** — `manifest.json` + `snapshot.png`, nothing else — is fully valid (see
[§14](#14-minimal-valid-pack)).

---

## 5. manifest.json

`manifest.json` is REQUIRED. It identifies the pack, records the capture environment, and
inventories the variable parts of the pack.

### 5.1 Top-level fields

| Field | Type | Required | Description |
|---|---|---|---|
| `format` | string | REQUIRED | MUST be the literal string `"capturepack"`. The first thing a reader checks. |
| `format_version` | string | REQUIRED | Version of this specification the pack conforms to, as [semver](https://semver.org/) (`"0.1.0"`). See [§13](#13-versioning-and-compatibility). |
| `id` | string | REQUIRED | RFC 4122 UUID uniquely identifying this pack. Version 4 (random) RECOMMENDED. Lowercase RECOMMENDED. |
| `created_at` | string | REQUIRED | Capture instant as ISO 8601 with a timezone offset (`"2026-07-27T14:03:21+09:00"` or `...Z`). A timezone designator MUST be present — local wall-clock time is context. |
| `generator` | object | REQUIRED | The software that wrote the pack: `{ "name": string, "version": string }`. Both fields REQUIRED. |
| `title` | string | OPTIONAL | Short human-readable title, one line. Used as the report heading and RECOMMENDED as part of documentation; the pack *folder* name stays the timestamped default ([§3.1](#31-the-pack-folder-the-save-unit)). |
| `note` | string | OPTIONAL | The user's own words about intent: what they were doing, what they expected, what went wrong. Carried verbatim into `report.md` and `README.md`. This is the single most valuable field for an LLM — writers SHOULD make entering it effortless, and MUST NOT block saving on it (the 5-second workflow wins). |
| `environment` | object | REQUIRED | Where the capture happened. See [§5.2](#52-environment). |
| `media` | object | REQUIRED | Declares the snapshot, replay, and annotated replay. See [§5.3](#53-media). |
| `plugins` | array | OPTIONAL | One entry per plugin payload in `plugins/`. Absent or `[]` means no plugin data. See [§5.4](#54-plugins). |

### 5.2 `environment`

| Field | Type | Required | Description |
|---|---|---|---|
| `os` | string | REQUIRED | Operating system family, lowercase. RECOMMENDED values: `"windows"`, `"macos"`, `"linux"`. Other values MAY be used for other platforms. |
| `os_version` | string | OPTIONAL (RECOMMENDED) | Free-form OS version, e.g. `"11 Pro 26200"` or `"14.5"`. |
| `screens` | array | OPTIONAL (RECOMMENDED) | The displays present at capture time, in OS enumeration order. Each entry: see below. |
| `app` | string | OPTIONAL | Name of the application that had focus at capture time, e.g. `"notably.exe"` or `"Google Chrome"`. Plugins can attach richer window/app data under `plugins/`. |

Each `screens` entry:

| Field | Type | Required | Description |
|---|---|---|---|
| `width` | integer | REQUIRED | Display width in physical pixels. |
| `height` | integer | REQUIRED | Display height in physical pixels. |
| `scale` | number | OPTIONAL | OS display scale factor (`1`, `1.25`, `1.5`, `2`, …). Default `1`. |

`screens` describes the hardware environment; it does not define the annotation coordinate space.
Annotations are always in snapshot pixel coordinates ([§8.2](#82-coordinate-space)), regardless
of screen count or scaling.

### 5.3 `media`

| Field | Type | Required | Description |
|---|---|---|---|
| `snapshot` | string | REQUIRED | Filename of the snapshot. In format 0.1.0 this MUST be `"snapshot.png"`. Declared explicitly so future versions can vary it without breaking readers that trust the manifest. |
| `replay` | string **or** `null` | REQUIRED | Filename of the original replay video — `"replay.webm"` or `"replay.mp4"` — or `null` for a screenshot-only pack. Readers MUST take the replay filename from this field rather than probing the pack. |
| `replay_duration_ms` | integer **or** `null` | REQUIRED when `replay` is a string | Duration of the replay video in milliseconds. MUST be `null` (or absent) when `replay` is `null`. |
| `replay_annotated` | string | OPTIONAL | Filename of the **annotated replay** — `"replay_annotated.webm"` or `"replay_annotated.mp4"` ([§7.2](#72-the-annotated-replay)). MUST be absent when `replay` is `null` (there is nothing to render it from). Absent while the annotated replay has not (yet) been rendered. The annotated replay may render in the background after save, so a reader MAY encounter a manifest that declares this file before the file exists — it SHOULD treat that as "still rendering" and fall back to `replay` + `annotations.json`. |
| `snapshot_t_ms` | integer | OPTIONAL | Position on the replay clock, in milliseconds, of the frame shown in `snapshot.png` — the same clock as annotation lifetimes ([§8.4](#84-lifetime)) and timeline `t_ms` offsets relative to `t0` ([§10.1](#101-structure)). MUST be >= 0. **Absent means the snapshot is the capture instant** — the native "now" frame. SHOULD be absent when `replay` is `null`: without a replay there is no timeline to anchor the value to. See [§7.1](#71-frame-accurate-captures). |
| `trim_offset_ms` | integer | OPTIONAL | **Provenance only.** When the writer trimmed the replay before saving, the position (ms) in the original captured recording of this replay's first frame — the trim in-point. MUST be >= 0. Purely informational: every time in the pack (annotation lifetimes, `snapshot_t_ms`, timeline offsets against `t0`) is already on the trimmed replay's clock, so readers never apply this offset to anything. Absent means the replay was never trimmed. SHOULD be absent when `replay` is `null`. |

### 5.4 `plugins`

Each entry declares one plugin payload directory:

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | REQUIRED | Plugin name. MUST match `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$` (lowercase letters, digits, single hyphens; no leading/trailing hyphen). MUST equal the `name` in the plugin's `meta.json` and the directory name. |
| `version` | string | REQUIRED | Plugin version (semver RECOMMENDED). MUST equal the `version` in the plugin's `meta.json`. |
| `path` | string | REQUIRED | Directory path relative to the pack root, with trailing slash. MUST be exactly `"plugins/<name>/"`. |

Every directory under `plugins/` written by the exporter MUST have a corresponding entry here.
An empty `plugins/` directory (no payloads, no declarations) is fine. Readers MUST ignore any
`plugins/` directory they find that is *not* declared (or not understood) — see
[§11](#11-plugins).

### 5.5 Example

```json
{
  "format": "capturepack",
  "format_version": "0.1.0",
  "id": "5f0c1e0a-8f7e-4c2b-9d3a-1b2c3d4e5f6a",
  "created_at": "2026-07-27T14:03:21+09:00",
  "generator": { "name": "capturepack", "version": "0.1.0" },
  "title": "Save button stays disabled after renaming a document",
  "note": "Renamed the document, then tried to save. The Save button never re-enables. Reproduced 3 times in a row. Expected: Save enables as soon as the title changes.",
  "environment": {
    "os": "windows",
    "os_version": "11 Pro 26200",
    "screens": [
      { "width": 2560, "height": 1440, "scale": 1.0 }
    ],
    "app": "notably.exe"
  },
  "media": {
    "snapshot": "snapshot.png",
    "replay": "replay.webm",
    "replay_duration_ms": 28437,
    "replay_annotated": "replay_annotated.webm"
  },
  "plugins": [
    { "name": "git", "version": "0.1.0", "path": "plugins/git/" }
  ]
}
```

---

## 6. snapshot.png

`snapshot.png` is REQUIRED. It is the single still frame the pack is built around — normally the
screen content at (or immediately before) the capture trigger.

- It MUST be a valid PNG. Truecolor (8-bit RGB or RGBA) is RECOMMENDED.
- Its pixel dimensions define the **snapshot pixel coordinate space** used by all annotations,
  and MUST equal `reference_width` × `reference_height` in `annotations.json` when that file is
  present ([§8.2](#82-coordinate-space)).
- What the snapshot shows — one screen, a region, a window, the whole virtual desktop — is the
  writer's choice. The format does not care; annotations are relative to the image itself.
- **The snapshot is original evidence and MUST NOT be modified.** No annotation is ever burned
  into `snapshot.png` — including blur. Blur renders only into derived views
  ([§9](#9-blur-and-privacy)). The snapshot is pixels; annotations are data drawn on top of it by
  viewers.

---

## 7. Replay video

The replay video is OPTIONAL. When present it holds the last stretch of screen activity leading
up to the capture — the MVP target is a ~30-second rolling buffer — so a reader can watch what
happened *before* the frame.

- The filename MUST be `replay.webm` or `replay.mp4`, and MUST match `manifest.media.replay`.
  A pack MUST NOT contain more than one replay file.
- `replay.webm` is the RECOMMENDED container: browser `MediaRecorder` produces WebM (VP8/VP9)
  with no extra dependencies, which fits the minimal-dependencies principle. `replay.mp4` MAY be
  used by tools that can produce it; H.264 video is RECOMMENDED inside MP4 for playback
  compatibility.
- `manifest.media.replay_duration_ms` MUST hold the video's duration in milliseconds.
- Audio is OPTIONAL and typically absent.
- **The replay is original evidence and MUST NOT be modified.** Annotations — including blur —
  are never burned into `replay.webm`/`replay.mp4`. Annotations live in `annotations.json` as
  editable data; the rendered view lives in the *separate* annotated replay file
  ([§7.2](#72-the-annotated-replay)).
- **Privacy note:** because the original replay is never redacted, blurred content is visible in
  it. See the sharing rule in [§9](#9-blur-and-privacy).
- A screenshot-only pack (`"replay": null`) is fully valid. Replay is evidence, not a
  prerequisite.

When both a replay and a timeline exist, `timeline.json`'s `t0` SHOULD be the instant of the
replay's first frame, so event offsets double as video seek positions ([§10.1](#101-structure)).

### 7.1 Frame-accurate captures

An editor that holds the frozen replay can let the user scrub backwards in time and pick the
exact frame that shows the problem — the moment *before* the dialog closed, the frame where the
glitch is visible. The chosen frame becomes `snapshot.png`, and the writer records its position
on the replay clock in `manifest.media.snapshot_t_ms` ([§5.3](#53-media)). When `snapshot_t_ms`
is absent, the snapshot is the capture instant — the default, and the only possibility in a
screenshot-only pack.

A scrubbed snapshot changes nothing else about the format:

- `snapshot.png` is still the single still frame the pack is built around, and its pixel
  dimensions still define the annotation coordinate space ([§8.2](#82-coordinate-space)).
  Writers composing the snapshot from a decoded video frame SHOULD render it at the same
  resolution a capture-instant snapshot would have had, so the coordinate space does not depend
  on the replay's encoded resolution.
- Individual annotations scope *when* they apply with their lifetime interval
  (`start_ms`/`end_ms`, [§8.4](#84-lifetime)) — useful when different annotations were made at
  different scrub positions.

### 7.2 The annotated replay

`replay_annotated.webm` (or `.mp4`) is OPTIONAL, and RECOMMENDED whenever the pack has both a
replay and annotations. It is the replay with the annotation boxes **rendered into the pixels**,
so that any video player — and any human with ten seconds — sees the full story without
CapturePack-aware tooling.

- The filename MUST be `replay_annotated.webm` or `replay_annotated.mp4`, and MUST match
  `manifest.media.replay_annotated` ([§5.3](#53-media)). A pack MUST NOT contain more than one
  annotated replay file. A pack without a replay MUST NOT contain one at all.
- The annotated replay is a **generated view**, never a source: it MUST be renderable from
  `replay` + `annotations.json` alone, and regenerating it after editing annotations SHOULD
  produce an equivalent result. Readers MUST NOT treat its pixels as authoritative annotation
  data — `annotations.json` is the truth.
- **Per-frame rendering.** For each frame at replay-clock time `t`, a renderer draws, in order:
  1. the original frame;
  2. the **blur** of every box with `blur: true` whose lifetime contains `t`
     ([§9](#9-blur-and-privacy)) — blur first, so nothing sensitive leaks under later layers;
  3. each visible box's **border/highlight**;
  4. each visible numbered box's **number badge**, using the box's *global* display number
     ([§8.5](#85-display-numbers)) — numbers are never re-compressed per frame;
  5. each visible box's **text**.
- A box is *visible* at `t` when its lifetime contains `t`; boxes without a lifetime are visible
  for the whole video ([§8.4](#84-lifetime)).
- **Results only.** Editing controls MUST NOT appear in the annotated replay: no headers, no
  toggles, no duration chips, no delete buttons, no resize handles, no selection outlines. The
  video contains blur, borders, number badges, and text — nothing else.
- Rendering MAY happen in the background after the pack is saved ([§3.1](#31-the-pack-folder-the-save-unit));
  a render failure loses the annotated replay, not the pack.

---

## 8. annotations.json

`annotations.json` is OPTIONAL; it is present when the user annotated the capture. Annotations
are the *intent* layer: they say what matters in the pixels. They are stored as data, are
editable forever, and are never burned into the original media ([§6](#6-snapshotpng),
[§7](#7-replay-video)); the annotated replay is a derived rendering of them
([§7.2](#72-the-annotated-replay)).

Format 0.1.0 defines exactly **one annotation type: the box.** There are no pin, arrow,
rectangle, blur, or text annotation types — a box *composes* those roles through its properties:
a box with `numbered: true` plays the role of a numbered pin; a box with `blur: true` marks a
sensitive region; a box with text is a labeled callout; any combination is valid on a single box.

### 8.1 Structure

| Field | Type | Required | Description |
|---|---|---|---|
| `reference_width` | integer | REQUIRED | Width in pixels of the coordinate space — MUST equal the pixel width of `snapshot.png`. |
| `reference_height` | integer | REQUIRED | Height in pixels of the coordinate space — MUST equal the pixel height of `snapshot.png`. |
| `annotations` | array | REQUIRED | List of annotation boxes. May be empty. Order carries no meaning — reading order is defined by the display-number rule ([§8.5](#85-display-numbers)) and lifetimes, not by array position. |

### 8.2 Coordinate space

All annotation geometry is in **snapshot pixel coordinates**: origin at the top-left pixel of
`snapshot.png`, x grows right, y grows down, units are snapshot pixels. Coordinates MAY be
non-integers (sub-pixel positions from freehand drawing are fine).

`reference_width`/`reference_height` exist so annotations survive image processing: if a reader
finds that `snapshot.png`'s actual dimensions differ from the reference (for example the snapshot
was recompressed or scaled by an intermediate tool), it SHOULD scale all geometry by
`actual / reference` per axis rather than discard the annotations.

### 8.3 The box

Every annotation object:

| Field | Type | Required | Description |
|---|---|---|---|
| `annotation_id` | string | REQUIRED | Permanent identity of the annotation. MUST match `^ann_[0-9a-f]{6}$` — the literal prefix `ann_` plus 6 lowercase hex digits, e.g. `"ann_8f21c4"`. MUST be unique within this file. Referenced by timeline events, documents, and MCP responses. The id never changes; display numbers do ([§8.5](#85-display-numbers)). |
| `type` | string | REQUIRED | MUST be `"box"` — the only annotation type in format 0.1.0. Readers MUST skip (and SHOULD preserve on rewrite) annotations of unknown type; new types can only arrive in a future format version. |
| `bounds` | object | REQUIRED | The box rectangle in snapshot pixel coordinates: `{ "x": number, "y": number, "width": number, "height": number }`. All four fields REQUIRED; `width` and `height` MUST be > 0. |
| `text` | string | OPTIONAL | The box's description — what the user typed. MAY be empty; absent means `""`. This is the annotation's meaning; writers SHOULD make entering it effortless. |
| `start_ms` | number | OPTIONAL | Start of the box's **lifetime** on the replay clock, in milliseconds. MUST appear together with `end_ms` — both or neither. See [§8.4](#84-lifetime). |
| `end_ms` | number | OPTIONAL | End of the box's lifetime, in milliseconds. MUST be >= `start_ms`. MUST appear together with `start_ms`. |
| `numbered` | boolean | OPTIONAL | Whether the box takes part in display numbering ([§8.5](#85-display-numbers)). Default `false`. The number itself is **never stored** — it is computed. |
| `blur` | boolean | OPTIONAL | Whether the box's interior is sensitive and MUST be blurred in rendered views ([§9](#9-blur-and-privacy)). Default `false`. Blur is a box property, never a separate annotation type. |
| `tracking` | object | OPTIONAL | Object-tracking state. In format 0.1.0 the only defined field is `enabled` (boolean, REQUIRED inside `tracking`), and it MUST be `false` — frame-by-frame tracking data (bounds following a moving object) is **reserved** for a future version. Absent means `{ "enabled": false }`. Readers MUST ignore tracking content they do not understand and treat the box as untracked. |
| `target` | object | OPTIONAL | **Reserved** for semantic object metadata: what real UI object the box points at (DOM selector, role and text; Windows UI Automation `AutomationId`/`ControlType`; engine object ids…). This is where the earlier draft's "element"/Tracked Element concept lives now — a box *with a target* is a semantic annotation; there is no separate element type. Format 0.1.0 does not define its contents; readers MUST ignore what they do not understand and MUST still render the box from `bounds`. |
| `style` | object | OPTIONAL | Display styling. In 0.1.0 the only defined field is `color`: CSS-style hex, `"#RRGGBB"` or `"#RRGGBBAA"`, used for the border, badge, and text. Viewers pick their own default when absent. |
| `created_at` | string | OPTIONAL | When the annotation was made, ISO 8601 with timezone. |
| `z` | integer | OPTIONAL | Stacking order for rendering; higher draws on top. Also a tiebreaker in display numbering ([§8.5](#85-display-numbers)). Default: the annotation's array position (later entries on top). |

### 8.4 Lifetime

A box MAY carry a **lifetime**: the closed interval `[start_ms, end_ms]` of the replay clock
during which the box applies — the same millisecond clock as `manifest.media.snapshot_t_ms` and
as timeline offsets relative to `t0` ([§10.1](#101-structure)).

- **Absent lifetime = whole capture.** When neither field is present the box applies to the
  entire capture. This is always valid — a simple writer that does not track time just omits both
  fields, and it is the natural state in a screenshot-only pack.
- **Both or neither.** `start_ms` and `end_ms` MUST be written together; a box with only one of
  them is malformed. (The JSON schema enforces this pairing.)
- **Well-formed interval.** `start_ms` MUST be <= `end_ms`, and both bounds SHOULD lie within
  `[0, replay_duration_ms]`. Lifetimes are only meaningful when the pack has a replay; in a
  screenshot-only pack writers SHOULD omit them.
- **The midpoint is the anchor.** When a single representative instant is needed for a box — the
  frame a document links to, the seek position a viewer jumps to — it is the **midpoint** of the
  lifetime, `(start_ms + end_ms) / 2`. A box without a lifetime has no anchor (treat as the
  snapshot frame). There is no separately stored anchor field.
- **Rendering.** A viewer scrubbing the replay SHOULD draw a box only while the current position
  lies inside its lifetime; boxes without a lifetime always draw. The annotated replay renders by
  the same rule ([§7.2](#72-the-annotated-replay)) — including blur, which applies exactly during
  the lifetime ([§9](#9-blur-and-privacy)).

### 8.5 Display numbers

Numbered boxes carry visible numbers — ①, ②, ③ — in every rendered view. Those numbers are
**computed, never stored**:

- A box's permanent identity is its immutable `annotation_id`. The display number is derived at
  display/render time and is not a source-data identifier. Writers MUST NOT store display
  numbers in the pack; readers MUST NOT parse them back out of rendered views.
- **The rule.** Take every box with `numbered: true`. Sort by:
  1. `start_ms` ascending, treating an absent lifetime as `start_ms = 0`;
  2. then `z` ascending (absent `z` = array position);
  3. then `annotation_id` ascending (lexicographic).
  Number them contiguously from **1** in that order. No gaps, ever: adding, deleting, or
  re-timing a box renumbers the rest immediately.
- **Consistency scope.** Every consumer MUST use exactly this rule, so the same box shows the
  same number everywhere: editor canvas, annotated replay, `report.md`, `README.md`, `skills/`
  documents, and MCP responses. Video numbers and document numbers never differ.
- **Global, not per-frame.** In the annotated replay, each frame draws only the boxes alive at
  that time, but with their global numbers: if only box ② is visible in a frame, it renders as
  ② — numbers are never re-compressed per frame ([§7.2](#72-the-annotated-replay)).
- Documents list numbered boxes in display order, e.g. `1. 00:03.200 — "renamed the document
  here"` ([§12](#12-reportmd-readmemd-and-skills)); if annotations change after generation, the
  documents are regenerated on the next save.

### 8.6 Example

```json
{
  "reference_width": 2560,
  "reference_height": 1440,
  "annotations": [
    {
      "annotation_id": "ann_8f21c4",
      "type": "box",
      "bounds": { "x": 620, "y": 380, "width": 300, "height": 44 },
      "text": "renamed the document here",
      "start_ms": 21500,
      "end_ms": 23000,
      "numbered": true,
      "blur": false,
      "tracking": { "enabled": false },
      "style": { "color": "#FF3B30" },
      "created_at": "2026-07-27T14:03:26+09:00",
      "z": 1
    },
    {
      "annotation_id": "ann_1d9b02",
      "type": "box",
      "bounds": { "x": 2140, "y": 1236, "width": 180, "height": 56 },
      "text": "Save — stays disabled, clicked 3x",
      "start_ms": 26900,
      "end_ms": 27900,
      "numbered": true,
      "blur": false,
      "tracking": { "enabled": false },
      "style": { "color": "#FF3B30" },
      "created_at": "2026-07-27T14:03:29+09:00",
      "z": 2
    },
    {
      "annotation_id": "ann_e33a7f",
      "type": "box",
      "bounds": { "x": 2080, "y": 24, "width": 360, "height": 40 },
      "text": "user email address",
      "start_ms": 0,
      "end_ms": 28437,
      "numbered": false,
      "blur": true,
      "tracking": { "enabled": false },
      "created_at": "2026-07-27T14:03:34+09:00",
      "z": 3
    }
  ]
}
```

Display numbers here: `ann_8f21c4` (start 21500) is **1**, `ann_1d9b02` (start 26900) is **2**;
`ann_e33a7f` is not numbered. The blurred box covers the whole replay, so the email address is
obscured in every frame of `replay_annotated.webm` — while `replay.webm` and `snapshot.png` keep
the original pixels ([§9](#9-blur-and-privacy)).

---

## 9. Blur and privacy

Blur is a **box property** (`blur: true`, [§8.3](#83-the-box)), not an annotation type, and it is
**non-destructive**: the original media in the pack are never modified.

### 9.1 The rule

1. **Originals stay original.** `snapshot.png` and the replay video MUST contain the original,
   unredacted pixels. Writers MUST NOT apply blur — or any annotation — destructively to them.
2. **Blur renders into derived views only.** Every rendered view of the capture — the annotated
   replay ([§7.2](#72-the-annotated-replay)), live editor previews, any future export — MUST
   obscure the interior of every `blur: true` box while that box is alive:
   - during the box's lifetime ([§8.4](#84-lifetime)); a box without a lifetime blurs every
     frame;
   - over the box's current bounds — the blur moves with the box (including future tracked
     bounds);
   - **before** any other annotation layer is drawn, so borders, badges, and text never sit on
     top of unredacted pixels ([§7.2](#72-the-annotated-replay)).
3. **Blur data is ordinary data.** The box stays fully editable in `annotations.json` — movable,
   resizable, removable — and rewriting the pack regenerates the derived views accordingly.
4. **Obscure strongly.** In rendered views, strong pixelation (large blocks) or a solid fill is
   RECOMMENDED. A weak Gaussian blur SHOULD NOT be used: lightly blurred text can sometimes be
   reconstructed.

### 9.2 The sharing rule

Because the originals are preserved, **the pack folder itself is not redacted**. The redaction
lives in `replay_annotated` — the artifact meant for sharing. Consequences:

- Writers MUST make this visible at save time whenever any `blur: true` box exists. The
  reference wording:

  > Original replay contains unredacted content — share replay_annotated.webm or create a
  > sanitized ZIP.

- Readers MUST NOT assume `snapshot.png` or the replay video honor blur boxes — they never do in
  format 0.1.0.
- `report.md`, `README.md`, and `skills/` documents SHOULD note when a pack contains blurred
  boxes, so downstream humans and LLMs know which files are safe to forward.

### 9.3 Why non-destructive

An earlier draft of this spec burned blur into `snapshot.png` destructively. 0.1.0 reverses that,
deliberately:

- **Evidence survives.** The pack's reason to exist is faithful context. Destroying pixels in the
  source of truth contradicts it — and could never cover the replay anyway, which shows the same
  content in motion.
- **Blur stays editable.** A mis-drawn blur box can be fixed and the views re-rendered. A
  destructive blur was forever, including its mistakes.
- **The folder is local.** A pack folder lives on the user's own machine; redaction matters at
  the moment of *sharing*, and the shareable artifact — `replay_annotated` — is exactly where
  blur renders.

### 9.4 Sanitized distribution (future)

A future version will define a **sanitized ZIP**: a `.capturepack` variant that excludes the
unredacted originals (`replay.webm`/`replay.mp4` and `snapshot.png`) and ships the annotated
replay in their place, for sharing a blurred capture without any unredacted pixels at all. It is
**not defined in 0.1.0**; until then, the sharing rule of [§9.2](#92-the-sharing-rule) is the
guidance.

---

## 10. timeline.json

`timeline.json` is OPTIONAL. It is the machine-readable record of *when things happened*:
append-only during capture, ordered, and replayable — a reader can step through events against
the replay video or reconstruct the session's story without watching anything.

### 10.1 Structure

| Field | Type | Required | Description |
|---|---|---|---|
| `t0` | string | REQUIRED | The absolute anchor instant, ISO 8601 with timezone. Every event's `t_ms` is an offset in milliseconds relative to `t0`. When a replay video exists, `t0` SHOULD be the instant of the replay's first frame, so `t_ms` doubles as a video seek position (and shares the replay clock with annotation lifetimes, [§8.4](#84-lifetime)). Otherwise the capture trigger instant is a natural choice. |
| `events` | array | REQUIRED | The events, sorted ascending by `t_ms` (stable order for equal values). Writers MUST only append while capturing — events are never rewritten or reordered during a session. May be empty. |

Each event:

| Field | Type | Required | Description |
|---|---|---|---|
| `t_ms` | integer | REQUIRED | Milliseconds relative to `t0`. MAY be negative (an event that occurred before `t0`). |
| `type` | string | REQUIRED | Namespaced dot-path identifying the event kind — see [§10.2](#102-event-namespaces). |
| `source` | string | REQUIRED | The component that emitted the event: `"core"` for `core.*` events; the plugin name (matching `plugins/<name>/`) for `plugin.<name>.*` events. |
| `data` | object | OPTIONAL | Type-specific payload. Absent means `{}`. Keep it small and structured — the timeline is an index into the capture, not a data store (bulk data belongs under `plugins/`). |

### 10.2 Event namespaces

Event types are lowercase dot-paths. The first segment is the namespace:

| Namespace | Status in 0.1.0 | Description |
|---|---|---|
| `core.*` | Defined | Events emitted by the capture tool itself. |
| `input.*` | **Reserved for V2** | User input events — `input.mouse.click`, `input.key.down`, `input.window.focus`, and similar. Not defined in 0.1.0; writers MUST NOT emit them yet, and readers MUST skip them like any unknown type. |
| `plugin.<name>.*` | Defined (open) | Events emitted by plugin `<name>`. The `<name>` segment MUST match a declared plugin, and the event's `source` MUST equal `<name>`. Everything after `plugin.<name>.` is plugin-defined. |

Core events defined in 0.1.0:

| Type | Emitted when | Conventional `data` fields |
|---|---|---|
| `core.capture.triggered` | The user triggered the capture (e.g. pressed the hotkey). | `hotkey` (string, optional) |
| `core.annotation.added` | An annotation was added in the editor. | `annotation_id`, `annotation_type` (matching `annotations.json`; in 0.1.0 `annotation_type` is always `"box"`) |
| `core.export.created` | The pack was saved/exported. | `filename` (string, optional) |

`data` fields listed here are conventions, not requirements — readers MUST tolerate their
absence. Readers MUST skip events of unknown type and SHOULD preserve them when rewriting a pack.
New `core.*` event types may be added in minor format versions.

### 10.3 Example

`t0` is the replay's first frame; the capture was triggered 28.4 s later (matching
`replay_duration_ms` in [§5.5](#55-example)); annotation and save events follow after the
replay ends.

```json
{
  "t0": "2026-07-27T14:02:53.104+09:00",
  "events": [
    {
      "t_ms": 28437,
      "type": "core.capture.triggered",
      "source": "core",
      "data": { "hotkey": "Ctrl+Alt+C" }
    },
    {
      "t_ms": 33180,
      "type": "core.annotation.added",
      "source": "core",
      "data": { "annotation_id": "ann_8f21c4", "annotation_type": "box" }
    },
    {
      "t_ms": 36020,
      "type": "core.annotation.added",
      "source": "core",
      "data": { "annotation_id": "ann_1d9b02", "annotation_type": "box" }
    },
    {
      "t_ms": 44310,
      "type": "plugin.git.state-recorded",
      "source": "git",
      "data": { "branch": "fix/save-state" }
    },
    {
      "t_ms": 61042,
      "type": "core.export.created",
      "source": "core",
      "data": { "filename": "CapturePack_2026-07-27_140321" }
    }
  ]
}
```

---

## 11. plugins/

`plugins/` is OPTIONAL. It is the extension point of the format: each plugin owns exactly one
subdirectory and appends whatever structured metadata it wants there — DOM snapshots, git state,
window trees, console logs, engine data.

### 11.1 Rules

- Each plugin writes to `plugins/<plugin-name>/` and nowhere else. `<plugin-name>` MUST match
  `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$` and MUST equal the `name` declared in `manifest.plugins` and
  in the plugin's own `meta.json`.
- `plugins/<plugin-name>/meta.json` is REQUIRED in every plugin directory:

  | Field | Type | Required | Description |
  |---|---|---|---|
  | `name` | string | REQUIRED | The plugin name — MUST equal the directory name. |
  | `version` | string | REQUIRED | The plugin version (semver RECOMMENDED). |

  `meta.json` MAY contain additional fields; readers MUST ignore unknown ones.
- Beyond `meta.json`, the directory's contents are **arbitrary structured files** chosen by the
  plugin. JSON is RECOMMENDED for machine-readable data; any format is allowed.
- **Plugins only append metadata.** A plugin MUST NOT create, modify, or influence the content of
  core files. The one channel into core data is the timeline: plugins MAY emit
  `plugin.<name>.*` events ([§10.2](#102-event-namespaces)), which core appends on their behalf.
  Core owns nothing except capture; plugins own nothing except their directory.
- An empty `plugins/` directory is valid (a folder-first writer MAY always create it).
- Core readers MUST ignore plugin directories they do not recognize — unknown plugin data never
  makes a pack unreadable. Readers that rewrite packs SHOULD preserve plugin directories intact.

### 11.2 Example

```
plugins/
└── git/
    ├── meta.json
    └── state.json
```

`plugins/git/meta.json`:

```json
{
  "name": "git",
  "version": "0.1.0"
}
```

`plugins/git/state.json` (plugin-defined):

```json
{
  "repository": "notably",
  "branch": "fix/save-state",
  "commit": "3f9d2c1a7e05b2c44f8d1e6a9b0c3d5e7f194a2b",
  "dirty": true,
  "changed_files": ["src/editor/save-state.ts", "src/ui/toolbar.tsx"]
}
```

---

## 12. report.md, README.md, and skills/

Three generated, audience-specific views live beside the source files. All three are OPTIONAL
(RECOMMENDED for every pack that will be shared), all three are **generated views, not sources of
truth**: regenerating them from the source files SHOULD produce an equivalent result, writers
SHOULD regenerate them on every save, and readers MUST NOT treat any of them as authoritative
when they disagree with the JSON. Display numbers appearing in any of them MUST come from the
rule of [§8.5](#85-display-numbers).

| File | Audience | Job |
|---|---|---|
| `report.md` | Humans *and* LLMs | The narrative of the capture: note, environment, annotations, files. |
| `README.md` | Humans first | The folder's front door: what this is, what happened, how to use it. |
| `skills/*.md` | LLMs first | Focused context documents an AI can consume directly, without MCP. |

### 12.1 report.md

`report.md` is the generated narrative of the pack. The test it must pass: **a person drops the
pack into any LLM, and the model understands the situation from `report.md` + `snapshot.png` +
`annotations.json` alone** — no CapturePack-aware tooling, no video decoding, no JSON spelunking
required. To that end, `report.md` deliberately duplicates data from the JSON files in prose
form.

Recommended template:

```markdown
# {title, or "Untitled capture"}

- **Captured:** {created_at, human-readable}
- **Pack ID:** {id}
- **Generator:** {generator.name} {generator.version}

## Note

{note, verbatim — or "(no note)"}

## Environment

- **OS:** {os} {os_version}
- **Screens:** {for each: width×height @ scale}
- **Focused app:** {app, if present}
- **Replay:** {replay filename and duration in seconds, or "none (screenshot only)"}
  {plus, if present: "annotated replay: replay_annotated.webm"}

## Annotations

Coordinates are pixels in snapshot.png ({reference_width}×{reference_height}). Numbers are the
computed display numbers (SPEC §8.5) — identical in every rendered view.

1. {lifetime as mm:ss.mmm–mm:ss.mmm, or "entire capture"} — "{text}" — box at (x, y)
   size width×height{", blur" when blur: true}
2. ...
{then each unnumbered box as a bullet, same line shape:}
- {lifetime or "entire capture"} — "{text}" — box at (x, y) size width×height{", blur"}

{If any blur boxes: a line noting that N box(es) are marked blur, that snapshot.png and the
replay contain the ORIGINAL unredacted pixels, and that blur is rendered only in
replay_annotated.}

## Files

- manifest.json — {one-line purpose}
- snapshot.png — ...
- {each remaining file present in the pack, including plugins/<name>/, one line each}
```

Writers MAY extend the template (for example with a plugin-provided summary section) but SHOULD
keep the section order above so readers and LLMs see a predictable shape.

Example:

```markdown
# Save button stays disabled after renaming a document

- **Captured:** 2026-07-27 14:03 (+09:00)
- **Pack ID:** 5f0c1e0a-8f7e-4c2b-9d3a-1b2c3d4e5f6a
- **Generator:** capturepack 0.1.0

## Note

Renamed the document, then tried to save. The Save button never re-enables. Reproduced 3 times
in a row. Expected: Save enables as soon as the title changes.

## Environment

- **OS:** windows 11 Pro 26200
- **Screens:** 2560×1440 @ 1.0
- **Focused app:** notably.exe
- **Replay:** replay.webm (28.4 s) — annotated replay: replay_annotated.webm

## Annotations

Coordinates are pixels in snapshot.png (2560×1440). Numbers are the computed display numbers
(SPEC §8.5) — identical in every rendered view.

1. 00:21.750–00:22.750 — "renamed the document here" — box at (620, 380) size 300×44
2. 00:26.900–00:27.900 — "Save — stays disabled, clicked 3x" — box at (2140, 1236) size 180×56
- entire capture — "user email address" — box at (2080, 24) size 360×40, blur

1 box is marked blur. snapshot.png and replay.webm contain the original, unredacted pixels;
the blur is rendered only in replay_annotated.webm.

## Files

- manifest.json — pack identity, environment, inventory
- snapshot.png — captured frame, 2560×1440 (original pixels)
- replay.webm — last 28.4 s before capture (original evidence)
- replay_annotated.webm — the replay with the 3 boxes rendered in
- annotations.json — the 3 annotation boxes above, as editable data
- timeline.json — capture/annotation/save events
- README.md — human-first entry point
- skills/ — AI-first context documents
- plugins/git/ — git repository state at capture time
- report.md — this file
```

### 12.2 README.md

`README.md` is the **first document a human reads** when they open the folder — the front door.
Reading it alone must be enough for a person to understand the whole pack: what was captured,
when, where, what it shows, and what to open next. It is deliberately shorter and less formal
than `report.md`.

RECOMMENDED content, in order:

1. **Title** — the manifest `title` (or "Untitled capture").
2. **Created / Application / Duration** — capture instant, focused app, replay length (or
   "screenshot only").
3. **Description** — the manifest `note`, verbatim.
4. **Files** — one line per file in the folder, saying what each is (mark the originals as
   never-modified, the annotated replay as the watchable result).
5. **How to use** — e.g.:
   1. Watch `replay_annotated.webm` (or open `snapshot.png`).
   2. Read `report.md` for the full narrative.
   3. AI: read `skills/`, or connect through a CapturePack MCP server.

When blur boxes exist, `README.md` SHOULD repeat the sharing warning of
[§9.2](#92-the-sharing-rule).

### 12.3 skills/

`skills/` holds **AI-first context documents**: small, focused Markdown files structured so an
LLM understands the pack immediately even without an MCP server — plain files beat protocols for
cold starts. Each document narrates one aspect of the pack in prose + compact lists, staying
within what the source files actually contain.

Well-known filenames (all OPTIONAL; RECOMMENDED as a set):

| File | Content |
|---|---|
| `skills/overview.md` | Whole-pack summary: what happened, where to look first, counts (annotations, events, plugins), whether blur is present. |
| `skills/timeline.md` | The timeline narrated: notable events in order with timestamps, or "no timeline recorded". |
| `skills/annotation.md` | Every annotation box: display number (when numbered), text, bounds, lifetime, blur flag — plus a one-line statement of the numbering rule. |
| `skills/dom.md` | DOM/semantic object metadata when a browser or UIA plugin contributed it; otherwise a one-line "no DOM metadata in this pack" so the LLM stops looking. |
| `skills/project.md` | What a CapturePack is and how this folder is laid out — for a model that has never seen the format. |

Writers MAY add further documents under `skills/`; readers MUST ignore names they do not know.
Like every generated view, `skills/` documents are regenerated on save and are never
authoritative over the JSON files.

---

## 13. Versioning and compatibility

Generated CapturePacks should remain readable forever. This section is how.

### 13.1 `format_version` policy

`format_version` follows [Semantic Versioning](https://semver.org/):

- **Major** — breaking changes only: removing or re-meaning a field, changing required
  structure, changing the blur rule. A reader built for major version N is not expected to
  understand major version N+1.
- **Minor** — additive, backward-compatible changes: new optional fields, new annotation types,
  new core event types, new optional files. A reader built for `0.1.0` MUST be able to read a
  `0.2.0` pack by ignoring what it doesn't know.
- **Patch** — clarifications and fixes to the spec text with no format change.

Pre-1.0 caveat: while the major version is 0, minor versions carry the compatibility promises
that major versions normally do; the rules above apply with `0.x` minor acting as major.

**Writers SHOULD write the oldest `format_version` that fully expresses their content.** If a
pack uses nothing introduced after 0.1.0, declare `"0.1.0"` even if the tool knows a newer spec.
This maximizes the packs' audience — old readers keep working.

**Readers MUST accept unknown optional fields and unknown files.** Forward compatibility is a
requirement, not a courtesy:

- Unknown JSON fields anywhere: ignore them; preserve them when rewriting. (This includes the
  reserved `tracking` and `target` contents of [§8.3](#83-the-box).)
- Unknown files in the pack root or anywhere else: ignore them; preserve them when rewriting.
- Unknown annotation types, event types, plugin directories, extra `skills/` documents: skip
  them; preserve on rewrite.

Readers encountering a higher major version than they support SHOULD tell the user and MAY still
attempt a best-effort read of the parts they understand (`snapshot.png`, `report.md`, and
`replay_annotated` degrade gracefully by design).

### 13.2 Reading a pack defensively

A checklist for reader implementations:

1. **Identify.** Read `manifest.json`. Check `format == "capturepack"`; if not, this is not a
   pack. Parse `format_version`; compare the major (pre-1.0: minor) version against what you
   support, and warn — don't crash — on a newer one.
2. **Trust the manifest, tolerate its absence of extras.** Take the replay and annotated-replay
   filenames from `media`; never guess by listing files. Treat absent optional files as normal,
   not as corruption — a declared `replay_annotated` that is not on disk usually means the
   background render has not finished ([§5.3](#53-media)); fall back to `replay` +
   `annotations.json`.
3. **Validate lazily, fail small.** A malformed `timeline.json` should cost you the timeline,
   not the pack. Only a missing/unparseable `manifest.json` or `snapshot.png` makes a pack
   invalid.
4. **Skip, don't reject.** Unknown annotation types, unknown event types, unknown fields,
   unknown files, undeclared plugin directories: skip them, keep going, preserve them if you
   rewrite the pack.
5. **Rescale if needed.** If `snapshot.png` dimensions differ from
   `reference_width`/`reference_height`, scale annotation geometry proportionally
   ([§8.2](#82-coordinate-space)).
6. **Extract safely.** Reject ZIP entries with absolute paths or `..` segments. Accept a single
   wrapping directory if you want to be generous; never require one.
7. **Recompute, never trust, display numbers.** Derive them from
   [§8.5](#85-display-numbers) — never from a document or a rendered frame.
8. **Never assume redaction in the originals.** `snapshot.png` and the replay always hold
   original pixels; only derived views honor blur ([§9](#9-blur-and-privacy)).

---

## 14. Minimal valid pack

The smallest valid CapturePack is a screenshot with a manifest — two files:

```
CapturePack_2026-07-27_140321/
├── manifest.json
└── snapshot.png
```

`manifest.json`:

```json
{
  "format": "capturepack",
  "format_version": "0.1.0",
  "id": "0b7f4c9e-2d31-4e8a-9f06-8c5d1a2b3c4d",
  "created_at": "2026-07-27T14:03:21+09:00",
  "generator": { "name": "my-exporter", "version": "1.0.0" },
  "environment": { "os": "windows" },
  "media": {
    "snapshot": "snapshot.png",
    "replay": null,
    "replay_duration_ms": null
  }
}
```

No replay, no annotations, no timeline, no report, no README, no skills, no plugins — and every
conforming reader MUST accept it. Anything a five-line script can produce is a first-class
citizen of the format; that is what keeps CapturePack an open format rather than an app's save
file.

---

## Appendix A: JSON Schemas

Machine-readable JSON Schemas (draft 2020-12) for the three core JSON files live in this
repository:

- [`docs/schemas/manifest.schema.json`](docs/schemas/manifest.schema.json)
- [`docs/schemas/annotations.schema.json`](docs/schemas/annotations.schema.json)
- [`docs/schemas/timeline.schema.json`](docs/schemas/timeline.schema.json)

The schemas validate what format 0.1.0 **defines**. Deliberately, they do not forbid unknown
properties — forward compatibility ([§13](#13-versioning-and-compatibility)) requires readers to
accept fields the schemas don't know about, so a 0.2.0 pack with additive fields still validates.
A pack using an annotation or event *type* unknown to 0.1.0 will fail these schemas while still
being readable under the defensive-reading rules; that is the expected difference between
"validates as 0.1.0" and "readable by a 0.1.0 reader".

Where the prose of this specification and the schemas disagree, the prose wins.
