# Roadmap

This file maps the path from [GOAL.md](GOAL.md) to shippable milestones. The format itself is
defined in [SPEC.md](SPEC.md) — spec before code, always. This roadmap tracks sequence and honest
status; it never overrides either document.

**Status legend:** `Done` · `In progress` · `Not started`.
**Shipping since 2026-07-27:** the auto-update chain was first verified end to
end on a real install (0.1.0 → 0.1.1 → 0.1.2). The active source and
documentation baseline and current public
[GitHub Release](https://github.com/r2cuerdame/capturepack/releases/latest) are
**0.5.0**.
What is *not* yet proven is the long-run habit — the one-month
no-manual-reinstall criterion is still running.

The guiding constraint for every milestone: **never sacrifice the 5-second workflow.**

```
Ctrl+Alt+C  →  capture  →  5-second annotation  →  save folder  →  share from History
```

---

## Current baseline — 0.5.0

The milestone narrative below is preserved as the product's design and
verification history. These are the current additions and next gates:

- Video context uses `Ctrl+Alt+C`; explicit cross-monitor region or complete
  virtual-desktop image context uses independently configurable `Ctrl+Alt+S`.
  Capture rate is 5–30 fps.
- Object Pick is a still-image affordance. A screenshot — live or reopened from
  History — picks real objects out of the captured Windows surface/control
  evidence, built-in UI Automation, optional Chrome DOM preview observations and
  an HWND fallback. A video offers no object picking at any frame, the captured
  instant included: it takes the boxes the user draws, each with a lifetime,
  while the same control evidence keeps being recorded into the pack's
  windows-context timeline. Observed motion is never interpolated; authored
  manual-box keyframes may interpolate across displays.
- Image packs and video packs have distinct storage contracts. Image packs
  contain no replay or top-level `timeline.json`.
- MCP is optional, loopback-only and read-only. It reads already-saved packs
  and cannot start a capture.
- 0.3.1 gates mixed-DPI Chrome DOM geometry, regeneration after late plugin
  context, and guidance that names only manifest-declared derived artifacts.
- 0.3.2 gates exact native selector coverage on portrait/mixed-monitor desks,
  selection-owned editor placement, lossless editor bootstrap, and persistent
  manual/semantic box ownership.
- 0.3.3 adds the offline pack viewer, bounded replay/recorder ownership,
  measured capture-health evidence and expanded temporal/multi-display QA.
- 0.3.4 ships element picking that reports arming, failure and every refusal
  instead of failing silently; picking inside iframes with a measured frame
  offset; an explicitly picked document element no longer filtered by a
  threshold measured for UI Automation enumerations
  ([#104](https://github.com/r2cuerdame/capturepack/issues/104)); a routine
  update notice held over a locked screen
  ([#103](https://github.com/r2cuerdame/capturepack/issues/103)); a screenshot
  that carries the page of every visible browser window rather than the one
  Chrome last focused
  ([#132](https://github.com/r2cuerdame/capturepack/issues/132)); and a replay
  that stops writing a quiet screen as a shorter recording
  ([#116](https://github.com/r2cuerdame/capturepack/issues/116)).
  0.3.4 also **removes object picking from a video entirely**
  ([#119](https://github.com/r2cuerdame/capturepack/issues/119)): control
  geometry could only be sampled at a 3% duty cycle and skipped Chromium
  altogether, so a scrubbed frame offered the window and never the thing inside
  it. A video now takes manual boxes only; a still keeps the whole affordance
  and gains the visible page of every visible browser window. Pinned by
  `check:video-no-picking`.
- **[#89](https://github.com/r2cuerdame/capturepack/issues/89) is closed, and
  not by a correction.** Overlays can lead the recorded video, and the picture
  runs on the order of 100 ms behind its own timestamp — two estimators sharing
  no code agree on the magnitude, and `qa:exposure-field` now measures it from
  any saved pack and refuses rather than guessing. What could not be settled is
  the exact figure: five separate confounds were found and fixed on the way, and
  the answer moved each time. The only correction design that survived the cost
  analysis measured one capture and corrected the next, which means telling
  someone their first capture was a calibration run — not a thing a screenshot
  tool may say. So no correction ships. A box marks the moment it was picked at,
  and a replay no longer claims to know where a control went afterwards. Kept
  from the whole investigation: the harness, and the real defect it found (#116
  above, the recorder writing a quiet screen short).
- 0.3.5 **removes the second process** — the watchdog and its supervisor are
  gone ([#80](https://github.com/r2cuerdame/capturepack/issues/80), closing
  [#78](https://github.com/r2cuerdame/capturepack/issues/78)) — because a
  supervisor cannot fix an app that died from a bug in the app, and the symptom
  it was reasoned onto is answered by a crash dump, a next start that says it
  stopped unexpectedly, and the Windows login item. It also adds a retention
  policy and a storage budget that run themselves
  ([#47](https://github.com/r2cuerdame/capturepack/issues/47),
  [#48](https://github.com/r2cuerdame/capturepack/issues/48)), pin numbers the
  user assigns rather than the app
  ([#51](https://github.com/r2cuerdame/capturepack/issues/51)), CI that records
  a real capture and asserts on the pack it produced
  ([#63](https://github.com/r2cuerdame/capturepack/issues/63)), and a keyframe
  that declares the size it actually is
  ([#133](https://github.com/r2cuerdame/capturepack/issues/133)).
- For video captures, 0.4.0 makes **N screens the normal case**:
  `media.displays` is always present, a single-monitor capture writes an array
  of one, and every display states the
  size of its own image measured from the file that was written rather than
  recomputed from its bounds — pack format 0.7.0
  ([#75](https://github.com/r2cuerdame/capturepack/issues/75)). The timeline
  also records what moved: `input.mouse.*` and `input.window.*` on the replay
  clock, pack format 0.8.0, declared only when a capture carries such an event
  ([#12](https://github.com/r2cuerdame/capturepack/issues/12)). `input.key.*`
  stays reserved and is never written — a screenshot contains every pixel you
  could see, and a keystroke is not among them.
- 0.4.1 makes a **saved pack's browser page readable again**: the reader asked
  for the viewport in a different spelling than the writer uses, and no pack had
  ever persisted the browser window's drawable area, so a pack could hold a
  complete document and place none of it. Capture was never affected, which is
  exactly why it survived three releases
  ([#136](https://github.com/r2cuerdame/capturepack/issues/136)). It also makes
  object picking measured rather than assumed — a check sweeps a saved pack on a
  grid and fails the build if what is offered under the cursor grows past a
  measured limit ([#134](https://github.com/r2cuerdame/capturepack/issues/134))
  — has CI assert on a pack whose derived stills were really rendered
  ([#135](https://github.com/r2cuerdame/capturepack/issues/135)), and pins four
  of #76's five three-screen risks on a synthetic desk.
- 0.4.3 stops a captured web page offering its own layout containers. #134's
  sweep — added in 0.4.1 precisely so this class of decay could not go unnoticed
  again — caught it on a real capture: chrome-dom answered 94.5% of hover points
  and the median rectangle offered was 32.22% of the frame against a 15% limit.
  The cause was a premise that stopped being true: 0.3.4 exempted
  `document-native` candidates from the container filter because such a
  candidate was one element a human had pointed at, and the same release taught
  a still to record every element of the visible document under that same
  authority. A provider now states which of the two a candidate is; an
  enumerated container is offered one rung back and an explicit pick still wins.
  Worst pack 32.22% → 5.88%, with the page still read in full. 0.4.3 also makes
  the 5-second workflow itself a measured number — every capture records how
  long it took to reach a usable editor, excluding the time the user held it —
  and promotes `capture-e2e` from advisory to a required CI job.
- 0.4.4 ships History review and creation of a separate
  `capturepack-share` `.share.zip` with the `reviewed-stills-only` profile. Its
  exact media allowlist contains only manifest-declared annotated keyframe PNGs:
  every PNG is decoded to pixels and deterministically re-encoded without
  ancillary chunks or trailing payload. Every thumbnail is derived from those
  exact outbound bytes and every full-resolution still is available lazily at
  1:1. A generated README, offline viewer and minimal inventory accompany that
  media. Share Copy excludes original media, all video containers including
  annotated replays, and structured pack context; rejects malformed or partial
  display lanes; blocks blur boxes whose labels would be drawn back into the
  result; preserves both raced destinations and the authoritative source folder;
  and deliberately does not call the result sanitized. The full `.zip` remains
  available under More with an originals warning
  ([#140](https://github.com/r2cuerdame/capturepack/issues/140),
  [#141](https://github.com/r2cuerdame/capturepack/pull/141)).
- Next: the three-screen acceptance test on REAL hardware — one portrait, one
  scaled, focus on the third — is still unrun, and
  [#76](https://github.com/r2cuerdame/capturepack/issues/76) stays open until
  someone with that desk works its checklist; a synthetic desk pins the risks it
  can honestly reach and cannot stand in for the machine. On three screens the
  tray and the toast now name which display lost its replay across nine locales
  ([#137](https://github.com/r2cuerdame/capturepack/issues/137)). Beyond that:
  the plugin platform ([#69](https://github.com/r2cuerdame/capturepack/issues/69),
  [#68](https://github.com/r2cuerdame/capturepack/issues/68)), code signing
  ([#21](https://github.com/r2cuerdame/capturepack/issues/21)), continued
  physical mixed-DPI/long-running recording, save/reopen, installer/update and
  Chrome reconnection QA, plus stronger share-specific opaque redaction whose
  pixels are proven independent of the covered source region.

---

## Where things stand

The table and milestone sections below record what each historical phase meant
at the time. Current shipped behavior is summarized above and in
[README.md](README.md); unresolved work is tracked in GitHub Issues.

| Milestone | Scope | Status |
|---|---|---|
| Format spec | SPEC.md + JSON Schemas (`docs/schemas/`) | Draft; additive contracts through 0.8.0 implemented by the reference writer. A video pack declares 0.7.0 (`media.displays` always present), and 0.8.0 when it carries `input.*` events |
| **V1 — MVP + release** | Capture, annotate (scrub timeline), export + installable auto-updating Windows release | **Done — shipped v0.1.0 → v0.1.2** |
| **V1.5 — MCP server** | Always-on read-only MCP so any AI reads packs natively | Shipped in v0.1.1 (daily-use verification ongoing) |
| **V1.6 — Working with saved packs** | History (browse/re-edit/re-render/package), replay trim, 9 languages, configurable hotkey | Shipped in v0.1.2 |
| **V1.7 — Truth** | A recorder that proves frames before claiming them, picking that offers the thing under the cursor, an app that leaves a record and does not stay gone | Shipped in v0.1.6 → v0.1.7. The "does not stay gone" half was a supervisor process; it was removed in 0.3.5 ([#80](https://github.com/r2cuerdame/capturepack/issues/80)) and the record half — crash dump, and a next start that says it stopped unexpectedly — is what carried the intent |
| **V2 — Temporal plugin system** | Providers that restore the PAST at any buffered time (one clock, checkpoints + deltas), a platform surface timeline that decides what the user was actually looking at, after-save actions that can never cost a capture, Chrome extension as the first web provider | Partially implemented — Core surface timeline, UIA history and Chrome preview shipped; general API pending |
| **V3 — Semantic layer** | Tracked annotations following their object through the replay, AI-assisted annotation | Partially implemented — semantic targets and observed tracks shipped; app/engine providers pending |

The milestone narrative below is a historical sequence, not a second statement
of the current contract. Current shipped behavior is the baseline above.

---

## V1 — MVP + installable, self-updating release

V1 is two halves, and **both are required**. The tool half is the MVP workflow from GOAL.md. The
release half is deployment infrastructure: **auto-update is required in V1, not optional** — the
creator uses CapturePack daily while fixing it frequently, and hand-replacing files breaks the
usage habit that the whole project is measured by.

### Capture — Implemented (continued field verification)

- [x] Bounded per-display replay ring: one fragmented-MP4 recorder when
      supported, with an honest dual-slot WebM fallback
- [x] Native-resolution per-display video snapshots plus explicit region/full
      virtual-desktop image capture
- [x] Independently configurable global video and image hotkeys

### Annotation — Implemented; temporal accuracy remains under field QA

- [x] One unified box annotation; numbering, text, lifetime and blur are box
      properties, not separate annotation types
- [x] Keyboard-first editing, instant undo and editable source data
- [x] **Scrub-timeline editor** (GOAL "Editor Input System"): wheel ±100 ms / Shift ±1 s /
      Alt ±1 frame (up = past, invert option), Ctrl+wheel zoom, Space+drag pan, timeline drag,
      right-click-drag rect with immediate description — the chosen frame becomes the snapshot
      (`media.snapshot_t_ms`)
- [x] **Annotation lifetime** (GOAL "Annotation Timeline & Lifetime"): manual annotations get a
      default 1.0 s duration (±0.5 s, clamped), duration label + editor with presets, × delete,
      lifetime bars on the timeline (`t_start_ms` / `t_end_ms`)
- [x] Object Pick binds a box to captured UIA/Chrome DOM/HWND evidence in a
      STILL capture; a video takes manual boxes only. Observed rectangles
      written by earlier releases still render from measured samples, never
      from interpolation

### Export — Implemented

- [x] Folder-first CapturePack sources plus an optional full `.zip` distribution
- [x] Original snapshot/replay media remain untouched; blur renders only into
      declared derived views and the pack warns that originals remain sensitive
- [x] A reviewed `capturepack-share` Share Copy packages only declared annotated
      keyframe stills as media through a closed media allowlist, accompanied by
      a generated README, offline viewer and minimal inventory; it canonicalizes
      the PNG pixels, excludes originals, all videos and structured context, and
      remains distinct from the CapturePack evidence contract
- [x] `viewer.html`, `README.md`, `report.md` and `skills/` generated from the
      source contract
- [x] Video packs may contain `timeline.json`; explicit image packs never do

### Release & auto-update — PROVEN (v0.1.0 → v0.1.1 update delivered end-to-end, 2026-07-27)

The V1 completion criteria from GOAL.md, verbatim:

- [x] **Installable Windows release** (v0.1.0 and v0.1.1 on GitHub Releases)
- [x] **GitHub Releases-based updater** — the installed 0.1.0 detected and
      background-downloaded 0.1.1 by itself; no separate update server
- [x] **Update notification and restart-to-update UX** (tray item + notification)
- [x] **Rollback-safe installation** (old version stays until the new one installs)
- [x] **Automatic build and release workflow** (tag → CI → installer + latest.yml +
      SHA256SUMS, twice)

Supporting: sha512-verified updates from `latest.yml` + published `SHA256SUMS.txt`; auto-check
toggle in settings; code signing when possible; channels later. Landing page: **done** —
[capturepack.dev](https://capturepack.dev) with Download pointing at the latest Release.

### V1 exit test

Tag `v0.1.x`, watch CI publish the installer, install it once, use it daily, and receive at
least one update through restart-to-update — **a full month with no manual reinstall.**

---

## V1.5 — Always-On MCP Server (read-only) — Implemented (live-usage verification pending)

Implemented ahead of the first release (GOAL "Always-On MCP Server"). The MCP server lives
inside CapturePack.exe (Streamable HTTP at `http://127.0.0.1:39393/mcp`, localhost only),
watches the export folder, and lets any AI analyze packs without the user explaining
anything — "Analyze the latest CapturePack." is the whole prompt. Like the rest of the app,
continued field verification remains ongoing. Client setup and the full tool reference:
[docs/MCP.md](docs/MCP.md).

- [x] Recent-pack index + export-folder watcher (no manual refresh)
- [x] Read-only tools: `latest` · `history` · `list` · `open` (dir or zip) · `summary` · `manifest` ·
      `report` · `timeline(from_ms,to_ms)` · `annotations` · `find_annotations` ·
      `frame(time_s)` · `replay` · `dom` / `find_dom` · `windows` · `search` ·
      `export_markdown` — exposed as `capturepack_*` tool names; every pack-reading tool
      defaults to the current pack. `frame` returns the nearest declared
      annotated keyframe when available, otherwise `snapshot.png`; arbitrary
      replay-frame extraction remains future work
- [x] Generic plugin-metadata exposure (MCP never special-cases plugin kinds)
- [x] Settings → MCP (enable, autostart, read-only, watch, port, request log)
- [x] Never creates/edits captures — capture always belongs to the application

---

## V2 — Temporal plugin system

Status: **Partially implemented.** Core temporal context is shipped; the
general third-party provider and after-save APIs are not frozen.

The plugin model V2 was originally scoped for — call a context provider once, at the capture
instant — does not survive contact with the product: the user scrubs thirty seconds into the
past, and a structural context collected at one moment cannot answer a question about second 7.
Confirmed in live use of v0.1.6, and fixed honestly rather than fully in v0.1.7 (picking is
refused away from the capture instant instead of quietly answering for the wrong moment).

V2 is the redesign in GOAL.md > "Plugin System, redesigned": **temporal context providers**
on the app's own monotonic clock, storing checkpoints plus deltas rather than a tree per frame;
a **Platform Surface Timeline** in Core deciding which window was on top at time T, because a
numeric priority cannot settle a Notepad window in front of a windowed Unreal game; and **after
save actions**, the half that gets the stable public API, because that is where a third party's
mistake lands visibly on whoever wrote it.

The Core surface timeline, bounded Windows UIA history and Chrome preview
provider are implemented. The general third-party provider/after-save API is
not frozen ([#68](https://github.com/r2cuerdame/capturepack/issues/68),
[#69](https://github.com/r2cuerdame/capturepack/issues/69)).

### Timeline events

- [x] Window/focus/control observations in provider-owned temporal context
- [x] Top-level mouse and window `input.*` events — `input.mouse.move`,
      `input.mouse.click`, `input.window.focus`, `input.window.move`,
      `input.window.resize`, on the replay clock (pack format 0.8.0). Derived
      from surface samples Core already takes plus one extra cursor read inside
      a dump that was already happening: no hook, no thread, no new boundary

`input.key.*` is **not a future item.** It stays RESERVED and unemitted at any
version — a decision, not a deferral. Recording what is visible is licensed by
the snapshot already containing those pixels; a keystroke is not among them, and
a password field renders dots, which is the case the DOM walker already refuses
`type="password"` for. `check:input-events` is what keeps that true.

### Plugin API & integrations

- [ ] In-process Plugin API — core owns capture; plugins only append metadata
      under `plugins/<name>/`. The **on-disk** half of that contract ships:
      `plugins/windows-uia`, `plugins/chrome-dom` and `plugins/windows-context`
      are written and declared exactly as SPEC §11 defines them. What is missing
      is the runtime surface a third party could write against
- [x] Chrome preview extension: element picker, selector generation, protocol v1,
      native host and installer registration
- [x] Built-in UIA and Chrome settings expose enable/disable and live health
- [ ] General third-party plugin manager and stable after-save API
      ([#69](https://github.com/r2cuerdame/capturepack/issues/69),
      [#68](https://github.com/r2cuerdame/capturepack/issues/68))
- [x] Element picking inside iframes, with the frame offset measured by
      cooperating frames rather than assumed
- [x] The picker reports arming, failure and every refusal, so a pick that does
      not arrive says where it stopped
- [x] Extension Phase 2, the document snapshot half: a still records the whole
      visible document of every visible browser window, not one element of one
      focused tab — and refuses the fields the picture does not contain
      (`check:document-snapshot`)
- [ ] Extension Phase 2, the rest: Shadow DOM and SPA route detection
- [x] Chromium-family registration (Chrome, Edge, Brave and Chromium)
- [x] Built-in Windows UI Automation context provider
- [ ] Git plugin · Console plugin
- [ ] Unreal plugin · Unity plugin

---

## V3 — Semantic layer

### Semantic object picking — Partially implemented

In a STILL capture, click actual UI objects instead of drawing rectangles;
CapturePack stores the object, not coordinates (GOAL "Annotation Timeline &
Lifetime"). A video has no object picking at any frame — it takes the boxes the
user draws, each with a lifetime — because control geometry could not be
answered at an arbitrary replay frame:

- [x] A box can carry a semantic `target` from UIA, Chrome DOM or HWND evidence
- [x] Observed target bounds written by earlier releases still render and
      survive save/reopen across displays without inventing intermediate object
      state
- [ ] App-specific object lifecycles beyond observed provider evidence
- [ ] Engine providers (Unreal widgets, Unity UI)

### AI-assisted annotation — Not started

- [ ] Prompt builder

Boundary: **No AI Dependency** is a core principle. AI features assist creation; a pack is never
less complete without them, and nothing becomes an AI API integration (a stated non-goal).

---

## Later — noted, not scheduled

- **Share-specific opaque redaction** — re-render Share Copy media so covered
  pixels are input-independent, rather than reusing the pack's editable
  pixelation view; retain mandatory human review because unmarked pixels can
  still contain secrets.
- **Open specification adoption** — other tools reading and writing `.capturepack`.
- **Future MCP tools** — compare, merge, diff, statistics, exportPDF/HTML/Issue,
  findByApplication/URL/WindowTitle; true replay-frame extraction for `frame(time_s)`
  (today it returns the nearest annotated keyframe, or `snapshot.png` with a note stating
  its frame time — a frame is never decoded out of the video).

---

## Success criteria (from GOAL.md)

| KPI | Criteria | Status |
|---|---|---|
| Primary | The creator naturally uses CapturePack every day. | In progress — installed and in daily use since 2026-07-27 |
| Secondary | Developers begin attaching CapturePack files instead of screenshots. | Not met — no outside users yet |
| Operational | Install once from a GitHub Release, then keep using it for a month without any manual reinstall. | In progress — installed 2026-07-27, one auto-update received; the month is running |
| Long-term | CapturePack becomes an open specification adopted by other tools. | Not met — spec drafted, no external adopters |

---

## Development order (from GOAL.md)

| # | Step | Milestone | Status |
|---|---|---|---|
| 1 | Write SPEC.md | — | Done (draft 0.1.0; grown additively since, through 0.8.0) |
| 2 | Define CapturePack format | — | Done (SPEC + schemas) |
| 3 | Build replay buffer | V1 | Done (shipped) |
| 4 | Screenshot | V1 | Done (shipped) |
| 5 | Annotation editor | V1 | Done — unified box editor with scrub timeline and lifetimes (shipped) |
| 6 | Export CapturePack | V1 | Done — folder-first packs with README/skills/annotated replay (shipped) |
| 7 | Plugin API | V2 | Not started — the in-process API. The on-disk plugin contract (SPEC §11) is implemented and written by every capture |
| 8 | Browser plugin | V2 | Done — picker, document snapshot, protocol v1, native host, Chromium-family installer registration. Shadow DOM / SPA routes pending |
| 9 | Windows plugin | V2 | Done — built-in UI Automation provider writing `plugins/windows-uia` and `plugins/windows-context` |
| 10 | Public release | V1 | Done (0.4.4 live; auto-update chain proven from 0.1.0) |

---

## How this roadmap evolves

GitHub Issues double as a daily **usage journal**
(`.github/ISSUE_TEMPLATE/usage-journal.md`): what was used, what hurt, what's missing. After a
month of real use, the journal — not this file — is the best source of what comes next. This
roadmap gets revised from it, and every public change to the format updates SPEC.md first.

Non-goals stay non-goals: no cloud, no accounts, no sync, no subscriptions, no analytics, no
collaboration features, no marketing features, no issue tracker, no AI API integration.
