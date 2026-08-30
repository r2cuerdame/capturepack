# CapturePack Format Specification

| | |
|---|---|
| **Format** | `capturepack` |
| **Version** | `0.6.0` |
| **Status** | Draft |
| **Date** | 2026-07-31 |
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
12. [Generated document views](#12-generated-document-views)
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
- **frames/** — the same annotations as **still images**, one per annotation state change. LLMs
  read images, not video; a reader that cannot decode a video still gets the whole story.
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
| **Generated views** | Files derived from the source files for a specific audience: `replay_annotated` (video players), `viewer.html` (offline browsers), `report.md` (narrative), `README.md` (humans), `skills/` (LLMs). Regenerating any of them from the source files SHOULD produce an equivalent result; none of them is ever authoritative over the source files. |
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
  annotated replay and the keyframe stills in `frames/`, which may render in the background —
  can appear later than the source files. Readers SHOULD tolerate a pack whose declared
  `replay_annotated` file is not (yet) present ([§5.3](#53-media)), and a pack that declares no
  `media.keyframes` yet ([§5.7](#57-keyframes-annotated-stills)), and fall back to the source
  files.

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

> **Note.** A Privacy-aware Share Copy is a separate `capturepack-share` ZIP, not a reduced
> CapturePack. It carries reviewed, canonical annotated PNG stills only and deliberately omits
> the original evidence, every video container, and structured source context; see
> [§3.3](#33-the-share-copy-derived-distribution) and [§9.4](#94-share-copy-distribution).

### 3.3 The Share Copy (derived distribution)

A Share Copy is a standard ZIP whose filename SHOULD end in `.share.zip`. It is a reviewed,
derived distribution for sending selected annotated PNG stills without sending the original
CapturePack. It is **not a CapturePack**, MUST NOT contain `manifest.json`, and MUST NOT claim
`format: "capturepack"`. Readers that index CapturePacks therefore ignore it rather than treating
it as a second or damaged pack.

The reference writer creates a Share Copy only from the authoritative CapturePack **folder**
selected in History. It MUST NOT use a full-pack ZIP or an existing Share Copy as its source;
the folder remains the source whose revision the user reviewed.

The archive root has this closed layout:

```text
README.md               REQUIRED   static, source-data-free human guidance
share.json              REQUIRED   capturepack-share inventory
viewer.html             REQUIRED   source-data-free offline view
media/                  REQUIRED   only media declared by share.json
```

`share.json` has the following 0.1.0 shape. Unknown top-level fields are reserved; writers MUST
NOT add source-pack data to it.

```json
{
  "format": "capturepack-share",
  "format_version": "0.1.0",
  "profile": "reviewed-stills-only",
  "media": [
    { "file": "media/display-1/annotated-still-01.png", "kind": "annotated-still", "display": 1 }
  ],
  "excluded": ["original-media", "capturepack-manifest", "annotations", "timeline", "plugins",
    "generated-source-documents", "user-note-and-report", "annotated-replays"],
  "warnings": ["review-every-still", "visual-redaction-is-not-a-security-proof"]
}
```

- `profile` MUST be `reviewed-stills-only`. `media` MUST be a non-empty array of unique entries,
  and `kind` MUST be `annotated-still`; no video kind is defined by this profile.
- Every `file` MUST be a writer-generated canonical path of the form
  `media/capture/annotated-still-<NN>.png` or
  `media/display-<N>/annotated-still-<NN>.png`. The first form MUST have `display: null` and is
  only for the one composed raster of an explicit image capture. The second MUST have a positive
  integer `display` equal to `<N>`. `<NN>` is a one-based lane ordinal, zero-padded to at least
  two digits. Each source MUST be a manifest-declared annotated keyframe, exist as a regular
  non-symlink file beneath the authoritative folder, and be the only kind of non-document entry
  in the archive.
- Writers MUST decode each source PNG to its pixel raster and deterministically re-encode it.
  They MUST NOT copy the source container bytes. The output PNG MUST contain only `IHDR`, `IDAT`,
  and `IEND` chunks and no bytes after `IEND`, thereby removing ancillary metadata, alternate
  container encodings, and trailing payload while preserving the decoded pixels.
- Writers MUST build the archive from an explicit entry allowlist. They MUST NOT recursively copy
  the source directory and MUST reject a declared derived path that escapes it.
- Writers MUST exclude original snapshots/replays, **all video containers including annotated
  replays**, the CapturePack manifest, annotations, timeline, plugins, existing viewer/documents,
  notes, reports, and unknown files. They MUST generate README/viewer content from this closed
  projection, never copy the CapturePack versions.
- A declared annotated keyframe that is absent, invalid, or still rendering makes creation fail.
  Writers MUST NOT fall back to original media or an annotated replay.
- The user MUST see the included media inventory, representative derived previews, excluded data
  classes, and any text visibly rendered into the media before creation. If the source changes
  after that review, creation MUST stop and require review of the new revision.
- The original CapturePack folder MUST remain byte-for-byte unchanged.
- “Share Copy” does not mean secret-free. Blur and other visual transforms cover only marked
  regions; the user MUST review every included still before sending it.

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
├── snapshot-d2.png          OPTIONAL   another display frozen by the same trigger (multi-monitor);
├── replay-d2.webm           OPTIONAL   its replay — both declared in manifest.media.displays
├── replay_annotated-d2.webm OPTIONAL   that display's OWN annotations rendered in, and
├── frames-d2/               OPTIONAL   its own stills — declared on its media.displays entry
├── frames/                  OPTIONAL (RECOMMENDED) annotated stills, one per annotation state
│   ├── frame-01_00-03.200.png          change — declared in manifest.media.keyframes;
│   └── frame-02_00-05.400.png          regenerable from the media + annotations.json
├── annotations.json         OPTIONAL   annotation boxes — the true source of annotation data
├── timeline.json            OPTIONAL   video-pack machine-readable event log;
│                                       MUST be absent for explicit image packs
├── viewer.html              OPTIONAL (RECOMMENDED) self-contained offline browser view
├── report.md                OPTIONAL (RECOMMENDED) generated narrative
├── README.md                OPTIONAL (RECOMMENDED) human-first entry point
├── skills/                  OPTIONAL (RECOMMENDED) AI-first context documents
│   ├── overview.md                     whole-pack summary
│   ├── timeline.md                     video packs only: the timeline, narrated
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
| `snapshot-d<N>.png`, `replay-d<N>.webm` | OPTIONAL — per-display media of a multi-monitor capture, each declared in `manifest.media.displays` | [§5.6](#56-displays-multi-monitor-captures) |
| `replay_annotated-d<N>.webm`, `frames-d<N>/frame-…png` | OPTIONAL — one display's own annotated views, declared as `replay_annotated`/`keyframes` on its `manifest.media.displays` entry | [§5.6](#56-displays-multi-monitor-captures) |
| `frames/frame-<NN>_<MM-SS.mmm>.png` | OPTIONAL (RECOMMENDED) — annotated keyframe stills, each declared in `manifest.media.keyframes` | [§5.7](#57-keyframes-annotated-stills) |
| `annotations.json` | OPTIONAL — fixed name, present when annotations exist | [§8](#8-annotationsjson) |
| `timeline.json` | OPTIONAL for video packs — fixed name, present when events were recorded; MUST be absent when `capture_kind` is `"image"` | [§10](#10-timelinejson) |
| `viewer.html` | OPTIONAL (RECOMMENDED) — fixed-name, self-contained offline generated view | [§12.4](#124-viewerhtml) |
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
| `format_version` | string | REQUIRED | Oldest version of this specification that fully expresses the pack, as [semver](https://semver.org/). See [§13](#13-versioning-and-compatibility). |
| `capture_kind` | `"image"` or `"video"` | REQUIRED for new writers; OPTIONAL when reading legacy packs, including early 0.3.0 RC output | What the user asked to capture, independent of whether a video recorder succeeded. New writers MUST declare it for both image and video captures. When it is absent in an existing pack, readers MAY infer video when `media.replay` is a filename and otherwise MUST NOT pretend to know whether a null replay was an explicit still or a failed video. **Added in 0.3.0.** |
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
| `bounds` | object | OPTIONAL | Display rectangle `{ x, y, width, height }` in OS virtual-desktop DIP coordinates. Current image writers include it so readers can prove whether a region crop lies wholly on one scale; legacy packs may omit it. |

`screens` describes the hardware environment; it does not define the annotation coordinate space.
Annotations are always in snapshot pixel coordinates ([§8.2](#82-coordinate-space)), regardless
of screen count or scaling.

### 5.3 `media`

| Field | Type | Required | Description |
|---|---|---|---|
| `snapshot` | string | REQUIRED | Filename of the snapshot. In format 0.1.0 this MUST be `"snapshot.png"`. Declared explicitly so future versions can vary it without breaking readers that trust the manifest. From 0.7.0 this is defined as an **alias for the FOCUSED display's entry** in `displays` below ([§5.6](#56-displays-multi-monitor-captures)) — the same string, not a second copy of the bytes. It is not "the capture": a pack may hold several screens, and `displays` is where a reader asks how many. |
| `replay` | string **or** `null` | REQUIRED | Filename of the original replay video — `"replay.webm"` or `"replay.mp4"` — or `null` for a screenshot-only pack. Readers MUST take the replay filename from this field rather than probing the pack. From 0.7.0, an **alias for the focused display's `replay`**, under the same rule as `snapshot` above. |
| `replay_duration_ms` | integer **or** `null` | REQUIRED when `replay` is a string | Duration of the replay video in milliseconds. MUST be `null` (or absent) when `replay` is `null`. |
| `cadence` | object | OPTIONAL | What this display's recorder ACHIEVED: `achieved_fps` (number) and `worst_stall_ms` (number, the longest the frame counter went without advancing — quantised to the writer's sampling interval and therefore a LOWER bound). Written only beside a replay, and only where the writer could measure itself: a rate nobody measured MUST NOT be reported as a rate. Also OPTIONAL `discarded_frames` (number): frames the source produced and threw away. A LOW `achieved_fps` means two different things, and only this tells them apart — a screen capture makes a frame when the screen CHANGES, so a monitor nobody touched delivers almost nothing and has lost nothing, while frames made and discarded are a replay that really is missing time. A reader uses it to know that a moment being annotated may simply not be in the file. Format 0.4.0 adds OPTIONAL capture provenance: `requested_fps` (number in 1..30), `backend` (`"chromium-desktop-capture"` or `"windows-gdi-bitblt"`), `quality` (`"full"` or `"degraded"`), and `recorder_count` (integer >= 1). A current writer MUST request 5..30 fps; readers keep accepting 1..30 here because this field is historical provenance and existing packs may record a former 1..4 fps request. These fields MUST describe the source and encoder(s) that produced the declared replay; a fallback MUST NOT call itself full quality. Format 0.6.0 adds OPTIONAL `source_latency` (object): how far this recorder's pixels lagged the glass, MEASURED. `measured_ms` (number >= 0), `reference` (`"dxgi-desktop-duplication"` or `"windows-gdi-bitblt"`) and `timing` (`"pixel-exposure"` or `"post-bitblt-completion"`) are all REQUIRED inside the object, because the same number means different things against a pixel exposure and against an operation completion, and a writer that cannot say which one it matched has not measured a source latency. A writer MUST NOT report a measured source latency whose `timing` is `"post-bitblt-completion"`: the copied surface may already have been stale by an unobserved amount, so that value is not an exposure latency. This MUST be an observation against an independent reference — never a configured delay, and never derived from `achieved_fps` or `requested_fps`; the rule above holds here too, a latency nobody measured MUST NOT be reported as a latency. Also OPTIONAL: `confidence` (number in 0..1, the matcher's own verdict), `uncertainty_ms` (number >= 0, the reference anchor's error bar) and `age_ms` (integer >= 0, milliseconds between the measurement and this capture). **Absent `age_ms` means the recorder that produced this replay measured it.** A writer MAY carry a measurement forward from an earlier capture of the same display — the calibration succeeds only when the desktop happens to move while it watches, so most captures have no measurement of their own — but a carried value MUST declare its `age_ms`, and MUST NOT be carried across a change of capture `backend`, which is a different path to the glass. The original achieved fields were added in 0.2.0; capture provenance is added in 0.4.0, and the measured source latency in 0.6.0. |
| `replay_annotated` | string | OPTIONAL | Filename of the **annotated replay** — `"replay_annotated.webm"` or `"replay_annotated.mp4"` ([§7.2](#72-the-annotated-replay)). MUST be absent when `replay` is `null` (there is nothing to render it from), and absent while the annotated replay has not (yet) been rendered. A writer MUST finish the file before publishing this declaration. A defensive reader that encounters a declared but missing file in an interrupted or older pack SHOULD treat the derived view as unavailable and fall back to `replay` + `annotations.json`. |
| `snapshot_t_ms` | integer | OPTIONAL | Position on the replay clock, in milliseconds, of the frame shown in `snapshot.png` — the same clock as annotation lifetimes ([§8.4](#84-lifetime)) and timeline `t_ms` offsets relative to `t0` ([§10.1](#101-structure)). MUST be >= 0. **Absent means the snapshot is the capture instant** — the native "now" frame. SHOULD be absent when `replay` is `null`: without a replay there is no timeline to anchor the value to. See [§7.1](#71-frame-accurate-captures). |
| `trim_offset_ms` | integer | OPTIONAL | **Provenance only.** When the writer trimmed the replay before saving, the position (ms) in the original captured recording of this replay's first frame — the trim in-point. MUST be >= 0. Purely informational: every time in the pack (annotation lifetimes, `snapshot_t_ms`, timeline offsets against `t0`) is already on the trimmed replay's clock, so readers never apply this offset to anything. Absent means the replay was never trimmed. SHOULD be absent when `replay` is `null`. |
| `image_scope` | `"region"` or `"fullscreen"` | REQUIRED when `capture_kind` is `"image"`; otherwise MUST be absent | The explicit still-image choice. `"region"` means `snapshot.png` contains only the selected pixels. `"fullscreen"` means the user explicitly requested the complete virtual desktop: every attached display is composed into the single `snapshot.png`, with no separate per-display raster. **Added in 0.3.0.** |
| `crop_bounds` | object | REQUIRED for a region image; otherwise MUST be absent | Places the selected crop in OS virtual-desktop DIP coordinates: `{ x, y, width, height, coordinate_space: "virtual-desktop-dip" }`. `x`/`y` are finite numbers and MAY be negative; `width`/`height` MUST be finite and > 0. This is placement provenance, not an authorization to store pixels outside the crop. **Added in 0.3.0.** |
| `displays` | array | **REQUIRED** for `capture_kind: "video"` from format **0.7.0**; OPTIONAL before it; MUST be absent for `capture_kind: "image"` | Per-display media: ONE entry for every display the trigger froze, focused one included. A capture that froze a single display writes an array of ONE — "how many displays" is a question every reader asks the same way, not a special case half of them forget. `snapshot` and `replay` above are ALIASES for the focused entry's files, never a second copy of the bytes. Absent in packs written before 0.7.0, which readers MUST accept and read as a single-display pack whose one display is the focused one ([§13.1](#131-format_version-policy)). See [§5.6](#56-displays-multi-monitor-captures). |
| `keyframes` | array | OPTIONAL (RECOMMENDED) | The **annotated keyframe stills** in `frames/`: one PNG per annotation state change, with the annotations rendered into the pixels. Absent until the render that produces them completes (the same background render as `replay_annotated`), and absent in a pack that was never rendered. See [§5.7](#57-keyframes-annotated-stills). |

For `capture_kind: "image"`, `media.replay` MUST be `null` and
`cadence`, `replay_duration_ms`, `replay_annotated`, `snapshot_t_ms`, `trim_offset_ms`, and
`displays` MUST be absent (a null `replay_duration_ms` remains tolerated for
generic legacy tooling). A conforming image writer MUST NOT persist another
source raster or video anywhere in the pack. It MAY render declared annotated
stills. Each such still MUST keep the selected `snapshot.png`'s exact width and
its complete source viewport unchanged at derived coordinate `(0, 0)`. Its height
MUST be at least the source height and MAY exceed it only by the result-only bottom
callout gutter defined in [§7.2](#72-the-annotated-replay); the added rows MUST NOT
contain pixels captured outside the selected source. This exception cannot be used
to smuggle a larger context image. When
`media.keyframes` is present, the screenshot-only rule in [§5.7](#57-keyframes-annotated-stills)
permits exactly one entry at `t_ms: 0`.

An explicit image pack is a still-image artifact, not a zero-duration video
artifact. Its writer MUST omit the top-level `timeline.json` and
`skills/timeline.md`; annotation and plugin context remain available through
`annotations.json`, the other image-specific `skills/` documents, and declared
plugin payloads.

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
  "format_version": "0.3.0",
  "capture_kind": "video",
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

### 5.6 `displays` (multi-monitor captures)

<!-- Heading text is load-bearing: every §5.6 cross-reference in this document is
     an anchor derived from it. The section is no longer only about multi-monitor
     captures — from 0.7.0 a single-display pack declares `displays` too — but
     renaming it would break seventeen links for a wording improvement. -->

A capture freezes one or more connected displays at the same instant. The pack carries one
snapshot (and optionally one replay) **per display**, and `media.displays` declares them.

**`media.displays` is REQUIRED and ALWAYS PRESENT for a video capture from format 0.7.0**, with
one entry per display the trigger froze. A capture that froze a single display writes an array of
**one**. It used to be omitted in that case, and that omission was the format's oldest wrong
default: it made ONE monitor the first-class citizen and every additional screen an optional
extra, so a reader following `media.snapshot` — the obvious field — got half the desk with no
signal the rest existed. A writer MUST NOT omit the array to mean "one display", and a reader
MUST NOT need to know that omission ever meant that.

`media.snapshot` and `media.replay` remain REQUIRED, and are defined as **aliases for the focused
entry's files** rather than as the capture. They are the same two strings written twice, not a
second copy of the bytes, which is why an older reader meeting a 0.7.0 pack still works: it finds
what it always found, still meaning what it always meant. What 0.7.0 binds is WRITERS.

Packs written before 0.7.0 carry no `media.displays` and stay valid. A reader built for 0.7.0
MUST accept them and read them as a single-display pack whose one display is the focused one —
`snapshot.png` is its snapshot, `media.replay` its replay, and `annotations.json`'s
`reference_width`/`reference_height` its frame ([§13.1](#131-format_version-policy)).

An **image** capture (`capture_kind: "image"`) MUST NOT declare `media.displays` at any version.
It ships no per-display raster for an entry to name: a fullscreen still is every attached display
composed into one `snapshot.png`, and a region still is a crop that may straddle two.
`media.image_scope` ([§5.3](#53-media)) is where an image pack says what its single raster covers.

Exactly one entry is the **focused** display — the display the user was on (cursor position) at
the trigger. Its media *is* the top-level media: `snapshot.png`, `replay`, `replay_duration_ms`,
`replay_annotated`, `keyframes`. Its bytes are never duplicated under a per-display name, so a
reader that ignores `displays` entirely still sees exactly the pack it would have seen without
this feature.

**Annotations may live on ANY captured display.** A box names its display in `display`
([§8.8](#88-display-which-display-a-box-is-on)); an absent `display` means the focused one. The
focused display is therefore not "the annotated display" — it is the display the pack's
top-level media, and every `display`-less box, belongs to.

Each entry:

| Field | Type | Required | Description |
|---|---|---|---|
| `index` | integer | REQUIRED | 1-based position of this display in `environment.screens` ([§5.2](#52-environment)) — the OS enumeration order. MUST be >= 1 and unique within the array. |
| `snapshot` | string | REQUIRED | Filename of this display's frozen frame: `"snapshot-d<index>.png"`, except the focused entry, which MUST repeat the top-level `media.snapshot` (`"snapshot.png"`). |
| `snapshot_width` | integer | **REQUIRED** from format **0.7.0** | Pixel width of the file named in `snapshot` — **the frame this display's annotations are expressed in** ([§8.2](#82-coordinate-space)). MUST be >= 1 and MUST equal that PNG's actual width. It was always derivable as `bounds.width × scale`, and derivable is not the same as stated: the multiplication rounds differently from the capture path at 1.25x/1.5x scaling, so a writer MUST take these numbers from the raster it actually wrote and MUST NOT recompute them from `bounds`. On the focused entry it MUST equal `annotations.json`'s `reference_width` ([§8.1](#81-structure)). |
| `snapshot_height` | integer | **REQUIRED** from format **0.7.0** | Pixel height of the file named in `snapshot`, under the same rules as `snapshot_width`. On the focused entry it MUST equal `annotations.json`'s `reference_height`. |
| `replay` | string **or** `null` | REQUIRED | Filename of this display's replay: `"replay-d<index>.webm"` (or `.mp4`), the top-level `media.replay` on the focused entry, or `null` when this display has no replay. |
| `replay_duration_ms` | integer | REQUIRED when `replay` is a string | Duration of this display's replay in milliseconds. |
| `replay_clock_offset_ms` | integer | OPTIONAL when `replay` is a string | Milliseconds to add to the pack clock to reach this display's replay clock: `t_i = t + replay_clock_offset_ms`. `0` on the focused display. A writer SHOULD include it when the recorder reported a shared-clock origin; readers of a legacy entry that omits it use the duration-difference fallback below. MUST be absent when `replay` is `null`. |
| `cadence` | object | OPTIONAL when `replay` is a string | This display's measured cadence and capture provenance, with the same fields and rules as top-level `media.cadence` ([§5.3](#53-media)). On the focused entry it MUST equal top-level `media.cadence`. MUST be absent when `replay` is `null`. |
| `replay_annotated` | string | OPTIONAL | This display's replay with **its own** annotation boxes rendered into the pixels: `"replay_annotated-d<index>.webm"` (or `.mp4`). Absent on the focused entry — its annotated replay is the top-level `media.replay_annotated` — and absent on any display that carries no annotations or no replay. Regenerable from `replay` + `annotations.json`. |
| `keyframes` | array | OPTIONAL | This display's annotated stills, same shape and rules as `media.keyframes` ([§5.7](#57-keyframes-annotated-stills)), with files under `"frames-d<index>/"`. `t_ms` is on **this display's own replay clock**, not the pack clock. Absent on the focused entry (its stills are the top-level `media.keyframes`) and on any display without annotations. |
| `bounds` | object | REQUIRED | This display's rectangle in the OS virtual-desktop coordinate space, in **device-independent pixels**: `{ "x", "y", "width", "height" }`. Multiply by `scale` for physical pixels — `bounds.width × scale` is `environment.screens[index-1].width` and approximates `snapshot_width`, which is the authoritative frame and MAY differ by a pixel at fractional scale factors. The offsets place the screens relative to each other, and are what lets a viewer lay the displays out in their real arrangement. |
| `scale` | number | REQUIRED | This display's scale factor (`1`, `1.25`, `1.5`, `2`, …). MUST be > 0. |
| `focused` | boolean | REQUIRED | `true` on exactly one entry: the display whose media is the pack's top-level media, and the display a box without an explicit `display` belongs to. |

Rules:

- Annotation geometry is **per display**: a box's `bounds` are pixels in the snapshot of the
  display its `display` field names ([§8.2](#82-coordinate-space),
  [§8.8](#88-display-which-display-a-box-is-on)) — never in the focused display's snapshot. That
  display's frame is its entry's `snapshot_width`/`snapshot_height`; a reader MUST measure the box
  against those and MUST NOT measure it against `annotations.json`'s
  `reference_width`/`reference_height`, which describe the FOCUSED display alone.
- **Rendered views are per display too.** The focused display's annotated replay and stills are
  the top-level `media.replay_annotated` / `media.keyframes` and MUST contain only the focused
  display's boxes; another display's are `replay_annotated` / `keyframes` on its own entry and
  MUST contain only its own. A writer MUST NOT draw one display's box into another display's
  rendering — the same coordinates mean something different on every screen.
- All per-display media is frozen by the **same trigger**, so the snapshots are the same instant.
  A viewer showing several displays at once SHOULD drive them from ONE position on the pack clock
  (the focused display's replay clock).
- **Aligning a non-focused replay with the pack clock.** When
  `replay_clock_offset_ms` is present, a reader placing pack-clock position `t` (the focused
  display's replay clock, which every annotation lifetime uses) on display *i* uses

  ```
  t_i = t + displays[i].replay_clock_offset_ms
  ```

  The value is an observed difference between recorder origins on one shared monotonic clock.
  It remains valid when recorder stop/flush completion times differ and when an exact cut rebases
  each replay independently. The focused entry's value is `0`.

  A legacy entry may omit the field. Only then, readers use the former end-alignment fallback:

  ```
  t_i = t + (displays[i].replay_duration_ms - media.replay_duration_ms)
  ```

  The same resolved offset applies to a non-focused display's `keyframes` times and to the
  lifetimes rendered into its `replay_annotated`: those are on that display's own clock, not the
  pack clock.
- When the writer trims a multi-display capture (`trim_offset_ms`, [§5.3](#53-media)), it SHOULD
  cut every declared per-display replay to the same observed real-time interval. A secondary
  recorder that started later MAY remain shorter and MUST NOT be padded. The saved
  `replay_clock_offset_ms` reflects any clamping/rebasing performed by that cut. Adding
  `trim_offset_ms` to a reader's seek is wrong: all declared clocks are already rebased, and the
  field is provenance only.
- A declared per-display file MUST exist in the pack. Readers MUST ignore per-display files that
  are not declared, and MUST NOT fail when `displays` is absent (a pack older than 0.7.0).

Two displays, focus on the second:

```json
"media": {
  "snapshot": "snapshot.png",
  "replay": "replay.webm",
  "replay_duration_ms": 28437,
  "displays": [
    {
      "index": 1,
      "snapshot": "snapshot-d1.png",
      "snapshot_width": 1920,
      "snapshot_height": 1080,
      "replay": "replay-d1.webm",
      "replay_duration_ms": 28402,
      "replay_clock_offset_ms": -35,
      "replay_annotated": "replay_annotated-d1.webm",
      "keyframes": [{ "file": "frames-d1/frame-01_00-21.475.png", "t_ms": 21475 }],
      "bounds": { "x": 0, "y": 0, "width": 1920, "height": 1080 },
      "scale": 1,
      "focused": false
    },
    {
      "index": 2,
      "snapshot": "snapshot.png",
      "snapshot_width": 2560,
      "snapshot_height": 1440,
      "replay": "replay.webm",
      "replay_duration_ms": 28437,
      "replay_clock_offset_ms": 0,
      "bounds": { "x": 1920, "y": 0, "width": 2560, "height": 1440 },
      "scale": 1,
      "focused": true
    }
  ]
}
```

A capture that froze **one** display. This is the shape a single-monitor pack writes from 0.7.0 —
the array is present, holds exactly one entry, and that entry is focused and repeats the
top-level media:

```json
"media": {
  "snapshot": "snapshot.png",
  "replay": "replay.webm",
  "replay_duration_ms": 12010,
  "displays": [
    {
      "index": 1,
      "snapshot": "snapshot.png",
      "snapshot_width": 2400,
      "snapshot_height": 1350,
      "replay": "replay.webm",
      "replay_duration_ms": 12010,
      "replay_clock_offset_ms": 0,
      "bounds": { "x": 0, "y": 0, "width": 1920, "height": 1080 },
      "scale": 1.25,
      "focused": true
    }
  ]
}
```

Note `snapshot_width` `2400` beside `bounds.width × scale` = `1920 × 1.25` = `2400` here, but the
two are computed differently and a fractional scale factor is exactly where they part company.
`snapshot_width`/`snapshot_height` are the raster's real size and win.

### 5.7 `keyframes` (annotated stills)

LLMs read images, not video. `media.keyframes` declares the **annotated keyframe stills** in
`frames/`: PNGs of the capture with the annotations rendered into the pixels — the same overlays
the annotated replay draws ([§7.2](#72-the-annotated-replay)) — one per **annotation state
change**. Reading them in order reconstructs the whole capture without decoding a single video
frame. How they are produced is [§7.3](#73-annotated-keyframes).

`keyframes` is OPTIONAL and RECOMMENDED. It is absent in a pack whose stills have not been
rendered — writers render them in the background after saving, so a freshly saved pack may
declare nothing here for a moment (or forever, if the render failed). Its presence is the
declaration that the files exist.

Each entry:

| Field | Type | Required | Description |
|---|---|---|---|
| `file` | string | REQUIRED | Pack-relative filename, `"frames/frame-<NN>_<MM-SS.mmm>.png"`. `NN` is this entry's **1-based position in the array**, zero-padded to at least two digits; `MM-SS.mmm` SHOULD be `t_ms` formatted as minutes-seconds.milliseconds, minutes zero-padded to at least two digits (`:` is not a legal filename character on Windows, hence `-`). The file MUST exist in the pack. |
| `t_ms` | integer | REQUIRED | Position on the replay clock, in milliseconds, of the frame this still shows — the same clock as annotation lifetimes ([§8.4](#84-lifetime)), `snapshot_t_ms`, and timeline offsets against `t0`. MUST be >= 0. |
| `width` | integer | OPTIONAL (RECOMMENDED) | The still's real pixel width, as written. Equals the source frame's width. |
| `height` | integer | OPTIONAL (RECOMMENDED) | The still's real pixel height, as written. **MAY be GREATER than the source frame's height** — see the label gutter rule below. Absent in packs written before this field existed; a reader that needs it MUST read the PNG rather than assume the reference frame's height. |

**The label gutter.** A keyframe MAY be taller than the frame it shows. A box sitting on the
bottom edge of the screen has to put its label somewhere, and a writer MAY grow the still
**downward** to hold it rather than move the box or flip its callout over the thing it points at.

What that space costs a reader is nothing, provided the reader is told:

- The source frame is at **(0, 0)**, at its **original scale**. The gutter is appended below it
  and never shifts, scales or crops the frame.
- Therefore annotation coordinates — which are in `annotations.json`'s
  `reference_width`/`reference_height` space ([§8.2](#82-coordinate-space)) — apply to this image
  **unchanged**. Drawing them straight onto the still is correct.
- A reader MUST NOT scale a keyframe to `reference_height`, and MUST NOT assume the still and
  the snapshot have the same dimensions. `height` above is what the file actually is.
- The gutter is per-instant: it depends on the labels present at that `t_ms`, so two entries in
  one pack MAY differ. Zero is normal when nothing at that instant carries text.

Rules:

- Entries MUST be ordered by `t_ms` **ascending**, which is what makes `NN` the reading order.
- Which instants get a still (the *state changes*): each box lifetime contributes its `start_ms`
  (the box appears) and its `end_ms` (it disappears); a box with no lifetime contributes the
  **capture instant** — the last frame of the replay, where the trigger froze the buffer. Writers
  SHOULD merge changes closer together than ~300 ms into a single still, and SHOULD cap the array
  at a sane number of stills (the reference implementation merges at 300 ms and caps at 24).
- A **screenshot-only pack** (`"replay": null`) has no video to render, and gets exactly **one**
  entry with `t_ms` 0, drawn from `snapshot.png`. A pack with a replay but no annotations gets
  one still at the capture instant.
- A keyframe is a **generated view**, never a source: it MUST be regenerable from the media +
  `annotations.json`, and readers MUST NOT treat its pixels as authoritative annotation data.
- A still shows the box lifetimes in effect at `t_ms` and the **global** display numbers
  ([§8.5](#85-display-numbers)) — identical to the annotated replay at the same instant.
- Like the annotated replay, `media.keyframes` covers the **focused display** and MUST contain
  only its boxes. In a multi-monitor capture each other annotated display has its own stills in
  `frames-d<N>/`, declared as `keyframes` on its `media.displays` entry
  ([§5.6](#56-displays-multi-monitor-captures)).
- Writers MUST regenerate `frames/` from scratch when annotations change (deleting stale stills),
  exactly as they do for `replay_annotated`. Readers MUST ignore PNGs under `frames/` that are
  not declared, and MUST NOT fail when `keyframes` is absent.
- Blur applies here like everywhere else ([§9](#9-blur-and-privacy)): blurred regions are
  pixelated in the still, while `snapshot.png` and the replay keep the original pixels.

```json
"media": {
  "snapshot": "snapshot.png",
  "replay": "replay.webm",
  "replay_duration_ms": 28437,
  "replay_annotated": "replay_annotated.webm",
  "keyframes": [
    { "file": "frames/frame-01_00-21.750.png", "t_ms": 21750 },
    { "file": "frames/frame-02_00-22.750.png", "t_ms": 22750 },
    { "file": "frames/frame-03_00-26.900.png", "t_ms": 26900 }
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
  writer's choice for a legacy pack. When `capture_kind` is present, the writer MUST follow its
  declared image/video intent and the `image_scope` rules in [§5.3](#53-media).
- In a `capture_kind: "image"` region pack, `snapshot.png` is the crop itself. A writer MUST NOT
  also store the uncropped display, another display's snapshot, or any hidden context raster.
  `crop_bounds` preserves where the crop came from without preserving those unselected pixels.
- In a `capture_kind: "image"` fullscreen pack, `snapshot.png` is the complete virtual-desktop
  frame the user explicitly requested. It MUST include every attached display captured by that
  trigger; a writer MUST fail rather than label a partial set as fullscreen. Fullscreen MUST NOT
  be inferred merely because no crop was supplied.
- **The snapshot is original evidence and MUST NOT be modified.** No annotation is ever burned
  into `snapshot.png` — including blur. Blur renders only into derived views
  ([§9](#9-blur-and-privacy)). The snapshot is pixels; annotations are data drawn on top of it by
  viewers. A fullscreen image MAY losslessly arrange native per-display rasters into one PNG
  (including blank pixels where the virtual layout has a gap), but MUST NOT resample or alter
  the source pixels.

---

## 7. Replay video

The replay video is OPTIONAL. When present it holds the last configured stretch of screen
activity leading up to the capture — 30 seconds by default — so a reader can watch what happened
*before* the frame. A writer with a rotating buffer MUST cut surplus footage before finalizing
the pack: the saved replay MUST NOT be longer than the configured replay length. A buffer that
has not filled yet stays at its real shorter duration and MUST NOT be padded. The editor or other
authoring surface SHOULD expose this same final range, not the longer recorder segment.

- The filename MUST be `replay.webm` or `replay.mp4`, and MUST match `manifest.media.replay`.
  A pack MUST NOT contain more than one replay file *of the pack's own display*. A
  multi-monitor capture MAY additionally contain one `replay-d<N>.webm` per other display, each
  declared in `manifest.media.displays` ([§5.6](#56-displays-multi-monitor-captures)).
- Writers SHOULD prefer a platform H.264 encoder in `replay.mp4` when one is available, then
  fall back to VP8 and VP9 in `replay.webm`. A writer MUST declare the filename matching the
  bytes it actually produced; Matroska/AVC is not WebM and MUST NOT be stored as `replay.webm`.
- `manifest.media.replay_duration_ms` MUST hold the video's duration in milliseconds.
- Audio is OPTIONAL and typically absent.
- **The replay is unannotated evidence.** A writer MAY range-cut/re-encode the recorder segment
  to enforce the configured duration (recording the source in-point in `trim_offset_ms`), but
  annotations — including blur — are never burned into `replay.webm`/`replay.mp4`. Annotations
  live in `annotations.json` as editable data; the rendered view lives in the *separate*
  annotated replay file ([§7.2](#72-the-annotated-replay)).
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
- **Callout placement does not rewrite evidence geometry.** Annotation text keeps its declared
  below-box anchor. A renderer MUST NOT translate a box or flip its label to another edge merely
  to fit the source frame. A generated annotated view MAY extend its canvas below the original
  frame with a result-only gutter large enough for that callout. When it does, the original
  source pixels remain unchanged at `(0, 0)` with their original width and height; only the
  derived canvas is taller. The original replay and `snapshot.png` are never resized.
- **One display per rendering.** `replay_annotated` renders the FOCUSED display's replay and
  MUST contain only the boxes whose display is the focused one ([§8.8](#88-display-which-display-a-box-is-on)).
  Another captured display's annotated replay is `replay_annotated` on its own `media.displays`
  entry, contains only its own boxes, and is rendered on its own replay clock
  ([§5.6](#56-displays-multi-monitor-captures)).
- Rendering MAY happen in the background after the pack is saved ([§3.1](#31-the-pack-folder-the-save-unit));
  a render failure loses the annotated replay, not the pack. The renderer writes
  the completed file before atomically adding its manifest declaration and
  regenerating manifest-derived documents; source-first readers therefore never
  need a derived file to understand the saved pack.

### 7.3 Annotated keyframes

The annotated **keyframes** are the still-image form of the same rendering: PNGs under `frames/`,
declared in `manifest.media.keyframes` ([§5.7](#57-keyframes-annotated-stills)). They exist for
the reader that cannot — or will not — decode video, which today is every LLM.

- **Same pixels, same rules.** A keyframe at `t_ms` MUST be composited exactly as the annotated
  replay's frame at that instant: original frame → blur → border → number badge → text, with the
  boxes whose lifetime contains `t_ms` and their GLOBAL display numbers, and with **no editing
  controls of any kind**. The straightforward implementation is to capture the stills from the
  annotated-replay render itself, which makes the two identical by construction.
- **When.** One still per annotation state change, merged and capped as described in
  [§5.7](#57-keyframes-annotated-stills).
- **No replay, one still.** A screenshot-only pack has nothing to play: its single keyframe is
  `snapshot.png` with the annotations drawn on top (`t_ms` 0). Lifetimes are replay-clock
  intervals ([§8.4](#84-lifetime)) with nothing to anchor to in such a pack, so every box is
  drawn.
- **Derived and disposable.** Keyframes are regenerated from scratch whenever annotations change,
  MAY render in the background after save, and a failed render loses the stills, not the pack.
- The stills are PNG. Their source viewport SHOULD equal `snapshot.png`'s annotation coordinate
  space ([§8.2](#82-coordinate-space)). A still MAY be taller only by the result-only bottom
  callout gutter allowed in [§7.2](#72-the-annotated-replay); source pixel `(0, 0)` remains
  derived pixel `(0, 0)`, so box bounds still map directly without an offset.

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
| `reference_width` | integer | REQUIRED | Width in pixels of **the FOCUSED display's** coordinate space — MUST equal the pixel width of `snapshot.png`, and from format 0.7.0 the `snapshot_width` of the focused `media.displays` entry ([§5.6](#56-displays-multi-monitor-captures)). This is *not* the size of the capture: a box carrying a `display` field is pixels in THAT display's snapshot and MUST be read against its own frame ([§8.2](#82-coordinate-space)). |
| `reference_height` | integer | REQUIRED | Height in pixels of **the FOCUSED display's** coordinate space, under the same rules as `reference_width`. |
| `annotations` | array | REQUIRED | List of annotation boxes. May be empty. Order carries no meaning — reading order is defined by the display-number rule ([§8.5](#85-display-numbers)) and lifetimes, not by array position. |

### 8.2 Coordinate space

All annotation geometry is in **snapshot pixel coordinates**: origin at the top-left pixel of
`snapshot.png`, x grows right, y grows down, units are snapshot pixels. Coordinates MAY be
non-integers (sub-pixel positions from freehand drawing are fine).

Each captured display ([§5.6](#56-displays-multi-monitor-captures)) has its own such space, and a
box's coordinates are pixels in the snapshot of the display its `display` field names
([§8.8](#88-display-which-display-a-box-is-on)) — `snapshot-d<N>.png` for a non-focused display,
`snapshot.png` for the focused one. There is no board-wide or virtual-desktop coordinate space in
the format: every box belongs to exactly one screen.

**`reference_width`/`reference_height` describe the FOCUSED display and nothing else.** There is
exactly one of them and there are N displays, so they cannot be "the coordinate space" of the
pack. They are the pixel size of `snapshot.png`, which is the focused display's snapshot, and
they are the frame for every box that carries **no** `display` field. A box that carries one is
read against that display's own snapshot, whose size its `media.displays` entry states in
`snapshot_width`/`snapshot_height`. Reading a `display: 2` box against `reference_width` puts it
on the wrong screen at coordinates that mean nothing — the same numbers describe different pixels
on every monitor. (Before 0.7.0 a reader had to compute the other display's frame as
`bounds.width × scale`; that is now a fallback for pre-0.7.0 packs only, and the declared frame
wins where both are present.)

A box's geometry MUST lie **within** the snapshot it is expressed in: `x >= 0`, `y >= 0`,
`x + width <= ` that snapshot's width, and `y + height <= ` its height. Coordinates outside the
image are not positions in the space the annotation declares — a reader cannot interpret them,
renderers clip them inconsistently, and generated views print them as facts (`report.md` writes
"box at (-202, 864)" for a box that left a 3840x2160 screen). Writers MUST clamp a box to its
display as it is drawn, moved or resized; readers encountering an out-of-range box SHOULD clamp
it into the frame rather than discard the annotation, and MAY report the pack as malformed.

**The frame checked is the one the box names, and a validator MUST NOT skip the check.** A box
with `display: 2` is measured against display 2's `snapshot_width`/`snapshot_height`, not against
`reference_width`/`reference_height`; a validator that cannot establish that display's frame —
neither declared nor readable from its snapshot — MUST report the box as unverifiable rather than
pass it. Silently skipping is how a pack whose boxes are hundreds of pixels off the side of a
screen looks valid.

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
| `bounds` | object | REQUIRED | The box rectangle in snapshot pixel coordinates: `{ "x": number, "y": number, "width": number, "height": number }`. All four fields REQUIRED; `width` and `height` MUST be > 0. In a multi-display pack these are pixels in the snapshot of the box's own display — see `display` below. |
| `display` | integer | OPTIONAL | WHICH captured display this box was drawn on: the 1-based `manifest.media.displays[].index` ([§5.6](#56-displays-multi-monitor-captures)). MUST be >= 1 and MUST match a declared display. **Absent = the focused display**, which is what a single-display pack and every box on the focused screen write. See [§8.8](#88-display-which-display-a-box-is-on). |
| `text` | string | OPTIONAL | The box's description — what the user typed. MAY be empty; absent means `""`. This is the annotation's meaning; writers SHOULD make entering it effortless. |
| `start_ms` | number | OPTIONAL | Start of the box's **lifetime** on the replay clock, in milliseconds. MUST appear together with `end_ms` — both or neither. See [§8.4](#84-lifetime). |
| `end_ms` | number | OPTIONAL | End of the box's lifetime, in milliseconds. MUST be >= `start_ms`. MUST appear together with `start_ms`. |
| `numbered` | boolean | OPTIONAL | Whether the box takes part in display numbering ([§8.5](#85-display-numbers)). Default `false`. The number itself is **never stored** — it is computed. |
| `number_pin` | integer | OPTIONAL | The display number this box's author assigned it, an integer **≥ 1** ([§8.5](#85-display-numbers)). Absent = automatic. An INPUT to the numbering rule, not a stored display number: a reader that ignores it still computes valid numbers. It claims a SLOT — a pin above the number of numbered boxes claims the last one, so numbering stays contiguous; values below 1 and non-integers are ignored. Inert while `numbered` is `false`. Introduced in `format_version` 0.2.1 as 1-9; widened to any integer ≥ 1 in 0.2.2. |
| `blur` | boolean | OPTIONAL | Whether the box's interior is sensitive and MUST be blurred in rendered views ([§9](#9-blur-and-privacy)). Default `false`. Blur is a box property, never a separate annotation type. |
| `tracking` | object | OPTIONAL | Object-tracking state. `enabled` (boolean) is REQUIRED inside `tracking`. When `true`, `samples` (array, non-empty) is REQUIRED and carries the path the box follows — see below. When `false` or absent, the box is a fixed rectangle and `bounds` is all there is. Absent means `{ "enabled": false }`. Readers MUST ignore tracking content they do not understand and treat the box as untracked, which is always safe: `bounds` remains correct on its own. **LEGACY as of 0.4.0.** Written by 0.2.0-0.3.x writers; a current writer MUST NOT emit `samples`, because it stopped claiming to know where an object was at an arbitrary past frame. **Readers MUST continue to honour `tracking` in packs that carry it** — the field is not removed and not deprecated for readers, and a pack written before 0.4.0 MUST render exactly as it always did. A writer that re-saves such a pack MUST carry the samples through unchanged, including across a trim ([§5.3](#53-media)). |
| `tracking.samples[]` | object | see above | One rectangle the tracked object occupied: `t_ms` (number, on the replay clock — [§10.1](#101-structure)), `x`, `y`, `width`, `height` (numbers, pixels in the snapshot of the sample's own display), and OPTIONAL `display` (number — the [§5.6](#56-displays-multi-monitor-captures) index whose snapshot these numbers are pixels of; absent means the annotation's own `display`, [§8.8](#88-display-which-display-a-box-is-on)). Samples MUST be in ascending `t_ms`, and each MUST lie within its own display's snapshot — a window may hang off a screen edge, but the part past it is in no image, so a sample is the VISIBLE rectangle (the same rule `bounds` obeys, [§8.2](#82-coordinate-space)). **Every sample is an OBSERVATION.** A reader resolving a time between two samples MUST use the NEARER sample unchanged, and MUST NOT interpolate: an interpolated rectangle is a position the object never occupied, written in the same numbers as a measured one, and nothing in the pack distinguishes them. Writers SHOULD record one sample per captured frame, which is what makes that rule cost nothing — a pack cannot show a moment finer than a frame. Before the first sample and after the last, the box is held at that end. A box's LIFETIME ([§8.4](#84-lifetime)) — not the sample range — is what says when it stops being drawn. **Added in 0.2.0.** |
| `target` | object | OPTIONAL | Semantic object metadata: what real UI object the box points at (DOM selector, role and text; Windows UI Automation `AutomationId`/`ControlType`; engine object ids…). This is where the earlier draft's "element"/Tracked Element concept lives now — a box *with a target* is a semantic annotation; there is no separate element type. Its `source` field says where the metadata came from; see [§8.7](#87-target-semantic-objects). Readers MUST ignore sources and fields they do not understand and MUST still render the box from `bounds`. |
| `style` | object | OPTIONAL | Display styling. In 0.1.0 the only defined field is `color`: CSS-style hex, `"#RRGGBB"` or `"#RRGGBBAA"`, used for the border, badge, and text. CapturePack writers use red `"#FF3B30"` for a newly authored manual rectangle and blue `"#0A84FF"` for a newly picked semantic object. When `style.color` is absent, viewers SHOULD use that same semantic rule (`target` present or `tracking.enabled: true` = blue; otherwise red). When it is present, readers MUST preserve and render the stored value so existing/custom packs are never silently recoloured. |
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
  snapshot frame).
- **A picked box names its own instant.** The midpoint is a good anchor for a box someone *drew*
  over a stretch of time. It is the wrong one for a box someone *picked off an object*: that box
  means "this window, as it was in the frame I was looking at", and editing the lifetime must not
  move what it means. So a picked box records that frame in `tracking.picked_at_ms`, on the replay
  clock. When it is present it is the box's representative instant and `bounds` MUST be the
  tracking sample nearest to it — which makes the two checkable against each other, and lets a
  reader place the box exactly where the editor did. When it is absent the midpoint rule stands.
- **Rendering.** A viewer scrubbing the replay SHOULD draw a box only while the current position
  lies inside its lifetime; boxes without a lifetime always draw. The annotated replay renders by
  the same rule ([§7.2](#72-the-annotated-replay)) — including blur, which applies exactly during
  the lifetime ([§9](#9-blur-and-privacy)).

### 8.5 Display numbers

Numbered boxes carry visible numbers — ①, ②, ③ — in every rendered view. Those numbers are
**computed, never stored**:

- A box's permanent identity is its immutable `annotation_id`. The display number is derived at
  display/render time and is not a source-data identifier. Writers MUST NOT store display
  numbers in the pack; readers MUST NOT parse them back out of rendered views. A box MAY carry
  `number_pin`, which is the number its author ASKED for — an input the rule below honours, never
  a record of what was rendered.
- **Contiguous from 1, always.** `N` numbered boxes carry exactly the numbers `1..N` — no gaps, no
  duplicates, whatever any pin asks for. The rules below decide only **which** box holds which
  number. A sequence with a hole would have the documents cite a ④ that no frame of the video
  contains, and no reader could tell which of the two was lying.
- **The order is ASSIGNMENT order**, and for a box nobody re-numbered that is creation order.
  Take every box with `numbered: true`. Sort by:
  1. `created_at` ascending, compared as an **instant**, not as text — it carries a UTC offset
     ([§8.3](#83-the-box)), so `…T18:22+09:00` and `…T10:22+01:00` are the same moment and a
     lexicographic comparison would order them wrongly;
  2. a box with no parseable `created_at` sorts **after** every box that has one, and among
     those the pre-existing chain decides: `z` ascending (absent `z` = array position), then
     `annotation_id` ascending (lexicographic).

  Numbers follow the order the person gave them out — which, for boxes numbered as they were
  drawn, is the order they made them in. Where a box sits on the replay clock is a different
  question, and the documents already answer it by printing each box's time beside its number
  ([§12](#12-generated-document-views)).
- **A box MAY be given a number.** `number_pin` ([§8.3](#83-the-box)) is an integer **≥ 1** that
  the user assigned. It is an **input to this rule, not a stored display number** — the number
  itself is still computed, and a reader that ignores `number_pin` computes valid, self-consistent
  numbers the automatic way, exactly as [§13.1](#131-format_version-policy) requires of an unknown
  optional field. It claims a **slot**:
  - Pins claim their slots **first**, ascending, ties broken by creation order. Boxes without one
    then fill the slots that remain, in creation order — so an automatic box numbers around the
    assigned ones rather than pushing them aside.
  - **A pin never leaves a gap.** A pin above the number of numbered boxes claims the **last**
    slot: pin the only box to `5` and it is ①, because 5 is not a number that pack has. A
    `number_pin` below 1, or a non-integer, names no slot at all and is ignored.
  - **Two boxes claiming one slot:** the one created **first** keeps it; the other takes the
    nearest free slot, searching upward before downward. Both still receive a number — a numbered
    box without one could not be referenced by the documents.
  - `number_pin` on a box with `numbered: false` is inert, not an error: a box that shows no
    number holds no slot, so a leftover pin cannot punch a hole in someone else's sequence.
  - Adding, deleting, re-numbering or un-numbering a box renumbers the rest immediately.
- **Assignment is an editor's job, and it MUST behave like one.** An editor that lets the user
  work with these numbers:
  - **turning numbering ON gives the box the NEXT number**, whatever the box's age. The user has
    just assigned it; putting it back in the middle of the sequence because `created_at` says so
    overrules them with the capture clock.
  - **turning numbering OFF releases the number** and the rest close up. Nothing is kept behind to
    be silently restored later — turning it back on is a new assignment, and takes the next number.
  - **typing a number another box holds PUSHES that box along** rather than duplicating it: the
    sequence is the one on screen with this box lifted out and dropped in at the number asked for,
    everything it steps over shifted by one, and nothing else moved.
  - **stores only what creation order cannot already say.** Numbering a box that was going to get
    that number anyway writes no `number_pin` at all; a pack should carry the user's decisions, not
    the app's defaults restated on every box.
- **Consistency scope.** Every consumer MUST use exactly this rule, so the same box shows the
  same number everywhere: editor canvas, annotated replay, `report.md`, `README.md`, `skills/`
  documents, and MCP responses. Video numbers and document numbers never differ.
- **Global, not per-frame.** In the annotated replay, each frame draws only the boxes alive at
  that time, but with their global numbers: if only box ② is visible in a frame, it renders as
  ② — numbers are never re-compressed per frame ([§7.2](#72-the-annotated-replay)).
- Documents list numbered boxes in display order, e.g. `1. 00:03.200 — "renamed the document
  here"` ([§12](#12-generated-document-views)); if annotations change after generation, the
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
      "target": {
        "source": "uia",
        "name": "Save",
        "control_type": "Button",
        "automation_id": "saveButton",
        "class_name": "Chrome_WidgetWin_1"
      },
      "style": { "color": "#0A84FF" },
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
the original pixels ([§9](#9-blur-and-privacy)). Box **2** also carries a `target`
([§8.7](#87-target-semantic-objects)): it was placed on a real UI object, so a reader knows it
is *the Save button*, not just a rectangle. A reader that ignores `target` entirely loses
nothing but that sentence.

### 8.7 `target` (semantic objects)

A box's `bounds` says *where*; `target` says *what*. It records the real UI object the box was
placed on, so a reader can talk about "the Save button" rather than "the rectangle at
(2140, 1236)" — and so the same object can still be found after the UI moved.

`target` is OPTIONAL and purely additive: a box without one is an ordinary box, and a box with
one MUST still be renderable from `bounds` alone. Writers MUST NOT require a reader to
understand `target`.

| Field | Type | Required | Description |
|---|---|---|---|
| `source` | string | REQUIRED | Where the metadata came from — the discriminator for every other field in the object. Format 0.1.0 defines exactly one value: `"uia"` (see below). Readers MUST ignore a `target` whose `source` they do not know, and MUST NOT guess at its other fields. |

**`source: "uia"` — Windows UI Automation.** The object is a Microsoft UI Automation object as
it was **at the capture instant**: either a control from a window's automation tree, or a
top-level window itself. Every field below is OPTIONAL and carries the UIA property of the same
meaning; a field the object had no value for is OMITTED rather than written as an empty string.

| Field | Type | Description |
|---|---|---|
| `level` | string | Which object this is: `"control"` (a control inside a window) or `"window"` (the top-level window itself). A target without `level` is a control — the value predates the window level and readers MUST treat its absence as `"control"`. |
| `name` | string | UIA `Name` — the control's accessible name, i.e. what the user sees ("Save"). Localized to the captured machine's language, and not stable across UI changes. Controls. |
| `control_type` | string | UIA `ControlType` **without** the `ControlType.` prefix, e.g. `"Button"`, `"Edit"`, `"TabItem"`. Language-independent. Controls. |
| `automation_id` | string | UIA `AutomationId` — the application's own identifier for the control. The most stable field when the application provides one; MAY be absent, and is only unique within its container. Controls. |
| `class_name` | string | Win32 window class, e.g. `"Chrome_WidgetWin_1"` — of the control at level `"control"`, of the window at level `"window"`. |
| `title` | string | The window's title at the capture instant. Windows. |
| `process` | string | Process name without extension, e.g. `"chrome"` — of the window at level `"window"`, and of the window a control was picked in when the writer knows it. |

**Why the window level exists.** Many applications expose no usable automation tree — Chromium
and Electron windows build one only when an assistive client asks, and some apps have none at
all. The window is what a writer can always identify, so a box on such an app still says *which
window* it points at rather than nothing. A reader MUST NOT treat a `"window"` target as a
lesser one: it is a complete answer at a coarser granularity.

**`source: "chrome-dom"` — Chrome DOM capture.** A selected document element carries
`level: "control"`, its provider-stable `object_id`, and every non-empty identity field the
provider observed: `selector`, `tag`, `dom_id`, `role`, `url`, `title`, and `name`. This target
persists the meaning of a DOM pick across save/reopen; it does not authorize a later live DOM
query. Readers that do not understand this source ignore its fields and render `bounds`.

- **The bounds are the truth.** `target` describes the object a box was placed on; it never
  overrides, extends, or replaces `bounds`. A reader that cannot resolve the object still has
  the exact rectangle in the snapshot.
- **A moment, not a live handle.** The metadata is a snapshot of one instant, like the pixels
  next to it. It says nothing about the object at any other point in the replay; following an
  object through time is `tracking` ([§8.3](#83-the-box)), which is reserved.
- **Provenance.** When the pack also carries the dump the object was picked from
  ([§11.3](#113-windows-uia-windows-ui-automation)), a reader MAY match the two by name,
  control type, automation id, and bounds. The dump is OPTIONAL: a `target` stands on its own.
- Writers MAY define further `source` values (a DOM picker, a game engine); they MUST NOT
  redefine `"uia"`.
- **Picking is a STILL-image affordance.** A `target` may be written by any writer, and every
  reader renders one wherever it finds it — but a writer SHOULD offer picking only where it can
  answer at every level it offers, which in practice is a still (`capture_kind: "image"`). A
  video's window geometry is cheap enough to sample continuously, while walking a window's
  controls is not: a writer that offers picking at an arbitrary replay frame will answer some
  frames with the control and some with only the window it sits in, and nothing in the pack
  distinguishes the two. A box drawn on a video is then a manual rectangle, which is exactly
  what `bounds` already is. This is a writer's rule and changes no format: a video pack that
  carries `target` from an earlier writer stays valid and MUST still render.

### 8.8 `display` (which display a box is on)

A capture MAY freeze several displays at once ([§5.6](#56-displays-multi-monitor-captures)), and
a box belongs to exactly one of them: the screen it was drawn on.

| Field | Type | Required | Description |
|---|---|---|---|
| `display` | integer | OPTIONAL | The 1-based `manifest.media.displays[].index` of the display this box was drawn on. MUST be >= 1 and MUST match a declared display entry. |

- **Absent means the focused display.** This is the whole compatibility story: a single-display
  pack has one screen and writes no `display` at all, and a box drawn on the focused screen of a
  multi-display capture writes none either. Every pack written before this field existed is
  therefore already correct under this rule, byte for byte.
- **Bounds follow the display.** A box's `bounds` are pixels in ITS display's snapshot, whose size
  that display's entry states in `snapshot_width`/`snapshot_height`
  ([§5.6](#56-displays-multi-monitor-captures), [§8.2](#82-coordinate-space)). A reader MUST
  resolve `display` before interpreting `bounds`; reading them against `snapshot.png` — or against
  `reference_width`/`reference_height`, which describe that same focused snapshot — would place a
  box on the wrong screen at coordinates that mean nothing.
- **Unknown or malformed values.** A `display` that is not an integer >= 1, or that names no
  declared display, MUST be treated as absent (the focused display) rather than dropping the
  box — the box still has a text, a lifetime, and a rectangle worth showing.
- **Lifetimes stay on the pack clock.** `start_ms`/`end_ms` are positions on the focused
  display's replay clock ([§8.4](#84-lifetime)) whatever screen the box is on, so one scrub
  position drives the whole capture. A writer rendering a box into a NON-focused display's
  `replay_annotated` or `keyframes` MUST convert those times to that display's own clock (the
  displays' replays are aligned by the same rule as everything else in
  [§5.6](#56-displays-multi-monitor-captures)).
- **Display numbers are global.** Numbering ([§8.5](#85-display-numbers)) runs over ALL numbered
  boxes of the pack, across every display, as ONE sequence. It MUST NOT restart per display: the
  numbers are the reading order of the capture, and the capture is one moment on several
  screens. (`display` takes no part in the sort.)
- **Blur is per display too.** A `blur` box redacts a region of ITS display's rendered views
  ([§9](#9-blur-and-privacy)); it says nothing about the same coordinates on another screen.

```json
{
  "annotation_id": "ann_44a1c9",
  "type": "box",
  "display": 1,
  "bounds": { "x": 220, "y": 640, "width": 300, "height": 120 },
  "text": "the log kept scrolling on the left screen",
  "numbered": true,
  "blur": false,
  "tracking": { "enabled": false },
  "z": 3
}
```

### 8.9 `keyframes` (authored motion)

| Field | Type | Required | Meaning |
|---|---|---|---|
| `keyframes[]` | array | OPTIONAL | Where the **user put this box**, at the moments they put it there. Each entry has `t_ms` (number, on the replay clock — [§10.1](#101-structure)), `x`, `y`, `width`, `height` (numbers, pixels in the snapshot named by its OPTIONAL `display`; absent means the annotation's own display, [§8.8](#88-display-which-display-a-box-is-on)). `display`, when present, MUST name a declared captured display. Entries MUST be in ascending `t_ms`. **Added in 0.3.0.** |

**These are AUTHORED, not observed, and that is the whole reason they are not
`tracking.samples`.** A sample in [§8.3](#83-the-box) is a measurement of a real window, which is
why readers MUST NOT interpolate between two of them: a position between two measurements is one
the object never occupied, written in the same numbers as a fact. A keyframe is the user stating
where their own annotation belongs at that moment. The path between two such statements is the
annotation's presentation, not a claim about the world — so readers **MUST interpolate linearly
between keyframes**, and MUST hold the box flat before the first and after the last. Keeping the
two in separate fields is what makes each rule safe: neither can ever be applied to the other kind.

A user MAY move one manual box across captured displays. When adjacent keyframes name different
displays, a reader MUST first project both native-pixel rectangles through
`manifest.media.displays[].bounds` and `scale` into the common virtual-desktop DIP space,
interpolate there, then project the result into the captured display containing most of the
interpolated rectangle. This keeps one continuous authored object across mixed-DPI monitors
without mixing the pixels of two unrelated images. The rectangle written in each keyframe MUST
still lie within the snapshot of that keyframe's own display.

A box with **fewer than two** keyframes MUST NOT write the field: one authored position is not
motion, it is simply where the box is, and that is `bounds`.

`bounds` REMAINS the box's rectangle at its representative instant — the lifetime midpoint,
[§8.4](#84-lifetime) — so a reader that ignores `keyframes` still draws the box somewhere it
genuinely is. This is the same promise [§8.3](#83-the-box) makes for a tracked box.

A box SHOULD NOT carry both `tracking.samples` and `keyframes`. A reader that meets both MUST
prefer `tracking.samples`: a measurement outranks a preference.

Writers MUST declare `format_version` **0.3.0** on a pack that uses this field, and MUST NOT
declare it on a pack that does not ([§13.1](#131-format_version-policy)).

```json
{
  "annotation_id": "ann_7c1e44",
  "type": "box",
  "bounds": { "x": 500, "y": 200, "width": 300, "height": 150 },
  "start_ms": 10000,
  "end_ms": 11000,
  "text": "the dialog slid in from the left",
  "numbered": true,
  "blur": false,
  "tracking": { "enabled": false },
  "keyframes": [
    { "t_ms": 10000, "display": 1, "x": 100, "y": 200, "width": 300, "height": 150 },
    { "t_ms": 10600, "display": 2, "x": 900, "y": 200, "width": 300, "height": 150 }
  ],
  "z": 4
}
```

---

## 9. Blur and privacy

Blur is a **box property** (`blur: true`, [§8.3](#83-the-box)), not an annotation type, and it is
**non-destructive**: the original media in the pack are never modified.

### 9.1 The rule

1. **Originals stay original.** `snapshot.png` and the replay video MUST contain the original,
   unredacted pixels. Writers MUST NOT apply blur — or any annotation — destructively to them.
2. **Blur renders into derived views only.** Every rendered view of the capture — the annotated
   replay ([§7.2](#72-the-annotated-replay)), the annotated keyframe stills
   ([§7.3](#73-annotated-keyframes)), live editor previews, any future export — MUST
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
5. **Explicit image selection bounds source pixels.** A region image pack contains only the
   selected source pixels. Neither plugins, multi-display media, a generated keyframe, nor an
   undeclared file may carry the uncropped display or another monitor. A fullscreen source image
   is valid only after the user explicitly selected the fullscreen scope; that one image contains
   the complete captured virtual desktop and replaces, rather than accompanies, per-display files.

### 9.2 The sharing rule

Because the originals are preserved, **the pack folder itself is not redacted**. The redaction
lives in the rendered views — `replay_annotated` and the keyframe stills in `frames/`
([§7.3](#73-annotated-keyframes)) — the artifacts meant for sharing. Consequences:

- Writers MUST make this visible at save time whenever any `blur: true` box exists. The
  reference wording:

  > Original pixels remain in this pack. Create a Share Copy from History and review every
  > included still before sending it.

- Readers MUST NOT assume `snapshot.png` or the replay video honor blur boxes — they never do in
  format 0.1.0.
- `report.md`, `README.md`, and `skills/` documents SHOULD note when a pack contains blurred
  boxes, so downstream humans and LLMs know that only derived views honor blur and still require
  review before forwarding.

### 9.3 Why non-destructive

An earlier draft of this spec burned blur into `snapshot.png` destructively. 0.1.0 reverses that,
deliberately:

- **Evidence survives.** The pack's reason to exist is faithful context. Destroying pixels in the
  source of truth contradicts it — and could never cover the replay anyway, which shows the same
  content in motion.
- **Blur stays editable.** A mis-drawn blur box can be fixed and the views re-rendered. A
  destructive blur was forever, including its mistakes.
- **The folder is local.** A pack folder lives on the user's own machine; redaction matters at
  the moment of *sharing*. Annotated replays remain useful local derived views, while the
  reviewed Share Copy is created separately from annotated stills only.

### 9.4 Share Copy distribution

The Share Copy of [§3.3](#33-the-share-copy-derived-distribution) closes the accidental full-pack
sharing path without weakening the evidence contract. Its `reviewed-stills-only` profile excludes
every original media file, every video container (including annotated replays), and all structured
source context. It contains only manifest-declared annotated keyframe pixels re-encoded as
canonical PNGs, plus documents generated from the closed share inventory.

It deliberately does **not** call itself a sanitized CapturePack:

- A conforming CapturePack requires `snapshot.png`, and that file means original pixels. Omitting
  it would make an invalid pack; replacing it with redacted pixels would make the filename lie.
- A visual redaction covers marked regions only. Pixels outside those regions and text intentionally
  drawn into an annotated still remain visible.
- Structured DOM/UIA/plugin data can repeat text hidden in pixels, so the 0.1.0 Share Copy excludes
  it wholesale instead of guessing which provider fields are safe.
- A blur-box label is drawn as visible result text. A writer MUST block Share Copy creation when a
  blur box still has a non-empty label, unless a future share-specific renderer proves that it
  removed that label from every output still.
- PNG canonicalization removes hidden container metadata and trailing bytes; it does not inspect
  the meaning of visible pixels or prove that a marked visual transformation is irreversible.

The full pack folder stays local and authoritative. The Share Copy is a disposable, replaceable
projection whose every still the user reviews at share time.

---

## 10. timeline.json

`timeline.json` is OPTIONAL for video packs and MUST be absent when
`manifest.capture_kind` is `"image"`. It is the machine-readable record of *when things happened*:
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
| `input.*` | **Partly defined (0.8.0)** | What the user did. `input.mouse.*` and `input.window.*` are defined below and MAY be emitted from 0.8.0. **`input.key.*` remains RESERVED: writers MUST NOT emit it**, at any version, until a future version of this spec defines it. Readers MUST skip every type they do not know, reserved ones included. |
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

Input events defined in 0.8.0:

| Type | Emitted when | Conventional `data` fields |
|---|---|---|
| `input.mouse.move` | The pointer was observed at a new position. | `x`, `y` (integers, the coordinate rule below), `display` (integer, optional) |
| `input.mouse.click` | A mouse button was observed DOWN having been observed UP. | `button` (`"left"`, `"right"` or `"middle"`), `x`, `y`, `display` (optional), `observed_within_ms` (integer, optional — see below) |
| `input.window.focus` | A different top-level window became the foreground window. | `title`, `process` (matching `plugins/windows-uia`, [§11.3](#113-windows-uia-windows-ui-automation)), `display` (optional) |
| `input.window.move` | A visible top-level window's position changed, its size unchanged. | `title`, `process`, `bounds` (`{x, y, width, height}`), `display` (optional) |
| `input.window.resize` | A visible top-level window's size changed. | `title`, `process`, `bounds`, `display` (optional) |

- **Coordinates.** `x`/`y` and `bounds` are **snapshot pixel coordinates** of the display named
  by `display`, exactly as an annotation's ([§8.2](#82-coordinate-space)) and a `windows-uia`
  rectangle's are. `display` is a `media.displays[].index` and is ABSENT for the focused display,
  the same rule [§8.8](#88-display-which-display-a-box-is-on) fixes for a box. An event that
  happened on a display the capture did not freeze has no coordinates in this pack and MUST NOT
  be written into another display's space; writers omit such an event entirely.
- **These are observations, and they are sampled.** A writer emits an event only for something it
  actually observed, and MUST NOT interpolate between two observations, invent an event it did
  not see, or restate one observation as several. It follows that the stream is INCOMPLETE by
  construction: a movement between two samples is not recorded, and neither is a click that began
  and ended between them. A reader MUST treat these events as evidence that something happened,
  never as proof that nothing else did.
- **`observed_within_ms`** is how much OLDER than `t_ms` the press may be: the gap back to the
  previous observation, in which the button is known to have gone down. A writer that can
  timestamp a press exactly omits the field; a writer that cannot MUST NOT pretend otherwise by
  omitting it.
- **Writers SHOULD coalesce.** `timeline.json` is an index into the capture, not a data store: a
  pointer sampled 45 times a second for 30 seconds is 1,350 events that say one sentence. Emitting
  at most a few events per second per moving thing keeps the shape of a movement, and dropping
  observations is the only permitted way to do it — never averaging them into a position that was
  never read.
- **Why the keyboard is missing, and staying missing.** Every event above describes something the
  pack's own pixels already contain: the replay shows the cursor, the effect of its clicks, and
  every window that moved. A keystroke does not — a password field renders dots — so recording one
  would put information into a pack that its picture never held, and observing one at all requires
  a system-wide keyboard hook. `input.key.*` therefore stays reserved.

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

A payload's contents are the plugin's own business, with one exception: this spec defines the
shape of the well-known `windows-uia` payload ([§11.3](#113-windows-uia-windows-ui-automation)),
because annotation targets ([§8.7](#87-target-semantic-objects)) are picked from it. Everything
in [§11.1](#111-rules) still applies to it unchanged.

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

### 11.3 `windows-uia` (Windows UI Automation)

`plugins/windows-uia/` is the well-known payload for **what was on screen as objects** at the
capture instant on Windows: the top-level window list and the Microsoft UI Automation control
trees of as many of those windows as the writer's budget allowed. It is what makes an
annotation box able to say *"the Save button"* ([§8.7](#87-target-semantic-objects)) instead of
only *"this rectangle"*.

The two arrays are not two halves of one thing — they are two LEVELS, and the difference
matters to a reader:

- `windows` is the **complete, cheap** level. Enumerating top-level windows costs almost
  nothing, so a writer SHOULD list every visible one. This is the level that always has an
  answer, including for the applications below.
- `elements` is the **expensive, partial** level. Walking an automation tree is unbounded work
  against a foreign process, so it is budgeted, and some applications expose no usable tree at
  all: Chromium and Electron windows build one only when an assistive client asks for it, and
  a writer that finds nothing there is looking at a normal, healthy window. Which is why each
  window records what happened to ITS tree (`tree` below) — "no controls were recorded for this
  window" is a statement about the dump, never about the window.

**A rectangle measured for a display the window has left (0.4.0).** A browser paints web
content in a renderer process that carries its own device scale factor. Drag the window from a
150% display to a 100% one and the browser frame re-lays out at once, while the renderer can
still be answering with the OLD display's scale — so UI Automation reports one window in two
coordinate spaces: the toolbar exact to the pixel, the page inside it off by the ratio between
the two displays. Measured in the field: two Chrome windows moved onto a 1200x1920 @1x display
reported web content covering **0.67** and **0.50** of the surface it was drawn into (1/1.5 and
1/2, the two scales involved), while a window that had never left its own display reported
1.00.

**And the damage is not always visible in the writer's own coordinates.** A multi-display
writer maps each rectangle into the snapshot space of the display it is ON
([§5.6](#56-displays-multi-monitor-captures)), choosing per rectangle so that a window
straddling two monitors keeps the children visible on the smaller side. That mapping is
ratio-preserving, so a parent and child mapped through the SAME display can never come out
disagreeing — but a stale rectangle reported in the coordinates of a display the window has
already left falls into the OTHER display's space and is scaled by the other display's factor.
Measured: a Chrome window whose web content covered 1.000 of its host in the writer's raw
coordinates produced 0.497 in the pack. A writer that checks only its raw numbers will pass
that one.

**And a later stage can make an innocent rectangle guilty.** A writer that composes displays,
crops to a selection, or reconciles against a window list will DROP elements — and when the
dropped element was another element's parent, the survivor inherits an ancestor it never had.
Its ratio against that inherited ancestor is meaningless, and measured in the field it read
0.497 while every earlier stage had correctly seen 1.000.

A writer therefore MUST NOT emit a control whose web-content root does not still COVER the
surface it was drawn into, and MUST count what it dropped in `geometry_refused`. A writer that
also OFFERS these controls to a user — a picker, an editor, a hover outline — MUST offer the
same refused set it writes, so that a `target` recorded in `annotations.json` can never name a
rectangle the pack itself declines to list. **The test MUST be applied to the array the writer
serializes** — after every mapping, composition, crop
and reconciliation, not before any of them. Applying it earlier as well is a legitimate
optimisation (a walk that skips a bad subtree does not pay to descend it), but an earlier
application alone is not conformant: no stage before the last can see what the last one
produces. Coverage and
not containment: scrolled content legitimately overflows its viewport, and is correct. A
refusal and not a correction: the ratio proves the numbers are wrong without revealing what the
right ones were. The window itself is unaffected — it was never measured wrongly — so a pick
still lands, one level coarser and in the right place.

Like every plugin payload it is OPTIONAL and purely additive. A pack without it is complete; a
reader that ignores it loses no core data. It follows all of [§11.1](#111-rules).

```
plugins/
└── windows-uia/
    ├── meta.json
    └── elements.json
```

`meta.json` is the standard plugin metadata (`{ "name": "windows-uia", "version": "0.5.0" }`).
Every version has been additive, and an older payload is still valid — read it by treating each
added field as absent (see each row below):

- **0.2.0** added the per-window fields `class_name`, `z`, `tree` and `element_count`, and the
  per-element field `window`.
- **0.3.0** added `display` on both windows and elements: on a multi-display capture each entry
  is now in the snapshot space of the display it is ON, instead of every entry being forced
  through the focused display's coordinate transform. Absent means the focused display, which
  is what a single-display pack writes — so such a payload is byte-identical to 0.2.0.
- **0.4.0** added `geometry_refused` on the payload: how many web-content roots the writer threw
  away for still measuring themselves against a display their window had left (see below).
- **0.5.0** added `client_bounds` on a window: the drawable rectangle inside the frame, beside
  the frame rectangle it qualifies (see below).

**A window's client rectangle (0.5.0).** A frame rectangle says where a window is; it does not
say where the window *draws*. The distance from the frame's top edge to the first drawable row
is the application's chrome — a title bar, a tab strip, an omnibox — and it varies by
application, theme, display scale and window state, so it cannot be assumed, subtracted or
looked up. `client_bounds` is that drawable rectangle, measured, in the same coordinate space as
`bounds`.

It is here because a **document** payload cannot be placed without it. A browser extension
measures a page in viewport CSS pixels ([§11.4](#114-chrome-dom-browser-dom-context)), a space
that says nothing about where the page is on the screen. The client rectangle is what converts
it, and both terms of the conversion are derived rather than assumed: the scale is
`client.width / viewport.width`, and the browser's chrome height is
`client.height - viewport.height * scale`. Neither the frame rectangle nor the control tree can
stand in — the tree reports frames too, and a browser's page is one opaque control inside it.

`client_bounds` is **OPTIONAL, and absent from every payload written before 0.5.0.** It is also
legitimately absent in a 0.5.0 payload: a window that only an automation dump ever saw has no
measured client area, and neither does one whose rectangle had to be reassembled from
per-display slices, where no single drawable rectangle ever existed. **A reader that meets a
window without one MUST decline to place a document element against it** — the same decline it
performed before this field existed. A chrome height guessed from a constant, or a scale derived
from the frame rectangle, would put a page's elements somewhere plausible and wrong, which is
worse than the window rung, which is at least true.

`elements.json`:

| Field | Type | Required | Description |
|---|---|---|---|
| `captured_at` | string | REQUIRED | When the dump was taken — the capture instant. ISO 8601 with timezone, the same shape as `manifest.created_at`. |
| `budget_ms` | integer | REQUIRED | The time budget the dump was given. Reading the UI Automation tree of an arbitrary application is unbounded work, so writers MUST bound it; this records the bound that was used. |
| `truncated` | boolean | REQUIRED | `true` = the dump is INCOMPLETE: a walk ran out of budget, depth, or element allowance, or a window was never walked at all. It is never a reason to distrust the entries that ARE present — an absent element means "not recorded", never "not on screen". `windows[].tree` says precisely which windows are affected. |
| `geometry_refused` | integer | OPTIONAL (0.4.0) | How many web-content roots the writer THREW AWAY because they were still measuring themselves against a display their window had already left (see below). Absent = the writer could not tell, which is every payload before 0.4.0; `0` = it looked and found none. Nonzero means those windows HAVE controls this payload cannot point at, and a reader MUST NOT present them as windows without controls. |
| `windows` | array | REQUIRED | Top-level windows that existed at the capture instant, in z-order (top-most first). MAY be empty. |
| `elements` | array | REQUIRED | Controls from the automation trees of the walked windows: grouped by window in walk order, pre-order within a window. MAY be empty. |

Each entry of `windows`:

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | string | REQUIRED | Window title. MAY be empty. |
| `process` | string | REQUIRED | Process name without extension, e.g. `"chrome"`. Empty when it could not be read. |
| `class_name` | string | REQUIRED (0.2.0) | Win32 window class, e.g. `"Chrome_WidgetWin_1"`. MAY be empty. Absent in a 0.1.0 payload. |
| `display` | integer | OPTIONAL (0.3.0) | WHICH captured display `bounds` is expressed in: a `manifest.media.displays[].index` ([§5.6](#56-displays-multi-monitor-captures)). ABSENT = the focused display, the same rule an annotation's `display` follows ([§8.8](#88-display-which-display-a-box-is-on)). A window is reported on the display it mostly covers; one straddling two displays keeps a single space and simply reaches past that snapshot's edge. |
| `bounds` | object | REQUIRED | `{ x, y, width, height }` — the window FRAME, see the coordinate rule below. |
| `client_bounds` | object | OPTIONAL (0.5.0) | `{ x, y, width, height }` — the window's DRAWABLE area, in the same space as `bounds`, with the title bar and borders removed. Absent = not measured, which is every payload before 0.5.0, every window seen only by an automation dump, and any window whose rectangle was reassembled from per-display slices. A reader with no `client_bounds` for a window MUST decline to place a `chrome-dom` document element against it rather than derive one from `bounds` (see above). |
| `focused` | boolean | REQUIRED | The window that had focus. At most one entry is `true`; a dump that could not determine the foreground window has none. |
| `z` | integer | REQUIRED (0.2.0) | Z-order at the capture instant, `0` = top-most. This is what decides which window covers a given pixel when several overlap. Absent in a 0.1.0 payload, where the array order carries the same information. |
| `tree` | string | REQUIRED (0.2.0) | What happened to THIS window's control tree: `"collected"` (whole tree), `"truncated"` (started, ran out of budget/depth/allowance), `"unavailable"` (walked, exposed no tree), `"skipped"` (never walked). Anything but `"collected"` means a reader MUST NOT conclude anything from the absence of this window's controls. Absent in a 0.1.0 payload, where only the focused window was ever walked. |
| `element_count` | integer | REQUIRED (0.2.0) | How many entries of `elements` belong to this window. Absent in a 0.1.0 payload. |

Each entry of `elements`:

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | REQUIRED | UIA `Name`. MAY be empty. |
| `control_type` | string | REQUIRED | UIA `ControlType` without the `ControlType.` prefix, e.g. `"Button"`. MAY be empty. |
| `automation_id` | string | REQUIRED | UIA `AutomationId`. MAY be empty. |
| `class_name` | string | REQUIRED | Win32 window class. MAY be empty. |
| `display` | integer | OPTIONAL (0.3.0) | The display `bounds` is expressed in, exactly as on a window above — and ALWAYS the same display as the window this control was walked from, since a control and its window MUST be resolvable in one coordinate space. |
| `bounds` | object | REQUIRED | `{ x, y, width, height }` — see the coordinate rule below. |
| `depth` | integer | REQUIRED | Depth in its window's control tree; `0` is that window itself. |
| `window` | integer | REQUIRED (0.2.0) | The `z` of the window this control was walked from. Absent in a 0.1.0 payload, where every element belongs to the focused window. |

Unlike `target` ([§8.7](#87-target-semantic-objects)), these fields are REQUIRED but MAY be
empty strings: this is a dump, and an empty `name` is itself information.

- **Coordinates.** Every rectangle in this payload — `bounds` on either array, and a window's
  `client_bounds` — is in **snapshot pixel coordinates**, the
  same space as `annotations.json` ([§8.2](#82-coordinate-space)), of the display its `display`
  field names, i.e. the pixels of that display's snapshot, and of `snapshot.png` itself when
  `display` is absent ([§5.6](#56-displays-multi-monitor-captures)). Writers MUST convert from
  the OS's virtual-desktop coordinates, accounting for display scaling and the virtual desktop's
  origin, and SHOULD do so PER DISPLAY: a single transform for the whole desktop leaves every
  screen but one holding rectangles that match no image. An entry on a display the capture did
  not freeze, and any entry of a 0.2.0 payload that was on another display, therefore lands
  outside the snapshot rectangle — possibly at negative coordinates. Such entries are valid and
  MUST NOT be dropped by readers: they describe the rest of the desktop.
- **Occlusion is `z`, not order of discovery.** Windows overlap, and `bounds` alone cannot say
  which one a pixel belongs to. A reader resolving "what is at (x, y)" MUST consider the
  window with the lowest `z` that contains the point, and MUST NOT offer a control of a window
  that another window covers at that point. The focused window was on top by definition. A
  point belongs to ONE display, so this resolution runs over the entries of THAT display
  (`z` is desktop-wide and remains comparable across them).
- **Silence is not absence.** `elements` covers only the windows whose `tree` is `"collected"`
  or `"truncated"`. For any other window the payload says nothing about its contents, and a
  reader MUST report that as *no data recorded*, never as *no objects*. Presenting a window
  with no recorded controls as an empty application is the one misreading this payload can
  cause.
- **One instant.** The payload describes the capture instant only. It says nothing about any
  other position in the replay, and it is never updated when annotations change.
- **Not authoritative for annotations.** An annotation's geometry always comes from
  `annotations.json`. This payload is context, and a `target` on a box is self-contained — the
  two are matched by a reader that wants more detail, never required to agree.

### 11.4 `chrome-dom` (browser DOM context)

`plugins/chrome-dom/` is the well-known payload for **what the user clicked in a browser**,
as the page itself understood it: a selector, a role, the text on it, and the URL it was on.
It is the browser's answer to the same question [§11.3](#113-windows-uia-windows-ui-automation)
answers for windows — a pack should be able to say "the Save button, `#save`, on the checkout
page", which is a sentence a person and a machine can both act on, where a screenshot of a
button is neither.

Written by CapturePack's browser extension over protocol v1. Like every plugin payload it is
OPTIONAL and purely additive, and it follows all of [§11.1](#111-rules).

**Payload 0.2.0 adds `document` on a pick:** the interface the picked element sat in — every
element the user could SEE in the top document at that instant, each with its role, its
rectangle in viewport CSS pixels, and its own visible text. `viewport` gives the space those
rectangles are in, exactly as the pick's own `viewport` does.

A `document` records only what the picture already shows, and the rule is not a courtesy — it
is the whole justification for recording page text at all. `snapshot.png` contains the pixels
a reader could read anyway, so writing the words down adds no exposure the pack did not
already have; that argument covers nothing beyond what was on the glass. Writers therefore
MUST NOT record:

- anything outside the viewport, which is outside the picture;
- the value of any `input`, `textarea` or `select` — a half-typed password or a card number
  may be dots on screen and characters in the document;
- anything about a `type="password"` field beyond its presence and position, its own `name`,
  `id` and `placeholder` included, because those can name the account it belongs to;
- the text of an element the user could not see — a collapsed panel, a closed menu;
- attributes outside a declared allowlist, because `data-*` routinely carries tokens.

A writer MAY record whether a field held something (`filled`), which is visible on the glass
and is frequently the whole bug, and MUST NOT record what it held.

**`omitted` is REQUIRED in a `document`** and is the payload's own statement of the above: a
reader learns what is missing without reading the writer's source. A reader MUST treat an
absent `document` as "nobody looked" rather than "the page was empty", and MUST treat
`truncated: true` as "this is a prefix of the page". Neither is a defect; both are the
difference between silence and evidence that [§11.3](#113-windows-uia-windows-ui-automation)
already draws for windows.

A pick made inside an iframe carries its element and no `document`: the snapshot belongs to
the frame whose client rectangle a reader can place, which is the top one.

**`age_ms` (payload 0.3.0) is REQUIRED on an event in a still-image pack** and MUST NOT be
written in a replay pack. A still describes ONE instant, so every event it carries is stamped
`t_ms: 0` — and without the age, a pick made seconds before the shutter is indistinguishable
from one made at it. The page may have changed in between, so the distance is the reader's to
weigh and the writer's to state. A writer SHOULD bound how far back a still looks at all;
CapturePack uses ten seconds, the reach of the picker's own two-click gesture, and simply does
not claim an older pick. In a replay pack `t_ms` already carries the time and `age_ms` would be
a second answer to one question.

```
plugins/
└── chrome-dom/
    ├── meta.json
    └── elements.json
```

`meta.json` is the standard plugin metadata (`{ "name": "chrome-dom", "version": "0.3.0" }`).

`elements.json`:

| Field | Type | Required | Description |
|---|---|---|---|
| `protocol` | integer | REQUIRED | The wire protocol the events were received over. `1` is the only version defined. |
| `extension_version` | string \| null | REQUIRED | The extension that sent them, or `null` when it never introduced itself. A reader comparing this against `generator.version` is doing the version check the app does. |
| `events` | array | REQUIRED | The events inside the replay, in arrival order. MAY be empty only if the payload is absent — a writer with nothing to say writes no directory at all ([§11.3](#113-windows-uia-windows-ui-automation)'s rule: silence is not absence). |

Each event:

| Field | Type | Required | Description |
|---|---|---|---|
| `t_ms` | number | REQUIRED | When it happened, on the **replay clock** ([§10.1](#101-structure)) — the same clock the video and the tracking samples use, so a DOM element and the window it was in can be named at one instant. |
| `age_ms` | number | REQUIRED in a still (0.3.0) | Milliseconds between this event and the captured instant. MUST NOT appear in a replay pack — see above. |
| `type` | string | REQUIRED | `dom.element.selected`, `dom.document.captured`, `tab.updated`, or `url.changed`. Readers ignore types they do not know. |
| `tab` | object | REQUIRED | `url` and `title`, both strings. |
| `element` | object | OPTIONAL | REQUIRED for `dom.element.selected`, absent otherwise. `tag`, `selector` and `bounds` (`x`/`y`/`width`/`height`) are required; `id`, `role` and `text` are written only when the page had them. |
| `viewport` | object | OPTIONAL | Where the page's coordinate space was: `width`, `height` and `dpr` are required when present, and `screenX`, `screenY`, `outerWidth`, `outerHeight` are the browser's own report of its window and MAY be `null`. Without this an event's rectangles cannot be placed at all — see the placement rule below. |
| `document` | object | OPTIONAL (0.2.0) | The whole interface that was visible, when the writer looked. Absent means NOBODY LOOKED, never that the page was empty. |

Each `document`:

| Field | Type | Required | Description |
|---|---|---|---|
| `viewport` | object | REQUIRED | `width`, `height`, `device_pixel_ratio`, `scroll_x`, `scroll_y` — all numbers. The space every `elements[].bounds` below is measured in. |
| `url` | string | REQUIRED | The document's own URL, which MAY differ from `tab.url`. |
| `title` | string | REQUIRED | The document's title. MAY be empty. |
| `elements` | array | REQUIRED | One entry per element the writer recorded: `i` (its ordinal), `tag`, `role` and `bounds` are required; `id`, `class`, `name`, `type`, `placeholder`, `alt`, `title`, `href`, `text`, `filled` and `secret` are written only when the page had them and the rules above allow them. MAY be empty. |
| `truncated` | boolean | REQUIRED | `true` = the walk hit its element cap, so this is a PREFIX of the page. |
| `visited_count` | integer | REQUIRED | How many nodes the walk visited, including those it did not record. |
| `elapsed_ms` | number | REQUIRED | How long the walk took. |
| `omitted` | array | REQUIRED | The writer's own statement of what it refused to record — see above. |

**Field names are the file's, not the wire's.** Every compound name in this payload is
`snake_case`, like every other field CapturePack persists: `device_pixel_ratio`, `scroll_x`,
`scroll_y`, `visited_count`, `elapsed_ms`. The protocol a browser extension speaks is a private
matter between a writer and its own extension and is not this document's business — but a reader
of a PACK reads the names above, and a reader that knows only its own extension's spelling will
find the viewport absent and, if it obeys the rule below, refuse every document in every pack it
is given. That is not hypothetical: it is how 6,091 recorded element rectangles across one
capture folder turned out to be unreadable while live capture worked perfectly.

**The DOM is never streamed.** These are the moments something was picked or the page changed,
not a feed — a pack holds a handful of them, not a recording.

**Placing a page on the picture.** Every rectangle here — `element.bounds` and every
`document.elements[].bounds` — is in **viewport CSS pixels**, not snapshot pixels: it locates
the element within its document and is not a rectangle to draw on a frame. Converting one needs
two things this payload does not contain: the viewport's own size and device pixel ratio (the
`viewport` object above) and the browser window's DRAWABLE rectangle, which a reader takes from
`plugins/windows-uia`'s `client_bounds`
([§11.3](#113-windows-uia-windows-ui-automation)). The scale is
`client.width / viewport.width` and the browser's chrome height is
`client.height - viewport.height * scale` — both measured, neither assumed. **A reader missing
either half MUST decline to place the element** rather than assume a device pixel ratio or a
chrome height; a rectangle drawn from a guess is indistinguishable from a measured one and is
wrong. Declining costs the reader the document rung and keeps the window, which is at least
true.

---

## 12. Generated document views

Four generated, audience-specific views live beside the source files. All four are OPTIONAL
(RECOMMENDED for every pack that will be shared), all four are **generated views, not sources of
truth**: regenerating them from the source files SHOULD produce an equivalent result, writers
SHOULD regenerate them on every save, and readers MUST NOT treat any of them as authoritative
when they disagree with the JSON. Display numbers appearing in any of them MUST come from the
rule of [§8.5](#85-display-numbers).

| File | Audience | Job |
|---|---|---|
| `report.md` | Humans *and* LLMs | The narrative of the capture: note, environment, annotations, files. |
| `README.md` | Humans first | The folder's front door: what this is, what happened, how to use it. |
| `skills/*.md` | LLMs first | Focused context documents an AI can consume directly, without MCP. |
| `viewer.html` | Humans first | A double-clickable, server-free view with declared media and context. |

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

## Annotated keyframes

{one line per keyframe (SPEC §5.7), as a markdown image so any Markdown reader — and any LLM —
sees the annotated frames without decoding video:}

- **{t_ms as mm:ss.mmm}** — ![Keyframe {NN} at {mm:ss.mmm}]({file})

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

## Annotated keyframes

- **00:21.750** — ![Keyframe 1 at 00:21.750](frames/frame-01_00-21.750.png)
- **00:22.750** — ![Keyframe 2 at 00:22.750](frames/frame-02_00-22.750.png)
- **00:26.900** — ![Keyframe 3 at 00:26.900](frames/frame-03_00-26.900.png)

## Files

- manifest.json — pack identity, environment, inventory
- snapshot.png — captured frame, 2560×1440 (original pixels)
- replay.webm — last 28.4 s before capture (original evidence)
- replay_annotated.webm — the replay with the 3 boxes rendered in
- frames/ — 3 annotated stills, one per annotation state change
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
4. **Annotated keyframes** — the stills of [§5.7](#57-keyframes-annotated-stills) as markdown
   images with their timestamps, when the pack has them. The story is visible before the reader
   opens anything.
5. **Files** — one line per file in the folder, saying what each is (mark the originals as
   never-modified, the annotated replay as the watchable result).
6. **How to use** — e.g.:
   1. Watch `replay_annotated.webm` (or open `snapshot.png`).
   2. Or read the stills in `frames/` — no video decoding needed.
   3. Read `report.md` for the full narrative.
   4. AI: read `skills/`, or connect through a CapturePack MCP server.

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
| `skills/overview.md` | Whole-pack summary: what happened, where to look first, counts (annotations, events, plugins), whether blur is present. SHOULD embed the annotated keyframes ([§5.7](#57-keyframes-annotated-stills)) as markdown images — an LLM then reconstructs the capture from this one file. |
| `skills/timeline.md` | Video packs only: the timeline narrated, with notable events in order. MUST be absent from an explicit image pack. |
| `skills/annotation.md` | Every annotation box: display number (when numbered), text, bounds, lifetime, blur flag — plus a one-line statement of the numbering rule. |
| `skills/dom.md` | DOM/semantic object metadata when a browser or UIA plugin contributed it; otherwise a one-line "no DOM metadata in this pack" so the LLM stops looking. |
| `skills/project.md` | What a CapturePack is and how this folder is laid out — for a model that has never seen the format. |

Writers MAY add further documents under `skills/`; readers MUST ignore names they do not know.
Like every generated view, `skills/` documents are regenerated on save and are never
authoritative over the JSON files.

### 12.4 viewer.html

`viewer.html` is the fixed-name offline browser view introduced in format 0.5.0. Its presence is
its declaration. It is OPTIONAL: a pack without it remains fully valid, and an older reader
ignores it as an unknown file.

The viewer is generated from the same manifest, annotations, timeline and plugin inventory as
the other documents. It MUST be regenerated when those sources change, including after a late
plugin declaration or a background render declaration. It is never authoritative over those
sources. If generation fails, the writer MUST preserve the source pack and MUST NOT leave an
older `viewer.html` describing a previous revision.

A conforming `viewer.html`:

- works when opened directly with `file://`; it needs no application install, local server,
  account, login or network;
- is a self-contained HTML document with inline presentation, no external fonts, stylesheets,
  scripts, frames, APIs, CDN assets or `fetch`;
- uses only safe pack-relative paths for media it renders and never constructs a path from `..`,
  an absolute path, a drive path, a URL scheme or an undeclared media guess;
- HTML-escapes every user- or plugin-controlled string, including title, note, annotation text,
  target fields and plugin inventory;
- renders only artifacts declared by `manifest.json`: annotated media first, then the declared
  original as an explicitly unannotated fallback; it MUST NOT advertise a pending or merely
  conventional filename as if it existed;
- presents image/video capture kind, environment, note, native video controls, declared
  keyframes, annotations with display and target context, per-display media, plugins and a file
  inventory; legacy packs degrade to the evidence they actually declare;
- distinguishes original evidence from derived annotated views; and
- visibly warns that the viewer is not a sanitized share. If any annotation has `blur: true`,
  it MUST state that blur applies only to derived views and that `snapshot.png` and original
  replay media can still contain sensitive pixels.

The document SHOULD use the pack language for its short labels through the same localization
layer as `report.md`, `README.md` and `skills/`. Native controls, semantic HTML, readable focus
styles, wrapping long strings and a layout that remains usable at 390 CSS pixels are
RECOMMENDED.

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

`number_pin` ([§8.3](#83-the-box)) was introduced in 0.2.1 as an integer 1-9 and widened to any
integer ≥ 1 in **0.2.2**. A patch, not a minor: 0.2.1 already defined a pin outside its range as
ignored, so a 0.2.1 reader meeting a pin of `12` does exactly what 0.2.1 told it to and still
computes a valid, contiguous sequence — and nothing on disk changes shape. No writer needs to
declare 0.2.2 to use it.

`capture_kind` was introduced in 0.3.0. A writer that emits it MUST declare
`format_version` 0.3.0 or later, and new writers MUST include it for both image and video
captures. Readers and validators MUST continue accepting existing manifests where it is absent,
including early 0.3.0 RC packs that used authored keyframes before `capture_kind` was written. A
replay filename establishes legacy video evidence, while a null replay alone is intentionally
ambiguous.

The optional capture-provenance members of `media.cadence` and
`media.displays[].cadence` (`requested_fps`, `backend`, `quality`, and
`recorder_count`) were introduced in 0.4.0. A writer that emits any of them MUST declare
`format_version` 0.4.0 or later. Packs that have only the 0.2.0 achieved-cadence fields keep
their older version; readers that do not understand the provenance ignore those optional
members and still read the replay.

The fixed-name optional `viewer.html` generated view was introduced in 0.5.0. A writer that
includes it MUST declare `format_version` 0.5.0 or later. Its absence is normal and never makes a
pack invalid.

The optional `source_latency` member of `media.cadence` and `media.displays[].cadence` was
introduced in 0.6.0. A writer that emits it MUST declare `format_version` 0.6.0 or later. Its
absence is normal and always will be: the measurement requires the desktop to move while the
calibration watches, and a capture of a still screen has nothing to measure against. Readers that
do not understand it ignore it and still read the replay and its cadence.

**0.7.0 makes `media.displays` REQUIRED for a video capture and adds `snapshot_width` /
`snapshot_height` to every entry** ([§5.6](#56-displays-multi-monitor-captures)). A writer that
declares the array — which every conforming video writer now must — MUST declare
`format_version` 0.7.0 or later, and MUST populate the two new fields from the raster it actually
wrote. This is the one place the pre-1.0 rule above needs spelling out, because "minor acts as
major" makes it look like a break and it is not:

- **Old readers keep working.** `media.snapshot` and `media.replay` are still REQUIRED and still
  mean exactly what they meant; 0.7.0 only says out loud that they are the focused display's
  files. A 0.5.0 reader opening a 0.7.0 pack reads the same snapshot and the same replay it
  always did, and ignores an array it does not know — which is what §13.1 has always required of
  it.
- **What 0.7.0 binds is WRITERS.** A writer MUST NOT omit `displays` to mean "one display", and
  MUST NOT compute `snapshot_width`/`snapshot_height` from `bounds × scale`.
- **New readers MUST still accept old packs.** A reader built for 0.7.0 MUST accept a pack that
  predates it and carries no `media.displays`, and MUST read it as a **single-display pack whose
  one display is the focused one**: `snapshot.png` is that display's snapshot,
  `annotations.json`'s `reference_width`/`reference_height` are its frame, and every box belongs
  to it. Refusing such a pack, or reporting it as malformed, is a bug in the reader.
- **Image packs are unaffected**, at 0.7.0 as before: they declare no `media.displays` because
  they ship no per-display raster, so they keep declaring the oldest version that expresses them.

**0.8.0 lets a writer emit `input.mouse.*` and `input.window.*` timeline events**
([§10.2](#102-event-namespaces)). A writer that emits one MUST declare `format_version` 0.8.0 or
later; a pack whose timeline carries none keeps its older version, which is the general rule
above applied to a capture in which nothing moved. This is additive in the strictest sense: since
0.1.0 readers have been REQUIRED to skip event types they do not know, so a 0.7.0 reader opening
a 0.8.0 pack reads exactly the timeline it always read and loses nothing it ever had.
**`input.key.*` is not part of this and is not scheduled.** It remains reserved and unemitted at
0.8.0, deliberately and for the reason §10.2 states, so a reader may continue to treat any
`input.key.*` event it meets as a pack that broke the rules.

**Readers MUST accept unknown optional fields and unknown files.** Forward compatibility is a
requirement, not a courtesy:

- Unknown JSON fields anywhere: ignore them; preserve them when rewriting. (This includes the
  reserved `tracking` contents of [§8.3](#83-the-box) and any `target` whose `source` the reader
  does not know, [§8.7](#87-target-semantic-objects).)
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
9. **Prefer images over video when you cannot decode video.** If `media.keyframes` is present,
   its stills already carry the annotations at every state change
   ([§5.7](#57-keyframes-annotated-stills)); if it is absent, fall back to `snapshot.png` +
   `annotations.json` and draw the boxes yourself.
10. **Read object metadata as a bonus, never as a requirement.** A box's `target`
    ([§8.7](#87-target-semantic-objects)) tells you *what* it points at, and
    `plugins/windows-uia/` ([§11.3](#113-windows-uia-windows-ui-automation)) describes the
    windows and controls at the capture instant. Both are optional and describe one instant:
    render every box from `bounds` alone, ignore a `target` whose `source` you do not know, and
    treat a pack without either as complete.

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
- [`docs/schemas/share.schema.json`](docs/schemas/share.schema.json) — the separate Share Copy inventory

The manifest schema models the capture-kind, still-image, capture-diagnostics and measured
source-latency media rules defined through 0.6.0 when `capture_kind` is present. It also accepts existing manifests without that discriminator,
including early 0.3.0 RC packs; compatibility does not make a null replay unambiguous. The
annotation and timeline schemas validate the fields and discriminator values they explicitly
define. All three deliberately allow unknown properties — forward compatibility
([§13](#13-versioning-and-compatibility)) requires readers to accept additive data they do not
know. A pack using a newer annotation or event *type* can therefore fail the corresponding schema
while still being readable under the defensive-reading rules.

JSON Schema cannot verify archive inventory, image dimensions, declared-file existence, ordering
across arrays, or every cross-file relationship. Those requirements remain normative in the prose
and in a full-pack validator.

Where the prose of this specification and the schemas disagree, the prose wins.
