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
- **Release notes** — every tag ships notes on the GitHub Release, and they lead with a
  **scannable list, not an essay**. Three sections, in this order, each entry one line
  carrying its issue number:

  ```
  ## Added        — new capability that was not there before        - Something new (#12)
  ## Fixed        — it was broken and now is not                    - Something broken (#43)
  ## Improved     — it worked, and now works better                 - Something better (#58)
  ```

  Omit a section that has nothing in it. A reader deciding whether to update should get the
  answer in fifteen seconds, and **the issue is where the depth lives** — cause, measurement,
  rejected alternatives, evidence. Notes that re-tell the whole investigation duplicate the
  issue and bury the one line the reader came for. Anything that changes behaviour people
  rely on, or that they must do something about, gets its own short paragraph BELOW the
  lists; nothing else does.
- **MCP interface** — tool descriptions, responses, and docs/MCP.md always match the
  current format and behavior; a format change (annotation model, pack layout, naming)
  is not done until the MCP tools speak it.
- **GitHub Milestones** — actively used: every issue belongs to a release milestone
  (vX.Y.Z), milestones mirror the roadmap, and a release closes its milestone with all
  issues resolved or explicitly moved. Two honest exceptions, and only two: work that is
  agreed but deliberately undated lives in **Later — not scheduled** (a version number
  nobody intends to hit is a lie, and an orphaned issue looks forgotten), and the standing
  **usage journal** issue is pinned rather than milestoned, because it is never "done".
  An issue that slips out of a release is MOVED with a comment saying why — a milestone is
  closed by finishing or by deciding, never by quietly leaving things behind.

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
- **A failure is always announced — once.** Whether or not the start notice is suppressed:
  if the recorder never starts, the user must find out immediately, not when they press the
  hotkey and get a screenshot-only pack. And exactly once per failure, not once per retry:
  the announcement re-arms only when the recorder has proved it is recording again, so a
  machine whose screen capture is genuinely broken gets one balloon, not a balloon every
  few minutes forever. Every retry and every refined reason still reaches the log and the
  tray tooltip; what a repeat announcement adds is nagging, not news.
- The tray icon itself carries the state (recording vs stopped), so a glance is enough.
- **The state keeps agreeing with reality — it is never decided once.** "Recording" is
  earned from proof that frames are flowing, and that proof keeps arriving, so a recorder
  that recovers re-earns the state by itself within seconds. A display that is NOT
  recording keeps being retried (probe, then a fresh recorder) with a backoff, for as long
  as the app runs. A wrong state must be able to correct itself without a restart —
  a fixed number of attempts at startup means a transient failure latches forever, and the
  icon then lies in the one direction nobody checks: it says "not recording" while
  recording works.
- **Checking on the recording must never cost the recording.** Both ways of checking take
  something from a live recorder: asking for a replay stops the older of its two rotating
  segments, and recreating its window throws the whole ring buffer away. So neither is
  allowed on a guess. A request that goes UNANSWERED is not evidence — a busy machine
  failing to reply in time says nothing about whether frames are flowing, so it does not
  move the state AND does not count towards a rebuild. A recorder is only ever recreated
  when its renderer is gone, or when it has ANSWERED — twice, emptily — because a slot that
  was entirely muxer-buffered comes back empty on a perfectly healthy recorder, so one
  empty answer is not proof of anything either. Losing the last 30 seconds to a wrong
  verdict is strictly worse than displaying a wrong verdict, which is all the original bug
  ever did.
- **And the honest price of that rule, so it is never mistaken for an oversight**: a display
  whose renderer answers nothing at all, ever, sits on "starting…" rather than being named
  as failed. No evidence is not evidence of failure. It is on the record every time it
  happens, and it is far cheaper than a confident verdict that throws a working buffer away.

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
- **A decision not to do something is still a decision, and it is logged.** "The MCP server
  was never started" and "the MCP server was never mentioned" must not read the same, so
  every branch says which it took and why — disabled, autostart off, or starting on a port
  — and the intent is written before the socket is even attempted, so a run that dies
  waiting for it still shows what it meant to do. The same goes for a launch that exits
  because another instance already holds the lock: one line, then it goes.
- **A quit and a death are different events.** Choosing Quit is recorded as such; anything
  else leaves the run marked open. On the next start the app says plainly that the previous
  run stopped unexpectedly, when it was last alive, and that **the buffer was not recording
  in between** — the one sentence a user who pressed the hotkey into silence actually
  needed. An open marker left by a DIFFERENT version is an update replacing the app, not a
  crash, and is never reported as one — but it is not reported as a normal shutdown either:
  nobody watched that run end, and a genuine crash minutes before an update looks exactly
  the same, so the honest word is *unknown*. The verdict stays readable afterwards in
  About, so "was it running?" is answerable without a terminal.
- **An unhandled error does not end the run — and does not get to hide.** A stray
  programming error must not take the tray app down with it: a resident buffer that
  disappears is the failure this whole section exists to prevent, and losing the last 30
  seconds is a bigger loss than one broken flow. So the app logs the error and keeps
  running. But it also stamps the run marker, and a run with a fault in it is NEVER
  reported as having closed normally — not in the log, not in About. Surviving an error
  and then certifying the run healthy would be the same lie, told by the very feature
  built to expose it.

**And do not stay gone.** Reporting a death on the next start is not enough on its own: a
user pressed Ctrl+Alt+C, got nothing, and concluded CapturePack was not installed. It was
installed — it had died hours earlier, and nothing brought it back until the next login.
So the product makes one promise, and everything below exists only to keep it:

> **Pressing the capture hotkey always produces a visible result — a capture, or the app
> starting, or a message. Never silence.**

- **An unintended exit is undone.** A detached watchdog process (the app's own binary
  re-entered as plain Node, so nothing extra ships) watches the run and asks the SAME
  marker the previous point defines: an exit that reached will-quit was meant — tray Quit,
  an updater restart, a Windows shutdown — and is left alone. Anything else is a death, and
  the app is relaunched **once, promptly (about four seconds), and never silently**: the
  run that comes back says it stopped, when, and that nothing was recorded in between.
- **A relaunch loop is worse than staying dead.** At most three relaunches in ten minutes.
  On the fourth death supervision STOPS — and says so plainly rather than dying quietly.
- **When the app is not there, Explorer answers.** CapturePack keeps a Start Menu shortcut,
  "CapturePack Capture", carrying the configured hotkey as a Windows shortcut key. The
  shortcut key is **armed the moment the app is gone** (by the watchdog) and **removed
  while the app is running** (which is what lets the app hold the accelerator itself, so a
  capture stays instant instead of costing a process launch). The watchdog arms BEFORE it
  works out why the app went — the keystroke must have an answer during the gap — so it
  also takes the shortcut back on every path that ends with CapturePack alive again. An
  intentional Quit is the one case where it stays: nothing is running, so Explorer holding
  the key is the promise being kept. Pressing it while the app is
  running is forwarded into the live instance through the single-instance lock and captures
  immediately; pressing it while the app is dead starts CapturePack and says so, instead of
  hitting nothing. A hotkey the user re-records in Settings is mirrored onto the shortcut.
  A combination Windows cannot store on a shortcut (the Windows key, or no Ctrl and no Alt)
  simply gets no fallback — inventing a different key would be worse than having none.
  After supervision gives up, the accelerator is left with the shortcut on purpose: slower
  than owning it, and it cannot crash.
- **All of it is removable, and none of it fights setup.** One Settings → General switch,
  **on by default**, turns the whole thing on and off; off stops the watchdog and deletes
  the shortcut in the same click. The installer and uninstaller raise a stand-down flag
  before closing the running app, so supervision can never resurrect CapturePack in the
  middle of an update, and the uninstaller removes the shortcut. It never fights the login
  item either: the login item starts the app at logon, the watchdog only acts when the app
  is already gone, and the single-instance lock settles any overlap.
- **The limits, stated honestly.** Supervision is a watchdog, not a service: if the
  watchdog and the app are destroyed in the same instant (an "end process tree", a power
  loss) nothing is left to relaunch or to arm the shortcut, and the login item is what
  restores the app at the next sign-in. A live app notices a killed watchdog within thirty
  seconds and starts another. There is no Scheduled Task and no admin right anywhere.

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

### Plugin System, redesigned (v0.2.0)

The plugin model above was written for a capture that happens at one instant. It does not
survive contact with the product we actually built: **the user scrubs thirty seconds into the
past**, and a structural context collected once, at the moment the hotkey was pressed, cannot
answer a question about second 7. The redesign below replaces it in v0.2.0 — the same
release as the Chrome extension, because a plugin API and its first real plugin are one
body of work and shipping them apart would design the API against nothing.

**Two plugin kinds, and they share nothing but the host.**

```
CapturePack Plugin System
├─ Temporal Context Providers   observe, record, restore
└─ After Save Actions           consume a finished pack
```

They get separate APIs, separate lifecycles, separate permissions. A Provider runs alongside
CapturePack all day and keeps its own temporal buffer; an Action never runs until a pack exists.

#### Temporal Context Providers

A Provider must be able to answer *what was here, at this time, at this point* for any time the
replay buffer still holds — and Core never collects or interprets its data:

> **Provider** — observes, records, restores.
> **Core** — chooses the time and the screen position.

**Logically restorable at any time; physically stored however the Provider likes.** Core does
NOT demand a full DOM or UI tree per video frame. The expected shape is periodic checkpoints +
change deltas + geometry samples, so second 0.7 is checkpoint 0.0 replayed forward through the
deltas between them. Chrome uses DOM snapshots + MutationObserver + scroll/resize + SPA route
changes; Windows uses UIA tree checkpoints + StructureChanged/FocusChanged + bounds and
visibility changes; Unreal uses widget-tree checkpoints + create/destroy/transform/visibility.

**One clock.** Every Provider timestamps against a monotonic session clock Core hands out
(`sessionId`, `nowMs`, `bufferStartMs`, `bufferEndMs`) — never its own wall clock, or the
semantic timeline drifts from the visual one and every answer is subtly wrong. Replay frame time,
DOM event time, UIA event time, window z-order time and annotation time are all comparable on
that one `timeMs`.

**Approximate, but never silently.** A Provider that cannot produce the exact requested instant
returns its nearest sample *together with the error* — `TemporalAccuracy { requestedTimeMs,
materializedTimeMs, errorMs, exact }`. An answer that is 80 ms off is useful; an answer that is
80 ms off and claims to be exact is the same class of lie as a tray icon that says "recording".

**Buffer lifecycle.** `onBufferStart` (new session, retention), `onTick` (current monotonic time —
**not** an order to snapshot; each Provider samples at its own rate, e.g. event-driven plus ~10 Hz
bounds for DOM, 10–15 Hz for UIA, engine tick for Unreal), `onPrune(beforeTimeMs)` (drop what fell
out of the ring, keeping the last checkpoint still needed to restore what remains), and
`onFreeze(range)` (pin the captured range until the editor closes or the pack is saved).

#### Surface Timeline and the arbitration problem

A numeric `pluginPriority` cannot resolve this: a Notepad window in front, a windowed Unreal game
behind, one screen point — both Providers legitimately claim an object there, and the user is
looking at Notepad. So **Core restores the surface stack for that time BEFORE asking any
Provider**, from its own minimal Platform Surface Timeline: top-level windows, HWND, process,
window/client bounds, z-order, visibility, minimized/foreground state, visible region, ownership,
recorded on the same clock as the replay. It is not a UIA interpreter; it only answers which
window was where, in what order, at time T — **for the past desktop, not the one behind the
editor**.

Providers then claim *regions*, not whole windows. One Chrome window is shared: the DOM Provider
owns the web content viewport, the Windows UI Provider owns the address bar, tabs and frame.

**Selection algorithm.** Restore the surface stack at T → take the topmost visible surface at the
point → ask only the Providers holding a claim there → drop candidates that are not visible or are
occluded → order them by **surface visibility and z-order, then Provider claim, then semantic
authority, then semantic depth, then confidence, then user preference** → offer the first →
**keep the rest as a candidate stack** (Tab / Shift+Tab cycle objects, Alt+Click cycles surfaces
behind — Alt+Click may ship later, but the candidate model and surface stack must support it from
the start) → and with no candidate at all, fall back to a manual rectangle.

Authority is specificity, not rank, and the ladder is fixed:

```
application-native  →  document-native  →  accessibility  →  window  →  manual rectangle
   (Unreal widget)      (DOM element)       (UIA element)     (HWND)
```

**The default must always match what the user was actually looking at.**

**Tracked annotations** follow their object: Core stores `{ providerId, surfaceId, objectId }`,
asks the Provider for that object's bounds over the range, and the track carries `createdAtMs` /
`removedAtMs` — so the annotation appears when the object does, moves with it, and its lifetime
ends when the object is destroyed.

**A picked box cannot outlive its object, however far the lifetime is stretched.** Its
`start_ms`/`end_ms` are clamped to the track: drag the end handle past the moment the object
disappears and it stops there, and says why. An annotation is a claim about a moment — *this
thing, here, then* — and past `removedAtMs` there is no thing, so the box points at whatever
pixels land in that rectangle afterwards. Well-formed and false, which is the same defect as a
tray icon that says "recording". A manual box carries no such bound: it points at a rectangle
rather than an object, and may live as long as the user wants.

**A slow Provider must never hold the editor shut.** Timeouts are budgets, not suggestions:
hitTest 100–300 ms, materialize under ~500 ms, background work may take seconds, an After Save
Action 30 s by default and minutes if configured. Late candidates update the list asynchronously
rather than delaying the first paint.

**Permissions are declared and shown.** A plugin manifest names its `type`, `protocol_version`,
`entry` and `permissions` from a fixed set — `read-pack`, `write-plugin-files`, `network`,
`run-process`, `read-browser-context`, `read-active-window`, `native-messaging`, `create-zip`,
`open-browser` — and the user sees them before enabling it. Anything that sends pack data off the
machine says so in those words.

**What this project maintains, and what it does not.** Two official Providers — **Chrome Web DOM**
and **Windows UI Automation** — plus, as Core platform infrastructure and explicitly *not*
Providers, the **Windows Surface Timeline** and the **Surface Resolver**. Unreal, Unity and other
applications are community or external, and Core does not interpret their object trees.

UIA stays in Core because it is the floor under object picking on the platform CapturePack ships
on: with no plugin installed at all, hovering any window must still offer something, and that
guarantee cannot depend on a third party. But **being maintained by us is about who fixes it, not
about what it is allowed to do**:

> **Windows UI Automation is the reference implementation of the Provider protocol.** It consumes
> the same public API an external Provider gets — the same clock, the same surface claims, the
> same `hitTest`, the same timeouts, the same failure isolation. It gets no private path into
> Core, no privileged ordering, no shortcut through the Surface Resolver.

That constraint is the whole point of shipping it this way. If UIA needed something the protocol
did not offer, the honest response would be that **the protocol has a gap** — not that UIA is
special. A plugin API whose most important consumer does not use it is decorative, and we would
find that out years later, from someone else's bug report.

#### The two APIs get different promises

They are both plugin APIs and they are not the same kind of thing, so they do not get the same
commitment:

| | Temporal Context Provider | After Save Action |
|---|---|---|
| **status** | documented, **explicitly unstable** | **public and stable** |
| the job | run all day, keep a temporal buffer, restore the past, claim regions, hit-test in ~200 ms | take a saved folder and do something with it |
| when it fails | *"CapturePack picks the wrong thing"* | `✕ Jira failed` — named, retryable, pack already safe |
| trust it needs | continuous observation of the whole screen | read one folder, with declared permissions |

**Failure attribution is what decides this.** A community Unreal Provider returning wrong bounds
is experienced by the user as CapturePack picking wrong; they blame us, and we cannot fix it. An
After Save Action failing is shown by name, next to a Retry button, beside a pack that is already
saved. **Open the side where failure lands honestly on whoever wrote it.**

Demand runs the same way. Almost nobody wants to write a Provider — it is deep platform work.
Everyone with an internal tool wants to write an After Save Action. That is where third-party
energy actually is, so that is what we commit to keeping stable.

**But the Provider API is not closed, only unfrozen.** Sealing it would quietly destroy the UIA
decision above: the only thing that keeps "no private path into Core" true is that the Provider
API is a real API. Make it internal and the first "we're all on the same team, just one shortcut
here" is a matter of time. And we have not built a single temporal Provider yet — fixing the
abstraction now, against two consumers we control, is exactly how the wrong one gets frozen. So:
the API is documented, anyone may build on it, and it will move. Someone wanting an Unreal
Provider hears *"yes, and the API will change"* — not *"no"*.

**Stabilisation trigger, decided in advance so it does not quietly never happen:** the Provider
protocol goes to v1 with a compatibility promise at whichever comes first — **a Provider we did
not write working in the wild**, or **the first serious external request to build one**.

#### Export, failure, and isolation

A Provider's whole temporal buffer is working data and does NOT go in the pack. Saving exports
only what the chosen range and the chosen object need: provider metadata, the context snapshot at
the selected time, the selected object (stable id or selector, bounds, hierarchy), its track,
temporal accuracy, and any warnings or gaps.

**No plugin failure may ever cost a capture.** A disconnected Chrome extension, a timed-out UIA
Provider, an incompatible Unreal build — replay, snapshot, manual rectangles, annotation, folder
save and annotated replay all still work, and the save screen says which context is missing
rather than pretending it is complete. Likewise an After Save Action that fails leaves the pack
saved: the folder is the original, actions are what happens afterwards, each one retryable on its
own. Actions declare the pack state they need (`captured` → `metadata-ready` → `source-ready` →
`annotated-replay-rendering` → `annotated-replay-ready` → `complete`), because the annotated
replay renders in the background and not every action can run at the same moment. Actions must be
re-runnable later against a saved pack, with an idempotency key (pack id + action id + config id)
where duplicates would otherwise be created. Secrets never enter the pack — Windows Credential
Manager or Electron `safeStorage` — and any action that sends data off the machine says so before
it is enabled.

#### Explicitly NOT how this gets built

Calling a Provider once at the capture instant. Asking every Provider about every point. Settling
conflicts with a global priority number. Letting a Provider write Core's files. Failing a capture
or a save because a plugin failed. Forcing a full DOM/UI tree copy per frame. Implementing Jira,
Redmine, Slack or email inside Core. Building a marketplace, a central server, a workflow builder,
or an AI dependency before any of the above works.

> CapturePack records the visual timeline.
> Temporal Context Providers preserve the semantic timeline.
> The user chooses the time and target.
> After Save Actions decide where the resulting context goes.

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
and explains itself in one line with a "?" for the long version. **"Last capture" means
the last capture**: a capture taken with the switch off collects nothing and therefore
leaves no counts behind, so switching the plugin back on says what it does rather than
quoting a capture two captures ago. A row may only say
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
  **how the previous run ended** and when — closed normally, closed after unhandled
  errors, stopped unexpectedly, or replaced by an update with its ending unknown; every
  one of those gets its own sentence, because folding them into "closed normally" is how
  the window came to certify runs nobody had watched end — the two slogans, MIT license,
  and links: Website · GitHub · Report an issue ·
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
    auto-update check, start with Windows, and **keep CapturePack running and answering its
    hotkey** (GOAL "And do not stay gone.") — on by default, and a real teardown when
    switched off: the watchdog stops and the Start Menu fallback shortcut is deleted on the
    click, not at the next launch.
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
    (disabled, autostart off, port in use, bind error).
    **"Enable MCP server" is the on/off switch it says it is**: unchecking it stops the
    running server there and then and the status row says so; checking it starts one and
    reports where it bound (or why it could not). It is never a note for the next launch —
    a checkbox that reads "Enable MCP server" while a server keeps answering requests is
    the same lie as a tray icon that claims to be recording. **"Start automatically"**
    governs one thing only, and says so under its label: whether an enabled server comes
    up with the app.
    **Restart** stops and restarts the server in place with the current settings and
    reports the outcome — so changing the port costs a button, never an app restart (and
    never the recording of the last N seconds). It is the *apply* affordance, not the
    on/off one, and it is greyed out while the server is switched off, because there is
    nothing to restart.
    Beside the connection URL, one click copies a **ready-made setup command** for the
    chosen client (the forms documented in docs/MCP.md) and the **ready-made prompt** to
    hand an AI once connected. The setup command is built from the LIVE endpoint and is
    disabled while nothing is listening — a pasted dead URL is worse than no button. The
    prompt is the fixed English sentence the save toast also carries; it names no endpoint,
    so it is always copyable — there is nothing in it a dead socket could make wrong.
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
  - **The editor OPENS on the whole board** — every captured display visible at once,
    not framed on one of them. A capture whose whole point is that it took every screen
    must not open showing a single screen: the first thing the editor says should be
    what was captured. Opening framed is sharper (measured on a two-monitor desk, 0.578
    against 0.430 zoom — every control ~44% smaller by area on the board), and that
    trade is still the wrong way round, because sharpness is one keystroke away while
    the *existence* of the other displays is not discoverable at all when they are off
    screen. `1`..`9` frames a display when the work needs the resolution. Zoom/pan
    applies to the whole board.
  - **No display picker in the top bar.** The board already shows every display, so a
    row of monitor buttons is redundant chrome in the one place that must stay
    uncluttered. Framing a single display stays available on the keyboard (`1`..`9`,
    and the key left of `1` — backtick — to fit the whole board; `0` still does it
    too) and is discoverable through the help tooltip, not a toolbar.
  - **Framing is a VIEW, and Esc never undoes a view.** Zoom and pan have no Esc rung
    and neither does framing: the key that fits the whole board is the only way back.
    Esc belongs to the editing ladder (duration editor → the box being created →
    unsaved bar → selection → close) — giving a view state its own rung stole the
    press users expect to close the editor and made leaving cost two.
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
  control **and every status chip** in it opting out so it still takes clicks and text
  selection — the drag region does not inherit, so anything left unnamed stays caption.
  But the strip is what the user can SEE, because a frameless window whose only drag
  surface is the leftover pixels between controls cannot be moved in practice.
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
*below* the box when there is genuinely no room above — but only when the header fits
below. A box **taller than the stage** has room on neither side, and there the header
goes to the **top** edge: covering the box's first rows is a nuisance, while the bottom
edge would bury it in the middle of the pixels being annotated. It is measured after its
own labels are written — the number chip, the blur label and the duration chip all
change its size — and it is positioned in the same coordinate space it is measured in,
so it never drifts away from the box it belongs to.

**The description input is never off screen.** It is focused the instant it appears, so
its position is held inside the part of the board the stage actually shows — at any zoom
or pan, and for a box against the bottom edge. A focused field the user cannot see is a
field they type into blind.

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

### The picture is the clock (#81)

**A box goes where the user can see the thing it points at.** Not where the
thing was at some correct-but-invisible instant.

Those come apart because a video cannot be seeked to an arbitrary moment. Ask a
replay for time T and it shows the last frame at or before T — that is the only
picture that exists. The surface ring, being a list of samples rather than a
film, answers T exactly. Draw one over the other and the box sits beside the
window.

Measured in 0.2.0-rc.4 on a 15 fps capture that actually achieved 11.9 fps: the
picked boxes were accurate to a median of 9 ms, while the frame on screen at
each box's own time was up to 498 ms old — 1304 px of error on a dragged window.
The box was right and the picture was late.

So **anything that has to agree with the image asks on the image's clock**: the
presentation timestamp of the frame the compositor actually put on screen. The
playhead keeps its own nominal time, because a timeline that jumps backwards
under the user's hand is worse than one that is a frame off.

**No frame rate is ever assumed.** The rate a machine achieves depends on the
machine, the encoder and whatever else is running, so a constant correction
would be right on one desk and wrong on the next. The browser reports the
presented frame's time; that number is correct everywhere by construction.

Recording faster is a separate obligation (#82) and does not replace this one.
A capture that drops to 1 fps for a second still owes the user a box on the
window they are looking at.

**A low frame rate is two different facts.** A screen capture makes a frame when
the screen CHANGES, so a monitor nobody touched delivers almost nothing and has
lost nothing at all. Frames that were made and thrown away are the case where
the replay is genuinely missing time. Only `discarded_frames` tells them apart,
so the app reports it beside the rate and does not call a still screen a fault.
Measured on the reference desk: display 1 came up 486 frames short and had
discarded two of them.

### A picked box means the frame it was picked on (#90)

A box someone DREW covers a stretch of time, and the middle of that stretch is
a fair thing to call its moment. A box someone PICKED OFF AN OBJECT is a
different statement: *this window, as it was in the frame I was looking at.*
Editing its lifetime must not change what it says.

So the pick instant is read from the picture at the click, from the screen the
click landed on, and it is **recorded** — `tracking.picked_at_ms` — rather than
derived later from whatever the lifetime happens to be. `bounds` is the observed
rectangle at that instant.

Recording it is what makes it checkable. Both halves are in the pack, so the
validator can assert that `bounds` IS the sample nearest `picked_at_ms`, and the
failure this replaced — an anchor computed from the lifetime, drifting outside a
one-second track and clamping to its first sample, so the box showed the window
as it had been *before* the frame the user clicked — would now fail validation
instead of shipping.

### One ring, one clock, and no correlation by luck (#110)

Everything above assumes a sample's TIME means what it says. Twice it did not,
and the result was reported as *"한 화면에서도 못따라온다"* — a box that will not
follow its window even on a single screen, with no second monitor and no scaling
anywhere in the picture.

**A reply belongs to the request that asked for it.** `surface.tick` is fire and
forget, so several are outstanding at once and their answers need not come back
in order. The lane kept the tick's two readings — Core's clock at the ask, and
how old the frame already was — in two fields that the NEXT tick overwrote. A
reply arriving later was therefore differenced against a stranger's numbers, and
the sample was filed at `frameMs + (a difference between two unrelated
instants)`. The error is unbounded and changes sign. Measured on
CapturePack_2026-07-29_135650: one window of constant size 1443x953 appeared to
move 96–900 px between consecutive 67 ms samples, alternating direction, up to
13,000 px/s. No hand drags a window like that — the rectangles were right and
their timestamps were fiction. The readings are now keyed on the frame time the
reply echoes back, so a pair is a pair or there is no pair.

**A ring holds one clock.** Each display's recorder is its own renderer with its
own media clock and its own zero point, and every one of them was ticking into
the single lane — so consecutive samples landed in unrelated time bases seconds
apart. `IPC.captureTick` had documented "Focused display only — one clock" from
the beginning and nothing enforced it. A tick makes the host dump the WHOLE
desk, not one screen's part of it, so a second ticking display adds no coverage
at all — only a second clock. The first display to tick is the clock; the rest
are ignored, and the log says so once.

**Neither fault is reachable at a schedule.** Both need several ticks in flight
with replies out of order, which a real host on a timer will not produce on
demand. `npm run check:sync` drives the real lane against a synthetic host that
does, and asserts what a reader actually cares about: a window moving at a known
speed must appear to move at that speed. Against the code before this fix it
reports 2% ring coverage in one scenario and 17,250 px/s of apparent motion in
the other.

**A median is not a measurement of correctness.** The lane reported "tick lag
+1 ms" throughout, and that number was true and useless: the median of a set of
mismatched pairs sits near zero while the individual values swing hundreds of
milliseconds either way. Three release candidates were spent chasing clock legs
that were each already correct. A statistic that cannot show the failure is not
evidence the failure is absent.

### Two observations cannot share one instant (#110)

The clock legs were then all measured and all small — tick lag +1 ms, frame age
1 ms, host clock ±0.3 ms, and the host's own desktop dump 1.5 ms. Template
matching the tracked window against the actual replay frames put the recorded
rectangle within ~0 px of the picture. And the box was still wrong while a window
was shaken. *"움직일때 어긋나"*.

It was never a time-domain error. What it is remains open. What follows is a
merge that was real but small, and a **withdrawn claim** that was neither.

**WITHDRAWN: "25% of samples collide."** Counting track samples that share a
millisecond gave 44 of 173 in `_144311`, every pair holding a different
rectangle — and that was a measuring error, not a defect. `trackOf` emits ONE
SAMPLE PER SCREEN the window is visible on (#103, by design): the rectangles
differ because they are pixels of DIFFERENT displays' snapshots, exactly as
SPEC §8.2 requires. Counted per display, the number is **zero** in rc.16 and
rc.18, and 10 samples in rc.15. The collision was already gone before the fix
below was written for it. Three sessions of this bug have now produced three
measurements that had to be withdrawn; the pattern in all three is the same —
**an aggregate computed across coordinate spaces that were never comparable.**

The merge that WAS real: a tick's round trip varies, `frameMs` arrives on an even
grid, so `frameMs + lag` can go backwards; the guard against that was
`Math.max(lastAppendedMs, ...)`, and **`Math.max` does not reorder, it merges.**
Worth 10 samples in one rc.15 pack, not 25% of anything.

Two fixes were tried and rejected on the bench before the third:

- *Smooth the lag* (use the median round trip instead of this tick's). Removes
  the collisions and destroys the measurement: apparent speed fell to 0.45
  against a truth of 1.0, because every rectangle was filed at the typical
  instant rather than the one it was read at.
- *Nudge to `lastAppendedMs + 0.001`*. Keeps them distinct, which was never the
  point: two different rectangles 0.001 ms apart is 82,000 px/ms.

An observation that cannot be filed truthfully is **dropped and counted**. The
ring already holds a sample from a later instant, so a reader can reach nothing
in the dropped one — it was already unreachable under `Math.max`; the difference
is that the loss is now visible in `dropped` instead of disguised as a rectangle.

### What is still wrong, stated without a fix (#110)

Measured identically in rc.15, rc.16 and rc.18, so **nothing done so far has
touched it**: counting samples that repeat the previous rectangle EXACTLY while
the window is demonstrably moving (both neighbours differ by >100 px), per
display —

| pack | build | repeats while moving | median travel in that frame |
|---|---|---|---|
| `_143319` | rc.15 | 16 of 52 | 433 px |
| `_144311` | rc.16 | 19 of 76 | 391 px |
| `_151348` | rc.18 | 13 of 49 | 363 px |

About a quarter of the observations during a drag say the window did not move,
while it moved a third of a screen. That is the size of the reported error and
it is the only unexplained thing left.

**It is not yet known whether that is a lost observation or a window that really
stalled.** The distinguishing test — a lost observation makes the NEXT step twice
a normal one, a real stall makes it one — gives 1.83x on `_151348` and 0.73x on
`_144311`. Opposite answers, so it decides nothing, because drag speed varies
inside a capture and a median across it compares nothing in particular. The test
that would settle it is the one that already works: template-match the window in
the replay frames on both sides of a repeat and see whether the picture moved.

### The elimination, and the leg nobody measured (#110)

The question above was settled by measurement, then the sender was found by
eliminating every innocent layer in order. All on 2026-07-29, pack `_151348`
plus three live probes with a human shaking a real window:

1. **The picture kept moving through every repeat.** Whole-frame mean-abs-diff
   between the two frames of each repeated rectangle: median 12.4 — the same as
   normal moving pairs (10.8) and nothing like true stillness (0.0–0.75, the
   capture's tail measures it in the same run). The record is wrong, not the
   window.
2. **The OS publishes fresh positions.** A 1 kHz probe gated on
   `GUI_INMOVESIZE` (so ordinary mousing cannot false-trigger — the first two
   probe designs false-triggered and measured nothing), during a real 52 s
   shake: `GetWindowRect` changed 12,161 times, every 4 ms at the median, only
   2 gaps over one frame. DWM extended bounds: identical cadence.
3. **The host is clean.** The real `context-host.ps1` driven exactly like
   production — `surface.tick` every 67 ms — while the same File Explorer
   window was shaken 292,274 px: **0 repeats in 644 moving samples**.
4. **The lane and the ring are clean.** The real `SurfaceLane` + real
   `SurfaceTimeline` + real host, three taps recording every rectangle (as the
   host event delivers it, as `append` receives it, as the ring reads back):
   **0 / 0 / 0 repeats in 433 moving samples**.

Every layer that MAKES rectangles measured innocent, so the fault had to be in
what ASSIGNS THEM TIMES — and the only unmeasured quantity left in the whole
chain was when the `requestVideoFrameCallback` callback actually runs. Under
encoder load the compositor delivers those callbacks in bursts: frame N's fires
tens of ms late, frame N+1's fires a few ms after it, both ticks read a desk
4 ms fresh at nearly the same instant, and the two nearly-identical rectangles
are filed under frame times 67 ms apart. A box frozen for a frame while the
window travels ~400 px — the exact measured defect, manufactured by tick
timing, invisible to `lag` (which starts at tick-SEND) and to `frameAgeMs`
(which ends at frame submission).

The missing leg was always measurable: the callback's own timestamp minus
`metadata.presentationTime`, same clock, per frame. It is now the fourth
measured term in the sample's time —

    observedAt = frameMs + callbackDelay + hostLag + pixelAge

and the lane logs it as `callback late N ms p50 / M ms p90` — the p90, because
bursts are the failure mode and a median of a bursty series reads healthy, which
is how every earlier number in this bug's history managed to look innocent.

`check:sync` now models bursty callbacks (every other frame 55 ms late through
the middle of the run) and counts frame-length stalls of a window that is truly
moving. Delay-blind arithmetic — what rc.18 shipped — fails it with 4 stalls;
with the delay folded in it passes at 0 stalls and apparent speed 1.00. The
next shaken pack is the field verdict: if its repeats are gone and the log
shows a fat callback p90, the conviction stands.

**The field verdict came back: acquitted.** rc.19's first shaken pack
(`_155020`) logs `callback late 0 ms p50 / 0 ms p90` — the compositor delivers
callbacks on time even under load — and the repeats sat at 27/101, unchanged
through the fifth consecutive fix. The delay measurement stays (a leg measured
at 0 is knowledge; a leg assumed 0 was this bug's whole biography), but the
burst hypothesis is dead.

### `Math.round` of a query is not the query (#110) — the actual cause

What was different about production was never the clocks, the host, the load or
the callbacks. It was that the bench read the ring back with the ring's own
EXACT sample times, and production reads it through `frozenRingObservations` —
which rounded the query to integer milliseconds because pack times are integer
milliseconds.

The ring's sample times are fractional (`frameMs + lag + age`, and
`presentationTime` is never whole). `restoreAt` answers with the newest sample
AT OR BEFORE the asked time — deliberately, so a frozen query can never see the
editor's own window. Round a fractional sample time DOWN by even 0.2 ms and the
query lands just before the sample it names; the at-or-before answer is then
the PREVIOUS sample. A rectangle from a whole frame earlier, republished under
this frame's label.

The arithmetic convicts it: a repeat surfaces when a round-up is followed by a
round-down — **P = 1/4 for uniform fractions — and the shaken packs measured
25%, 27%, 31%.** The same miss also explains the physically impossible
apparent speeds the very first analysis found (a whole frame's travel divided
by a sub-millisecond label gap). One mechanism, both signatures, present in
every build since the ring was first read back.

The fix keeps both truths: the QUERY uses the exact fractional time, so the
answer is the sample being named; only the LABEL is rounded, because SPEC pack
times are integer ms and half a millisecond of label error is bounded and
harmless. Two samples that would share a label publish once, not twice.

`check:sync` was passing while all of this shipped, and the reason is a bench
lesson worth the price: **it read the ring directly, bypassing the layer that
contained the bug — and its clocks were all integers, so the rounding was the
identity.** It now reads back through the real `frozenRingObservations` with
fractional frame times like the real clock's. Against the rounded query it
reports 17 stalls and 19,000 px/s — both measured production signatures,
reproduced at last — and 0 stalls, speed 1.00, with the fix. A bench that
bypasses a production layer certifies nothing about it, and a bench whose
numbers are rounder than production's cannot see a rounding bug.

### The floor under everything: 15 observations of an 8,000 px/s hand (#110)

rc.20's field pack (`_160014`) measured clean at every layer this document has
convicted so far — repeats 0/149, data within −4 ms of the picture, the
annotated renderer within −4 px of the data — and the user looked at it and
said, correctly, *"박스 싱크 안맞아"*. Box against window in the annotated
frames: p50 −8 snapshot px, p10 −112, p90 +80, single frames past 250. Frame
`t=7095` shows the box a third of its own width off the window. The eye judges
the worst frame, not the median.

That residual is not an error in anything; it is the sampling floor. Samples
now carry their honest times, which land BETWEEN frames, so the nearest
observation to a frame is up to half the sampling interval away — at 15
observations/s and a shaken window's 8,000 px/s, up to ±270 px, on exactly the
frames that show motion.

**Interpolation was tried and measured worse, and the measurement is the
reason it is not shipped.** Drawing the box at the time-weighted point between
the two bracketing observations: p10 −183 / p90 +163, against nearest's
−112/+80. Shaking at 5–7 Hz sits at 15 Hz sampling's Nyquist limit — a whole
direction reversal fits between two samples, and a straight line across a
reversal cuts the corner by more than the nearest sample misses. No rendering
can recover what was never observed.

So the fix is observations. The first tick used to STOP the free-running host
loop (#106) — necessary when free-running samples lived on a second clock, and
obsolete since the tick mapping (callback delay included) converts them onto
the frame clock with the same monotone guard as everything else. The loop now
runs alongside the ticks at 31 ms — the fastest cadence the 5%-of-a-core
promise (Rule 4) allows at ~1.5 ms per dump, odd so it drifts through the
67 ms tick grid instead of aliasing. The host's own floor drops from 50 ms to
15 ms; its old rationale ("the compositor doesn't move anything faster")
measured false weeks ago — GetWindowRect updates every 4 ms in a drag.

Live, against the real host: **479 appends in 10 s (~48 observations/s), zero
inversions, inter-sample gap p50 29 ms / p90 42 ms** — the nearest-observation
error budget drops from ±33 ms to ~±15 ms, ~±120 px at violent-shake speed and
under the border's own width at ordinary drag speed. If the field pack still
shows visible detachment at the extremes, the next step is event-driven
observation (`EVENT_OBJECT_LOCATIONCHANGE` in the host — SetWindowPos cadence
during drags, zero cost at rest), not more arithmetic.

### The governor was right, and the desk is usually still (#110)

rc.21's field pack (`_161901`) confirmed the density fix — and then measured
the bill being paid wrongly. The first ten seconds ran at ~48 obs/s, gaps p50
23 ms; then the observation rate fell to ~20/s mid-capture. That was the
GOVERNOR, correctly enforcing Rule 4: a constant 31 ms free-run is ~4.8% of a
core and the ticks' own sampling is ~2.2% more — the budget arithmetic behind
"31 ms fits under 5%" had forgotten the ticks. Three status ticks over the cap
and the lane demoted itself, exactly as designed.

Even at half density, the eye's error improved: box vs window p10/p90 went
from −112/+80 (rc.20) to **−76/+56**, renderer still faithful at −4 px. (The
first read of that measurement said the renderer was off by up to 994 px — a
measurement artifact: this pack has boxes on several different windows, and a
global green-pixel scan finds the leftmost box, not the asked-about one. The
detection is now gated near the expected rectangle.)

The structural fix is that the fast rate should never have been constant: a
desk is still almost all of the time, and hands move windows for seconds, not
hours. The host's dump already knows whether anything moved since the last
one (`MovedLastSample`), so `surface.start` now carries two cadences — a base
interval and a `fastMs` the resident loop switches to whenever the previous
dump saw motion. In motion: 31 ms. At rest: 200 ms under ticks, and the duty
the 5% promise is written against — cumulative over the host's life — stays
far under the cap by construction. Verified against the real host: a still
desk observes at ~20/s (ticks + base), zero inversions; the constant-rate
version measured 479 appends in the same window.

And with ~20–45 ms between observations, the interpolation verdict FLIPS,
measured on the same pack: drawing between bracketing observations lands
p10/p90 −52/+40 against nearest's −76/+56 — at 67 ms it was worse (163 vs 80,
the Nyquist corner-cut). So drawing briefly interpolated across gaps ≤40 ms.

**Interpolation was then removed by decision, not by measurement**
(*"보간하면 안되지.. 왜 정확히 못얻어오는지가 중요하지"*): a drawn rectangle
nobody measured is a statement the record cannot back, however plausible its
position — and it papers over the actual defect, which is that the
observations are not exact enough at the moments that matter. #89 stands for
DRAWING as well as for the pack.

### The OS says when — the move hook (#110)

The remedy for inexact observation is exact observation. `context-host.ps1`
now installs `SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE)` on a pump thread:
the window manager announces every rectangle change (measured at ~4 ms cadence
through a real drag), the callback filters to visible top-level WINDOWS (the
same event fires for the cursor — on every mouse move — and the caret), and
the resident loop dumps the desk at once, coalesced to 8 ms. Position still
comes from direct `GetWindowRect` — the hook is WHEN to look, never HOW.

The polling ladder becomes the fallback: `fastMs` stepping only runs where the
hook could not install, and the hello reply carries `moveHook` so main.log
states which regime a session observed under. Verified standalone: hook
installs, a still desk stays at the base cadence, and the first movement
switches sampling to 9–16 ms gaps within one coalescing window. The error
budget during motion drops from ±15 ms (31 ms polling) to ~±4 ms — under
~100 px at even the wildest measured shake.

### Controls exist at every frame, anchored to their window (#111)

*"매프레임 하위 컨트롤러도 저장해야지."* The UIA tree is dumped once — a full
desktop walk costs 183.8 ms and cannot run per frame — but a control does not
float free: it is drawn inside its window at an offset that survives the
window being dragged, and the window's position at every frame is already in
the ring at the move hook's exactness. So the provider now offers the dump's
controls at EVERY requested time, each translated by how far its own window
moved between the dump and that time. A control whose window has no surface at
the asked time is dropped, not floated. The position is composed from two real
observations and says so (`interpolated` on its accuracy, #83); the CONTENT is
still the dump's.

### Lane A: the tracker holds the references (#111)

The other half of that directive — a control that moves INSIDE its window, which
anchoring cannot see — is now built, and the measurements decided its shape
rather than the design sketch doing it.

**The walk is the cost, not the property fetch.** A bare `FindAll(Subtree)`
reading NOTHING is already 95.1 ms of Explorer's 98.7 ms one-property total.
So `FindAllBuildCache`, the obvious optimisation, is a NET LOSS — measured
4.4x worse on ChatGPT (147.2 → 652.8 ms), 4.5x on Explorer, 4.3x desktop-wide.
It batches property round trips, and property round trips are the minority.
It is not used.

**What wins is holding the element references.** Re-reading `BoundingRectangle`
off refs from a previous walk:

| | walk | refresh held refs | |
|---|---|---|---|
| whole desktop, 2782 elements | 1580.6 ms | 227.2 ms | 7.0x |
| Explorer, 234 elements | 482.8 ms | 17.6 ms | 27x |
| this lane's own foreground window, 400 | 976.9 ms | 32.4 ms | **30.2x** |

Per-element refresh is also UNIFORM at 55–105 µs across Qt, Chromium and
Explorer, where the walk varies 20x by provider. The incremental path is
predictable; the walk is not.

A short-lived helper can hold nothing, so lane A is RESIDENT — and a SEPARATE
process from lane S, because UI Automation blocks: Docker Desktop answers for
ten elements in ~2050 ms, reproducibly, more than the rest of the desktop
combined. Inside the context host that would freeze window sampling, which is
the one lane the box actually follows. Separate processes mean lane A can hang
and be killed while lane S keeps its 10 ms cadence.

**Its budget is structural, not aspirational.** After every pass the loop sleeps
(1/duty − 1) times what that pass cost, so the duty cycle is a property of the
loop rather than a hope about the desktop. Target 3% — not 5%, because 5% is the
whole context subsystem's budget and lane S now spends 1.11% of it. Measured
driving four real windows (195 held elements) for 45 s: cumulative duty falls
7.92% → 3.54% as the one-time walks amortise, and the MARGINAL rate settles at
2.8–3.0%, reading 3.02% across the last interval.

Three things the measurements said would bite, all handled and all pinned by
`npm run check:controls`: held references ROT (4.4% of 3140 dead within 50 s
with nothing driven at all) so a dead ref REMOVES its control rather than
freezing it; a re-walk starts a new tree VERSION so a delta can never be applied
to a tree it does not belong to; and a chatty `StructureChanged` (186 events in
20 s at desktop root, idle) cannot drive re-walks — there is a 3 s floor between
them, because a walk costs three orders of magnitude more than the refresh that
serves the same window meanwhile.

Anchoring stays as the FALLBACK: with lane A running, the nearest observation to
a requested time already carries the right rectangles, so what anchoring has
left to correct is the residual window movement since that observation rather
than the whole replay's worth.

### Can UIA be TRACKED after the first dump? Measured: yes — 7-27x (#111)

*"UIA 전체덤프는 힘들겠지 하지만 첫덤프 이후에 추적이나 업데이트는 가능하지
않을까?"* Yes. The intuition was right and the reason was not the expected one,
so the numbers are here rather than the assumption. All measured on this
machine, live desktop of 3111 elements across 17 windows.

**The tree WALK is the cost, not the property fetch.** A bare
`FindAll(Subtree)` reading ZERO properties is 95.1 ms of Explorer's 98.7 ms
one-property total — 96% of it. So the obvious optimisation is the wrong one:

| what | uncached | `FindAllBuildCache` |
|---|---|---|
| ChatGPT, 593 elements, 1 prop | 147.2 ms | **652.8 ms** (4.4x worse) |
| Explorer, 234 elements, 1 prop | 98.7 ms | **445.8 ms** (4.5x worse) |
| whole desktop | 1580 ms | **6787 ms** (4.3x worse) |

`IUIAutomationCacheRequest` batches property round-trips, which are the
minority of the cost, and pays per-node cache construction on top. It won in
exactly one case (an in-process-ish Qt provider, 1.2x). **Do not build on it.**

**Holding the element references IS the win.** Keep the `AutomationElement`
handles from one walk and re-read only `BoundingRectangle`:

| | refresh held refs | re-find by walking |
|---|---|---|
| all 2782 desktop elements | **227.2 ms** | 1580.6 ms (7.0x) |
| Explorer, 234 | **17.6 ms** | 482.8 ms (27x) |
| ChatGPT, 593 | **43.6 ms** | 599.9 ms (14x) |

And it is PREDICTABLE where the walk is not: per-element cost is 55-105 us
across Qt, Chromium and Explorer alike, while the full walk varies 20x by
provider (0.14 ms/elem to 3 ms/elem).

Frame budget, n=200 each: K=20 p99 3.08 ms, K=50 p99 5.95 ms — both inside a
16 ms frame. K=100 p99 18.57 ms — does not fit. K=728 (a real dump) p50 58.0 /
p99 82.8 ms — not per frame, but comfortable at 2-4 Hz. So: a tracked subset of
~50 per frame, everything else at a few hertz, and a full desktop re-dump per
frame stays impossible.

**Events work and are cheap**, so the refresh does not have to be a timer.
StructureChanged on one window/Subtree registers in 16-19 ms,
PropertyChanged(BoundingRectangle) in 3.5-8.0 ms, desktop root in 43-106 ms.
Delivery confirmed with nothing driven: 186 StructureChanged + 5
BoundingRectangleChanged in 20 s at root scope; scoped to one idle window, 0
events in 10 s — correctly quiet.

Two findings that shape the design more than the speed does:

- **Held references rot.** 3140 refs, no input synthesized: 0 dead at 5 s and
  20 s, **138 dead (4.4%) by ~50 s**. A tracked set decays by itself, so it
  must be reconciled — a dead reference has to remove its candidate, never
  freeze it.
- **One provider can dominate everything.** Docker Desktop: 10 elements,
  ~2050 ms per pass, reproducible across three passes — more than the entire
  rest of the desktop combined. Any walk needs a per-window timeout and a
  repeat-offender blocklist, or one hung provider defines the latency.

Also confirming the existing split: Win32 `GetWindowRect` over 17 top-level
windows is 0.177 ms against 13.05 ms for UIA top-level enumeration — 74x. Window
geometry stays with lane S; lane A is for IN-WINDOW controls only, which is
what docs/temporal-protocol.md §1 said before any of this was measured.

### Recording is a switch (privacy)

`settings.recordingEnabled` — OFF resolves the recorder set to empty through
the ordinary rebuild (no special teardown path to rot), the hotkey answers
with a notification saying recording is off instead of silently doing nothing,
and Settings > Capture leads with the switch because every row below it
describes what it turns on. Nine languages, applied live.

`npm run check:sync` asserts it: zero samples sharing an instant, and apparent
speed 1.00 against a truth of 1.0. Against the `Math.max` version it reports 20
of 60 colliding. That red test only worked on the second attempt — the harness's
first jitter was `ft * prime % n`, whose step is one of two constants, and it
never fell far enough to invert anything. **A jitter that cannot invert proves
nothing**, and it passed the red test, which is the only reason it was caught.

The host's `t` was stamped by the caller, *before* the dump it labels — filing
every rectangle early by the dump's cost, one-directional and proportional to
drag speed. Now stamped at the dump's midpoint, with `dumpMs` in the event so the
cost is visible. Measured at 1.5 ms, so this was worth ~5 px, not 443. It is
fixed because it is wrong, and reported as small because it is small.

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
