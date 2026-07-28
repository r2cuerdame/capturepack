# CapturePack

> **Capture context, not screenshots.**
>
> **Better input. Better answers.**

## Essence

두 문장이 프로젝트의 본질이다. README에 크게 써놓는다.

> **Can you explain a bug in under 5 seconds?**
>
> **The fastest way to explain something to an LLM.**

- **Repository Type:** Open Source
- **License:** MIT

---

## Vision

CapturePack is a local-first context capture toolkit designed for humans and AI.

It captures not only pixels but also user intent, interaction, and application context.

Instead of sending screenshots or videos, people send CapturePacks.

A CapturePack should contain enough information that another human or any LLM can immediately understand the situation.

---

## Mission

Build the fastest possible workflow for explaining visual problems.

**Target workflow:**

```
Ctrl+Alt+C
    ↓
Capture current context
    ↓
5-second annotation
    ↓
Export CapturePack
    ↓
Drop into ChatGPT / Claude / Codex / Cursor / Gemini
or send to another developer.
```

The workflow should feel instantaneous.

---

## Philosophy

**CapturePack is NOT**

- Screen Recorder
- Bug Tracker
- Issue Manager
- Cloud Service
- AI Product

**CapturePack IS**

A universal context package.

- Screenshots preserve pixels.
- Videos preserve motion.
- CapturePack preserves context.

**Context means**

- Time
- Space
- Intent
- Environment
- Optional Metadata

Video is evidence.
Annotations describe intent.
Metadata provides understanding.

---

## Core Principles

- Local First
- Offline First
- Open Format
- Open Source
- Plugin Based
- No Cloud
- No Login
- No Database
- No AI Dependency
- No Vendor Lock-In

Generated CapturePacks should remain readable forever.

---

## Success Criteria

| KPI | Criteria |
| --- | --- |
| Primary | The creator naturally uses CapturePack every day. |
| Secondary | Developers begin attaching CapturePack files instead of screenshots. |
| Operational | Install once from a GitHub Release, then keep using it for a month without any manual reinstall. |
| Long-term | CapturePack becomes an open specification adopted by other tools. |

---

## Landing Page (GitHub Pages)

The goal of the page is not to explain the product — it is to drive the Download click.

- Domain: **https://capturepack.dev** — the one and only official domain; every document,
  README link, and download link uses it. A one-line `CNAME` file (exactly `capturepack.dev`)
  lives at the repo root AND in `site/` so every Pages deployment carries the domain; it must
  always match the Pages custom-domain setting. DNS: apex A records 185.199.108–111.153,
  `www` CNAME → `r2cuerdame.github.io`. Enforce HTTPS as soon as the certificate is issued.
- Static site served by GitHub Pages from `site/` in this repository (no separate repo).
- One page, minimal scroll, no signup/server/database, no flashy animation.
- A visitor must understand the product within 5 seconds; the only action is **Download**.

Structure:

- **Hero** — "Capture context, not screenshots." / "The fastest way to explain something
  to humans and AI." Exactly three buttons: **Download**, **GitHub**, **♥ Sponsor**
  (GitHub Sponsors).
- **Demo** — one ~10s GIF below the hero: Ctrl+Alt+C → capture freezes → mouse wheel moves
  through time → click object → write annotation → CapturePack exported.
- **Output preview** — the generated pack tree (manifest.json, snapshot.png, annotations.json,
  timeline.json, report.md, replay video).
- **Footer** — MIT License · Open Source · "Made because explaining bugs to AI was taking
  too much time."

Download always points at the latest GitHub Release; release info is auto-reflected
(client-side fetch of the latest release, falling back to the releases page).
Deployment: `.github/workflows/pages.yml` publishes `site/` on push to main.

---

## Internationalization (9+ languages)

Both the landing page and the application support at least nine languages:
**English, 한국어, 日本語, 中文, Español, Français, Deutsch, Português, Русский.**

- **Landing** — client-side dictionary (`site/i18n.js`), top-right language picker,
  browser-language auto-detection, choice persisted. English is the SEO base.
- **Application** — every UI string goes through a shared i18n layer
  (`core/src/shared/i18n.ts`): tray menu, editor (top bar, hints, box header, duration
  editor, toast), settings window, notifications, dialogs. Language setting in
  Settings → General (default: system language via `app.getLocale()`, fallback English).
  No hardcoded UI strings outside the dictionaries.
- **Pack documents** (README/skills/report templates) follow a `packLanguage` setting
  defaulting to the UI language — the user's own description text is never translated.
- Adding a language = adding one dictionary entry; missing keys fall back to English.

---

## Development Practice: Docs Follow Every Fix

Every fix or feature updates ALL public surfaces in the same pass — none may drift:

- **GitHub Issues** — bugs get an issue (cause, fix, commit) even when fixed immediately;
  user-reported pain links back to the usage journal.
- **README** — reflects the current released behavior.
- **Landing page** — capturepack.dev stays truthful (roadmap Now/Next, download state).
- **Release notes** — every tag ships human-readable notes on the GitHub Release
  (what changed, what was fixed, upgrade impact).
- **MCP interface** — tool descriptions, responses, and docs/MCP.md always match the
  current format and behavior; a format change (annotation model, pack layout, naming)
  is not done until the MCP tools speak it.
- **GitHub Milestones** — actively used: every issue belongs to a release milestone
  (vX.Y.Z), milestones mirror the roadmap, and a release closes its milestone with all
  issues resolved or explicitly moved.

---

## Development Practice: Usage Journal

Open GitHub Issues from day one — and don't use them only for feature requests.
Keep a daily usage journal:

```
Used Today

Today I used CapturePack 7 times.

Pain

- Annotation took too long.

Idea

- Need object picker.
```

After a month, the journal itself becomes the best roadmap.

---

## MVP

**Capture**

- 30-second replay buffer
- Screenshot

**Say that you are recording.** A silent tray icon gives no reason to trust that the buffer
is running — and today a buffer that FAILED to start looks exactly like one that is
working. So:

- **Tray tooltip is live state**, always: "CapturePack — recording · last 30s ready
  (Ctrl+Alt+C)", "starting…", or "not recording — <reason>". The tooltip costs nothing and
  never interrupts.
- **A brief tray notification when replay recording starts**, once per launch, saying the
  last N seconds are now always available and naming the hotkey. Suppressible in Settings
  (default on).
- **Say it in the user's words, never in ours.** "Replay buffer" is an implementation
  detail the user never configured and cannot see; every one of these surfaces — the
  Settings toggle, the notification, the failure balloon, the reasons — names what actually
  happens instead: *the last N seconds are (not) being recorded*.
- **A failure is always announced**, whether or not the start notice is suppressed: if the
  recorder never starts, the user must find out immediately, not when they press the
  hotkey and get a screenshot-only pack.
- The tray icon itself carries the state (recording vs stopped), so a glance is enough.
- **The state keeps agreeing with reality — it is never decided once.** "Recording" is
  earned from proof that frames are flowing, and that proof keeps arriving, so a recorder
  that recovers re-earns the state by itself within seconds. A display that is NOT
  recording keeps being retried (probe, then a fresh recorder) with a backoff, for as long
  as the app runs. A wrong state must be able to correct itself without a restart —
  a fixed number of attempts at startup means a transient failure latches forever, and the
  icon then lies in the one direction nobody checks: it says "not recording" while
  recording works.

**Start with Windows, by default.** A capture tool that is not running when the bug happens
has already failed — the buffer only holds what it was there to record. So the app
registers itself to launch at login (per-user, via Electron's login-item API, no admin
rights and no scheduled task), **on by default**, with a Settings → General toggle to turn
it off. Launching at login starts it minimized to the tray: no window, no welcome, no
stealing focus at boot. The uninstaller removes the entry.

**Never disappear without a word.** The app cannot announce its own death — there is
nothing left to announce it with — so it leaves a record instead, and the NEXT start says
what happened. All of it local; nothing is ever uploaded.

- **A crash leaves a dump.** The crash reporter runs with uploading off, so main- and
  renderer-process crashes land as minidumps under the user data folder, where the user
  can attach one to an issue.
- **The app writes a log.** A rolling, size-capped `logs/main.log` in the user data folder
  records startup and version, hotkey registration, per-display recorder state changes with
  their reason, capture requests and outcomes, save results, MCP and updater activity, and
  every error that would otherwise be silent — including a renderer that vanishes, which is
  a recorder failure and must be treated as one. Reachable from the tray
  ("Open logs folder"), because a record nobody can find is not a record.
- **A quit and a death are different events.** Choosing Quit is recorded as such; anything
  else leaves the run marked open. On the next start the app says plainly that the previous
  run stopped unexpectedly, when it was last alive, and that **the buffer was not recording
  in between** — the one sentence a user who pressed the hotkey into silence actually
  needed. An open marker left by a DIFFERENT version is an update replacing the app, not a
  crash, and is never reported as one. The verdict stays readable afterwards in About, so
  "was it running?" is answerable without a terminal.

**Capture must stay cheap.** CapturePack runs all day; a resident tool that eats a core is
a tool people quit. The buffer currently encodes VP9 in software, twice over (two rotating
recorders) and once per display — the worst possible combination on a 4K desktop.

- **Use the GPU encoder when the machine has one.** On Windows that means the platform
  H.264 encoder (Media Foundation, which is what NVENC/QuickSync/AMF sit behind — not
  CUDA directly). Probe the hardware-friendly recorder types first and fall back in
  order: H.264 → VP8 → VP9. The pack format already allows an mp4 replay, so a hardware
  H.264 stream is a legal replay, not a workaround.
- **Do not encode more pixels than the replay needs.** Cap the recorded stream's long edge
  (setting: replay quality, default ~1920) while the SNAPSHOT stays at native resolution —
  annotation precision comes from the snapshot, not the video. On a 4K screen this alone
  removes most of the encode cost.
- **Keep the concurrent encoder count as low as the ring buffer allows** — two per display
  is the price of the rolling window; anything finer must justify its CPU.
- The annotated-replay render and the exact-length cut ride the same encoder, so both get
  cheaper for free.
- Measure before and after (CPU % idle-recording, 1 display and N displays) and record the
  numbers; "feels faster" is not a result.

**The replay is exactly the configured length.** The ring buffer runs rotating recorders,
so the raw footage on hand is always *at least* the configured window and usually more.
That surplus must never reach the pack: what gets saved is exactly the last N seconds
(N = the replay length setting), and the editor's timeline shows exactly that range, so
what the user scrubs is what the pack contains.

- Keep the surplus small at the source: rotate on a finer interval so the buffer
  overshoots by a fraction of N instead of up to 2xN.
- Cut the remainder to exact length through the existing trim render path.
- **Showing work is allowed.** If preparing the replay genuinely needs time (an encode or a
  cut), the editor may open with a progress bar for that step instead of pretending to be
  ready. The rules: the frozen SNAPSHOT and annotation stay usable immediately — the
  progress belongs to the replay only — the bar states what it is doing and how far along,
  and Save is never blocked by it (the pack finishes writing when the encode does). Silent
  waiting is the only forbidden option.
- A shorter-than-N buffer (right after launch) is reported honestly as its real length;
  the guarantee is "never longer than N", never padding.

**Annotation**

- Pin
- Arrow
- Rectangle
- Blur
- Text

**Export**

A `.capturepack` file (a standard ZIP) contains:

- `manifest.json`
- `replay.webm` (or `replay.mp4`)
- `snapshot.png`
- `annotations.json`
- `report.md`

No plugins required. Everything works locally.

**Save-first capture** — the moment Ctrl+Alt+C is pressed, the raw capture (snapshot +
replay + manifest) is saved to disk immediately, BEFORE the editor opens. Annotating then
updates the same pack in place; **Save** (Enter) finalizes it. Cancelling the editor keeps
the raw capture; a crash can never lose one. The UI verb is **Save**, not Export —
"export" survives only as the SPEC's internal event name (`core.export.created`).

**Output layout — Folder First.** The primary save unit is always a **folder**; ZIP is not
the original, only an optional distribution package created when the user clicks
[ Create ZIP ]. (This supersedes the earlier date-folder + automatic zip layout — the date
lives in the folder name now.)

```
CapturePack_2026-07-27_143052/
├── replay.webm              ← original evidence, never modified
├── replay_annotated.webm    ← annotations rendered in; plays in any player
├── snapshot.png
├── annotations.json         ← the true source: annotations, lifetime, DOM,
│                              tracking, style, bounds — replay_annotated is
│                              always regenerable from it
├── timeline.json            ← all time info: window, DOM, focus, mouse,
│                              keyboard, plugin metadata
├── report.md                ← the user's own description
├── manifest.json            ← format version, file inventory, plugins, created
├── README.md                ← the FIRST document a human reads
├── skills/                  ← context structured for LLMs, readable without MCP
│   ├── overview.md          ← whole-pack summary
│   ├── timeline.md          ├── annotation.md
│   ├── dom.md               └── project.md
└── plugins/
```

**README.md (human-first)** — Created, Application, Duration, Description, Files,
How to use (1. open replay_annotated 2. read report.md 3. open via CapturePack MCP).
Reading README alone must be enough for a person to understand the whole pack.

**skills/ (AI-first)** — structured so an LLM understands the pack immediately even
without the MCP server.

**Save pipeline** — Save → create folder → metadata → original replay →
annotated-replay render (may run in the background).

**Annotated keyframes (LLM-first)** — LLMs read images, not videos. The render pass also
saves an annotated STILL at every annotation state change (each box's appearance /
disappearance / edit point; changes within ~300 ms merge into one frame):

```
frames/
├── frame-01_00-03.200.png    ← box ① appears
├── frame-02_00-05.400.png    ← box ② appears, ① still visible
└── frame-03_00-08.100.png    ← blur box ③
```

- Declared in the manifest as `media.keyframes: [{file, t_ms}]`.
- report.md / README.md / skills reference the frames inline (markdown images), so an
  LLM reconstructs the whole story without decoding video.
- MCP `capturepack_frame(time)` returns the nearest rendered keyframe (removing the v0
  snapshot-only limitation).
- Screenshot-only packs still get one annotated keyframe.

**Save-complete UI**

```
Saved  CapturePack_2026-07-27_143052
[ Open Folder ] [ Copy Folder Path ] [ Create ZIP ] [ Copy Prompt ]
```

**Principles** — the folder is the source; ZIP is distribution. replay is evidence;
replay_annotated is the instantly-understandable result; annotations.json is the true
original. A person should understand from replay_annotated alone; an AI should
understand from README.md + skills/ alone. One CapturePack must carry complete context
for both.

---

## V1 Release & Auto-Update (Required)

Auto-update is **required in V1** — not a nice-to-have. The creator uses CapturePack daily while
fixing it frequently; downloading a ZIP from GitHub and replacing files by hand breaks the usage
habit. Auto-update is the deployment infrastructure that turns CapturePack from a development
experiment into a real resident tool.

**Update flow (Windows)**

```
GitHub Release
    ↓
Check latest version on app start
    ↓
Notify if a new version exists
    ↓
Background download
    ↓
Replace on app exit
    ↓
Relaunch
```

**Auto-update principles**

- GitHub Releases only — no separate update server.
- No forced restart while in use.
- If an update fails, keep the existing version.
- Hash verification (SHA-256) of update files.
- Auto-check can be disabled in settings.
- Stable / Preview channels can be separated.

**Update UX**

Fully unattended updates are not the starting point. The safe initial UX:

```
CapturePack 0.1.4 available

[Restart and update]  [Later]
```

Download ahead of time; let the user restart after finishing their work. CapturePack holds a live
screen replay buffer — force-killing it is not acceptable.

**Release pipeline**

```
Git tag: v0.1.4
    ↓
GitHub Actions
    ↓
Build + Test
    ↓
Code sign
    ↓
Generate SHA-256
    ↓
Upload GitHub Release
    ↓
Update latest.json
```

Example `latest.json`:

```json
{
  "version": "0.1.4",
  "channel": "stable",
  "url": "GitHub Release asset URL",
  "sha256": "...",
  "minimum_supported_version": "0.1.0",
  "release_notes": "..."
}
```

**Update security**

CapturePack runs continuously and handles screen content, so update security matters more than
usual. Minimum requirements:

- HTTPS only.
- SHA-256 verification.
- Windows code signing when possible.
- Signature verification of the update executable.
- Never update from arbitrary URLs.

**V1 completion criteria**

- Installable Windows release
- GitHub Releases-based updater
- Update notification and restart-to-update
- Rollback-safe installation
- Automatic build and release workflow

---

## Future Versions

### V2

**Timeline Events**

- Mouse
- Keyboard
- Window
- Application Focus
- Window Resize

**Plugin API**

- Browser DOM
- Windows UI Automation
- Unreal
- Unity
- Git
- Console

### V3

**Semantic Object Picking**

Instead of drawing rectangles manually, users click actual UI objects.

Supported targets:

- DOM Elements
- Windows UI Automation
- Application Objects
- Future Engine Plugins

**AI-assisted annotation**

- Prompt Builder

---

## Plugin Architecture

- Core owns nothing except capture.
- Plugins only append metadata.
- Plugins cannot modify the capture process.
- Plugin interface must remain stable.

**Examples**

- Browser Plugin
- Window Plugin
- Mouse Plugin
- Keyboard Plugin
- Git Plugin
- Unreal Plugin
- Unity Plugin

Plugins generate structured events.

---

## Chrome Extension

CapturePack is not a single Windows application. An official Chrome Extension is developed
alongside it to obtain DOM information. The extension is part of CapturePack, not a separate
product.

**Purpose** — deliver real DOM objects, not screen pixels. The user clicks a button on the
replay; CapturePack stores the button's meaning: selector, id, role, text, bounds, url.
This information is linked to annotations.

**Structure** — managed inside this repository:

```
extensions/
└── chrome/
    ├── manifest.json
    ├── background.js
    ├── content-script.js
    └── native-host/
shared/
└── protocol/
```

**Extension role (minimum only)** — current URL, tab title, DOM element under the mouse,
user-selected element, CSS selector generation, element bounds, tab/URL change events.
The DOM is never streamed continuously; information is sent only at the moment it is needed.

**Application role** — replay buffer, timeline, annotation, export, UI, package creation.
The extension handles DOM metadata only.

**Communication**

```
Chrome Extension
      │  Native Messaging
      ▼
CapturePack Native Host
      │  IPC
      ▼
CapturePack Application
```

The extension talks only to CapturePack. No cloud servers.

**Shared protocol** — application and extension speak the same protocol, managed in
`shared/protocol/`. Example:

```json
{
  "type": "dom.element.selected",
  "timestamp": 18420,
  "tab": { "url": "...", "title": "..." },
  "element": {
    "tag": "button", "id": "save", "role": "button", "text": "Save",
    "selector": "#save",
    "bounds": { "x": 100, "y": 200, "width": 120, "height": 40 }
  }
}
```

**Phases** — Phase 1: URL, tab title, DOM element selection, selector, bounds.
Phase 2: DOM snapshot, Shadow DOM, iframes, SPA route-change detection.

**Distribution** — app, extension, and protocol share one version (CapturePack 0.1.0 =
Chrome Extension 0.1.0 = Protocol v1). Initially loaded unpacked in developer mode;
Chrome Web Store distribution comes after stabilization.

**Philosophy** — the extension's purpose is not to store the DOM. It is to make CapturePack
understand meaningful objects (context) instead of screen pixels.

### Extension Install & Management UX

The extension is part of CapturePack. Users must never hunt through browser settings or
developer mode — every install and status check starts and ends inside the CapturePack app.
The user presses one button: **Install**. CapturePack handles the rest.

**Settings UI** — add an Integrations menu:

```
Settings
└── Integrations
    └── Chrome DOM Capture
```

- Not installed: status "Not Installed" + [ Install Chrome Extension ].
- Installed: Extension Connected · Native Host Installed · Protocol v1 · Version, plus
  [ Open Extension Settings ] [ Reinstall ] [ Uninstall ]. Status visible at a glance.

**Install flow** — starts from CapturePack: Install button → open Chrome Web Store → user
clicks "Add to Chrome" → CapturePack installs the Native Messaging host → connection
verified → Connected.

**Developer mode** (before Web Store listing): [ Open chrome://extensions ]
[ Open Extension Folder ] [ Copy Extension Path ] — CapturePack opens the needed pages
and folders automatically.

**Native Messaging (installer responsibilities)** — the CapturePack installer automatically:
installs the native host, generates the native messaging manifest, registers the Windows
Registry key, registers the extension ID, links the CapturePack executable, and cleans up
registry + manifest on uninstall. No manual setup, ever.

**Diagnostics** — CapturePack always knows the extension state:
"✔ Extension Installed / ✔ Native Host Installed / ✔ Connected / ✔ Protocol Compatible",
"✖ Extension Missing [ Install ]", or "⚠ Version Mismatch (Extension 0.1.0, CapturePack
0.2.0) [ Update ]".

**First run** — if the extension is absent: "Chrome context capture is unavailable.
[ Install ] [ Not now ]". Never force the install; always available later in Settings.

### Integration Operations (post-install experience)

What matters most is the experience after installation:

1. **Auto-update (most important)** — a version gap between app and extension breaks UX.
   The app always checks the protocol version:
   "CapturePack 0.3.0 / Chrome Extension 0.2.0 → Update available [ Update Extension ]".
2. **Browser support structure** — extensible from day one, not Chrome-hardcoded:
   ✓ Chrome; Coming soon: Edge, Brave, Arc, Firefox. (Chromium-family browsers can reuse
   the extension almost as-is.)
3. **Health check** — six-point diagnostics, invaluable for bug reports:
   ✔ Extension Installed · ✔ Native Host Installed · ✔ IPC Connected ·
   ✔ Protocol Compatible · ✔ Permissions Granted · ✔ Content Script Running.
4. **[Test Connection] button** — one click shows: current tab URL, DOM count,
   element under mouse, round-trip latency. Solves most install problems alone.
5. **Permission display** — explain why the extension is needed:
   ✓ Read current page · ✓ Read selected DOM element · ✗ No browsing history ·
   ✗ No passwords · ✗ No cloud upload. Open source makes this credible.
6. **Privacy (near-mandatory)** — "Everything stays on your PC. No cloud. No telemetry.
   No page data leaves your computer."
7. **Plugin structure** — future integrations (Chrome, Windows UI Automation, Unity,
   Unreal, VS Code, JetBrains, Terminal, Git) all Enable/Disable from the same UI.
8. **Status icons** — on the main surface, not only Settings:
   🟢 Chrome Connected · 🟢 Replay Running · ⚪ UI Automation Disabled.

### Plugin Manager

Settings is a **Plugin Manager**. The Chrome extension gets no special treatment — it is
one plugin among equals, sharing the exact structure future integrations will use:

```
Plugins
🟢 Windows UI Automation   Active — last capture: 14 windows, 812 controls   [✓]
   Click real buttons and windows instead of drawing boxes — sub-second helper per capture.
⚪ Chrome DOM              Not installed                                     [ Install ]
⚪ Unreal · Unity · VSCode · Git                                             coming soon
```

Every row tells the truth or says nothing: a shipped plugin reports what it actually did
(and why it did not, when it failed), carries a switch that genuinely changes behavior,
and explains itself in one line with a "?" for the long version. A row may only say
"coming soon" while that is still true — Windows UI Automation shipped in 0.1.4 and object
picking has run on it ever since.

With this design CapturePack naturally grows into a plugin-based context platform.

---

## Tray Menu

**Left-clicking the tray icon opens History** — the icon must never be inert; the menu
below is the right-click surface.

The tray menu is the app's only always-present surface, so it stays short:

```
Capture now   Ctrl+Alt+C
History
Open output folder
Settings…
─────────────────
Check for updates…
Open logs folder
About CapturePack
─────────────────
Quit CapturePack
```

- **Open logs folder** — opens the app's own log directory. It sits with the diagnostics,
  not with the user's output folder: this is what the APP did, not what the user made. The
  log only exists to be read when something went wrong, and a user cannot be asked to find
  `%APPDATA%` by hand.
- **Check for updates…** — manual check with inline feedback in the menu item
  ("Checking…", "You're up to date", "Downloading…", "Restart and update (vX)").
  The automatic check keeps working exactly as before.
- **About CapturePack** — a small window: icon, name, version (+ "up to date" state),
  **how the previous run ended** (closed normally, or stopped unexpectedly and when),
  the two slogans, MIT license, and links: Website · GitHub · Report an issue ·
  **♥ Sponsor**. Donation lives here, never in the capture flow — the tool must never
  interrupt the 5-second workflow to ask for money.

---

## Settings GUI

Settings are edited in a GUI window — never by opening settings.json in an editor
(the JSON file remains the storage; no database).

- Opened from the tray ("Settings…"). One compact dark window consistent with the editor's
  minimal design; keyboard accessible; instant apply where possible, and where a running
  subsystem has to pick a change up, an inline hint pointing at the button that applies it
  — never at an app restart.
- Grouped sections:
  - **General** — output folder (picker + open button), copy exported pack to clipboard,
    auto-update check.
  - **Capture** — **capture hotkey** (recordable field: click, press the new combination;
    default Ctrl+Alt+C; must include a modifier; conflict with another app's global
    shortcut is detected on registration and reverts with an inline error; applies
    instantly and updates the tray label), replay length (seconds), capture FPS, and the
    **replay resolution limit** — a DROPDOWN of the few choices that matter (native/no
    limit, 3840, 2560, 1920 default, 1280, 720), each labelled with the quality/CPU trade
    it is rather than a bare pixel count, and each stating that only the replay video is
    scaled while the snapshot stays native. The stored value remains an integer width
    (`replayMaxWidth`, 0 or 720..3840), so older profiles keep loading; a stored width that
    is not one of the presets is SHOWN as its own entry, never silently snapped.
  - **Annotation** — default manual duration, show duration label, scrub wheel invert,
    scrub sensitivity (ms per notch).
  - **MCP** — enable, start automatically, port, watch export folder, log requests, plus
    the read-only badge. The section reports the server's **live state**, not the settings:
    running on the endpoint it actually bound, starting, or not running with the reason
    (disabled, autostart off, port in use, bind error). **Restart** stops and restarts the
    server in place with the current settings and reports the outcome — so changing the
    port costs a button, never an app restart (and never the recording of the last N
    seconds). Beside the connection URL, one click copies a **ready-made setup command**
    for the chosen client (the forms documented in docs/MCP.md) and the **ready-made
    prompt** to hand an AI once connected — both built from the LIVE endpoint, both
    disabled while nothing is listening.
  - **Plugins** — the Plugin Manager surface (GOAL "Plugin Manager"): each integration with
    a status read from REALITY, a one-line description of what it does and what it costs, a
    "?" that reveals the long explanation, and a real Enable/Disable where the switch can
    genuinely change behavior. Chrome DOM appears first (install/health-check UX per
    "Extension Install & Management UX"); only integrations that genuinely have not shipped
    are listed as coming soon.
- Settings values validate on input; invalid values never write to settings.json.

---

## Multi-Monitor Support

Dual (and more) monitor setups are fully supported. **Capturing ALL displays
simultaneously is the default** — one Ctrl+Alt+C, N displays in the pack.

- **Capture display** modes in Settings:
  - **All displays (default)** — every connected display records continuously; the
    trigger freezes ALL of them. The pack contains a replay + snapshot per display
    (`media.displays[]` in the manifest: snapshot/replay/annotated per display, with
    the focused display marked). The display under the cursor becomes the FOCUSED
    display — the editor opens on it and annotations anchor to it; the other displays
    ship as synchronized context.
  - **Cursor display** — record all, but the pack keeps only the cursor display
    (smaller packs).
  - **Fixed display** — record only the chosen display (lowest CPU).
- **All captured displays are shown at once.** The editor lays the frozen displays out
  side by side (scaled to fit, in their real left-to-right arrangement), not one at a
  time behind a switcher. Every display is annotatable: a box belongs to the display it
  was drawn on, and the scrub timeline drives all of them together so the whole desktop
  moves through time as one moment.
  - The focused display (cursor at trigger) opens centered and at the largest scale;
    the others sit beside it. Zoom/pan applies to the whole board.
  - **No display picker in the top bar.** The board already shows every display, so a
    row of monitor buttons is redundant chrome in the one place that must stay
    uncluttered. Framing a single display stays available on the keyboard (`1`..`9`,
    and the key left of `1` — backtick — to fit the whole board; `0` still does it
    too) and is discoverable through the help tooltip, not a toolbar.
  - **Framing is a VIEW, and Esc never undoes a view.** Zoom and pan have no Esc rung
    and neither does framing: the key that fits the whole board is the only way back.
    Esc belongs to the editing ladder (duration editor → unsaved bar → selection →
    close) — giving a view state its own rung stole the press users expect to close
    the editor and made leaving cost two.
  - Annotations stay in their own display's pixel space; `annotations.json` gains an
    optional `display` index (absent = the focused display, so single-monitor packs are
    unchanged).
- Existing profiles that still carry the pre-0.1.3 default (`cursor`) migrate once to
  `all`, since that value was never a deliberate choice.
- `manifest.environment.screens` continues to list every connected display; the focused
  one is the snapshot's coordinate space.
- Display hotplug (connect/disconnect, resolution change) restarts the affected recorders
  without losing the app.

---

## History

CapturePack provides a **History** screen managing saved CapturePack projects — not a
recent-files list, but the entry point for reopening a saved Folder and continuing work.

**Main navigation** is minimal: **Capture · History · Settings**. History is a top-level
menu; there is no separate Export menu — packaging, sharing, and re-rendering live in
History.

**History list** — CapturePack folders in the output folder, newest first, searchable.
Each card shows: title (or report.md first sentence), captured application, time, replay
length, annotation count (+ numbered count), blur presence, annotated-replay state
(ready / rendering / failed → [Retry Render]), ZIP created or not, folder size, and a
snapshot.png thumbnail (placeholder when missing/corrupt; external share previews must
use a sanitized snapshot).

**Search / filters** — search over title, report.md, application, URL, date, annotation
text. Filters: All · Today · This Week · Has Blur · Render Failed · Not Packaged.
(v0.1: search + minimal filters are enough.)

**Open & re-edit** — Open loads the Folder back into the Editor with everything restored:
replay, annotations (bounds/text/lifetime/numbered/blur/tracking), timeline, manifest,
report, DOM/UIA metadata, timeline position. Every editing operation works again (move,
resize, retext, duration, number toggle, blur toggle, delete, add, adjust times, edit
report, re-save, re-render). No project conversion step — the Folder IS the project.

**Source of truth** — replay + annotations.json + timeline.json + manifest.json.
replay_annotated is derived; README.md, report.md, and skills/ are (partly) derived.
After re-edit, regenerate: annotations/timeline/report/manifest/README/skills/
replay_annotated. replay is NEVER modified or overwritten.

**Save after re-edit** — Save updates the same Folder by default, with an explicit
unsaved-changes state: [ Save ] [ Save As New CapturePack ] [ Discard ]. Save As creates
a new folder preserving the original; Discard restores the last saved state.

**Detail actions** — Edit CapturePack · Play Annotated Replay · Open Folder ·
Create ZIP (choose included files; option to exclude the original replay) · Copy Prompt;
secondary: Re-render · Save As · Rename · Delete.

**Card buttons say what they do.** The primary action is labelled **Edit** — it reopens the
pack in the editor, and "Open" left users guessing whether it opened a folder, a video, or
the editor. **Open folder** is a first-class button next to it, not buried in the overflow
menu: reaching the files on disk is one of the two things people come to History for.

---

## Annotation Timeline & Lifetime

Annotations are not drawings on a screen — CapturePack is a program that creates
**Context with time**. Every annotation has a start time and an end time.

**Two kinds of annotations**

1. **Tracked Element** — automatically selected objects (Chrome DOM, Windows UI Automation;
   later Unity objects, Unreal widgets/actors, HTML elements). Selecting one stores the
   OBJECT, not coordinates: selector, AutomationId, role, text, bounds.
2. **Manual Annotation** — user-drawn rectangle, arrow, circle, highlight, pin (and text/blur).

**Tracked Element lifetime** — alive for as long as the object exists. CapturePack tracks
the same object frame by frame; when its bounding box moves, the annotation moves with it.
Tracking ends automatically when the element is removed from the DOM / UI Automation tree,
the window closes, or the capture ends. The user never manages duration.
UI: an × button always at the top-right — clicking it (or Delete) removes the annotation,
its tracking, and the linked context; restorable with Ctrl+Z.

**Manual Annotation lifetime** — default duration **1.0 s**, centered on the current time
(−0.5 s → +0.5 s), auto-clamped at the capture edges. When selected, the duration label
("1.0s") shows at the top-left; clicking it opens the editor (duration or start/end offsets)
with quick presets: 0.5s · 1s · 2s · 5s · 10s · Until End · Entire Capture.

**Timeline visualization** — the timeline shows every annotation's lifetime as bars;
tracked elements' bars grow automatically to the object's lifespan:

```
Rectangle       ███████
Arrow           ██
Tracked Button  ██████████████████
```

**UI summary** — top-left: duration (manual only) · top-right: × delete.

**Settings**

```
Settings └── Annotation
  Default Manual Duration: 1.0 s
  Manual Duration Presets: 0.5 / 1 / 2 / 5 / 10
  Auto Track Elements: ✓
  Delete Key Removes Annotation: ✓
  Show Duration Label: ✓
```

**UX principles** — selecting an object starts tracking automatically; users never manage
tracked lifetimes; only manual annotations have editable durations; duration is always one
click away at the top-left; delete via × and Delete key; the timeline visualizes every
lifetime.

**Core philosophy** — a Tracked Element is "an annotation that lives while the object
exists". A Manual Annotation is "an annotation that exists for the time the user chose".

### Static object picking (v0 — before full tracking)

Automatic window/control selection ships in a static form first:

1. **At capture** (alongside save-first) a Windows UI Automation helper dumps the window
   list + the control trees of the top windows in z-order (Name, ControlType, AutomationId,
   Bounds) into `plugins/windows-uia/` — budgeted (sub-second, async), never delaying the
   editor. The window list is the cheap, complete level and is always collected; trees are
   the expensive, partial level, so the foreground window is walked first with a guaranteed
   slice of the budget and the rest follow down the z-order until the deadline. Every window
   records what happened to its tree — collected, truncated, unavailable, skipped — so the
   editor never has to guess whether "no controls" means "none exist" or "none were read".
2. **In the editor**, the object tool (O / left click) highlights the UIA element under the
   cursor from that dump; clicking selects the element's exact bounds and pre-fills its
   name as the label — stored as the `"element"` annotation type with the object metadata.
   **Windows are always selectable.** The window list is captured for every visible
   window, so even when a window exposes no usable control tree (Chromium and Electron
   windows do not until an assistive client asks), hovering it highlights the WINDOW and
   clicking snaps a box to its bounds with its title as the label. Controls refine the
   selection when they exist; the window is the guaranteed floor, never "nothing
   happens". Hovering shows which level is being offered (window vs control), and holding
   **Shift** forces the window level when a control is on top. The one exception is the
   desktop wallpaper itself (a full-screen `Progman`/`WorkerW` window): offering it would
   turn every click on empty space into a full-desktop box, so picking says "no object data
   here" instead — once, quietly, rather than doing nothing without explanation.
3. In Chrome, the extension's DOM picker plays the same role (protocol v1) — and it is the
   REAL answer for browser and Electron windows, whose UIA trees are thin by design. Until
   that bridge lands (v0.2.0), the window level is what covers them: a box on a Chrome
   window still says which window it points at, and a `#save` selector will beat a UIA node
   that never existed once the extension can contribute one.
4. **A container is not a control.** The two levels only earn their keep if the control
   level is genuinely more precise than the window; a rectangle covering half the window
   is the window, wearing the label "Pane". So any control that is most of its window's
   AREA, or spans nearly a whole AXIS of it while still being bulky, is dropped and the
   pick falls through to the window level — which names it properly. A toolbar spans its
   window's full width too and is the most annotatable thing in it; what separates the two
   is that the toolbar is short, so the axis test carries an area floor.

   This is measured, not asserted. The rule is calibrated by rebuilding the editor's index
   from a real multi-monitor pack and sweeping it: the median rectangle offered under the
   cursor must stay a small fraction of the screen, and tightening the rule must not cost
   precise targets. When it was first shipped mis-calibrated the median offer was 19% of a
   3840x2160 screen while 0% of probes came back empty — picking looked healthy and was
   useless, which is exactly how it was reported ("hover select doesn't work"). A pack a
   user sends is enough to re-run that sweep, and CI can produce its own with `--capture-now`.
5. **Picking is a hit test, so it culls.** Only the top window at a pixel may offer controls,
   and inside that window the pick scans every candidate rather than stopping at the first:
   where one control encloses another the inner one wins (it is the finer annotation and it
   is what is on top), and where two genuinely overlap without nesting, the one later in the
   tree walk wins, because that is the one painted over the other. UIA gives siblings no
   z-order, so tree order is the only occlusion signal there is inside a window — and the
   element's `depth` is NOT one: it is how deep the walk went, and measured against a real
   capture, ordering by it never once beat ordering by containment while losing on 31.9% of
   contested points. Once containers are dropped (4) genuine sibling overlap is rare, so this
   rule is a correctness floor rather than the thing that makes picking feel right.
6. **The user may decline it.** The dump costs a sub-second helper process on EVERY
   capture, so Settings → Plugins carries a real switch (`uiaEnabled`, default ON — it is
   what left click picks with). Off means the helper is never spawned: the cost genuinely
   leaves the capture rather than the row merely greying out, packs carry no
   `plugins/windows-uia/`, and picking falls back to manual boxes with the editor saying
   so. The row also reports what the LAST capture actually collected (N windows /
   M controls), or why it collected nothing (helper missing, PowerShell blocked by policy,
   out of budget) — status from reality, never a constant.
7. Frame-by-frame tracking (bounds following the object through the replay) remains V3.

---

## Always-On MCP Server

CapturePack is not only a program that creates .capturepack files — it ships an official,
always-running **MCP (Model Context Protocol) server** so any AI can read CapturePacks in a
standard way. The MCP server never creates captures; it reads, explores, and analyzes them.

**Core goal** — after saving a CapturePack the user does nothing. The workflow is
Capture → Annotate → Save → done. Any AI finds and analyzes the latest CapturePack through
MCP on its own. The user never explains the file structure, never unzips, never pastes
report.md.

**Philosophy**

```
CapturePack        → creates Context
CapturePack Format → stores Context      (a data format, AI-independent)
CapturePack MCP    → serves Context      (the standard read interface)
Any AI             → consumes Context    (ChatGPT, Claude, Gemini, Cursor, VSCode, Codex, …)
```

**Always-on** — the MCP server starts automatically with the app and stays resident:

```
CapturePack.exe
├── Replay Buffer
├── Editor
├── Export
└── MCP Server   (port 39393, localhost only)
```

**Index & discovery** — MCP watches the export folder and keeps a recent-packs index
updated automatically (no manual refresh). `latest()`, `list()`, `open()` all use this index.

**Tools (initial, read-only)**

| Tool | Purpose |
| --- | --- |
| `capturepack.latest()` | The most recent pack — most LLM sessions need only this |
| `capturepack.list()` | Recent packs ("1 Chrome Login Bug / 2 Unreal Crash / …") |
| `capturepack.open(id \| path)` | Open a pack — folder and ZIP both supported |
| `capturepack.summary()` | App, window, URL, capture time, duration, annotation count, timeline length |
| `capturepack.manifest()` / `report()` | Raw manifest.json / report.md |
| `capturepack.timeline(from?, to?)` | Full timeline or a time slice |
| `capturepack.annotations()` / `findAnnotations(keyword)` | Annotation list / keyword search |
| `capturepack.frame(time)` | Frame at a given time (e.g. 12.4s) |
| `capturepack.replay()` | Replay metadata (segments on demand) |
| `capturepack.dom()` / `findDOM(selector)` | DOM metadata when the Chrome extension contributed it |
| `capturepack.windows()` | Window focus timeline |
| `capturepack.search(keyword)` | Search across report, annotations, timeline, DOM, window, plugin metadata |
| `capturepack.exportMarkdown()` | Convert a pack to Markdown (HTML/Issue export later) |

Plugin metadata is exposed generically — MCP never needs to know plugin kinds.

**Read-only rule** — initial version supports Read / Search / Summary / Export only.
No edit, no delete, no annotation modification, no capture creation (capture always
belongs to the application).

**Settings**

```
Settings └── MCP
  [✓] Enable MCP Server      [✓] Start Automatically   [✓] Always Running
  [✓] Read Only              [✓] Auto Discover Latest  [✓] Watch Export Folder
  Port: 39393                [ ] Log Requests
  Server status: 🟢 Running on http://127.0.0.1:39393/mcp   [ Restart ]
  Connection URL: http://127.0.0.1:39393/mcp               [ Copy ]
  Set up a client: [ Claude Code ▾ ] [ Copy setup command ] [ Copy prompt ]
```

The status line is read from the RUNNING server, never rebuilt from the settings above:
`mcpEnabled` says nothing about whether a socket is listening (the port can be taken —
the app logs one line and keeps running — and autostart can be off). [ Restart ] applies
the current port and settings in place and reports what happened; the capture buffer, the
hotkey and any open editor keep running through it. Every surface that advertises the
endpoint — About, welcome, settings, the copied setup command — reads that one live value,
so the three can never disagree.

**Usage** — the user says only "방금 캡처한 거 분석해줘" / "Analyze the latest CapturePack."
The AI chains `latest() → summary() → timeline() → annotations() → report() → dom()` itself.

**Future tools (not in the initial version)** — compare, merge, diff, statistics,
exportPDF/HTML/Issue, findByApplication, findByURL, findByWindowTitle,
latestFromApplication, latestFromBrowser.

---

## CapturePack Specification

```
CapturePack/
├── manifest.json
├── timeline.json
├── annotations.json
├── report.md
├── snapshot.png
├── replay.webm
└── plugins/
```

Specification is more important than implementation.

Any language should be able to generate CapturePack files.

The specification must remain versioned. Backward compatibility is important.

---

## Annotation Philosophy

Annotation speed is everything.

- **Target:** less than 5 seconds.
- Keyboard shortcuts preferred.
- No complex UI.
- Undo must be instant.
- Annotation should remain editable.
- Never burn annotations permanently into videos.

---

## Editor Input System

The editor is not a static screenshot viewer — it scrubs the frozen replay in time.
The user should finish **time selection → object selection → description** with the mouse alone.

**Final UX**

```
Ctrl+Alt+C
→ Freeze the last 30 seconds
→ Open the editor on the last frame

Wheel up        → toward the past
Wheel down      → toward the present

Left click      → semantic object auto-selection → type description immediately (V3;
                  MVP falls back to manual selection)

Right-click drag → manual rectangle → type description immediately

Space + drag    → pan the zoomed view
Middle-button drag → pan the zoomed view (one hand, no key)
Ctrl + wheel    → zoom in/out
Timeline drag   → coarse navigation across the buffer
```

**Panning** has two gestures and they are the same gesture: **Space + drag** and a
**middle-button (wheel-click) drag**, the way image and map viewers do it. Both use
pointer capture, so a drag that leaves the window still tracks and still ends; both are
available only while there is something to pan (a fully fitted board leaves the press
alone instead of swallowing it). A middle-button drag never starts a box and never
changes the selection, and a middle CLICK — pressed and released without moving — does
nothing at all. The wheel is untouched: rotating it still scrubs time, Ctrl + wheel still
zooms.

**Wheel time navigation**

Time-based movement, independent of the video's FPS:

| Input | Movement |
| --- | --- |
| Wheel | ±100 ms |
| Shift + wheel | ±1 s |
| Alt + wheel | ±1 frame |
| Ctrl + wheel | zoom |

- Sensitivity is configurable in settings.
- Wheel direction: up = past, down = future — with an **invert option** for users with
  video-editor habits.
- Scrubbing while playing: pause instantly and scrub to that point.
- **The trim range is the boundary.** Once in/out points are set, scrubbing, playback and
  the timeline drag all stay inside them — the position clamps at the handles instead of
  wandering into footage that will not be saved. Moving a handle re-clamps the current
  position. (Before a trim is set the whole buffer is in range, so nothing changes for
  the common case.)

### Editor Chrome

The editor's own UI must read as an editor, not a settings screen:

- **Icons, not words**, for the recurring controls (window mode, help, save), each with a
  tooltip carrying its shortcut. Text stays where it is content: the title, the note, and
  the annotation itself.
- **Zoom control** in the top bar: zoom-out button · slider · zoom-in button, showing the
  current percentage. The order follows the SLIDER — dragging right makes the image
  larger, so `−` is on the left and `+` on the right; a control that contradicts the track
  it sits on is worse than no control. It mirrors Ctrl+wheel (same range and steps), snaps
  to Fit and 100%, and double-clicking the slider returns to Fit. The board's zoom is a
  first-class control, not a hidden gesture — a wheel shortcut alone leaves it
  undiscoverable.
- **Shortcut overlay**, toggled by the `?` button (and F1): a translucent panel pinned to
  the **top-right of the capture**, listing the shortcuts grouped as capture (left click,
  right drag, Shift), time (wheel, Shift/Alt wheel, I/O trim, play), view (Ctrl+wheel,
  Space drag, middle-button drag, `1`..`9`, `` ` ``/`0`), and edit (Ctrl+Z, Del, Enter,
  Esc).
  - **On by default**, so a new user sees the whole vocabulary without asking; the toggle
    state persists (`showShortcutOverlay`), so turning it off is permanent until turned
    back on.
  - It is a passive layer, never a modal: click-through (`pointer-events: none`), no focus,
    no Esc handling, and it dims further while the pointer is near it so it can never hide
    the thing being annotated. Shows the LIVE key names where they are configurable.
  - It replaces the long inline key hint in the top bar, which was a wall of text in the
    one place that must stay quiet.

### Replay Trim

The timebar carries **in/out trim handles** (default: the full buffer). Keep only the
part that matters:

- Drag the handles, or press **I** / **O** to set the in/out point at the current scrub
  position; double-click a handle to reset it. A chip shows the trimmed length.
- **Save writes the trimmed range as `replay.webm`** (re-encoded through the render
  pipeline) and renders `replay_annotated` over the same range. Annotations, timeline,
  and `snapshot_t_ms` rebase onto the trimmed clock; the manifest records
  `trim_offset_ms` for provenance.
- Annotations whose lifetime falls entirely outside the trim are dropped — with a count
  hint shown before saving.
- Trim exists only in the initial capture session. Re-edit (History) cannot trim
  further: the pack's replay is already the original evidence.

### Editor Window Mode

The editor opens as a fullscreen overlay by default (fastest annotation), but it is a
real window too:

- A ⧉ button in the top bar (and F11) toggles **windowed mode**: standard move and resize
  (edges/corners), alwaysOnTop off, canvas re-fits live.
- **Windowed mode has a visible title bar.** A slim strip above the top bar naming the
  pack (the app name until the pack has a title) is the drag handle, and double-clicking
  it maximizes/restores like any caption. The top bar's own gaps drag too, with every
  control in it opting out so it still takes clicks and text selection — but the strip is
  what the user can SEE, because a frameless window whose only drag surface is the
  leftover pixels between controls cannot be moved in practice.
- **Fullscreen keeps no drag region and no title bar** — there is nothing to move, so the
  strip is not rendered at all and costs the board no pixels. It is also never over the
  canvas: it sits above the top bar in flow, so it can never take a click meant for a box.
- The last mode and windowed bounds are remembered (`editorWindowMode` + bounds);
  the next capture opens the way the user left it.
- Esc/Enter semantics identical in both modes.

### Welcome (first launch after install)

A tray app that opens nothing after install leaves the user with no idea what happened.
On the **first launch only**, a small welcome window appears:

```
CapturePack is running in your tray.

  Press  Ctrl+Alt+C  anytime               ← the live hotkey, not a hardcoded string
  the last 30 seconds are already recorded

  1  Capture      press the hotkey after the problem happens
  2  Annotate     right-drag a box, type what's wrong
  3  Save         a folder lands in <output folder>

  [ Try it now ]  [ Settings ]  [ Done ]
```

- **Try it now** closes the window and fires a capture, so the very first capture is
  guided rather than guessed at.
- Also mentions, in one line each: the tray icon opens History, and the built-in MCP
  server lets any AI read captures ("Analyze the latest CapturePack.").
- Shown once (`welcomeShown` setting); re-openable from About. Never shown on update —
  only on a genuinely fresh install (no settings file yet).
- Fully i18n'd; opens on the display holding the cursor.

### First-Run Tutorial

The toolless editor explains itself once. On the editor's FIRST open, a compact popup
shows an animated demonstration of the core interactions:

- **Left click** → select an object/box (animated cursor click + highlight)
- **Right drag** → draw a box, description input appears (animated drag + typing)
- **Wheel** → travel back through time (animated playhead)

Rules: dismiss with [Got it] (Enter/Esc too); a **"Don't show again"** checkbox persists
(`showEditorTutorial` setting); never blocks the 5-second workflow more than once.
Settings → General gets a **Guide link** (opens the online manual) and a
**"Show tutorial again"** action. All tutorial text is i18n'd.

### Annotation Interaction (toolless)

The editor minimizes annotation tool menus. Selection boxes, object selection, deletion,
and duration editing happen through mouse interaction alone — no Rectangle/Selection/Pin
tool buttons in the default UI. The user remembers only:

| Interaction | Action |
| --- | --- |
| **Left click** | Probe the real object at the current frame (Chrome DOM, Windows UI Automation). If a semantic object exists, select it, create an object annotation, and show the description input immediately. |
| **Right drag** | Manual selection box, live while dragging; on release, default 1.0 s lifetime + description input immediately. No tool-selection step exists. |
| **Top-left duration** | Shows the manual annotation's duration; click to edit instantly. Default 1.0 s. |
| **Top-right ×** | Delete the annotation (for Tracked Elements, tracking ends too). Ctrl+Z restores. |
| **Delete key** | Delete the selected annotation. |
| **Escape** | Cancel the annotation being created or edited. |

Manual boxes carry no semantic info; they store annotation_id, type, bounds, start/end
time, text, style.

### Unified Annotation Box

Pin, Rectangle, and Blur are NOT separate annotation types. Every annotation is one
**Box** model; users compose the features they need on a single box:

- Common properties: `annotation_id`, `bounds`, `text`, `start_ms`, `end_ms`,
  `numbered` (bool), `blur` (bool), `tracking`, `target`, `style`.
- Plain description box: numbered:false, blur:false · Numbered box: numbered:true ·
  Sensitive-content box: blur:true · Both: numbered+blur true.

**Box header** — minimal inline controls only, left to right: Number toggle · Duration ·
Blur toggle · (right edge) Delete:

```
[#] [1.0s] [Blur]                    [×]
[①] [1.0s] [Blur On]                 [×]   ← numbered + blurred
```

No Pin/Rectangle/Blur tool menus exist.

**The header is glued to its box.** It sits a few screen pixels above the selection
rectangle at every zoom level, on whichever display the box lives on, and it flips
*below* the box when there is genuinely no room above. It is measured after its own
labels are written — the number chip, the blur label and the duration chip all change
its size — and it is positioned in the same coordinate space it is measured in, so it
never drifts away from the box it belongs to.

**The header appears with the description input** — the moment a right-drag ends, the
box header (`[#] [1.0s] [Blur] [×]`) shows *together with* the text field, so number,
duration, and blur can be set while typing, without committing first and re-selecting.
Toggling a control never steals focus from the input; Enter commits the whole box.

**Selecting a box is editing its description** — selecting an existing box (a click, a
double-click, a lifetime lane on the timebar) puts the caret in its description with the
current text SELECTED, exactly as creating one does: typing replaces it, Enter applies,
Esc leaves it unchanged and closes the field. Moving or resizing the box never pulls
focus back to the canvas, and the standing rule holds — keyboard shortcuts are dead
while a text field has focus, so Delete edits the description rather than deleting the
box (the header `[×]` deletes it, and so does Delete once Esc has left the field).

- **Number toggle** — [#] click → numbered:true, shows the auto-computed number ([①]);
  click again → off; remaining numbered boxes renumber immediately. Numbers are never
  typed by the user; identity is always annotation_id.
- **Duration** — [1.0s] click → inline edit. Default 1.0 s; presets 0.5/1/2/5/10 s,
  Until End, Entire Capture, Custom. Tracked Elements may auto-extend until the target
  object disappears.
- **Blur toggle** — click flips blur on the box's interior instantly: editor preview
  blurs live, replay_annotated renders the blur, blur applies ONLY during the box's
  lifetime, and it moves with the box (including tracking). The original replay is
  never modified. Blur is a box property, never a separate annotation.

**Blur rendering order (per frame)** — original frame → blur → highlight/border →
number badge → annotation text. Editing controls (header, #, duration, blur toggle, ×,
resize handles) are NEVER rendered into replay_annotated — the video contains results
only (blur, border, number, text; arrow/highlight when supported later).

**Blur security principle (supersedes destructive snapshot blur)** — replay stays
original (preservation); blur lives in replay_annotated only. README/report may note an
annotation is blurred. The save-complete screen warns:
"Original replay contains unredacted content. Share replay_annotated or create a
sanitized ZIP." A future sanitized-ZIP option excludes replay + original snapshot.png.

**No include-replay toggle** — the editor has no option to exclude the replay from the
pack. Saving always keeps everything (save-first philosophy); what leaves the machine is
decided at SHARE time (annotated video, on-demand ZIP, future sanitized ZIP). Replay
length is the trim feature's job, not a checkbox.

Data example:

```json
{
  "annotation_id": "ann_8f21c4",
  "type": "box",
  "numbered": true,
  "blur": true,
  "start_ms": 12400,
  "end_ms": 13400,
  "text": "사용자 이메일 주소",
  "bounds": { "x": 100, "y": 200, "width": 240, "height": 42 },
  "tracking": { "enabled": false }
}
```

**UX principle** — no tool selection, ever: Left click = semantic object → box ·
Right drag = manual box · # = number toggle · Duration = time edit · Blur = blur
toggle · × = delete. Everything happens inside one Annotation Box.

### Pin Numbering

- Displayed pin numbers are **computed, never stored** — each annotation's permanent
  identity is its immutable `annotation_id` (e.g. `ann_8f21c4`); `display_number` is
  derived at display/export time and is not a source-data identifier.
- **Automatic renumbering** — add, delete, move, or time-change recomputes every pin
  number immediately. No gaps, always contiguous from 1.
- **Ordering** — start_time asc → creation order asc → annotation_id asc. Changing a
  pin's time on the timeline updates its number immediately.
- **Consistency scope** — the same numbers everywhere: editor canvas, annotation list,
  timeline, replay_annotated, report.md, README.md, the annotations export view, MCP
  responses, skills documents. Video numbers and document numbers must never differ.
- **Rendering** — final numbers are computed right before rendering replay_annotated;
  each frame draws only the pins active at that time, but with their GLOBAL fixed
  numbers (if only ② is active in a frame, it renders as ② — numbers never re-compress
  per frame).
- **Documents** — report.md/README.md use the final computed order
  (`1. 00:03.200 - description`); if pins change after generation, documents are
  regenerated on Save/Export.
- The user never manages pin numbers — CapturePack always keeps them tidy.

---

## Object Model

Future versions should understand actual interface objects.

**Examples**

- DOM: Button, Input, Panel, Window
- Windows UI: AutomationId, ControlType, Name, Bounds
- Future: Unreal Widgets, Unity UI, Custom Plugin Objects

CapturePack should remember objects instead of pixels whenever possible.

---

## Event Timeline

Events should be machine-readable.

**Examples**

- Mouse Click
- Keyboard
- Window Focus
- DOM Click
- Object Selection
- Annotation Added
- Plugin Event

Timeline should be replayable.

---

## Coding Guidelines

- Readable code over clever code.
- Composition over inheritance.
- Small modules.
- Plugin-first architecture.
- Avoid overengineering.
- Keep dependencies minimal.
- Public APIs should remain stable.

---

## Open Source Goals

- MIT License
- Contributor Friendly
- Clear Documentation
- SPEC before Code

Every public change updates the specification.

README should explain the project in under one minute.

---

## Repository Structure

```
capturepack/
├── README.md
├── LICENSE
├── SPEC.md
├── ROADMAP.md
├── ARCHITECTURE.md
├── CONTRIBUTING.md
├── docs/
├── core/
├── plugins/
├── examples/
├── tools/
├── site/
└── tests/
```

---

## Non Goals

Do not build:

- Cloud
- Accounts
- Sync
- Subscriptions
- Analytics
- Collaboration
- Marketing Features
- Issue Tracker
- AI API Integration

CapturePack should remain a focused tool.

---

## First Development Order

1. Write SPEC.md
2. Define CapturePack Format
3. Build Replay Buffer
4. Screenshot
5. Annotation Editor
6. Export CapturePack
7. Plugin API
8. Browser Plugin
9. Windows Plugin
10. Public Release

Always prefer simplicity over features.

Never sacrifice the 5-second workflow.

---

## Naming & README Notes

README 첫 문장 추천:

> CapturePack is an open-source context capture format and toolkit that helps humans and AI understand visual problems beyond screenshots and screen recordings.

이 문장 하나만 읽어도 프로젝트의 방향이 명확해진다.

GitHub 저장소 이름은 `CapturePack`보다 `capturepack`으로 하고, 확장자도 `.capturepack`으로 통일한다. 저장소 이름, 파일 포맷, 프로젝트 이름이 모두 일치하면 사용자가 기억하기 쉽고, 장기적으로 하나의 포맷으로 자리 잡기에도 유리하다.
