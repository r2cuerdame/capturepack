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

function validateManifest(m, pack) {
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

  return { replay, replayDurationMs, declaredPlugins: declared };
}

function validateAnnotations(a, snapshotDims, replay, replayDurationMs) {
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
  a.annotations.forEach((ann, i) => {
    const label = `annotations.json: annotations[${i}]`;
    if (!isObj(ann)) { fail(`${label} MUST be an object`); bad++; return; }
    if (!isStr(ann.id) || ann.id.length === 0) { fail(`${label}.id MUST be a non-empty string (SPEC §8.3)`); bad++; }
    else if (knownIds.has(ann.id)) { fail(`${label}.id "${ann.id}" is not unique within the file (SPEC §8.3)`); bad++; }
    else knownIds.add(ann.id);

    if (ann.z !== undefined && !isInt(ann.z)) { fail(`${label}.z MUST be an integer (SPEC §8.3)`); bad++; }
    if (ann.color !== undefined && (!isStr(ann.color) || !COLOR_RE.test(ann.color))) { fail(`${label}.color MUST be "#RRGGBB" or "#RRGGBBAA" (SPEC §8.3)`); bad++; }
    if (ann.created_at !== undefined && !isIsoWithTz(ann.created_at)) { fail(`${label}.created_at MUST be ISO 8601 with timezone (SPEC §8.3)`); bad++; }
    if (ann.t_ms !== undefined) {
      if (!isNum(ann.t_ms)) { fail(`${label}.t_ms MUST be a number (SPEC §8.3)`); bad++; }
      else if (!replay) note(`${label}.t_ms is ${ann.t_ms} but the pack has no replay — t_ms is a replay position and is only meaningful with a replay (SPEC §8.3)`);
      else if (replayDurationMs !== null && (ann.t_ms < 0 || ann.t_ms > replayDurationMs)) note(`${label}.t_ms ${ann.t_ms} lies outside the replay [0, ${replayDurationMs}] ms (SPEC §8.3)`);
    }

    const req = (fields, pred, what) => {
      for (const f of fields) {
        if (!pred(ann[f])) { fail(`${label} (${ann.type}): "${f}" MUST be ${what} (SPEC §8.4)`); bad++; }
      }
    };
    switch (ann.type) {
      case "pin":
        req(["x", "y"], isNum, "a number");
        if (ann.label !== undefined && !isStr(ann.label)) { fail(`${label}.label MUST be a string`); bad++; }
        break;
      case "arrow":
        req(["x1", "y1", "x2", "y2"], isNum, "a number");
        break;
      case "rect":
      case "blur":
        req(["x", "y"], isNum, "a number");
        req(["w", "h"], (v) => isNum(v) && v > 0, "a number > 0");
        if (ann.type === "rect" && ann.label !== undefined && !isStr(ann.label)) { fail(`${label}.label MUST be a string`); bad++; }
        if (ann.type === "blur" && ann.color !== undefined) note(`${label}: color on a blur annotation SHOULD be omitted (SPEC §8.3)`);
        break;
      case "text":
        req(["x", "y"], isNum, "a number");
        if (!isStr(ann.text)) { fail(`${label} (text): "text" MUST be a string (SPEC §8.4)`); bad++; }
        if (ann.size !== undefined && (!isNum(ann.size) || ann.size <= 0)) { fail(`${label}.size MUST be a number > 0 (SPEC §8.4)`); bad++; }
        break;
      default:
        if (isStr(ann.type)) note(`${label}: unknown type "${ann.type}" — skipped (readers MUST skip unknown annotation types, SPEC §8.3)`);
        else { fail(`${label}.type MUST be a string (SPEC §8.3)`); bad++; }
    }
  });
  if (bad === 0) pass(`annotations.json: all ${a.annotations.length} annotation(s) are well-formed`);
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
  const { replay, replayDurationMs, declaredPlugins } = validateManifest(manifest, pack);

  // --- optional JSON files ---
  let annotationIds = null;
  const annBuf = pack.files.get("annotations.json");
  if (annBuf) {
    const parsed = parseJsonFile("annotations.json", annBuf);
    if (!parsed.error && isObj(parsed.value)) annotationIds = validateAnnotations(parsed.value, snapshotDims, replay, replayDurationMs);
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

  if (pack.files.has("report.md")) pass(`report.md: present (RECOMMENDED; generated view, not validated as a source of truth — SPEC §12)`);
  else note(`report.md: absent (OPTIONAL, but RECOMMENDED for every pack that will be shared — SPEC §12)`);

  // --- unknown files: ignored, with a note (forward compatibility, SPEC §13) ---
  const known = new Set(["manifest.json", "snapshot.png", "annotations.json", "timeline.json", "report.md"]);
  if (replay) known.add(replay);
  for (const name of pack.files.keys()) {
    if (known.has(name)) continue;
    const pluginMatch = /^plugins\/([^/]+)\//.exec(name);
    if (pluginMatch) continue; // plugin payloads are arbitrary; undeclared dirs already noted
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
