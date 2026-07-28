#!/usr/bin/env node
/**
 * validate-capturepack.mjs — dependency-free CapturePack validator.
 *
 * Validates a pack against SPEC.md (format 0.1.0). Accepts either form of a
 * pack (SPEC §3): an extracted directory, or a `.capturepack` / `.zip` file.
 * ZIP reading is implemented here directly (end-of-central-directory + central
 * directory + node:zlib inflateRawSync) — no npm dependencies, Node 18+ only.
 *
 * Usage:  node tools/validate-capturepack.mjs <pack-dir | pack.capturepack>
 * Exit:   0 = valid, 1 = invalid, 2 = usage/IO error.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

const SPEC_VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Result collection
// ---------------------------------------------------------------------------

const results = []; // { status: "pass" | "fail" | "note", text }
const pass = (text) => results.push({ status: "pass", text });
const fail = (text) => results.push({ status: "fail", text });
const note = (text) => results.push({ status: "note", text });

// ---------------------------------------------------------------------------
// Small validators
// ---------------------------------------------------------------------------

const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// ISO 8601 date-time; a timezone designator (Z or +-HH:MM) is REQUIRED (SPEC §5.1).
const ISO_TZ_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const COLOR_RE = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const PLUGIN_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const EVENT_TYPE_RE = /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/;
const REPLAY_RE = /^replay\.(webm|mp4)$/;
const REPLAY_ANNOTATED_RE = /^replay_annotated\.(webm|mp4)$/;
// Per-display media of a multi-monitor capture (SPEC §5.6). The focused entry
// repeats the top-level names instead of using these.
const DISPLAY_SNAPSHOT_RE = /^snapshot-d[1-9][0-9]*\.png$/;
const DISPLAY_REPLAY_RE = /^replay-d[1-9][0-9]*\.(webm|mp4)$/;
// Annotated keyframe stills (SPEC §5.7): frames/frame-<NN>_<MM-SS.mmm>.png,
// NN = the 1-based position in media.keyframes, MM-SS.mmm = its t_ms.
const KEYFRAME_FILE_RE = /^frames\/frame-(\d{2,})_(\d{2,})-(\d{2})\.(\d{3})\.png$/;
// The same rule for ONE display's own stills (SPEC §5.6): frames-d<N>/…, and
// its own annotated replay. Built per display so the index in the path is
// checked against the entry that declares it.
const displayKeyframeRe = (index) =>
  new RegExp(`^frames-d${index}/frame-(\\d{2,})_(\\d{2,})-(\\d{2})\\.(\\d{3})\\.png$`);
const displayAnnotatedRe = (index) => new RegExp(`^replay_annotated-d${index}\\.(webm|mp4)$`);
const ANNOTATION_ID_RE = /^ann_[0-9a-f]{6}$/;
// Annotation type names from pre-release drafts of 0.1.0. The unified box model
// replaced them before release; a pack that still uses one was written against
// a draft, not against format 0.1.0 — that is a FAIL, not an unknown type.
const LEGACY_ANNOTATION_TYPES = new Set(["pin", "arrow", "rect", "blur", "text"]);
const SKILLS_DOCS = ["overview.md", "timeline.md", "annotation.md", "dom.md", "project.md"];

const isStr = (v) => typeof v === "string";
const isInt = (v) => Number.isInteger(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function isIsoWithTz(s) {
  return isStr(s) && ISO_TZ_RE.test(s) && !Number.isNaN(Date.parse(s));
}

// ---------------------------------------------------------------------------
// CRC-32 (for ZIP entry integrity)
// ---------------------------------------------------------------------------

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Minimal ZIP reader (SPEC §3.1: store/deflate only, no encryption, no spans)
// ---------------------------------------------------------------------------

function entryNameProblem(name) {
  if (name.length === 0) return "empty entry name";
  if (name.includes("\\")) return "uses '\\' — entry names MUST use '/' as the path separator";
  if (name.startsWith("/")) return "absolute path — entry names MUST be relative";
  if (/^[A-Za-z]:/.test(name)) return "begins with a drive letter";
  if (name.split("/").includes("..")) return "contains a '..' segment (zip-slip)";
  return null;
}

/** Returns { files: Map<name, Buffer>, dirs: Set<string>, count } or throws. */
function readZip(buf) {
  // Locate the end-of-central-directory record (sig PK\x05\x06), scanning
  // backwards over a possible archive comment (max 65535 bytes).
  let eocd = -1;
  const stop = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a ZIP archive (no end-of-central-directory record)");

  const diskNo = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (diskNo !== 0 || cdDisk !== 0) throw new Error("split/spanned archive — MUST NOT be used (SPEC §3.1)");
  if (totalEntries === 0xffff || cdOffset === 0xffffffff) throw new Error("ZIP64 archive — not supported by this validator");

  const files = new Map();
  const dirs = new Set();
  let p = cdOffset;
  for (let n = 0; n < totalEntries; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`corrupt central directory at entry ${n}`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const expectedCrc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;

    const problem = entryNameProblem(name);
    if (problem) throw new Error(`entry "${name}": ${problem}`);
    if ((flags & 0x0001) !== 0) throw new Error(`entry "${name}" is encrypted — MUST NOT be (SPEC §3.1)`);
    if (name.endsWith("/")) { dirs.add(name.replace(/\/+$/, "")); continue; }
    if (method !== 0 && method !== 8) {
      throw new Error(`entry "${name}" uses compression method ${method} — only store (0) and deflate (8) are allowed (SPEC §3.1)`);
    }

    // Local header gives the actual data offset (its name/extra lengths may
    // differ from the central directory's).
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`entry "${name}": bad local file header`);
    const lhNameLen = buf.readUInt16LE(localOffset + 26);
    const lhExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
    const compressed = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed);
    if (data.length !== uncompSize) throw new Error(`entry "${name}": size mismatch after decompression`);
    if (crc32(data) !== expectedCrc) throw new Error(`entry "${name}": CRC-32 mismatch`);
    // Track implied parent directories too.
    for (let i = name.indexOf("/"); i !== -1; i = name.indexOf("/", i + 1)) dirs.add(name.slice(0, i));
    files.set(name, data);
  }
  return { files, dirs, count: totalEntries };
}

// ---------------------------------------------------------------------------
// Directory reader
// ---------------------------------------------------------------------------

function readDir(root) {
  const files = new Map();
  const dirs = new Set();
  const walk = (abs, rel) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        dirs.add(childRel);
        walk(join(abs, entry.name), childRel);
      } else if (entry.isFile()) {
        files.set(childRel, readFileSync(join(abs, entry.name)));
      }
    }
  };
  walk(root, "");
  return { files, dirs };
}

// ---------------------------------------------------------------------------
// JSON / PNG helpers
// ---------------------------------------------------------------------------

/** Parse a JSON file buffer per SPEC §2 (UTF-8, no BOM). Returns { value } or { error }. */
function parseJsonFile(name, buf) {
  let text = buf.toString("utf8");
  let bom = false;
  if (text.charCodeAt(0) === 0xfeff) { bom = true; text = text.slice(1); }
  if (bom) fail(`${name}: begins with a UTF-8 BOM — JSON MUST be UTF-8 without BOM (SPEC §2)`);
  try {
    return { value: JSON.parse(text), bom };
  } catch (e) {
    fail(`${name}: not valid JSON (${e.message})`);
    return { error: true, bom };
  }
}

/** Returns { width, height } if buf is a plausible PNG, else null. */
function pngDimensions(buf) {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 33) return null;
  for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) return null;
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Fields that are explicitly nullable in 0.1.0; everything else MUST be omitted, not null (SPEC §2). */
function checkNoNulls(obj, path, nullableAt) {
  for (const [k, v] of Object.entries(obj)) {
    const at = `${path}.${k}`;
    if (v === null) {
      if (!nullableAt.has(at)) fail(`${at}: is null — writers MUST omit a field rather than write null (SPEC §2)`);
    } else if (isObj(v)) {
      checkNoNulls(v, at, nullableAt);
    }
  }
}

// ---------------------------------------------------------------------------
// Section validators
// ---------------------------------------------------------------------------

function validateManifest(m, pack, snapshotDims) {
  // format / format_version
  if (m.format === "capturepack") pass(`manifest.json: format is "capturepack"`);
  else fail(`manifest.json: format is ${JSON.stringify(m.format)} — MUST be "capturepack" (SPEC §5.1)`);

  if (isStr(m.format_version) && SEMVER_RE.test(m.format_version)) {
    pass(`manifest.json: format_version "${m.format_version}" is valid semver`);
    const [maj, min] = m.format_version.split(".").map(Number);
    if (!(maj === 0 && min === 1)) {
      note(`manifest.json: format_version ${m.format_version} differs from ${SPEC_VERSION} — validating against 0.1.0 rules (pre-1.0: minor acts as major, SPEC §13.1)`);
    }
  } else {
    fail(`manifest.json: format_version ${JSON.stringify(m.format_version)} is not valid semver (SPEC §5.1)`);
  }

  // id
  if (isStr(m.id) && UUID_RE.test(m.id)) {
    pass(`manifest.json: id is an RFC 4122 UUID`);
    if (m.id !== m.id.toLowerCase()) note(`manifest.json: id contains uppercase hex — lowercase is RECOMMENDED (SPEC §5.1)`);
  } else {
    fail(`manifest.json: id ${JSON.stringify(m.id)} is not an RFC 4122 UUID (SPEC §5.1)`);
  }

  // created_at
  if (isIsoWithTz(m.created_at)) pass(`manifest.json: created_at is ISO 8601 with a timezone designator`);
  else fail(`manifest.json: created_at ${JSON.stringify(m.created_at)} MUST be ISO 8601 with a timezone designator (SPEC §5.1)`);

  // generator
  if (isObj(m.generator) && isStr(m.generator.name) && m.generator.name.length > 0 &&
      isStr(m.generator.version) && m.generator.version.length > 0) {
    pass(`manifest.json: generator is ${m.generator.name} ${m.generator.version}`);
  } else {
    fail(`manifest.json: generator MUST be an object with non-empty string "name" and "version" (SPEC §5.1)`);
  }

  // title / note
  if (m.title !== undefined && m.title !== null && !isStr(m.title)) fail(`manifest.json: title, when present, MUST be a string`);
  if (m.note !== undefined && m.note !== null && !isStr(m.note)) fail(`manifest.json: note, when present, MUST be a string`);

  // environment
  const env = m.environment;
  if (!isObj(env)) {
    fail(`manifest.json: environment MUST be an object (SPEC §5.2)`);
  } else {
    if (isStr(env.os) && env.os.length > 0) {
      pass(`manifest.json: environment.os is "${env.os}"`);
      if (env.os !== env.os.toLowerCase()) note(`manifest.json: environment.os should be lowercase (SPEC §5.2)`);
    } else {
      fail(`manifest.json: environment.os is REQUIRED and MUST be a non-empty string (SPEC §5.2)`);
    }
    if (env.os_version !== undefined && env.os_version !== null && !isStr(env.os_version)) fail(`manifest.json: environment.os_version MUST be a string`);
    if (env.app !== undefined && env.app !== null && !isStr(env.app)) fail(`manifest.json: environment.app MUST be a string`);
    if (env.screens !== undefined && env.screens !== null) {
      if (!Array.isArray(env.screens)) {
        fail(`manifest.json: environment.screens MUST be an array (SPEC §5.2)`);
      } else {
        let ok = true;
        env.screens.forEach((s, i) => {
          if (!isObj(s) || !isInt(s.width) || s.width < 1 || !isInt(s.height) || s.height < 1) {
            fail(`manifest.json: environment.screens[${i}] MUST have integer width/height >= 1 (SPEC §5.2)`);
            ok = false;
          } else if (s.scale !== undefined && (!isNum(s.scale) || s.scale <= 0)) {
            fail(`manifest.json: environment.screens[${i}].scale MUST be a number > 0 (SPEC §5.2)`);
            ok = false;
          }
        });
        if (ok) pass(`manifest.json: environment.screens describes ${env.screens.length} display(s)`);
      }
    }
  }

  // media
  const media = m.media;
  let replay = null;
  let replayDurationMs = null;
  let replayAnnotated = null;
  // Files declared by media.displays[] — known to the unknown-file sweep.
  const displayFiles = new Set();
  // Same, for the annotated keyframe stills declared by media.keyframes[].
  const keyframeFiles = new Set();
  // Which displays this pack declares, and which one is focused — what
  // annotations.json's `display` field is checked against (SPEC §8.8). Empty
  // indices = a single-display pack, where no box may name a display at all.
  const displayInfo = { indices: new Set(), focused: null, declared: false };
  if (!isObj(media)) {
    fail(`manifest.json: media MUST be an object (SPEC §5.3)`);
  } else {
    if (media.snapshot === "snapshot.png") pass(`manifest.json: media.snapshot is "snapshot.png"`);
    else fail(`manifest.json: media.snapshot ${JSON.stringify(media.snapshot)} MUST be "snapshot.png" in format 0.1.0 (SPEC §5.3)`);

    if (media.replay === null) {
      if (media.replay_duration_ms === null || media.replay_duration_ms === undefined) {
        pass(`manifest.json: media.replay is null (screenshot-only pack), replay_duration_ms is null/absent`);
      } else {
        fail(`manifest.json: media.replay_duration_ms MUST be null or absent when replay is null (SPEC §5.3)`);
      }
    } else if (isStr(media.replay) && REPLAY_RE.test(media.replay)) {
      replay = media.replay;
      if (isInt(media.replay_duration_ms) && media.replay_duration_ms >= 0) {
        replayDurationMs = media.replay_duration_ms;
        pass(`manifest.json: media.replay is "${media.replay}" (${media.replay_duration_ms} ms)`);
      } else {
        fail(`manifest.json: media.replay_duration_ms MUST be an integer when replay is declared (SPEC §5.3)`);
      }
    } else {
      fail(`manifest.json: media.replay ${JSON.stringify(media.replay)} MUST be "replay.webm", "replay.mp4", or null (SPEC §5.3)`);
    }

    // replay_annotated (annotated replay, SPEC §5.3, §7.2)
    if (media.replay_annotated !== undefined && media.replay_annotated !== null) {
      if (!isStr(media.replay_annotated) || !REPLAY_ANNOTATED_RE.test(media.replay_annotated)) {
        fail(`manifest.json: media.replay_annotated ${JSON.stringify(media.replay_annotated)} MUST be "replay_annotated.webm" or "replay_annotated.mp4" (SPEC §5.3)`);
      } else if (media.replay === null) {
        fail(`manifest.json: media.replay_annotated is declared but replay is null — the annotated replay is rendered from the replay and MUST be absent in a screenshot-only pack (SPEC §5.3, §7.2)`);
      } else {
        replayAnnotated = media.replay_annotated;
      }
    }

    // snapshot_t_ms (frame-accurate snapshot, SPEC §7.1) — null is reported by checkNoNulls
    if (media.snapshot_t_ms !== undefined && media.snapshot_t_ms !== null) {
      if (!isInt(media.snapshot_t_ms) || media.snapshot_t_ms < 0) {
        fail(`manifest.json: media.snapshot_t_ms ${JSON.stringify(media.snapshot_t_ms)} MUST be an integer >= 0 (SPEC §5.3)`);
      } else if (!replay) {
        note(`manifest.json: media.snapshot_t_ms is ${media.snapshot_t_ms} but replay is null — SHOULD be absent when there is no replay timeline to anchor it (SPEC §5.3)`);
      } else if (replayDurationMs !== null && media.snapshot_t_ms > replayDurationMs) {
        note(`manifest.json: media.snapshot_t_ms ${media.snapshot_t_ms} exceeds replay_duration_ms ${replayDurationMs} — the frame position should lie within the replay (SPEC §5.3)`);
      } else {
        pass(`manifest.json: media.snapshot_t_ms is ${media.snapshot_t_ms} ms into the replay (frame-accurate snapshot, SPEC §7.1)`);
      }
    }

    // trim_offset_ms (trimmed-replay provenance, SPEC §5.3) — null is reported by checkNoNulls
    if (media.trim_offset_ms !== undefined && media.trim_offset_ms !== null) {
      if (!isInt(media.trim_offset_ms) || media.trim_offset_ms < 0) {
        fail(`manifest.json: media.trim_offset_ms ${JSON.stringify(media.trim_offset_ms)} MUST be an integer >= 0 (SPEC §5.3)`);
      } else if (!replay) {
        note(`manifest.json: media.trim_offset_ms is ${media.trim_offset_ms} but replay is null — trim provenance SHOULD be absent when there is no replay (SPEC §5.3)`);
      } else {
        pass(`manifest.json: media.trim_offset_ms is ${media.trim_offset_ms} — the replay was trimmed from the original recording at that in-point (provenance only; all pack times are on the trimmed clock, SPEC §5.3)`);
      }
    }

    // media.displays[] — multi-monitor capture (SPEC §5.6)
    if (media.displays !== undefined && media.displays !== null) {
      validateDisplays(media, env, pack, displayFiles, keyframeFiles, displayInfo);
    }

    // media.keyframes[] — annotated stills (SPEC §5.7)
    if (media.keyframes !== undefined && media.keyframes !== null) {
      validateKeyframes(media.keyframes, pack, keyframeFiles, replay, replayDurationMs, snapshotDims);
    }
  }

  // media declarations vs actual files
  if (replay) {
    if (pack.files.has(replay)) pass(`media: declared replay "${replay}" exists in the pack`);
    else fail(`media: declared replay "${replay}" is missing from the pack`);
  }
  for (const candidate of ["replay.webm", "replay.mp4"]) {
    if (candidate !== replay && pack.files.has(candidate)) {
      fail(`media: "${candidate}" exists but is not declared in manifest.media.replay — readers take the replay from the manifest, and a pack MUST NOT contain more than one replay file (SPEC §7)`);
    }
  }
  if (replayAnnotated) {
    if (pack.files.has(replayAnnotated)) {
      pass(`media: declared annotated replay "${replayAnnotated}" exists in the pack (regenerable from replay + annotations.json, SPEC §7.2)`);
    } else {
      note(`media: declared annotated replay "${replayAnnotated}" is not in the pack — it may still be rendering (the annotated replay renders in the background after save); readers fall back to replay + annotations.json (SPEC §5.3, §7.2)`);
    }
  }
  for (const candidate of ["replay_annotated.webm", "replay_annotated.mp4"]) {
    if (candidate !== replayAnnotated && pack.files.has(candidate)) {
      note(`media: "${candidate}" exists but is not declared in manifest.media.replay_annotated — readers take the annotated replay from the manifest; writers declare it once rendered (SPEC §5.3, §7.2)`);
    }
  }

  // plugins
  const declared = new Map();
  if (m.plugins !== undefined && m.plugins !== null) {
    if (!Array.isArray(m.plugins)) {
      fail(`manifest.json: plugins MUST be an array (SPEC §5.4)`);
    } else {
      for (const [i, p] of m.plugins.entries()) {
        const label = `manifest.json: plugins[${i}]`;
        if (!isObj(p)) { fail(`${label} MUST be an object`); continue; }
        let ok = true;
        if (!isStr(p.name) || !PLUGIN_NAME_RE.test(p.name)) { fail(`${label}.name ${JSON.stringify(p.name)} MUST match ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ (SPEC §5.4)`); ok = false; }
        if (!isStr(p.version) || p.version.length === 0) { fail(`${label}.version MUST be a non-empty string`); ok = false; }
        if (ok && p.path !== `plugins/${p.name}/`) { fail(`${label}.path ${JSON.stringify(p.path)} MUST be exactly "plugins/${p.name}/" (SPEC §5.4)`); ok = false; }
        if (ok && declared.has(p.name)) { fail(`${label}: duplicate plugin name "${p.name}"`); ok = false; }
        if (!ok) continue;
        declared.set(p.name, p);

        const metaName = `plugins/${p.name}/meta.json`;
        const metaBuf = pack.files.get(metaName);
        if (!metaBuf) { fail(`${metaName}: missing — REQUIRED in every plugin directory (SPEC §11.1)`); continue; }
        const meta = parseJsonFile(metaName, metaBuf);
        if (meta.error) continue;
        if (!isObj(meta.value) || meta.value.name !== p.name || meta.value.version !== p.version) {
          fail(`${metaName}: name/version MUST equal the manifest declaration ("${p.name}" ${p.version}) (SPEC §5.4, §11.1)`);
        } else {
          pass(`plugins/${p.name}/: declared in manifest and meta.json matches (${p.name} ${p.version})`);
        }
        // windows-uia is a well-known payload with a defined shape (SPEC §11.3);
        // every other plugin's contents stay plugin-defined and unchecked.
        if (p.name === "windows-uia") validateWindowsUia(pack);
      }
      if (m.plugins.length === 0) pass(`manifest.json: plugins is [] (no plugin data)`);
    }
  }

  // plugin directories on disk that were never declared
  const topPluginDirs = new Set(
    [...pack.dirs].filter((d) => /^plugins\/[^/]+$/.test(d)).map((d) => d.split("/")[1]),
  );
  for (const f of pack.files.keys()) {
    const mtch = /^plugins\/([^/]+)\//.exec(f);
    if (mtch) topPluginDirs.add(mtch[1]);
  }
  for (const name of topPluginDirs) {
    if (!declared.has(name)) {
      note(`plugins/${name}/: not declared in manifest.plugins — ignored (readers MUST ignore undeclared plugin directories, SPEC §11.1; writers MUST declare every plugin payload, SPEC §5.4)`);
    }
  }

  return {
    replay,
    replayDurationMs,
    replayAnnotated,
    declaredPlugins: declared,
    displayFiles,
    keyframeFiles,
    displayInfo,
  };
}

/**
 * plugins/windows-uia/elements.json (SPEC §11.3): the capture-instant window
 * list and the UI Automation trees of the walked windows, which annotation
 * targets are picked from. Purely additive data — a malformed payload is a
 * failure of THIS plugin, never of the core pack, so nothing here touches
 * annotation results.
 *
 * Fields added in payload 0.2.0 (class_name/z/tree/element_count on a window,
 * window on an element) are checked WHEN PRESENT: a 0.1.0 payload is still
 * valid, and demanding them would fail packs written by a conforming older
 * writer.
 */
function validateWindowsUia(pack) {
  const name = "plugins/windows-uia/elements.json";
  const buf = pack.files.get(name);
  if (!buf) {
    fail(`${name}: missing — the windows-uia payload REQUIRES it (SPEC §11.3)`);
    return;
  }
  const parsed = parseJsonFile(name, buf);
  if (parsed.error) return;
  const p = parsed.value;
  if (!isObj(p)) { fail(`${name}: MUST be a JSON object (SPEC §11.3)`); return; }

  let bad = 0;
  if (!isIsoWithTz(p.captured_at)) { fail(`${name}: captured_at MUST be ISO 8601 with a timezone designator (SPEC §11.3)`); bad++; }
  if (!isInt(p.budget_ms) || p.budget_ms <= 0) { fail(`${name}: budget_ms MUST be a positive integer — the bound the dump was given (SPEC §11.3)`); bad++; }
  if (typeof p.truncated !== "boolean") { fail(`${name}: truncated MUST be a boolean (SPEC §11.3)`); bad++; }

  const checkBounds = (label, b) => {
    if (!isObj(b) || !isNum(b.x) || !isNum(b.y) || !isNum(b.width) || !isNum(b.height)) {
      fail(`${label}.bounds MUST be { x, y, width, height } with all four numbers, in snapshot pixel coordinates (SPEC §11.3)`);
      return false;
    }
    return true;
  };

  let focusedWindows = 0;
  const TREE_STATUSES = ["collected", "truncated", "unavailable", "skipped"];
  const windowZ = new Set();
  let noTreeWindows = 0;
  if (!Array.isArray(p.windows)) {
    fail(`${name}: windows MUST be an array (may be empty) (SPEC §11.3)`);
    bad++;
  } else {
    p.windows.forEach((w, i) => {
      const label = `${name}: windows[${i}]`;
      if (!isObj(w)) { fail(`${label} MUST be an object`); bad++; return; }
      for (const f of ["title", "process"]) {
        if (!isStr(w[f])) { fail(`${label}.${f} MUST be a string (may be empty) (SPEC §11.3)`); bad++; }
      }
      if (w.class_name !== undefined && !isStr(w.class_name)) {
        fail(`${label}.class_name MUST be a string (may be empty) (SPEC §11.3, payload 0.2.0)`);
        bad++;
      }
      if (typeof w.focused !== "boolean") { fail(`${label}.focused MUST be a boolean (SPEC §11.3)`); bad++; }
      else if (w.focused) focusedWindows++;
      if (!checkBounds(label, w.bounds)) bad++;
      // z — the z-order that decides which window covers a pixel. Duplicates
      // would make that unanswerable, so they are a failure, not a note.
      if (w.z !== undefined) {
        if (!isInt(w.z) || w.z < 0) {
          fail(`${label}.z MUST be a non-negative integer (0 = top-most) (SPEC §11.3, payload 0.2.0)`);
          bad++;
        } else if (windowZ.has(w.z)) {
          fail(`${label}.z ${w.z} is used by more than one window — z is the z-ORDER, so it MUST be unique (SPEC §11.3)`);
          bad++;
        } else {
          windowZ.add(w.z);
        }
      }
      if (w.tree !== undefined) {
        if (!TREE_STATUSES.includes(w.tree)) {
          fail(`${label}.tree MUST be one of ${TREE_STATUSES.map((s) => `"${s}"`).join(", ")} (SPEC §11.3, payload 0.2.0)`);
          bad++;
        } else if (w.tree !== "collected") {
          noTreeWindows++;
        }
      }
      if (w.element_count !== undefined && (!isInt(w.element_count) || w.element_count < 0)) {
        fail(`${label}.element_count MUST be a non-negative integer (SPEC §11.3, payload 0.2.0)`);
        bad++;
      }
    });
  }
  if (focusedWindows > 1) {
    fail(`${name}: ${focusedWindows} windows are marked focused — at most ONE window had focus at the capture instant (SPEC §11.3)`);
    bad++;
  }

  let orphans = 0;
  const ORPHAN_REPORTS = 3;
  if (!Array.isArray(p.elements)) {
    fail(`${name}: elements MUST be an array (may be empty) (SPEC §11.3)`);
    bad++;
  } else {
    p.elements.forEach((e, i) => {
      const label = `${name}: elements[${i}]`;
      if (!isObj(e)) { fail(`${label} MUST be an object`); bad++; return; }
      for (const f of ["name", "control_type", "automation_id", "class_name"]) {
        if (!isStr(e[f])) { fail(`${label}.${f} MUST be a string (may be empty — this is a dump, SPEC §11.3)`); bad++; }
      }
      if (!isInt(e.depth) || e.depth < 0) { fail(`${label}.depth MUST be a non-negative integer (0 = the element's own window) (SPEC §11.3)`); bad++; }
      if (!checkBounds(label, e.bounds)) bad++;
      // window — which window's tree this control came from. A control pointing
      // at a window that is not in the list cannot be placed in the z-order.
      // Reported at most ORPHAN_REPORTS times: one bad window list orphans
      // every control under it, and a thousand identical lines hide the rest of
      // the report.
      if (e.window !== undefined) {
        if (!isInt(e.window) || e.window < 0) {
          fail(`${label}.window MUST be a non-negative integer — the z of the window this control was walked from (SPEC §11.3, payload 0.2.0)`);
          bad++;
        } else if (windowZ.size > 0 && !windowZ.has(e.window)) {
          orphans++;
          if (orphans <= ORPHAN_REPORTS) {
            fail(`${label}.window ${e.window} matches no windows[].z — every control belongs to a listed window (SPEC §11.3)`);
          }
          bad++;
        }
      }
    });
    if (orphans > ORPHAN_REPORTS) {
      fail(`${name}: ${orphans - ORPHAN_REPORTS} further element(s) also name a window that is not in windows[] (SPEC §11.3)`);
    }
    if (bad === 0 && p.truncated === true) {
      note(`${name}: truncated is true — the UI Automation walk ran out of budget/depth/elements, or did not reach every window, so the dump is INCOMPLETE; an absent element means "not recorded", never "not on screen" (SPEC §11.3)`);
    }
    if (bad === 0 && noTreeWindows > 0) {
      note(`${name}: ${noTreeWindows} window(s) carry no control tree (tree is not "collected") — that is a statement about the DUMP, never about the windows; readers MUST NOT present them as applications without objects (SPEC §11.3)`);
    }
    if (bad === 0 && p.elements.length === 0 && Array.isArray(p.windows) && p.windows.length === 0) {
      note(`${name}: the dump is empty (no windows, no elements) — valid, but it carries no object context (SPEC §11.3)`);
    }
  }
  if (bad === 0) {
    pass(`plugins/windows-uia/: capture-instant object dump is well-formed (${Array.isArray(p.windows) ? p.windows.length : 0} window(s), ${Array.isArray(p.elements) ? p.elements.length : 0} element(s), bounds in snapshot pixels — SPEC §11.3)`);
  }
}

/**
 * media.keyframes[]: the annotated stills under frames/ (SPEC §5.7). Checks the
 * array shape, ascending t_ms, the NN-encodes-the-order filename rule, and that
 * every declared still exists and is a real PNG in the annotation coordinate
 * space. The array is written by the same background render as
 * replay_annotated, but — unlike that declaration — it is written AFTER the
 * files, so a declared-but-missing still is a failure, not a "still rendering".
 */
function validateKeyframes(keyframes, pack, keyframeFiles, replay, replayDurationMs, snapshotDims, opts = {}) {
  // `opts` is what makes this serve BOTH the pack's own stills and one
  // display's (SPEC §5.6): the rules are identical, only the field path, the
  // filename shape, and the snapshot they are measured against differ.
  const where = opts.where ?? "manifest.json: media.keyframes";
  const short = opts.short ?? "media.keyframes";
  const fileRe = opts.fileRe ?? KEYFRAME_FILE_RE;
  const shape = opts.shape ?? '"frames/frame-<NN>_<MM-SS.mmm>.png"';
  const snapshotName = opts.snapshotName ?? "snapshot.png";
  const clock = opts.clock ?? "the replay clock";
  const ref = opts.ref ?? "SPEC §5.7";
  if (!Array.isArray(keyframes)) {
    fail(`${where} MUST be an array (${ref})`);
    return;
  }
  if (keyframes.length === 0) {
    note(`${where} is [] — omit it entirely when there are no annotated stills (${ref})`);
    return;
  }
  let ok = true;
  let lastT = null;

  keyframes.forEach((k, i) => {
    const label = `${where}[${i}]`;
    if (!isObj(k)) {
      fail(`${label} MUST be an object with "file" and "t_ms" (${ref})`);
      ok = false;
      return;
    }

    // t_ms — the position on the replay clock this still shows.
    let tOk = false;
    if (!isInt(k.t_ms) || k.t_ms < 0) {
      fail(`${label}.t_ms ${JSON.stringify(k.t_ms)} MUST be an integer >= 0 on ${clock} (${ref})`);
      ok = false;
    } else {
      tOk = true;
      if (lastT !== null && k.t_ms < lastT) {
        fail(`${label}.t_ms ${k.t_ms} is earlier than the previous entry (${lastT}) — keyframes MUST be ordered by t_ms ascending (${ref})`);
        ok = false;
      } else if (lastT !== null && k.t_ms === lastT) {
        note(`${label}.t_ms ${k.t_ms} repeats the previous entry — state changes within ~300 ms SHOULD merge into one still (${ref})`);
      }
      lastT = k.t_ms;
      if (replayDurationMs !== null && k.t_ms > replayDurationMs) {
        note(`${label}.t_ms ${k.t_ms} lies past the replay end (${replayDurationMs} ms) — a keyframe is a position on ${clock} (${ref})`);
      }
      if (!replay && k.t_ms !== 0) {
        note(`${label}.t_ms is ${k.t_ms} but there is no replay here — without one there is exactly one still at t_ms 0, drawn from the snapshot (${ref}, §7.3)`);
      }
    }

    // file — the NN-encodes-the-order filename rule.
    const mtch = isStr(k.file) ? fileRe.exec(k.file) : null;
    if (!mtch) {
      fail(`${label}.file ${JSON.stringify(k.file)} MUST be ${shape} (${ref})`);
      ok = false;
      return;
    }
    if (Number(mtch[1]) !== i + 1) {
      fail(`${label}.file ${JSON.stringify(k.file)} carries order ${Number(mtch[1])} but is entry ${i + 1} — NN MUST be the entry's 1-based position (${ref})`);
      ok = false;
    }
    if (tOk) {
      const named = Number(mtch[2]) * 60_000 + Number(mtch[3]) * 1000 + Number(mtch[4]);
      if (named !== k.t_ms) {
        note(`${label}.file encodes ${named} ms but t_ms is ${k.t_ms} — the filename SHOULD spell the entry's own time (${ref}); t_ms is what readers use`);
      }
    }

    keyframeFiles.add(k.file);
    const buf = pack.files.get(k.file);
    if (!buf) {
      fail(`${short}: declared still "${k.file}" is missing from the pack (${ref})`);
      ok = false;
      return;
    }
    const dims = pngDimensions(buf);
    if (!dims) {
      fail(`${short}: "${k.file}" is not a valid PNG (bad signature or IHDR) (${ref}, §7.3)`);
      ok = false;
    } else if (snapshotDims && (dims.width !== snapshotDims.width || dims.height !== snapshotDims.height)) {
      note(`${short}: "${k.file}" is ${dims.width}x${dims.height} but ${snapshotName} is ${snapshotDims.width}x${snapshotDims.height} — stills SHOULD use that display's annotation coordinate space so box bounds map onto them directly (SPEC §7.3)`);
    }
  });

  if (ok) {
    pass(`${short}: declares ${keyframes.length} annotated still(s), ordered by t_ms and present in the pack (${ref})`);
  }
}

/**
 * media.displays[]: the per-display media of a capture that froze more than one
 * display (SPEC §5.6). Checks the array shape, index uniqueness, that exactly
 * one entry is focused and repeats the top-level media, and that every declared
 * file exists. A display without a replay is a NOTE, never a failure.
 */
function validateDisplays(media, env, pack, displayFiles, keyframeFiles, displayInfo) {
  const displays = media.displays;
  if (!Array.isArray(displays)) {
    fail(`manifest.json: media.displays MUST be an array (SPEC §5.6)`);
    return;
  }
  if (displays.length === 0) {
    note(`manifest.json: media.displays is [] — omit it entirely for a single-display capture (SPEC §5.6)`);
    return;
  }
  const screenCount = isObj(env) && Array.isArray(env.screens) ? env.screens.length : null;
  const seenIndices = new Set();
  let focused = 0;
  let focusedIndex = null;
  let nonFocusedReplays = 0;
  let ok = true;

  displays.forEach((d, i) => {
    const label = `manifest.json: media.displays[${i}]`;
    if (!isObj(d)) {
      fail(`${label} MUST be an object (SPEC §5.6)`);
      ok = false;
      return;
    }
    const isFocused = d.focused === true;
    if (typeof d.focused !== "boolean") {
      fail(`${label}.focused MUST be a boolean — exactly one entry is the focused display (SPEC §5.6)`);
      ok = false;
    } else if (isFocused) {
      focused += 1;
      focusedIndex = d.index;
      if (isInt(d.index)) displayInfo.focused = d.index;
    }

    // index: 1-based position in environment.screens, unique
    let indexOk = false;
    if (isInt(d.index) && d.index >= 1) displayInfo.indices.add(d.index);
    if (!isInt(d.index) || d.index < 1) {
      fail(`${label}.index ${JSON.stringify(d.index)} MUST be an integer >= 1 — the 1-based position in environment.screens (SPEC §5.6)`);
      ok = false;
    } else if (seenIndices.has(d.index)) {
      fail(`${label}.index ${d.index} is declared more than once — display indices MUST be unique (SPEC §5.6)`);
      ok = false;
    } else {
      seenIndices.add(d.index);
      indexOk = true;
      if (screenCount !== null && d.index > screenCount) {
        note(`${label}.index ${d.index} has no matching environment.screens entry (${screenCount} declared) — the index is the display's position in that list (SPEC §5.6)`);
      }
    }

    // geometry
    const b = d.bounds;
    if (!isObj(b) || !isNum(b.x) || !isNum(b.y) || !isNum(b.width) || b.width <= 0 || !isNum(b.height) || b.height <= 0) {
      fail(`${label}.bounds MUST be { x, y, width, height } in device-independent pixels, width/height > 0 (SPEC §5.6)`);
      ok = false;
    }
    if (!isNum(d.scale) || d.scale <= 0) {
      fail(`${label}.scale MUST be a number > 0 (SPEC §5.6)`);
      ok = false;
    }

    // snapshot: the focused entry repeats the top-level file, the others use
    // the per-display name for their own index.
    if (!isStr(d.snapshot)) {
      fail(`${label}.snapshot MUST be a string (SPEC §5.6)`);
      ok = false;
    } else if (isFocused) {
      if (d.snapshot !== media.snapshot) {
        fail(`${label}.snapshot ${JSON.stringify(d.snapshot)} MUST equal the top-level media.snapshot ${JSON.stringify(media.snapshot)} — the focused display's media IS the pack's media (SPEC §5.6)`);
        ok = false;
      }
    } else if (!DISPLAY_SNAPSHOT_RE.test(d.snapshot)) {
      fail(`${label}.snapshot ${JSON.stringify(d.snapshot)} MUST be "snapshot-d<index>.png" for a non-focused display (SPEC §5.6)`);
      ok = false;
    } else {
      if (indexOk && d.snapshot !== `snapshot-d${d.index}.png`) {
        fail(`${label}.snapshot ${JSON.stringify(d.snapshot)} MUST be "snapshot-d${d.index}.png" to match its index (SPEC §5.6)`);
        ok = false;
      }
      displayFiles.add(d.snapshot);
      if (pack.files.has(d.snapshot)) {
        pass(`media.displays: declared snapshot "${d.snapshot}" exists in the pack`);
      } else {
        fail(`media.displays: declared snapshot "${d.snapshot}" is missing from the pack (SPEC §5.6)`);
        ok = false;
      }
    }

    // replay: optional per display — a display without one is context-only.
    if (d.replay === null) {
      note(`media.displays: display ${isInt(d.index) ? d.index : i} has no replay (replay: null) — its snapshot is the only media for that screen (SPEC §5.6)`);
    } else if (!isStr(d.replay)) {
      fail(`${label}.replay MUST be a filename string or null (SPEC §5.6)`);
      ok = false;
    } else if (isFocused) {
      if (d.replay !== media.replay) {
        fail(`${label}.replay ${JSON.stringify(d.replay)} MUST equal the top-level media.replay ${JSON.stringify(media.replay)} (SPEC §5.6)`);
        ok = false;
      } else if (d.replay_duration_ms !== media.replay_duration_ms) {
        fail(`${label}.replay_duration_ms ${JSON.stringify(d.replay_duration_ms)} MUST equal the top-level media.replay_duration_ms ${JSON.stringify(media.replay_duration_ms)} (SPEC §5.6)`);
        ok = false;
      }
    } else if (!DISPLAY_REPLAY_RE.test(d.replay)) {
      fail(`${label}.replay ${JSON.stringify(d.replay)} MUST be "replay-d<index>.webm" (or .mp4) for a non-focused display (SPEC §5.6)`);
      ok = false;
    } else {
      nonFocusedReplays += 1;
      if (indexOk && !d.replay.startsWith(`replay-d${d.index}.`)) {
        fail(`${label}.replay ${JSON.stringify(d.replay)} MUST be "replay-d${d.index}.webm" (or .mp4) to match its index (SPEC §5.6)`);
        ok = false;
      }
      if (!isInt(d.replay_duration_ms) || d.replay_duration_ms < 0) {
        fail(`${label}.replay_duration_ms MUST be an integer >= 0 when this display declares a replay (SPEC §5.6)`);
        ok = false;
      }
      displayFiles.add(d.replay);
      if (pack.files.has(d.replay)) {
        pass(`media.displays: declared replay "${d.replay}" exists in the pack`);
      } else {
        fail(`media.displays: declared replay "${d.replay}" is missing from the pack (SPEC §5.6)`);
        ok = false;
      }
    }

    // This display's OWN annotated views (SPEC §5.6, §8.8): its boxes rendered
    // into its own replay and its own stills. Present only on a NON-focused
    // display that carries annotations — the focused display's are the
    // top-level media, and repeating them here would declare the same file
    // twice under two owners.
    if (!validateDisplayRenders(d, i, label, isFocused, indexOk, pack, displayFiles, keyframeFiles)) {
      ok = false;
    }
  });
  displayInfo.declared = true;

  if (focused !== 1) {
    fail(`manifest.json: media.displays MUST contain EXACTLY ONE entry with focused: true (found ${focused}) — the focused display owns snapshot.png, the replay, and every annotation (SPEC §5.6)`);
    ok = false;
  }
  if (ok) {
    pass(`manifest.json: media.displays declares ${displays.length} display(s), display ${focusedIndex} focused and matching the top-level media (SPEC §5.6)`);
  }
  if (nonFocusedReplays > 0 && isInt(media.trim_offset_ms)) {
    note(`media.displays: the replay was trimmed (trim_offset_ms ${media.trim_offset_ms}) but non-focused per-display replays keep the ORIGINAL recording's clock — add trim_offset_ms to align them with the pack clock (SPEC §5.6)`);
  }
}

/**
 * One display's `replay_annotated` and `keyframes` (SPEC §5.6): the same
 * generated-view rules as the top-level pair, scoped to one screen.
 *
 * Returns false when something failed. Absent fields are the normal case — a
 * display nobody annotated has no rendered views, and neither does the focused
 * entry, whose views ARE the top-level media.
 */
function validateDisplayRenders(d, i, label, isFocused, indexOk, pack, displayFiles, keyframeFiles) {
  let ok = true;
  const has = (v) => v !== undefined && v !== null;
  if (isFocused) {
    for (const field of ["replay_annotated", "keyframes"]) {
      if (has(d[field])) {
        fail(`${label}.${field} MUST NOT appear on the FOCUSED entry — the focused display's annotated views ARE the top-level media.${field} (SPEC §5.6)`);
        ok = false;
      }
    }
    return ok;
  }
  const index = indexOk ? d.index : null;

  if (has(d.replay_annotated)) {
    if (!isStr(d.replay_annotated) || (index !== null && !displayAnnotatedRe(index).test(d.replay_annotated))) {
      fail(`${label}.replay_annotated ${JSON.stringify(d.replay_annotated)} MUST be "replay_annotated-d${index ?? "<index>"}.webm" (or .mp4) (SPEC §5.6)`);
      ok = false;
    } else if (d.replay === null) {
      fail(`${label}.replay_annotated is declared but this display has no replay — an annotated replay is rendered FROM a replay (SPEC §5.6, §7.2)`);
      ok = false;
    } else {
      displayFiles.add(d.replay_annotated);
      if (pack.files.has(d.replay_annotated)) {
        pass(`media.displays: display ${index ?? i} has its own annotated replay "${d.replay_annotated}" (its boxes only — SPEC §5.6, §8.8)`);
      } else {
        // Same rule as the top-level: the declaration is written when the
        // background render finishes, so a missing file may still be rendering.
        note(`media.displays: declared annotated replay "${d.replay_annotated}" is not in the pack — it may still be rendering; readers fall back to that display's replay + annotations.json (SPEC §5.6, §7.2)`);
      }
    }
  }

  if (has(d.keyframes)) {
    // Measured against THIS display's snapshot, not snapshot.png: its boxes are
    // in its own coordinate space (SPEC §8.2, §8.8).
    const snapBuf = isStr(d.snapshot) ? pack.files.get(d.snapshot) : undefined;
    const dims = snapBuf ? pngDimensions(snapBuf) : null;
    validateKeyframes(
      d.keyframes,
      pack,
      keyframeFiles,
      d.replay !== null,
      isInt(d.replay_duration_ms) ? d.replay_duration_ms : null,
      dims,
      {
        where: `${label}.keyframes`,
        short: `media.displays[${i}].keyframes`,
        fileRe: displayKeyframeRe(index ?? "[1-9][0-9]*"),
        shape: `"frames-d${index ?? "<index>"}/frame-<NN>_<MM-SS.mmm>.png"`,
        snapshotName: isStr(d.snapshot) ? d.snapshot : "this display's snapshot",
        clock: "THIS display's own replay clock",
        ref: "SPEC §5.6",
      },
    );
  }
  return ok;
}

function validateAnnotations(a, snapshotDims, replay, replayDurationMs, displayInfo) {
  const knownIds = new Set();
  if (!isInt(a.reference_width) || a.reference_width < 1 || !isInt(a.reference_height) || a.reference_height < 1) {
    fail(`annotations.json: reference_width/reference_height MUST be positive integers (SPEC §8.1)`);
  } else if (snapshotDims && (a.reference_width !== snapshotDims.width || a.reference_height !== snapshotDims.height)) {
    fail(`annotations.json: reference ${a.reference_width}x${a.reference_height} does not equal snapshot.png ${snapshotDims.width}x${snapshotDims.height} — they MUST be equal (SPEC §8.1; readers SHOULD rescale rather than discard, SPEC §8.2)`);
  } else {
    pass(`annotations.json: coordinate space ${a.reference_width}x${a.reference_height} matches snapshot.png`);
  }

  if (!Array.isArray(a.annotations)) {
    fail(`annotations.json: annotations MUST be an array (SPEC §8.1)`);
    return knownIds;
  }

  let bad = 0;
  let blurCount = 0;
  const numberedBoxes = []; // { id, startMs, z, index } for display-number computation
  const targetedBoxes = []; // annotation ids carrying a source:"uia" target (SPEC §8.7)
  const displayBoxes = new Map(); // display index -> how many boxes name it (SPEC §8.8)
  a.annotations.forEach((ann, i) => {
    const label = `annotations.json: annotations[${i}]`;
    if (!isObj(ann)) { fail(`${label} MUST be an object`); bad++; return; }

    // annotation_id — permanent identity (SPEC §8.3).
    if (!isStr(ann.annotation_id) || !ANNOTATION_ID_RE.test(ann.annotation_id)) {
      fail(`${label}.annotation_id ${JSON.stringify(ann.annotation_id)} MUST match ^ann_[0-9a-f]{6}$ — "ann_" plus 6 lowercase hex digits (SPEC §8.3)`);
      bad++;
    } else if (knownIds.has(ann.annotation_id)) {
      fail(`${label}.annotation_id "${ann.annotation_id}" is not unique within the file (SPEC §8.3)`);
      bad++;
    } else {
      knownIds.add(ann.annotation_id);
    }

    // type — "box" is the only type in 0.1.0.
    if (ann.type !== "box") {
      if (isStr(ann.type) && LEGACY_ANNOTATION_TYPES.has(ann.type)) {
        fail(`${label}.type "${ann.type}" is a legacy type from a pre-release draft — format 0.1.0 defines only "box"; compose the role with numbered/blur/text properties on a box instead (SPEC §8.3)`);
        bad++;
      } else if (isStr(ann.type)) {
        note(`${label}: unknown type "${ann.type}" — skipped (readers MUST skip unknown annotation types, SPEC §8.3)`);
      } else {
        fail(`${label}.type MUST be a string (SPEC §8.3)`);
        bad++;
      }
      return;
    }

    // bounds — sanity (SPEC §8.3).
    let boundsOk = false;
    const b = ann.bounds;
    if (!isObj(b) || !isNum(b.x) || !isNum(b.y) || !isNum(b.width) || !isNum(b.height)) {
      fail(`${label}.bounds MUST be { x, y, width, height } with all four numbers (SPEC §8.3)`);
      bad++;
    } else if (b.width <= 0 || b.height <= 0) {
      fail(`${label}.bounds: width and height MUST be > 0 (got ${b.width}x${b.height}) (SPEC §8.3)`);
      bad++;
    } else {
      boundsOk = true;
      if (isInt(a.reference_width) && isInt(a.reference_height) &&
          (b.x + b.width <= 0 || b.y + b.height <= 0 || b.x >= a.reference_width || b.y >= a.reference_height)) {
        note(`${label}.bounds lies entirely outside the ${a.reference_width}x${a.reference_height} coordinate space — nothing of the box is visible (SPEC §8.2)`);
      }
    }

    // display — WHICH captured display this box was drawn on (SPEC §8.8).
    // ABSENT is the normal case and means the focused display: that is what a
    // single-display pack writes and what a box on the focused screen writes,
    // so every pack written before the field existed is already correct.
    if (ann.display !== undefined) {
      if (!isInt(ann.display) || ann.display < 1) {
        fail(`${label}.display ${JSON.stringify(ann.display)} MUST be an integer >= 1 — the 1-based manifest.media.displays[].index of the display this box was drawn on (SPEC §8.8)`);
        bad++;
      } else if (displayInfo && displayInfo.declared && !displayInfo.indices.has(ann.display)) {
        fail(`${label}.display ${ann.display} names no display declared in manifest.media.displays (${[...displayInfo.indices].join(", ") || "none"}) — the box's bounds are pixels in THAT display's snapshot, so an unresolvable index leaves them meaningless (SPEC §8.8)`);
        bad++;
      } else if (displayInfo && !displayInfo.declared) {
        fail(`${label}.display ${ann.display} is set but this pack declares no manifest.media.displays — a single-display pack has exactly one screen and boxes on it MUST omit display (SPEC §8.8)`);
        bad++;
      } else {
        displayBoxes.set(ann.display, (displayBoxes.get(ann.display) ?? 0) + 1);
        if (displayInfo && ann.display === displayInfo.focused) {
          note(`${label}.display ${ann.display} names the FOCUSED display — writers SHOULD omit display there (absent means the focused display), which is what keeps a pack byte-identical to one written without this field (SPEC §8.8)`);
        }
      }
    }

    // text — the description; MAY be empty, absent means "" (SPEC §8.3).
    if (ann.text !== undefined && !isStr(ann.text)) { fail(`${label}.text MUST be a string (may be empty) (SPEC §8.3)`); bad++; }

    // numbered / blur — booleans (SPEC §8.3).
    let numbered = false;
    if (ann.numbered !== undefined) {
      if (typeof ann.numbered !== "boolean") { fail(`${label}.numbered MUST be a boolean (SPEC §8.3)`); bad++; }
      else numbered = ann.numbered;
    }
    if (ann.blur !== undefined) {
      if (typeof ann.blur !== "boolean") { fail(`${label}.blur MUST be a boolean (SPEC §8.3)`); bad++; }
      else if (ann.blur) blurCount++;
    }

    // tracking — { enabled: false } in 0.1.0; richer data reserved (SPEC §8.3).
    if (ann.tracking !== undefined) {
      if (!isObj(ann.tracking) || typeof ann.tracking.enabled !== "boolean") {
        fail(`${label}.tracking MUST be an object with a boolean "enabled" (SPEC §8.3)`);
        bad++;
      } else if (ann.tracking.enabled) {
        note(`${label}.tracking.enabled is true — tracking is reserved in format 0.1.0 (MUST be false); readers treat the box as untracked (SPEC §8.3)`);
      }
    }

    // target — semantic object metadata (SPEC §8.3, §8.7). It is purely
    // additive: whatever is wrong with it, the box still renders from bounds.
    if (ann.target !== undefined) {
      if (!isObj(ann.target)) {
        fail(`${label}.target, when present, MUST be an object (semantic object metadata, SPEC §8.7)`);
        bad++;
      } else if (!isStr(ann.target.source) || ann.target.source.length === 0) {
        fail(`${label}.target.source MUST be a non-empty string — it is the discriminator for every other field of a target (SPEC §8.7)`);
        bad++;
      } else if (ann.target.source === "uia") {
        targetedBoxes.push(isStr(ann.annotation_id) ? ann.annotation_id : `(annotations[${i}])`);
        // level — "control" (the default when absent) or "window". A window
        // target is a complete answer at a coarser granularity, not a degraded
        // control, so nothing here treats it as lesser (SPEC §8.7).
        if (ann.target.level !== undefined && ann.target.level !== "control" && ann.target.level !== "window") {
          fail(`${label}.target.level MUST be "control" or "window" when present (SPEC §8.7)`);
          bad++;
        }
        for (const f of ["name", "control_type", "automation_id", "class_name", "title", "process"]) {
          if (ann.target[f] === undefined) continue;
          if (!isStr(ann.target[f])) {
            fail(`${label}.target.${f} MUST be a string (SPEC §8.7)`);
            bad++;
          } else if (ann.target[f].length === 0) {
            note(`${label}.target.${f} is an empty string — a UIA property the element had no value for MUST be omitted, not written empty (SPEC §8.7)`);
          }
        }
      } else {
        note(`${label}.target.source "${ann.target.source}" is not defined in format 0.1.0 — skipped (readers MUST ignore target sources they do not understand and render the box from bounds, SPEC §8.7)`);
      }
    }

    // style — { color } in 0.1.0 (SPEC §8.3).
    if (ann.style !== undefined) {
      if (!isObj(ann.style)) { fail(`${label}.style, when present, MUST be an object (SPEC §8.3)`); bad++; }
      else if (ann.style.color !== undefined && (!isStr(ann.style.color) || !COLOR_RE.test(ann.style.color))) {
        fail(`${label}.style.color MUST be "#RRGGBB" or "#RRGGBBAA" (SPEC §8.3)`);
        bad++;
      }
    }

    if (ann.created_at !== undefined && !isIsoWithTz(ann.created_at)) { fail(`${label}.created_at MUST be ISO 8601 with timezone (SPEC §8.3)`); bad++; }
    if (ann.z !== undefined && !isInt(ann.z)) { fail(`${label}.z MUST be an integer (SPEC §8.3)`); bad++; }

    // Lifetime — [start_ms, end_ms], both or neither (SPEC §8.4).
    let lifetimeOk = true;
    for (const f of ["start_ms", "end_ms"]) {
      if (ann[f] !== undefined && !isNum(ann[f])) { fail(`${label}.${f} MUST be a number (SPEC §8.4)`); bad++; lifetimeOk = false; }
    }
    if (lifetimeOk && (ann.start_ms !== undefined) !== (ann.end_ms !== undefined)) {
      fail(`${label}: only one of start_ms/end_ms is present — a lifetime MUST carry both bounds or neither (SPEC §8.4)`);
      bad++;
      lifetimeOk = false;
    }
    if (lifetimeOk && ann.start_ms !== undefined) {
      if (ann.start_ms > ann.end_ms) {
        fail(`${label}: start_ms ${ann.start_ms} > end_ms ${ann.end_ms} — a lifetime MUST satisfy start_ms <= end_ms (SPEC §8.4)`);
        bad++;
      } else if (!replay) {
        note(`${label}: has a lifetime (start_ms/end_ms) but the pack has no replay — a lifetime is a replay-clock interval and is only meaningful with a replay (SPEC §8.4)`);
      } else if (replayDurationMs !== null) {
        for (const f of ["start_ms", "end_ms"]) {
          if (ann[f] < 0 || ann[f] > replayDurationMs) {
            note(`${label}.${f} ${ann[f]} lies outside the replay [0, ${replayDurationMs}] ms (SPEC §8.4)`);
          }
        }
      }
    }

    if (numbered && boundsOk) {
      numberedBoxes.push({
        id: isStr(ann.annotation_id) ? ann.annotation_id : `(annotations[${i}])`,
        startMs: isNum(ann.start_ms) ? ann.start_ms : 0,
        z: isInt(ann.z) ? ann.z : i,
        index: i,
      });
    }
  });

  // Display numbers — computed, never stored (SPEC §8.5): start_ms asc
  // (absent = 0), then z asc (absent = array position), then annotation_id asc.
  if (numberedBoxes.length > 0) {
    numberedBoxes.sort((p, q) =>
      p.startMs - q.startMs || p.z - q.z || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
    const assigned = numberedBoxes.map((nb, idx) => `${nb.id}=${idx + 1}`).join(", ");
    pass(`annotations.json: display numbers (computed, never stored — SPEC §8.5): ${assigned}`);
  }
  if (blurCount > 0) {
    note(`annotations.json: ${blurCount} box(es) are marked blur — snapshot.png and the replay keep the ORIGINAL unredacted pixels; blur renders only into derived views such as replay_annotated (SPEC §9)`);
  }
  if (targetedBoxes.length > 0) {
    pass(`annotations.json: ${targetedBoxes.length} box(es) carry a semantic target with source "uia" (${targetedBoxes.join(", ")}) — the box's geometry still comes from bounds alone (SPEC §8.7)`);
  }
  // Multi-display packs: say which screens carry boxes, and against which
  // snapshot each group's coordinates are read (SPEC §8.8).
  if (displayBoxes.size > 0) {
    const focusedCount = a.annotations.length - [...displayBoxes.values()].reduce((n, v) => n + v, 0);
    const parts = [...displayBoxes.entries()]
      .sort((p, q) => p[0] - q[0])
      .map(([index, n]) => `display ${index}: ${n}`);
    if (focusedCount > 0 && displayInfo && displayInfo.focused !== null) {
      parts.unshift(`display ${displayInfo.focused} (focused, implied by an absent display): ${focusedCount}`);
    }
    pass(`annotations.json: boxes are spread over more than one captured display (${parts.join(", ")}) — each box's bounds are pixels in ITS OWN display's snapshot (SPEC §8.2, §8.8)`);
  }
  if (bad === 0) pass(`annotations.json: all ${a.annotations.length} annotation(s) are well-formed boxes`);
  return knownIds;
}

function validateTimeline(t, declaredPlugins, annotationIds) {
  if (isIsoWithTz(t.t0)) pass(`timeline.json: t0 is ISO 8601 with a timezone designator`);
  else fail(`timeline.json: t0 ${JSON.stringify(t.t0)} MUST be ISO 8601 with a timezone designator (SPEC §10.1)`);

  if (!Array.isArray(t.events)) {
    fail(`timeline.json: events MUST be an array (SPEC §10.1)`);
    return;
  }

  let bad = 0;
  let lastT = -Infinity;
  let sorted = true;
  t.events.forEach((ev, i) => {
    const label = `timeline.json: events[${i}]`;
    if (!isObj(ev)) { fail(`${label} MUST be an object`); bad++; return; }
    if (!isInt(ev.t_ms)) { fail(`${label}.t_ms MUST be an integer (may be negative) (SPEC §10.1)`); bad++; }
    else { if (ev.t_ms < lastT) sorted = false; lastT = ev.t_ms; }
    if (!isStr(ev.source) || ev.source.length === 0) { fail(`${label}.source MUST be a non-empty string (SPEC §10.1)`); bad++; }
    if (ev.data !== undefined && !isObj(ev.data)) { fail(`${label}.data, when present, MUST be an object (SPEC §10.1)`); bad++; }

    if (!isStr(ev.type) || !EVENT_TYPE_RE.test(ev.type)) {
      fail(`${label}.type ${JSON.stringify(ev.type)} MUST be a namespaced lowercase dot-path (SPEC §10.2)`);
      bad++;
      return;
    }
    const [ns, second] = ev.type.split(".");
    if (ns === "core") {
      if (ev.source !== "core") { fail(`${label}: source MUST be "core" for core.* events (SPEC §10.1)`); bad++; }
      const known = ["core.capture.triggered", "core.annotation.added", "core.export.created"];
      if (!known.includes(ev.type)) note(`${label}: core event type "${ev.type}" is not defined in 0.1.0 — skipped (readers MUST skip unknown event types, SPEC §10.2)`);
      if (ev.type === "core.annotation.added" && annotationIds && isObj(ev.data) && isStr(ev.data.annotation_id) && !annotationIds.has(ev.data.annotation_id)) {
        note(`${label}: annotation_id "${ev.data.annotation_id}" does not appear in annotations.json (conventional field mismatch, SPEC §10.2)`);
      }
    } else if (ns === "input") {
      fail(`${label}: "${ev.type}" — input.* is reserved for V2; writers MUST NOT emit it in format 0.1.0 (SPEC §10.2)`);
      bad++;
    } else if (ns === "plugin") {
      if (!second || !declaredPlugins.has(second)) { fail(`${label}: plugin event "${ev.type}" does not match any plugin declared in manifest.plugins (SPEC §10.2)`); bad++; }
      else if (ev.source !== second) { fail(`${label}: source MUST equal the plugin name "${second}" for plugin.* events (SPEC §10.1)`); bad++; }
    } else {
      note(`${label}: unknown event namespace "${ns}.*" — skipped (SPEC §10.2)`);
    }
  });
  if (!sorted) { fail(`timeline.json: events MUST be sorted ascending by t_ms (SPEC §10.1)`); bad++; }
  if (bad === 0) pass(`timeline.json: all ${t.events.length} event(s) are well-formed and sorted by t_ms`);
}

// ---------------------------------------------------------------------------
// Pack validation
// ---------------------------------------------------------------------------

function validatePack(pack) {
  // --- required: manifest.json ---
  const manifestBuf = pack.files.get("manifest.json");
  if (!manifestBuf) {
    fail(`manifest.json: missing — REQUIRED; without it this is not a CapturePack (SPEC §5, §13.2)`);
    return;
  }
  pass(`manifest.json: present at the pack root`);
  const manifestParsed = parseJsonFile("manifest.json", manifestBuf);
  if (manifestParsed.error || !isObj(manifestParsed.value)) {
    if (!manifestParsed.error) fail(`manifest.json: MUST be a JSON object`);
    return;
  }
  if (!manifestParsed.bom) pass(`manifest.json: parses as UTF-8 JSON without BOM`);
  const manifest = manifestParsed.value;

  checkNoNulls(manifest, "manifest", new Set(["manifest.media.replay", "manifest.media.replay_duration_ms"]));

  // --- required: snapshot.png ---
  let snapshotDims = null;
  const snapshotBuf = pack.files.get("snapshot.png");
  if (!snapshotBuf) {
    fail(`snapshot.png: missing — REQUIRED (SPEC §6)`);
  } else {
    snapshotDims = pngDimensions(snapshotBuf);
    if (snapshotDims) pass(`snapshot.png: valid PNG, ${snapshotDims.width}x${snapshotDims.height}`);
    else fail(`snapshot.png: not a valid PNG (bad signature or IHDR) (SPEC §6)`);
  }

  // --- manifest fields, media consistency, plugins ---
  const {
    replay,
    replayDurationMs,
    replayAnnotated,
    declaredPlugins,
    displayFiles,
    keyframeFiles,
    displayInfo,
  } = validateManifest(manifest, pack, snapshotDims);

  // --- optional JSON files ---
  let annotationIds = null;
  const annBuf = pack.files.get("annotations.json");
  if (annBuf) {
    const parsed = parseJsonFile("annotations.json", annBuf);
    if (!parsed.error && isObj(parsed.value)) annotationIds = validateAnnotations(parsed.value, snapshotDims, replay, replayDurationMs, displayInfo);
    else if (!parsed.error) fail(`annotations.json: MUST be a JSON object (SPEC §8.1)`);
  } else {
    note(`annotations.json: absent (OPTIONAL — a pack without annotations is valid)`);
  }

  const tlBuf = pack.files.get("timeline.json");
  if (tlBuf) {
    const parsed = parseJsonFile("timeline.json", tlBuf);
    if (!parsed.error && isObj(parsed.value)) validateTimeline(parsed.value, declaredPlugins, annotationIds);
    else if (!parsed.error) fail(`timeline.json: MUST be a JSON object (SPEC §10.1)`);
  } else {
    note(`timeline.json: absent (OPTIONAL — a pack without a timeline is valid)`);
  }

  // --- generated views (SPEC §12): recommended, never required ---
  if (pack.files.has("report.md")) pass(`report.md: present (RECOMMENDED; generated view, not validated as a source of truth — SPEC §12.1)`);
  else note(`report.md: absent (OPTIONAL, but RECOMMENDED for every pack that will be shared — SPEC §12.1)`);

  if (pack.files.has("README.md")) pass(`README.md: present (RECOMMENDED; the human-first entry point — SPEC §12.2)`);
  else note(`README.md: absent (OPTIONAL, but RECOMMENDED — the first document a human reads — SPEC §12.2)`);

  const skillsFiles = [...pack.files.keys()].filter((f) => f.startsWith("skills/"));
  if (skillsFiles.length > 0) {
    pass(`skills/: present with ${skillsFiles.length} document(s) (RECOMMENDED; AI-first context, readable without MCP — SPEC §12.3)`);
    const missing = SKILLS_DOCS.filter((d) => !pack.files.has(`skills/${d}`));
    if (missing.length > 0) {
      note(`skills/: missing recommended document(s): ${missing.join(", ")} (the well-known set is RECOMMENDED, not required — SPEC §12.3)`);
    }
  } else {
    note(`skills/: absent (OPTIONAL, but RECOMMENDED — AI-first context documents — SPEC §12.3)`);
  }

  // --- unknown files: ignored, with a note (forward compatibility, SPEC §13) ---
  const known = new Set(["manifest.json", "snapshot.png", "annotations.json", "timeline.json", "report.md", "README.md"]);
  if (replay) known.add(replay);
  // Per-display media of a multi-monitor capture (SPEC §5.6); undeclared
  // snapshot-d*/replay-d* files fall through to the unknown-file note below.
  for (const name of displayFiles) known.add(name);
  // Annotated stills (SPEC §5.7): declared ones are known, undeclared ones get
  // their own note below — readers MUST ignore them.
  for (const name of keyframeFiles) known.add(name);
  // Undeclared replay_annotated files were already noted in the media checks.
  for (const candidate of ["replay_annotated.webm", "replay_annotated.mp4"]) {
    if (pack.files.has(candidate)) known.add(candidate);
  }
  for (const name of pack.files.keys()) {
    if (known.has(name)) continue;
    if (name.startsWith("skills/")) continue; // skills/ documents are open-ended (SPEC §12.3)
    const pluginMatch = /^plugins\/([^/]+)\//.exec(name);
    if (pluginMatch) continue; // plugin payloads are arbitrary; undeclared dirs already noted
    if (name.startsWith("frames/")) {
      note(`${name}: not declared in manifest.media.keyframes — ignored (readers MUST ignore undeclared stills; writers regenerate frames/ from scratch and declare every still, SPEC §5.7)`);
      continue;
    }
    // One display's own annotated views (SPEC §5.6) follow exactly the same
    // rule as the pack's: undeclared means ignored, never invalid.
    if (/^frames-d[1-9][0-9]*\//.test(name)) {
      note(`${name}: not declared as keyframes on any manifest.media.displays entry — ignored (readers MUST ignore undeclared stills, SPEC §5.6, §5.7)`);
      continue;
    }
    if (/^replay_annotated-d[1-9][0-9]*\.(webm|mp4)$/.test(name)) {
      note(`${name}: not declared as replay_annotated on any manifest.media.displays entry — ignored (readers take a display's annotated replay from its manifest entry, SPEC §5.6)`);
      continue;
    }
    note(`${name}: unknown file — ignored (readers MUST ignore unknown files, SPEC §13.1)`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
  const arg = process.argv[2];
  if (!arg || arg === "--help" || arg === "-h") {
    console.error("Usage: node tools/validate-capturepack.mjs <pack-directory | pack.capturepack | pack.zip>");
    process.exit(2);
  }

  let st;
  try {
    st = statSync(arg);
  } catch {
    console.error(`error: cannot read "${arg}"`);
    process.exit(2);
  }

  let pack;
  if (st.isDirectory()) {
    pack = readDir(arg);
    pass(`container: extracted directory form (${pack.files.size} file(s)) — equally valid (SPEC §3.2)`);
  } else {
    let zip;
    try {
      zip = readZip(readFileSync(arg));
    } catch (e) {
      fail(`container: ${e.message}`);
      report(arg);
      return;
    }
    pack = zip;
    pass(`container: standard ZIP, ${zip.count} entries, store/deflate only, not encrypted (SPEC §3.1)`);

    // Defensive tolerance: accept a single wrapping top-level directory
    // (readers MAY; writers MUST NOT produce one — SPEC §3.1).
    if (!pack.files.has("manifest.json")) {
      const tops = new Set([...pack.files.keys()].map((n) => n.split("/")[0]));
      const top = tops.size === 1 ? [...tops][0] : null;
      if (top && pack.files.has(`${top}/manifest.json`)) {
        const files = new Map();
        for (const [k, v] of pack.files) files.set(k.slice(top.length + 1), v);
        const dirs = new Set([...pack.dirs].filter((d) => d !== top && d.startsWith(`${top}/`)).map((d) => d.slice(top.length + 1)));
        pack = { files, dirs };
        note(`container: all entries are wrapped in "${top}/" — accepted defensively, but writers MUST place core files at the archive root (SPEC §3.1)`);
      }
    }
  }

  validatePack(pack);
  report(arg);
}

function report(input) {
  const label = { pass: "PASS", fail: "FAIL", note: "NOTE" };
  console.log(`capturepack validator (spec ${SPEC_VERSION})`);
  console.log(`input: ${input}`);
  console.log("");
  for (const r of results) console.log(`  ${label[r.status]}  ${r.text}`);
  const failed = results.filter((r) => r.status === "fail").length;
  const passed = results.filter((r) => r.status === "pass").length;
  const notes = results.filter((r) => r.status === "note").length;
  console.log("");
  console.log(`result: ${failed === 0 ? "VALID" : "INVALID"} — ${passed} passed, ${failed} failed, ${notes} note(s)`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
