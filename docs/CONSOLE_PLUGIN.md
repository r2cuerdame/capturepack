# Console context provider — design baseline

**Status: planning document for the 2026-12 milestone (0.6.2 candidate).
Nothing described here is implemented yet.** It fixes the storage layout, the
collection budget, the masking rules and the write order that a console
provider must meet *before* any code is written, so the prototype is built
against a contract instead of discovering one.

[SPEC.md](../SPEC.md) stays normative. This document adds no format version and
changes no rule: a console payload is an ordinary plugin payload under
[SPEC §11](../SPEC.md#11-plugins), and everything in
[§11.1](../SPEC.md#111-rules) and [§5.4](../SPEC.md#54-plugins) applies to it
unchanged. If the payload later becomes a well-known shape that readers rely
on, its definition moves into SPEC §11 the way `windows-uia` did, and this
document then points there.

Sources this baseline is derived from:

- [ROADMAP — Next milestone 2026-12](../ROADMAP.md#next-milestone--2026-12-062-candidate-planning-only)
  and the same plan in [HANDOFF](HANDOFF.md#next-milestone--2026-12-062-candidate-planning-only):
  collection within 100 ms, missing/inaccessible/slow data omitted, the pack
  still saves normally, cost 0.
- [ARCHITECTURE §1.3](../ARCHITECTURE.md#13-plugins-append-never-modify):
  plugins append metadata and never modify the capture.
- The Git provider in `core/src/main/plugins/git.ts`, which already meets the
  same 100 ms fail-open budget and publishes `meta.json` last.
- The publish order and failure cleanup that `core/src/main/exporter.ts` uses
  for `windows-uia`, `chrome-dom` and `windows-context`: payload first,
  `meta.json` last, and a directory that never received its `meta.json`
  removed after a failed write.

---

## 1. What is collected, and what is not

The provider records the **recent text output of a supported console** at the
capture instant, so a pack about a failing build or a crashing tool carries the
error text instead of only its picture.

- It reads output the console has **already displayed** — the text a person
  could have scrolled back to. It never hooks standard input, never reads the
  keyboard, never writes or injects input into a console, and never starts or
  signals a process to make it print something. `input.key.*` stays reserved ([SPEC §10.2](../SPEC.md#102-event-namespaces));
  a console payload is not a way round that rule.
- Which consoles count as *supported* is the prototype's decision. This
  document fixes the contract every supported source has to meet; it does not
  choose the source.
- The provider is optional context. It cannot delay the hotkey, change the
  snapshot or replay, or touch any core file.

## 2. Folder layout and file list

A pack whose console collection succeeded contains exactly one extra directory:

```
CapturePack_2026-12-03_101500/
├── manifest.json            declares plugins/console/ (only if both files below landed)
├── snapshot.png
├── …                        all other core files, unchanged
└── plugins/
    └── console/
        ├── output.log       the masked, bounded recent console output
        └── meta.json        written last; its presence publishes the payload
```

| File | Required | Written | Contents | Limit |
|---|---|---|---|---|
| `plugins/console/output.log` | REQUIRED when the directory exists | First | UTF-8 text without BOM, `\n` line endings, terminal control sequences removed, every secret masked ([§4](#4-masking-rules)). Oldest kept line first, newest last. | At most 100 lines **and** at most 256 KiB (262,144 bytes) |
| `plugins/console/meta.json` | REQUIRED ([SPEC §11.1](../SPEC.md#111-rules)) | Last | The fields below | Small fixed object |

`meta.json` carries the two fields SPEC §11.1 requires plus provider-defined
fields that readers may ignore:

| Field | Type | Description |
|---|---|---|
| `name` | string | Always `"console"` — equals the directory name and the manifest entry. |
| `version` | string | Provider version, starting at `"0.1.0"`. |
| `output` | string | Always `"output.log"`, the payload file this metadata publishes. |
| `source` | string | The kind of console the text came from, named by the provider (for example the terminal family). Never a window title, path or command line. |
| `line_count` | integer | Lines actually written to `output.log` after masking and bounding. |
| `byte_count` | integer | Bytes actually written to `output.log`. |
| `truncated` | boolean | `true` when older output was dropped to fit the line or byte limit. |
| `redaction_count` | integer | How many values were replaced by `[REDACTED]`. A count only — never which rule matched where. |
| `collected_ms` | integer | Measured collection time; always at most the 100 ms budget, because a slower collection writes nothing. |

The manifest declaration is the standard [SPEC §5.4](../SPEC.md#54-plugins) entry:

```json
{ "name": "console", "version": "0.1.0", "path": "plugins/console/" }
```

No other file is written. The provider emits no `plugin.console.*` timeline
events in this milestone: the output belongs in the plugin directory, and the
timeline is an index, not a data store ([SPEC §10.2](../SPEC.md#102-event-namespaces)).

**Absence means "not collected", never "no errors".** A pack without
`plugins/console/` says nothing about what the console showed — no supported
console, access refused, too slow, or a failed write all look the same on disk.
Readers, reports and AI tools must not phrase absence as a clean console.

## 3. Time limit — the 100 ms budget

The five-second capture workflow is the constraint every milestone keeps
([ROADMAP](../ROADMAP.md)). The console provider spends at most **100 ms** of
the save, measured from the moment collection starts to the moment its text is
in memory, masked and bounded.

- One budget for the whole collection — finding the console, reading it,
  masking and bounding — not 100 ms per step.
- Enforced twice, as `collectGitState()` does: a deadline raced against the
  collection, then a measured check that discards a result which arrived late.
  A result that took 101 ms is thrown away even though it is complete.
- Any helper process runs hidden (`windowsHide`) with its own timeout no larger
  than the remaining budget, and is not waited for after the deadline.
- No retry, no second attempt later in the same save, no prompt to the user.
- The budget is a ceiling, not a target. The capture instant is already fixed —
  the snapshot and replay are in memory when collection runs — so the provider
  can delay when the pack lands on disk by at most the budget, and never changes
  what was captured.

Every outcome other than success is the same outcome — **omit and keep saving**:

| Situation | `plugins/console/` | Manifest entry | Pack saves |
|---|---|---|---|
| Collected, masked and bounded within 100 ms | Written | Added | Yes |
| No supported console present | Not created | None | Yes |
| Console present but access refused | Not created | None | Yes |
| Collection exceeds 100 ms | Not created | None | Yes |
| Masking or bounding throws | Not created | None | Yes |
| Writing either file fails | Removed ([§5](#5-safe-write-order)) | None | Yes |

A failure is logged to the main-process log the way the other providers log
theirs (`capturepack: writing plugins/console failed: …`), without the console
text itself. There is no toast: optional context must not interrupt the
five-second workflow.

## 4. Masking rules

Masking runs in memory on the collected text **before** the size bounds are
applied, so a limit can never cut a secret in half and leave the half that the
pattern no longer recognises. Unmasked text is never written to disk — not to a
temporary file, not to a log, not as a fallback when masking fails.

Order of processing:

1. Normalise line endings to `\n` and strip terminal control sequences (ANSI
   colour and cursor codes), so a colour code cannot split a token away from
   its pattern.
2. Apply every rule below to the whole collected text.
3. Apply the bounds ([§4.2](#42-size-bounds)).

### 4.1 Rules

Every match is replaced by the fixed string `[REDACTED]`. The replacement never
preserves the secret's length, prefix, suffix or a hash of it — a hash of a
short password is a password with extra steps. Matching is case-insensitive
unless the rule says otherwise.

| Rule | What it matches (case-insensitive unless noted) | What is kept |
|---|---|---|
| Bearer token | `Bearer` followed by a token: `\bbearer\s+[A-Za-z0-9\-._~+/]+=*` | `Bearer [REDACTED]` |
| Authorization header | `authorization` followed by `:` or `=` and the rest of the value, any scheme (`Basic`, `Token`, …) | `Authorization: [REDACTED]` |
| Named secret | A key whose name contains `api_key`, `apikey`, `api-key`, `secret`, `token`, `password`, `passwd`, `pwd`, `access_key`, `private_key` or `client_secret`, followed by `:` or `=` and a value — quoted (`"…"`, `'…'`) or up to the next whitespace | The key name and separator, e.g. `API_KEY=[REDACTED]` |
| URL credentials | `scheme://user:password@host` | `scheme://[REDACTED]@host` |
| Secret query parameters | `?` or `&` followed by `access_token`, `token`, `api_key`, `apikey`, `key`, `sig`, `signature` or `password` and `=` | The parameter name, e.g. `&token=[REDACTED]` |
| Well-known token shapes (case-sensitive) | `gh[pousr]_[A-Za-z0-9]{36,}`, `github_pat_[A-Za-z0-9_]{22,}`, `\b(?:AKIA\|ASIA)[0-9A-Z]{16}\b`, `xox[abprs]-[A-Za-z0-9-]{10,}`, `\bsk-[A-Za-z0-9_-]{20,}`, `AIza[0-9A-Za-z_-]{35}` | Nothing of the token |
| JSON Web Token (case-sensitive) | `eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+` | Nothing of the token |
| Private key block | From a `-----BEGIN … PRIVATE KEY-----` line through its `-----END … PRIVATE KEY-----` line | One `[REDACTED]` line for the whole block |

A private key block cut by the collection window fails closed: a `BEGIN` line
with no `END` masks everything from `BEGIN` to the end of the text, and an
`END` line with no `BEGIN` before it masks everything from the start of the
text to `END`.

### 4.2 Size bounds

After masking, keep the **newest** output:

1. Keep at most the last 100 lines.
2. If those lines exceed 256 KiB, drop whole lines from the oldest end until
   the text fits.
3. If a single remaining line alone exceeds 256 KiB, keep its last 256 KiB,
   cut on a UTF-8 code-point boundary so the file never holds a broken
   character.

`truncated` in `meta.json` is `true` whenever step 1, 2 or 3 dropped anything.

### 4.3 What masking does not promise

These rules are a deny-list. They remove the shapes listed above; they cannot
prove the remaining text is free of personal data or secrets, and nothing in
the product may call the result sanitized — the same position the Share Copy
takes ([SPEC §9.4](../SPEC.md#94-share-copy-distribution)). Where the masked
text can travel today:

- **Share Copy** (`.share.zip`) excludes all structured plugin context, so the
  console payload never leaves through it.
- **The full `.zip` / `.capturepack`** includes every plugin directory. Its
  existing originals warning covers the console payload too.
- **The reference webhook action** sends a summary read from `manifest.json`
  (`core/src/main/actions/webhook.ts`), not plugin files.
- **Local readers** of the pack folder, the MCP server included, see the masked
  text.

A new rule is added when a real leak shape is found; a rule is never removed
to make output look fuller.

## 5. Safe write order

The pack folder must never hold a console directory that looks published but is
not complete. The order below is the one the Git payload adopted in
[#410](https://github.com/r2cuerdame/capturepack/pull/410) and the
`windows-uia`, `chrome-dom` and `windows-context` payloads adopted in
[#412](https://github.com/r2cuerdame/capturepack/pull/412), after
[#408](https://github.com/r2cuerdame/capturepack/pull/408) pinned that Git
changed paths containing tabs and newlines are written intact.

1. **Finish in memory first.** Collect, mask and bound completely. Nothing
   touches the disk until the final `output.log` text and the `meta.json`
   object exist in memory.
2. **Create the directory** `plugins/console/`.
3. **Write `output.log` atomically**: write `output.log.<pid>.<uuid>.tmp`,
   then rename it onto `output.log`. The temporary file is removed in a
   `finally` block whether or not the rename succeeded.
4. **Write `meta.json` atomically, last**, the same way. `meta.json` is what a
   reader takes as "this plugin exists", so it lands only after the payload it
   publishes.
5. **Declare only what landed.** The `plugins/console/` entry is added to the
   manifest only when steps 3 and 4 both succeeded. `manifest.json` is the
   pack's commit point and is published after every file it declares
   ([SPEC §3.1](../SPEC.md#31-the-pack-folder-the-save-unit)).

If any step fails:

- The temporary file of the failed step is already gone (step 3/4 `finally`).
- A `plugins/console/` directory without a regular-file `meta.json` never
  finished. It is removed recursively, the way `removeUnpublishedPluginDir()`
  in `core/src/main/exporter.ts` removes an unfinished `windows-uia` or
  `chrome-dom` directory.
- The provider reports "not written", so no manifest entry is made.
- The save continues. The pack is complete without console context.

| Failure point | Left on disk afterwards | Manifest |
|---|---|---|
| Before step 2 | Nothing | No entry |
| Step 3 (`output.log`) | Nothing — temporary file removed, directory removed | No entry |
| Step 4 (`meta.json`) | Nothing — temporary file removed, directory removed with its `output.log` | No entry |
| After step 4, the pack save itself fails | Nothing — the whole pack folder is removed by the existing save-first cleanup in `savePack()` | — |

Never:

- write `meta.json` before `output.log`;
- write the manifest entry before both files exist;
- leave a `*.tmp` file in the pack;
- fall back to writing unmasked or unbounded text when masking or bounding
  fails;
- let a console failure turn into a failed capture.

## 6. Checks the prototype must add

The prototype is not done until a deterministic script — planned as
`check:console-plugin` in `core/package.json`, so the QA gate discovers it —
asserts every case below without a real console:

- **Success:** a fake source returns text; `plugins/console/output.log` and
  `meta.json` exist, the manifest declares `plugins/console/`, and the pack
  passes SPEC validation.
- **Absent and refused:** no source, and a source that throws an access error;
  no directory, no manifest entry, pack saved.
- **Timeout:** a source that answers after 100 ms, and one that never answers;
  no directory, no manifest entry, and the save is not held past the budget.
- **Masking:** one input per rule in [§4.1](#41-rules), including a private key
  block split at either end of the window and a token wrapped in colour codes;
  no input secret appears in `output.log`.
- **Bounds:** 101 lines, more than 256 KiB of short lines, one line over
  256 KiB, and a multi-byte character at the cut; the newest text is kept and
  the file is valid UTF-8.
- **Write failure:** a failure injected while writing `output.log` and while
  writing `meta.json`; no `plugins/console/`, no `*.tmp`, no manifest entry,
  and the pack still saves.

Then the full QA gate and SPEC validation run as for any other change, as the
milestone in [ROADMAP](../ROADMAP.md#next-milestone--2026-12-062-candidate-planning-only)
requires.

## 7. Open questions for the prototype

These are left to the prototype on purpose; each answer must keep every rule
above.

- Which console sources are supported first, and how the provider finds the
  one that belongs to the capture (focused window, last active console).
- Whether a capture with several consoles records one or none — never a merge
  of several into one `output.log`, which would make the order a guess.
- Whether the provider is on by default. That is a product decision for the
  owner, made with the results of the checks in
  [§6](#6-checks-the-prototype-must-add); this baseline does not decide it.
