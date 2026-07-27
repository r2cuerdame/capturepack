# Roadmap

This file maps the path from [GOAL.md](GOAL.md) to shippable milestones. The format itself is
defined in [SPEC.md](SPEC.md) — spec before code, always. This roadmap tracks sequence and honest
status; it never overrides either document.

**Status legend:** `Done` · `In progress` · `Not started` · — **nothing has shipped yet.**
There is no GitHub Release, no installable build, and the app does not run end-to-end.

The guiding constraint for every milestone: **never sacrifice the 5-second workflow.**

```
Ctrl+Alt+C  →  capture  →  5-second annotation  →  export .capturepack  →  drop anywhere
```

---

## Where things stand

| Milestone | Scope | Status |
|---|---|---|
| Format spec 0.1.0 | SPEC.md + JSON Schemas (`docs/schemas/`) | Done (draft) |
| **V1 — MVP + release** | Capture, annotate, export + installable auto-updating Windows release | In progress (scaffolding only) |
| **V2 — Context depth** | Timeline input events + Plugin API and first plugins | Not started |
| **V3 — Semantic layer** | Object picking, AI-assisted annotation, prompt builder | Not started |

What exists today: SPEC.md (format 0.1.0, draft) with validating schemas, a complete valid
example pack (`examples/minimal`, also zipped as `examples/minimal.capturepack`), a
dependency-free spec validator (`tools/validate-capturepack.mjs`), the usage-journal issue
template, CI and tag-triggered release workflows, an electron-builder config, a landing page
(`site/`, not yet published), and — under `core/` — the main-process modules (updater, settings,
tray, capture/snapshot, session flow, export writer, report generation) plus the replay-buffer
capture renderer. What does not exist yet: the annotation editor renderer (so the app cannot run
the flow end-to-end), the GitHub Pages workflow, any published release.

---

## V1 — MVP + installable, self-updating release

V1 is two halves, and **both are required**. The tool half is the MVP workflow from GOAL.md. The
release half is deployment infrastructure: **auto-update is required in V1, not optional** — the
creator uses CapturePack daily while fixing it frequently, and hand-replacing files breaks the
usage habit that the whole project is measured by.

### Capture — In progress (replay buffer, snapshot, and hotkey code written; unproven end-to-end)

- [ ] 30-second rolling replay buffer (exported as `replay.webm`, the SPEC-recommended container)
- [ ] Screenshot (`snapshot.png`, the frame every annotation is anchored to)
- [ ] Global hotkey `Ctrl+Alt+C` triggers capture from anywhere

### Annotation — Not started

- [ ] Pin, Arrow, Rectangle, Blur, Text — exactly the five types of format 0.1.0 (SPEC §8)
- [ ] Keyboard-first: shortcuts preferred, no complex UI
- [ ] Target: a useful annotation pass in **under 5 seconds**
- [ ] Instant undo
- [ ] Annotations stay editable data — never burned into the replay video

### Export — In progress (export writer and report generation written; no editor to drive them yet)

- [ ] Assemble a valid `.capturepack` per SPEC: `manifest.json` + `snapshot.png` + replay +
      `annotations.json` + generated `report.md`
- [ ] Apply blur destructively to `snapshot.png` at export; never ship the unredacted frame
      (SPEC §9)
- [ ] Warn when blur + replay coexist (the replay is not redacted in 0.1.0) and offer one-step
      replay exclusion (SPEC §9.4)
- [ ] Generate `report.md` from the SPEC §12 template so any LLM understands the pack with no
      tooling
- [ ] Optional in V1: `timeline.json` with `core.*` events (capture / annotation / export);
      `input.*` recording is V2

### Release & auto-update — In progress (pipeline and updater written, unproven until a release ships)

The V1 completion criteria from GOAL.md, verbatim:

- [ ] **Installable Windows release**
- [ ] **GitHub Releases-based updater** — no separate update server, ever
- [ ] **Update notification and restart-to-update UX** — background download, then
      `[Restart and update] [Later]`; no forced restart while a live replay buffer is running
- [ ] **Rollback-safe installation** — a failed update leaves the existing version working
- [ ] **Automatic build and release workflow** — git tag → GitHub Actions → build + test →
      sign → SHA-256 → upload Release assets

Supporting requirements (GOAL.md update principles):

- [ ] Hash verification of update files; HTTPS only; never update from arbitrary URLs
      (implemented as electron-updater's sha512 check from `latest.yml`, plus a published
      `SHA256SUMS.txt` for manual verification — see [docs/RELEASING.md](docs/RELEASING.md))
- [ ] Windows code signing when possible
- [ ] Auto-check can be disabled in settings
- [ ] Stable / Preview channels can be separated
- [ ] Landing page published from `site/` via GitHub Pages, with Download pointing at the
      latest GitHub Release (GOAL.md "Landing Page"; the page exists, the
      `.github/workflows/pages.yml` deployment does not yet)

### V1 exit test

Tag `v0.1.x`, watch CI publish the installer to GitHub Releases, install it once, use it daily,
and receive at least one update through restart-to-update — **a full month with no manual
reinstall.** That is the operational success criterion, and V1 is not done until it passes.

---

## V2 — Context depth

V2 makes the timeline and the plugin system real. Recording `input.*` events is an additive
format change: it lands as format **0.2.0** (the `input.*` namespace is already reserved in
SPEC §10.2, and 0.1.0 readers skip unknown event types by design).

### Timeline events — Not started

- [ ] Mouse
- [ ] Keyboard
- [ ] Window
- [ ] Application focus
- [ ] Window resize

Machine-readable, append-only during capture, replayable against the video (SPEC §10).

### Plugin API — Not started

The stable interface, then the first plugins:

- [ ] Plugin API — core owns nothing except capture; plugins only append metadata under
      `plugins/<name>/` and can never modify the capture process (SPEC §11)
- [ ] Browser DOM plugin — fed by the official Chrome Extension (GOAL.md "Chrome Extension"):
      the extension delivers DOM metadata (selector, role, text, bounds, url) over Native
      Messaging; the app remains the only writer of the pack
- [ ] Windows UI Automation plugin
- [ ] Unreal plugin
- [ ] Unity plugin
- [ ] Git plugin
- [ ] Console plugin

The plugin interface must remain stable once published — plugins are the format's extension
point, and breaking them breaks the ecosystem promise.

---

## V3 — Semantic layer

### Semantic object picking — Not started

Instead of drawing rectangles, click actual UI objects. CapturePack remembers objects, not
pixels, whenever possible.

- [ ] DOM elements
- [ ] Windows UI Automation (AutomationId, ControlType, Name, Bounds)
- [ ] Application objects
- [ ] Future engine plugins (Unreal widgets, Unity UI, custom plugin objects)

### AI-assisted annotation — Not started

- [ ] Prompt builder

Boundary: **No AI Dependency** is a core principle. AI features assist creation; a pack is never
less complete, less readable, or less exportable without them, and nothing here becomes an AI API
integration (a stated non-goal).

---

## Later — noted, not scheduled

- **Replay redaction.** In format 0.1.0, blur applies to the snapshot only; a future format
  version will close the replay gap (SPEC §9.4).
- **Open specification adoption.** The long-term goal is other tools reading and writing
  `.capturepack` — driven by keeping SPEC.md primary, versioned, and backward compatible.

---

## Success criteria (from GOAL.md)

| KPI | Criteria | Status |
|---|---|---|
| Primary | The creator naturally uses CapturePack every day. | Not met — nothing to use yet |
| Secondary | Developers begin attaching CapturePack files instead of screenshots. | Not met |
| Operational | Install once from a GitHub Release, then keep using it for a month without any manual reinstall. | Not met — no release exists |
| Long-term | CapturePack becomes an open specification adopted by other tools. | Not met — spec drafted, no external adopters |

---

## Development order (from GOAL.md)

| # | Step | Milestone | Status |
|---|---|---|---|
| 1 | Write SPEC.md | — | Done (draft 0.1.0) |
| 2 | Define CapturePack format | — | Done (SPEC + schemas) |
| 3 | Build replay buffer | V1 | In progress (capture renderer written, unproven) |
| 4 | Screenshot | V1 | In progress (snapshot module written, unproven) |
| 5 | Annotation editor | V1 | Not started |
| 6 | Export CapturePack | V1 | In progress (exporter + report modules; no editor to drive them) |
| 7 | Plugin API | V2 | Not started |
| 8 | Browser plugin | V2 | Not started |
| 9 | Windows plugin | V2 | Not started |
| 10 | Public release | V1 (release infra ships with V1) | In progress (workflows written, nothing published) |

---

## How this roadmap evolves

GitHub Issues double as a daily **usage journal** (template already in
`.github/ISSUE_TEMPLATE/usage-journal.md`): what was used, what hurt, what's missing. After a
month of real use, the journal — not this file — is the best source of what comes next. This
roadmap gets revised from it, and every public change to the format updates SPEC.md first.

Non-goals stay non-goals: no cloud, no accounts, no sync, no subscriptions, no analytics, no
collaboration features, no marketing features, no issue tracker, no AI API integration.
