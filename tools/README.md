# tools

## validate-capturepack.mjs

A dependency-free validator for CapturePack files, checking a pack against
[SPEC.md](../SPEC.md) (format 0.1.0). It exists to prove the format's core
promise: a pack can be generated *and checked* from any language, with nothing
but a standard library — this validator uses only Node built-ins (`node:fs`,
`node:zlib`), zero npm dependencies, and even reads ZIP archives itself
(end-of-central-directory + central directory + `inflateRawSync`).

### Requirements

- Node.js 18 or newer. Nothing to install.

### Usage

Both forms of a pack (SPEC §3) are accepted:

```
# extracted directory form
node tools/validate-capturepack.mjs examples/minimal

# zipped form (.capturepack or .zip)
node tools/validate-capturepack.mjs examples/minimal.capturepack
```

Output is one line per check, then a summary:

```
capturepack validator (spec 0.1.0)
input: examples/minimal.capturepack

  PASS  container: standard ZIP, 11 entries, store/deflate only, not encrypted (SPEC §3.1)
  PASS  manifest.json: present at the pack root
  ...
  NOTE  extra.txt: unknown file — ignored (readers MUST ignore unknown files, SPEC §13.1)

result: VALID — 18 passed, 0 failed, 1 note(s)
```

Exit codes: `0` valid, `1` invalid, `2` usage or unreadable input.

### What it checks

- **Container** (SPEC §3): standard ZIP, store/deflate only, not encrypted or
  split, entry names safe (`/` separators, no `..`, no absolute paths), CRC-32
  intact. A single wrapping top-level directory is accepted defensively, with a
  note, as §3.2 allows readers to do. The extracted directory form — the
  primary, folder-first form of a pack — is equally valid input.
- **Required files** (SPEC §4–6): `manifest.json` parses as UTF-8 JSON without
  BOM; `snapshot.png` is a real PNG (signature + IHDR).
- **Manifest** (SPEC §5): `format` marker, semver `format_version`, UUID `id`,
  ISO 8601 `created_at` with timezone, `generator`, `environment`, `media`
  field shapes; nullable rules (`null` only where the spec allows it).
- **Media consistency** (SPEC §5.3, §7): declared replay exists; no undeclared
  or second replay file; `replay_duration_ms` coupled to `replay`;
  `replay_annotated` (the annotated replay, §7.2) matches
  `replay_annotated.(webm|mp4)` and requires a replay (FAIL when declared on a
  screenshot-only pack); a *declared but missing* annotated replay is only a
  NOTE — it may still be rendering in the background, and is always
  regenerable from `replay` + `annotations.json`; `snapshot_t_ms`
  (frame-accurate snapshot, §7.1) is an integer >= 0, with a note when it has
  no replay to anchor to or exceeds the replay duration.
- **Per-display media** (SPEC §5.6): when `media.displays` is present (a
  multi-monitor capture), every declared `snapshot-d<N>.png` /
  `replay-d<N>.webm` exists in the pack, `index` values are integers >= 1 and
  unique (a note when an index has no `environment.screens` entry), `bounds`
  and `scale` are well-formed, exactly one entry is `focused: true`, and that
  entry repeats the top-level `snapshot`, `replay`, and `replay_duration_ms`
  rather than declaring its own files. A display with `replay: null` is a
  NOTE, never a failure; a trimmed replay alongside non-focused replays gets a
  clock-alignment note.
- **Annotated keyframes** (SPEC §5.7, §7.3): when `media.keyframes` is present,
  every entry is `{ file, t_ms }` with an integer `t_ms >= 0`, the array is
  ordered by `t_ms` ascending (FAIL otherwise), each `file` matches
  `frames/frame-<NN>_<MM-SS.mmm>.png` with `NN` equal to the entry's 1-based
  position (FAIL otherwise; a filename whose time disagrees with `t_ms` is only
  a NOTE — `t_ms` is what readers use), and every declared still exists in the
  pack and is a real PNG. Unlike a declared-but-missing annotated replay, a
  missing still is a FAIL: the declaration is written *after* the files. Notes
  cover a still past the replay end, a repeated `t_ms` (state changes within
  ~300 ms should merge), a non-zero `t_ms` in a screenshot-only pack (which has
  exactly one still at 0), and stills whose pixel size differs from
  `snapshot.png`. Undeclared PNGs under `frames/` are ignored with their own
  note.
- **Plugins** (SPEC §5.4, §11): name pattern, `path` exactly
  `plugins/<name>/`, `meta.json` present and matching the declaration.
  Undeclared plugin directories are ignored with a note. Plugin payload
  *contents* are plugin-defined and unchecked, with one exception:
- **plugins/windows-uia/** (SPEC §11.3), the well-known capture-instant object
  dump, is shape-checked when declared: `elements.json` must exist and be an
  object with an ISO-8601-with-timezone `captured_at`, a positive integer
  `budget_ms`, a boolean `truncated`, and `windows`/`elements` arrays (either
  MAY be empty). Every window needs string `title`/`process`, a boolean
  `focused`, and numeric `bounds`; **more than one focused window FAILS** (only
  one window had focus). Every element needs string `name`/`control_type`/
  `automation_id`/`class_name` — which MAY be empty, this is a dump — a
  non-negative integer `depth`, and numeric `bounds`. Notes cover
  `truncated: true` (the tree is incomplete; an absent element means "not
  recorded", never "not on screen") and a dump with no windows and no elements.
  A malformed payload never affects the annotation results — object data is
  additive.
- **annotations.json** (SPEC §8, unified **box** model): reference dimensions
  equal the actual snapshot dimensions; `annotation_id` matches
  `^ann_[0-9a-f]{6}$` and is unique; `bounds` is `{x, y, width, height}` with
  `width`/`height` > 0 (a note when the box lies entirely outside the
  coordinate space); `text` a string; `numbered`/`blur` booleans; `tracking`
  an object with boolean `enabled` (a note when `enabled` is `true` — reserved
  in 0.1.0); `style.color` hex. A `target` (§8.7 — the real UI object the box
  was placed on) must be an object with a non-empty string `source`; for
  `source: "uia"` the `name`/`control_type`/`automation_id`/`class_name` fields
  must be strings when present, with a NOTE on an empty one (a property the
  element had no value for is omitted, not written empty) and a NOTE for a
  `source` value 0.1.0 does not define. A PASS line lists the boxes carrying a
  UIA target. Lifetimes
  (`start_ms`/`end_ms`, §8.4): both bounds or neither (FAIL otherwise),
  `start_ms <= end_ms` (FAIL otherwise), notes when a bound lies outside
  `[0, replay_duration_ms]` or a lifetime appears without a replay. Display
  numbers are recomputed by the §8.5 rule and printed as a PASS line — they
  are never stored in the pack. The five legacy pre-release type names
  (`pin`, `arrow`, `rect`, `blur`, `text`) **FAIL** with a legacy-type
  message; other unknown types are skipped with a note. When any box is
  marked blur, a NOTE reminds that the originals are never redacted (§9).
- **timeline.json** (SPEC §10): `t0` with timezone, events sorted ascending by
  `t_ms`, namespaced event types, `source` matching the namespace, `input.*`
  rejected (reserved for V2), plugin events matching declared plugins.
- **Generated views** (SPEC §12): `report.md`, `README.md`, and `skills/` are
  PASS lines when present and NOTE lines when absent — RECOMMENDED, never
  required. Missing well-known `skills/` documents (overview, timeline,
  annotation, dom, project) get a single note. None of them is
  content-checked: they are generated views, never the source of truth.
- **Forward compatibility** (SPEC §13): unknown files, unknown fields, unknown
  annotation/event types, extra `skills/` documents, and undeclared plugin
  directories never fail a pack — they are reported as `NOTE` lines and
  otherwise ignored, exactly as the spec requires of readers.

### Notes

- Validation is against format **0.1.0**. Packs declaring another
  `format_version` are still checked under 0.1.0 rules, with a note (pre-1.0,
  the minor version acts as the major — SPEC §13.1).
- ZIP64 archives are rejected; packs are small by design and never need it.
