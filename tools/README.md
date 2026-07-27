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

  PASS  container: standard ZIP, 5 entries, store/deflate only, not encrypted (SPEC §3.1)
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
  note, as §3.1 allows readers to do. The extracted directory form is equally
  valid input.
- **Required files** (SPEC §4–6): `manifest.json` parses as UTF-8 JSON without
  BOM; `snapshot.png` is a real PNG (signature + IHDR).
- **Manifest** (SPEC §5): `format` marker, semver `format_version`, UUID `id`,
  ISO 8601 `created_at` with timezone, `generator`, `environment`, `media`
  field shapes; nullable rules (`null` only where the spec allows it).
- **Media consistency** (SPEC §5.3, §7): declared replay exists; no undeclared
  or second replay file; `replay_duration_ms` coupled to `replay`;
  `snapshot_t_ms` (frame-accurate snapshot, §7.1) is an integer >= 0, with a
  note when it has no replay to anchor to or exceeds the replay duration.
- **Plugins** (SPEC §5.4, §11): name pattern, `path` exactly
  `plugins/<name>/`, `meta.json` present and matching the declaration.
  Undeclared plugin directories are ignored with a note.
- **annotations.json** (SPEC §8): reference dimensions equal the actual
  snapshot dimensions; per-type geometry (rect/blur `w`,`h` > 0, etc.), unique
  ids, color format; `t_ms` (replay position, §8.3) is a number, with a note
  when the pack has no replay or the value lies outside
  `[0, replay_duration_ms]`. Lifetime intervals (`t_start_ms`/`t_end_ms`,
  §8.3 "Annotation lifetime"): both must be numbers with
  `t_start_ms <= t_end_ms` (FAIL otherwise), with a note when a bound lies
  outside `[0, replay_duration_ms]`, when the anchor `t_ms` lies outside the
  lifetime, when only one bound is present, or when a lifetime appears in a
  pack without a replay. Unknown annotation types are skipped with a note.
- **timeline.json** (SPEC §10): `t0` with timezone, events sorted ascending by
  `t_ms`, namespaced event types, `source` matching the namespace, `input.*`
  rejected (reserved for V2), plugin events matching declared plugins.
- **Forward compatibility** (SPEC §13): unknown files, unknown fields, unknown
  annotation/event types, and undeclared plugin directories never fail a pack —
  they are reported as `NOTE` lines and otherwise ignored, exactly as the spec
  requires of readers.

`report.md` is noted but not content-checked: per SPEC §12 it is a generated
view, never the source of truth.

### Notes

- Validation is against format **0.1.0**. Packs declaring another
  `format_version` are still checked under 0.1.0 rules, with a note (pre-1.0,
  the minor version acts as the major — SPEC §13.1).
- ZIP64 archives are rejected; packs are small by design and never need it.
