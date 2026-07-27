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
3. [Container format](#3-container-format)
4. [Pack layout](#4-pack-layout)
5. [manifest.json](#5-manifestjson)
6. [snapshot.png](#6-snapshotpng)
7. [Replay video](#7-replay-video)
8. [annotations.json](#8-annotationsjson)
9. [Blur and privacy](#9-blur-and-privacy)
10. [timeline.json](#10-timelinejson)
11. [plugins/](#11-plugins)
12. [report.md](#12-reportmd)
13. [Versioning and compatibility](#13-versioning-and-compatibility)
14. [Minimal valid pack](#14-minimal-valid-pack)
- [Appendix A: JSON Schemas](#appendix-a-json-schemas)

---

## 1. Overview

A **CapturePack** is a small, self-contained package that explains a visual situation — usually a
bug — to another human or to an LLM. It bundles what a screenshot cannot:

- **snapshot.png** — the captured frame (pixels).
- **replay video** — the last ~30 seconds before capture (motion).
- **annotations.json** — pins, arrows, rectangles, blurs, and text notes, stored as editable data
  (intent).
- **timeline.json** — a machine-readable, replayable event log (time).
- **manifest.json** — identity, environment, and an inventory of the pack (structure).
- **report.md** — a human- and LLM-readable summary of all of the above (understanding).
- **plugins/** — optional structured metadata appended by plugins (extra context).

### Design goals

These follow directly from the project principles in `GOAL.md`:

- **Local first, offline, forever readable.** A pack is plain files in a standard ZIP. No cloud,
  no login, no database, no proprietary runtime. `unzip` plus a text editor is a valid viewer.
- **Open and language-neutral.** A shell script, a Rust CLI, or a browser extension can all write
  valid packs. Nothing in this format requires a specific library.
- **Data over pixels.** Annotations are structured data, editable forever, and are never burned
  into the replay video. The single deliberate exception is [blur](#9-blur-and-privacy), which is
  destructive for privacy.
- **LLM-ready by construction.** `report.md` + `snapshot.png` + `annotations.json` alone must let
  any LLM understand the situation, with no CapturePack-specific tooling.
- **Plugin-based, core-owned.** Core owns capture. Plugins only append metadata under `plugins/`
  and can never alter core files.
- **Never sacrifice the 5-second workflow.** The format imposes nothing that would slow down
  `Ctrl+Alt+C → annotate → export`.

### What this spec is not

This spec defines a **file format**, not an application. Hotkeys, editors, replay buffers,
auto-update, and UI are implementation concerns and appear here only as context.

---

## 2. Conformance and terminology

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**,
**SHOULD NOT**, **RECOMMENDED**, **MAY**, and **OPTIONAL** in this document are to be interpreted
as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) when, and only when, they appear in all
capitals.

| Term | Meaning |
|---|---|
| **Pack** | A CapturePack: either a `.capturepack` ZIP file or its extracted directory. Both forms are equally valid (see [§3](#3-container-format)). |
| **Writer** (or **exporter**) | Software that produces a pack. The reference app is a writer; so is any script that assembles the files by hand. |
| **Reader** | Software that consumes a pack: viewers, editors, converters, indexers, LLM ingestion pipelines. |
| **Core files** | `manifest.json`, `snapshot.png`, the replay video, `annotations.json`, `timeline.json`, `report.md`. |
| **Plugin** | An extension that appends structured metadata under `plugins/<name>/`. Plugins never modify core files. |
| **Snapshot pixel coordinates** | The coordinate space of `snapshot.png`: origin at the top-left pixel, x grows right, y grows down, units are pixels of the snapshot image. |

All JSON in a pack MUST be UTF-8 encoded, without a byte-order mark. Writers SHOULD pretty-print
JSON (packs are meant to be opened and read by humans, not only machines). Unless a field is
explicitly documented as nullable, writers MUST omit a field rather than write `null`.

---

## 3. Container format

### 3.1 The `.capturepack` file

A `.capturepack` file is a **standard ZIP archive** (PKWARE APPNOTE ZIP) of the pack directory.

- Entries MUST use compression method **store (0)** or **deflate (8)** only.
- The archive MUST NOT be encrypted, split, or spanned.
- Entry names MUST be UTF-8, use `/` as the path separator, and MUST be relative paths. Entry
  names MUST NOT contain `..` segments or begin with `/` or a drive letter. Readers MUST reject
  entries that would escape the extraction root (zip-slip).
- The core files MUST be at the **root** of the archive: `manifest.json` is a top-level entry,
  not nested inside a wrapping folder. Readers MAY, defensively, accept an archive whose entries
  all share a single top-level directory, but writers MUST NOT produce one.
- Explicit directory entries (e.g. `plugins/`) are OPTIONAL.
- The file extension is `.capturepack`. There is no registered media type; `application/zip` is
  accurate where one is needed.

Writers MAY choose any base filename. A RECOMMENDED default is a timestamp plus a slug of the
title, e.g. `2026-07-27-1403-save-button.capturepack`, so packs sort chronologically in a folder.

### 3.2 The directory form

Working with the **extracted directory** is equally valid. A directory containing the same files
in the same layout *is* a CapturePack; zipping is packaging, not transformation. Tools SHOULD
accept both forms wherever a pack is an input.

This spec uses "pack" for both forms and "pack root" for the directory (or archive root) that
contains `manifest.json`.

---

## 4. Pack layout

```
example.capturepack  (ZIP)  — or the same tree as a plain directory
├── manifest.json        REQUIRED   identity, environment, inventory
├── snapshot.png         REQUIRED   the captured frame
├── replay.webm          OPTIONAL   last ~30 s of replay (or replay.mp4)
├── annotations.json     OPTIONAL   editable annotation data
├── timeline.json        OPTIONAL   machine-readable event log
├── report.md            OPTIONAL   human/LLM-readable summary
└── plugins/             OPTIONAL   one subdirectory per plugin
    └── git/
        ├── meta.json    REQUIRED per plugin directory
        └── state.json   (arbitrary plugin files)
```

| Path | Requirement | Section |
|---|---|---|
| `manifest.json` | REQUIRED | [§5](#5-manifestjson) |
| `snapshot.png` | REQUIRED | [§6](#6-snapshotpng) |
| `replay.webm` **or** `replay.mp4` | OPTIONAL — declared in `manifest.media.replay` | [§7](#7-replay-video) |
| `annotations.json` | OPTIONAL — fixed name, present when annotations exist | [§8](#8-annotationsjson) |
| `timeline.json` | OPTIONAL — fixed name, present when events were recorded | [§10](#10-timelinejson) |
| `report.md` | OPTIONAL (RECOMMENDED) — fixed name | [§12](#12-reportmd) |
| `plugins/<name>/` | OPTIONAL — each declared in `manifest.plugins` | [§11](#11-plugins) |

The manifest is the pack's entry point. Components whose identity varies are declared there
explicitly: the replay's actual filename and duration in `media`, and every plugin payload in
`plugins`. The remaining optional files have fixed, well-known names; their presence in the pack
is their declaration. Readers MUST NOT fail because an optional file is absent, and MUST ignore
unknown extra files anywhere in the pack (see [§13](#13-versioning-and-compatibility)).

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
| `title` | string | OPTIONAL | Short human-readable title, one line. Used as the report heading and RECOMMENDED as the basis of the pack filename. |
| `note` | string | OPTIONAL | The user's own words about intent: what they were doing, what they expected, what went wrong. Carried verbatim into `report.md`. This is the single most valuable field for an LLM — writers SHOULD make entering it effortless, and MUST NOT block export on it (the 5-second workflow wins). |
| `environment` | object | REQUIRED | Where the capture happened. See [§5.2](#52-environment). |
| `media` | object | REQUIRED | Declares the snapshot and replay. See [§5.3](#53-media). |
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
| `replay` | string **or** `null` | REQUIRED | Filename of the replay video — `"replay.webm"` or `"replay.mp4"` — or `null` for a screenshot-only pack. Readers MUST take the replay filename from this field rather than probing the pack. |
| `replay_duration_ms` | integer **or** `null` | REQUIRED when `replay` is a string | Duration of the replay video in milliseconds. MUST be `null` (or absent) when `replay` is `null`. |
| `snapshot_t_ms` | integer | OPTIONAL | Position in the replay timeline, in milliseconds, of the frame shown in `snapshot.png` — the same clock as timeline `t_ms` offsets relative to `t0` ([§10.1](#101-structure)). MUST be >= 0. **Absent means the snapshot is the capture instant** — the native "now" frame. SHOULD be absent when `replay` is `null`: without a replay there is no timeline to anchor the value to. See [§7.1](#71-frame-accurate-captures). |

### 5.4 `plugins`

Each entry declares one plugin payload directory:

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | REQUIRED | Plugin name. MUST match `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$` (lowercase letters, digits, single hyphens; no leading/trailing hyphen). MUST equal the `name` in the plugin's `meta.json` and the directory name. |
| `version` | string | REQUIRED | Plugin version (semver RECOMMENDED). MUST equal the `version` in the plugin's `meta.json`. |
| `path` | string | REQUIRED | Directory path relative to the pack root, with trailing slash. MUST be exactly `"plugins/<name>/"`. |

Every directory under `plugins/` written by the exporter MUST have a corresponding entry here.
Readers MUST ignore any `plugins/` directory they find that is *not* declared (or not understood)
— see [§11](#11-plugins).

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
    "replay_duration_ms": 28437
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
- If any blur annotations exist, the exported `snapshot.png` MUST be the **redacted** image, with
  blur applied destructively. The unredacted frame MUST NOT appear anywhere in the pack. This is
  the format's one privacy-over-editability rule — see [§9](#9-blur-and-privacy).
- Annotations other than blur MUST NOT be burned into `snapshot.png`. The snapshot is evidence;
  annotations are data drawn on top of it by viewers.

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
- Annotations MUST NOT be burned into the replay video — ever. Annotations live in
  `annotations.json` as editable data.
- **Privacy note:** in the MVP era, blur is applied to the snapshot only; the replay video is
  *not* redacted. See the exporter requirements in [§9](#9-blur-and-privacy).
- A screenshot-only pack (`"replay": null`) is fully valid. Replay is evidence, not a
  prerequisite.

When both a replay and a timeline exist, `timeline.json`'s `t0` SHOULD be the instant of the
replay's first frame, so event offsets double as video seek positions ([§10.1](#101-structure)).

### 7.1 Frame-accurate captures

An editor that holds the frozen replay can let the user scrub backwards in time and pick the
exact frame that shows the problem — the moment *before* the dialog closed, the frame where the
glitch is visible. The chosen frame becomes `snapshot.png`, and the writer records its position
in the replay timeline in `manifest.media.snapshot_t_ms` ([§5.3](#53-media)). When
`snapshot_t_ms` is absent, the snapshot is the capture instant — the default, and the only
possibility in a screenshot-only pack.

A scrubbed snapshot changes nothing else about the format:

- `snapshot.png` is still the single still frame the pack is built around, and its pixel
  dimensions still define the annotation coordinate space ([§8.2](#82-coordinate-space)).
  Writers composing the snapshot from a decoded video frame SHOULD render it at the same
  resolution a capture-instant snapshot would have had, so the coordinate space does not depend
  on the replay's encoded resolution.
- Blur still applies destructively to the exported `snapshot.png` ([§9](#9-blur-and-privacy)),
  and the replay-gap caveat of [§9.4](#94-the-replay-gap-mvp-era) still applies.
- Individual annotations MAY additionally record the replay position they refer to via their
  own optional `t_ms` ([§8.3](#83-common-fields)) — useful when different annotations were made
  at different scrub positions.

---

## 8. annotations.json

`annotations.json` is OPTIONAL; it is present when the user annotated the capture. Annotations
are the *intent* layer: they say what matters in the pixels. They are stored as data, are
editable forever, and are never burned into media (blur excepted, and even blur keeps its data —
[§9](#9-blur-and-privacy)).

### 8.1 Structure

| Field | Type | Required | Description |
|---|---|---|---|
| `reference_width` | integer | REQUIRED | Width in pixels of the coordinate space — MUST equal the pixel width of `snapshot.png`. |
| `reference_height` | integer | REQUIRED | Height in pixels of the coordinate space — MUST equal the pixel height of `snapshot.png`. |
| `annotations` | array | REQUIRED | Ordered list of annotation objects. Array order is **reading order** — the order in which a human (or `report.md`) should walk through them, normally creation order. May be empty. |

### 8.2 Coordinate space

All annotation geometry is in **snapshot pixel coordinates**: origin at the top-left pixel of
`snapshot.png`, x grows right, y grows down, units are snapshot pixels. Coordinates MAY be
non-integers (sub-pixel positions from freehand drawing are fine).

`reference_width`/`reference_height` exist so annotations survive image processing: if a reader
finds that `snapshot.png`'s actual dimensions differ from the reference (for example the snapshot
was recompressed or scaled by an intermediate tool), it SHOULD scale all geometry by
`actual / reference` per axis rather than discard the annotations.

### 8.3 Common fields

Every annotation object:

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | REQUIRED | Non-empty, unique within this file. Short ids (`"a1"`) or UUIDs both fine. Referenced by timeline events and `report.md`. |
| `type` | string | REQUIRED | One of `"pin"`, `"arrow"`, `"rect"`, `"blur"`, `"text"` in format 0.1.0. Readers MUST skip (and SHOULD preserve on rewrite) annotations of unknown type. |
| `z` | integer | OPTIONAL | Stacking order for rendering; higher draws on top. Default: array position (later entries on top). |
| `color` | string | OPTIONAL | Display color as CSS-style hex, `"#RRGGBB"` or `"#RRGGBBAA"`. Meaningless for `blur` and SHOULD be omitted there. Viewers pick their own default when absent. |
| `created_at` | string | OPTIONAL | When the annotation was made, ISO 8601 with timezone. |
| `t_ms` | number | OPTIONAL | The replay position, in milliseconds, that this annotation refers to — normally the scrub position at which it was created ([§7.1](#71-frame-accurate-captures)). Same clock as timeline `t_ms` offsets relative to `t0` ([§10.1](#101-structure)). Only meaningful when the pack has a replay; SHOULD lie within `[0, replay_duration_ms]`. It does not change the coordinate space — geometry is always in snapshot pixel coordinates ([§8.2](#82-coordinate-space)). |

### 8.4 Annotation types

Geometry fields are REQUIRED unless marked optional.

**`pin`** — a numbered/pointed marker at a spot.

| Field | Type | Description |
|---|---|---|
| `x`, `y` | number | The pinned point. |
| `label` | string (optional) | Short caption, e.g. `"1. renamed the document here"`. |

**`arrow`** — a directed line from tail to head.

| Field | Type | Description |
|---|---|---|
| `x1`, `y1` | number | Tail (where the arrow starts). |
| `x2`, `y2` | number | Head (what the arrow points at). |

**`rect`** — a rectangle outline highlighting a region.

| Field | Type | Description |
|---|---|---|
| `x`, `y` | number | Top-left corner. |
| `w`, `h` | number | Width and height, both > 0. |
| `label` | string (optional) | Short caption for the region. |

**`blur`** — a redacted rectangular region. See [§9](#9-blur-and-privacy) for its special
semantics.

| Field | Type | Description |
|---|---|---|
| `x`, `y` | number | Top-left corner. |
| `w`, `h` | number | Width and height, both > 0. |

**`text`** — a free-floating text note.

| Field | Type | Description |
|---|---|---|
| `x`, `y` | number | Anchor: top-left of the first line of text. |
| `text` | string | The note content. |
| `size` | number (optional) | Font size in snapshot pixels. Viewers pick a legible default when absent. |

### 8.5 Example

```json
{
  "reference_width": 2560,
  "reference_height": 1440,
  "annotations": [
    {
      "id": "a1",
      "type": "pin",
      "z": 1,
      "color": "#FF3B30",
      "created_at": "2026-07-27T14:03:26+09:00",
      "x": 640,
      "y": 402,
      "label": "1. renamed the document here"
    },
    {
      "id": "a2",
      "type": "rect",
      "z": 2,
      "color": "#FF3B30",
      "created_at": "2026-07-27T14:03:29+09:00",
      "x": 2140,
      "y": 1236,
      "w": 180,
      "h": 56,
      "label": "2. Save — stays disabled"
    },
    {
      "id": "a3",
      "type": "arrow",
      "z": 3,
      "color": "#FF3B30",
      "created_at": "2026-07-27T14:03:31+09:00",
      "x1": 1980,
      "y1": 1040,
      "x2": 2210,
      "y2": 1230
    },
    {
      "id": "a4",
      "type": "text",
      "z": 4,
      "color": "#FF3B30",
      "created_at": "2026-07-27T14:03:34+09:00",
      "x": 1860,
      "y": 990,
      "text": "clicked 3x — no reaction",
      "size": 32
    },
    {
      "id": "a5",
      "type": "blur",
      "z": 5,
      "created_at": "2026-07-27T14:03:37+09:00",
      "x": 2080,
      "y": 24,
      "w": 360,
      "h": 40
    }
  ]
}
```

---

## 9. Blur and privacy

Blur is the one place where CapturePack breaks its own "annotations are data, never burned in"
rule — deliberately.

### 9.1 The rule

1. Exporters MUST apply every `blur` region **destructively** to the exported `snapshot.png`:
   the pixels inside each blur rectangle are irreversibly obscured in the image itself.
2. The original, unredacted frame MUST NOT be included anywhere in the pack — not as another
   file, not embedded in metadata, not recoverable from any pack content.
3. The `blur` annotation MUST still be recorded as data in `annotations.json`, exactly like any
   other annotation.
4. The obscuring MUST be irreversible in practice. Strong pixelation (large blocks) or a solid
   fill is RECOMMENDED. A weak Gaussian blur SHOULD NOT be used: lightly blurred text can
   sometimes be reconstructed.

### 9.2 Why the exception

Every other annotation is additive commentary — losing it loses intent, so it stays editable
data. **Blur is a promise.** A pack exists to travel: it gets dropped into LLM chats, attached
to issues, forwarded in DMs, and read by tools that have never heard of CapturePack. If blur were
stored only as an overlay, every one of those readers would receive the secret pixels underneath
it, and any viewer that ignores `annotations.json` — including a human just opening
`snapshot.png` — would expose them. The only blur that keeps the promise is one applied to the
pixels themselves before the pack leaves the machine. Privacy beats editability, exactly once.

Keeping the blur *annotation* as data still pays for itself: readers can see that redaction
happened and where, viewers can outline redacted regions, `report.md` can list them, and the
live editor (before export, while the original frame still exists only in the app's memory) can
move or remove the blur freely. Destructiveness applies at **export**, not while editing.

### 9.3 Consequences for re-export

A pack, once exported with blur, contains only redacted pixels. Editing a pack's annotations and
re-exporting cannot un-blur anything — the data is gone, which is the point. Newly added blur
regions on a re-export are applied destructively again, to the already-redacted snapshot.

### 9.4 The replay gap (MVP era)

In the MVP era, blur applies to the snapshot only — the replay video is **not** redacted, and the
blurred content may be visible in it. Therefore:

- Exporters MUST make this limitation visible to the user when a blur annotation exists and a
  replay is about to be included.
- Exporters SHOULD offer, in that moment, a one-step way to exclude the replay from the export
  (producing a pack with `"replay": null`).
- Readers MUST NOT assume the replay honors blur regions in format 0.1.0.

A future format version that specifies replay redaction will address this gap.

---

## 10. timeline.json

`timeline.json` is OPTIONAL. It is the machine-readable record of *when things happened*:
append-only during capture, ordered, and replayable — a reader can step through events against
the replay video or reconstruct the session's story without watching anything.

### 10.1 Structure

| Field | Type | Required | Description |
|---|---|---|---|
| `t0` | string | REQUIRED | The absolute anchor instant, ISO 8601 with timezone. Every event's `t_ms` is an offset in milliseconds relative to `t0`. When a replay video exists, `t0` SHOULD be the instant of the replay's first frame, so `t_ms` doubles as a video seek position. Otherwise the capture trigger instant is a natural choice. |
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
| `core.annotation.added` | An annotation was added in the editor. | `annotation_id`, `annotation_type` (matching `annotations.json`) |
| `core.export.created` | The pack was exported. | `filename` (string, optional) |

`data` fields listed here are conventions, not requirements — readers MUST tolerate their
absence. Readers MUST skip events of unknown type and SHOULD preserve them when rewriting a pack.
New `core.*` event types may be added in minor format versions.

### 10.3 Example

`t0` is the replay's first frame; the capture was triggered 28.4 s later (matching
`replay_duration_ms` in [§5.5](#55-example)); annotation and export events follow after the
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
      "data": { "annotation_id": "a1", "annotation_type": "pin" }
    },
    {
      "t_ms": 36020,
      "type": "core.annotation.added",
      "source": "core",
      "data": { "annotation_id": "a2", "annotation_type": "rect" }
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
      "data": { "filename": "2026-07-27-1403-save-button.capturepack" }
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

## 12. report.md

`report.md` is OPTIONAL but RECOMMENDED for every pack that will be shared. It is the
human- and LLM-readable narrative of the pack, generated by the exporter from the other files.

The test it must pass: **a person drops the pack into any LLM, and the model understands the
situation from `report.md` + `snapshot.png` + `annotations.json` alone** — no CapturePack-aware
tooling, no video decoding, no JSON spelunking required. To that end, `report.md` deliberately
duplicates data from the JSON files in prose form. It is a generated view, not a source of truth:
regenerating it from the other files SHOULD produce an equivalent report, and readers MUST NOT
treat it as authoritative when it disagrees with the JSON.

### 12.1 Recommended template

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

## Annotations

Coordinates are pixels in snapshot.png ({reference_width}×{reference_height}), listed in
reading order.

1. **{Type}** at {geometry summary} — "{label/text, if any}"
2. ...

{If any blur annotations: a line noting that N region(s) of the snapshot are permanently
redacted, and (if a replay is included) that the replay is not redacted.}

## Files

- manifest.json — {one-line purpose}
- snapshot.png — ...
- {each remaining file present in the pack, including plugins/<name>/, one line each}
```

Writers MAY extend the template (for example with a plugin-provided summary section) but SHOULD
keep the section order above so readers and LLMs see a predictable shape.

### 12.2 Example

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
- **Replay:** replay.webm (28.4 s)

## Annotations

Coordinates are pixels in snapshot.png (2560×1440), listed in reading order.

1. **Pin** at (640, 402) — "1. renamed the document here"
2. **Rect** at (2140, 1236) size 180×56 — "2. Save — stays disabled"
3. **Arrow** from (1980, 1040) to (2210, 1230)
4. **Text** at (1860, 990) — "clicked 3x — no reaction"
5. **Blur** at (2080, 24) size 360×40

1 region of the snapshot is permanently redacted (blur). The replay video is not redacted.

## Files

- manifest.json — pack identity, environment, inventory
- snapshot.png — captured frame, 2560×1440
- replay.webm — last 28.4 s before capture
- annotations.json — the 5 annotations above, as editable data
- timeline.json — capture/annotation/export events
- plugins/git/ — git repository state at capture time
- report.md — this file
```

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

- Unknown JSON fields anywhere: ignore them; preserve them when rewriting.
- Unknown files in the pack root or anywhere else: ignore them; preserve them when rewriting.
- Unknown annotation types, event types, plugin directories: skip them; preserve on rewrite.

Readers encountering a higher major version than they support SHOULD tell the user and MAY still
attempt a best-effort read of the parts they understand (`snapshot.png` and `report.md` degrade
gracefully by design).

### 13.2 Reading a pack defensively

A checklist for reader implementations:

1. **Identify.** Read `manifest.json`. Check `format == "capturepack"`; if not, this is not a
   pack. Parse `format_version`; compare the major (pre-1.0: minor) version against what you
   support, and warn — don't crash — on a newer one.
2. **Trust the manifest, tolerate its absence of extras.** Take the replay filename from
   `media.replay`; never guess by listing files. Treat absent optional files as normal, not as
   corruption.
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
7. **Never expect blurred pixels back.** Redaction is permanent by design ([§9](#9-blur-and-privacy)).

---

## 14. Minimal valid pack

The smallest valid CapturePack is a screenshot with a manifest — two files:

```
minimal.capturepack
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

No replay, no annotations, no timeline, no report, no plugins — and every conforming reader MUST
accept it. Anything a five-line script can produce is a first-class citizen of the format; that
is what keeps CapturePack an open format rather than an app's save file.

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
