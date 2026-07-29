# Handoff — CapturePack v0.2.0

> Historical archive. Do not use this file as current release or task status.
> Start with [HANDOFF.md](HANDOFF.md), then consult this record only for its
> measurements, incidents and design history.

Written 2026-07-28 for whoever picks this up next. Read this before touching anything.

---

## SAFETY RULES — read these first, they are not boilerplate

Two real incidents happened on this machine today. Both are why these exist.

- **NEVER synthesize keystrokes or mouse input.** Not SendKeys, not nircmd, not AutoHotkey, not robotjs, not PowerShell key synthesis. **Especially never `Ctrl+Alt+C`** — CapturePack is installed on this machine and it will fire a real capture on the user's desktop. This already happened once: an agent synthesized the hotkey, a real pack was created, and it ended up in the Recycle Bin.
- **NEVER touch the installed app.** `C:/Users/recue/AppData/Local/Programs/CapturePack` and `%APPDATA%/CapturePack` are live. Reading logs is fine; writing, killing, restarting, uninstalling are not. `%APPDATA%/CapturePack` holds the run marker and supervision state the running app depends on.
- **NEVER write to `C:/Users/recue/OneDrive/Desktop/CapturePack`.** Those are the user's real packs and several are the evidence this work is measured against. Read them; never write, move or delete.
- **Verify your worktree is a real separate path before you start.** An orca worktree once pointed at the same directory as `main` and an agent began editing the primary checkout. `git rev-parse --show-toplevel` and confirm it is not `C:/_Project/capturepack`.
- **Headed testing**: detached Electron only, with your own `--user-data-dir`, `--output-dir`, `--no-global-shortcut`, `--no-login-item`, all inside your own worktree — never a shared scratchpad, because a second instance on the same profile takes the single-instance lock and kills yours. Kill only PIDs you verified by command line as yours.
- **v0.1.6 ships a watchdog that relaunches the app** and a Start Menu fallback shortcut. Anything you start must only ever be able to relaunch *your* instance, and you must tear down every watchdog, scheduled task and shortcut you create. Verify they are gone before you finish. (This is also slated for removal — see #80.)
- Do not change display settings, driver settings, or anything else in the OS. Do not push, do not tag, do not open PRs.

---

## How this project decides things

These are not style preferences. Every one of them exists because ignoring it cost a release.

1. **Measure before you claim.** Three times in two days, work was reported as "fixed" and adversarial verification proved it was not: #50's root cause was disproven by measurement, v0.1.6's recorder fix destroyed a healthy ring buffer, and the picking fix's headline was false. A claim without a number is a hypothesis.
2. **Every implementation gets an adversarial verifier** whose default assumption is that the fix is not a fix, who re-runs the checks themselves and reproduces runtime behaviour in their own isolated run. This caught four release blockers today. It is why the project moves slowly and why it ships.
3. **Being wrong in the contract is the same defect as being wrong in the code.** `GOAL.md` is the living spec and is authoritative. If code and GOAL.md disagree, one of them is a bug — fix it and say which.
4. **Say what you did NOT close.** A commit that writes `Closes #N` for work that leaves the issue's headline symptom untouched is the specific dishonesty this release cycle exists to remove.
5. **i18n is type-enforced** (`core/src/shared/i18n.ts`): every user-visible string needs all nine languages with real translations, never English pasted nine times.
6. **Strict TypeScript.** No `any`, no non-null assertions, no `@ts-ignore`, no empty `catch`.
7. **Verify with**: `cd core && npm run typecheck && npm run build && npx electron . --smoke`, and from the repo root `node tools/validate-capturepack.mjs examples/minimal`.

---

## THE IMMEDIATE JOB — integrate three divergent branches

**This is the blocking task.** Nothing else in v0.2.0 can proceed until it is done.

Phase 1 ran three implementations in parallel from one design document. Each built the shared foundation independently, so there are now **three incompatible versions of the same subsystem**:

| branch | commit | what it owns |
|---|---|---|
| `worktree-wf_f0562ba6-c11-1` | `6ebfbb6` | `docs/temporal-protocol.md` — the design, 840 lines, docs only |
| `worktree-wf_f0562ba6-c11-2` | `fe234a5` | **spine**: `timeline.ts`, `clock.ts`, `host.ts`, `providerHost.ts`, `surfaceLane.ts`, `runtime.ts`, `context-host.ps1`, two benchmark harnesses |
| `worktree-wf_f0562ba6-c11-3` | `1018cf5` | **uia**: the real Windows UIA provider, its own `context-host.ps1`, `resolver.ts`, SPEC.md, MCP tools, validator |
| `worktree-wf_f0562ba6-c11-4` | `50429aa` | **picking**: `resolver.ts` + `surfaces.ts` (shared), editor integration, deletion of the v0.1.7 stopgap, temporal test fixtures |

`core/src/shared/context/protocol.ts` exists in all three at 690 / 597 / 519 lines; branches 3 and 4 differ by 786 changed lines in that file alone. Branch 3 has `main/context/legacy-pack.ts`, branch 4 has `main/context/legacyPack.ts` — same idea, different files. `resolver.ts` lives under `main/context/` in one and `shared/context/` in the other.

**Recommended approach**: take **c11-2 (spine)** as the base — it is the deepest and best-measured, and its verifier said "two small fixes and it's mergeable" — then port c11-3's UIA provider and c11-4's resolver + editor changes onto its protocol. Do not try `git merge`; these are design divergences, not textual conflicts.

Read all three verifier verdicts first (see below). They contain measurements you should not have to re-derive.

---

## Verifier verdicts you must act on

### spine — DO NOT SHIP AS-IS (one blocker)

**The string intern table grows forever and is charged against the ring budget.** `core/src/main/context/timeline.ts:716-728` (`intern`) never evicts; `timeline.ts:439-443` charges `identityBytes` against `bytesUsed()`, which `enforceBudget()` (`:647-650`) tests against the 512 KB ceiling and `prune()`'s recovery gate (`:297-300`) tests too.

Measured: **one window retitling once per second** — a downloading browser, a media player, a terminal progress line, a VS Code dirty marker — puts the ring at **1,551 KB against a 512 KB ceiling** and collapses sampling from 10 Hz to **~1 Hz**, and it **never recovers** even after the churn stops and retention prunes everything away, because the recovery gate tests the same inflated number.

The benchmark misses it because `surface-bench.mjs:330-353` builds its hostile ring from windows with *constant* titles, so only geometry churns. On this actual desk the churn measured 0.000 KB/s, so it is latent, not observed — but it needs no exotic desktop.

**Fix**: prune the intern table in `prune()`, or stop charging an unbounded table against a sample budget.

### picking — SHIP the code, but the headline is false

The commit subject says "object picking follows the scrub". Verified headed against the real pack `CapturePack_2026-07-28_191714`:

| requested t | coverage | candidates |
|---|---|---|
| 30000 ms (the capture instant) | `covered` | **461** |
| 29999 ms | `single-instant` | **0** |
| 15000 ms | `single-instant` | 0 |
| 0 ms | `single-instant` | 0 |

**Picking is alive at exactly one millisecond of the thirty seconds.** Existing packs carry a single-instant dump, so there is no past to restore, and `surfaces.ts:61-69` short-circuits to `single-instant`. That is defensible behaviour and it is *the same observable result as v0.1.7's stopgap*. **The user's reported bug is not fixed for the user by this commit.**

What IS genuinely true and independently confirmed: the stopgap is really gone (`git grep objectsDescribeNow` → no matches, all nine i18n slots deleted); the replacement refuses based on `accuracy.coverage`, a property of the data, and never consults the playhead; picking quality survived bit-identical (median offered rectangle and the share under 100 kpx unchanged); and the mechanism works when there IS temporal data — a two-observation ring returns 458 candidates at two real times and 0 in between, with the 3000 ms staleness ceiling cutting exactly where it should.

**The open question, and the reason to build an installer**: nobody has verified that a *new* capture on the new build records temporally. All verification used old packs and synthetic rings. **That is the single most valuable thing to test.**

### DXGI (#62, branch `worktree-agent-aafaf5aa087f2942c`, `d4a8e54`) — DO NOT SHIP (one blocker)

`core/src/main/index.ts:291` calls `app.relaunch()` with no `args`, so the new process inherits `process.argv` verbatim. Reproduced twice on the built app: a backend restart that inherits `--relaunched-by-supervisor` makes the new run announce *"CapturePack stopped unexpectedly and restarted itself"* about its own deliberate restart, and one that inherits `--capture` tells the user *"you pressed the hotkey and the app was not running, press again"* when they pressed nothing.

`NON_RELAUNCHABLE_ARGS` (`core/src/shared/supervision.ts:70-80`) exists for exactly this and is used by `supervisor.ts:393-397` but not by `index.ts:291`. **One-line fix.** Note that #80 (removing the watchdog) eliminates most of the blast radius but not the underlying bug — `--capture-now`, `--simulate-no-frames` and friends would still survive a restart.

Also from that verdict, worth fixing but not blocking: the editor guard `isCaptureFlowActive()` goes false while fire-and-forget work is still running (`session.ts:815` exact-length cut, `annotatedRender.ts:140` render + `writeKeyframes` which deletes and rewrites `frames/`, and History's [Retry Render] which never sets the flag at all), so a restart mid-sequence leaves a pack whose manifest and files disagree; `isRenderInFlight()` (`annotatedRender.ts:122`) is the missing predicate. And escalation is a one-way door with no Settings UI — a machine that falls to GDI sits at ~6× the frame cost forever with no way back.

**What is verified good**: the ladder cannot loop (`duplication → wgc → gdi → stop`, exactly 3 launches, then it stops harmlessly), the `ExitKind` handling is correct, and every Chromium claim was independently reproduced (`AllowWgcScreenCapturer`, `DirectXCapturer`, and frame times 1.6 / 3.2 / 10.0 ms).

---

## After integration: the rest of v0.2.0, in dependency order

The milestone is `v0.2.0 - temporal plugin system and Chrome extension`. Full detail is in the issues; they carry the evidence and the rejected alternatives.

**2 — format, and do it in ONE version bump.** #75 (`media.displays` becomes REQUIRED and always present, so one monitor is the special case rather than several; the annotation reference frame moves per display), #76 (multi-monitor as the normal case; acceptance is a three-display capture with one portrait, one scaled, focus on the third), #12 (`input.*` events). Doing this before Chrome means the DOM provider is written against the final contract rather than the old one. Not done until SPEC.md, `docs/schemas/`, `tools/validate-capturepack.mjs`, the MCP tool descriptions and `docs/MCP.md` all agree.

**3 — Chrome.** #67 (DOM as the first web temporal provider), #11 (extension + native host). This is what proves the protocol is real rather than decorative: a second, independent consumer.

**4 — After Save.** #68 (host, pack states, pipelines, retry, idempotency), #69 (Settings › Plugins). Independent of the temporal work; can run in parallel.

**5 — editor.** #52 (colour semantics: red = manual, blue = picked, remove the colour picker; then keyframed positions for red boxes, which needs a format addition), #77 (a picked box's lifetime clamps to its object's track — stretch it as far as you like and it still ends when the object does), #51 (numbering), #50 (box header drift — **reopened; its stated root cause was measured and disproven, do not close it on reasoning again**), #17 (first-run tutorial).

**6 — trust.** #62 (finish the DXGI work), #63 (CI captures a pack end to end with `--capture-now` and asserts on it — including that the median offered rectangle stays small, so picking quality is a red build rather than something someone notices), #70 (the ten acceptance conditions).

**Also open**: #80 (remove the watchdog — it was built before we knew why the app died, and now `#60`'s logging can answer that), #78 (two identical `CapturePack.exe` in Task Manager).

---

## Decisions already made — do not relitigate these

- **Windows UI Automation stays in Core** and is the *reference implementation* of the provider protocol. It uses the same public API an external provider gets: same clock, same surface claims, same `hitTest`, same timeouts, same failure isolation. **No private path into Core.** If UIA needs something the protocol lacks, that is a gap in the protocol to close for everyone — report it, do not carve an exception.
- **The provider protocol is documented but explicitly UNSTABLE.** After Save Actions get the stable public promise instead, because that is the side where a third party's mistake lands visibly on whoever wrote it. Stabilisation trigger, fixed in advance: a provider *we did not write* running in the wild, or the first serious external request.
- **Ordering objects by the element's `depth` was tested and rejected.** Measured on a real capture: it never once produced a more precise answer and produced a worse one on 31.9% of contested points, because `depth` is how deep the tree walk went, not what is in front. Containment plus tree order is what works.
- **The Scheduled Task approach to supervision was weighed and rejected** (`supervisor.ts:20-26`), and re-examined today: two of its three objections still hold, plus a fourth found later — a task that simply runs the exe resurrects an app the user deliberately quit, so the quit-intent verdict would have to be re-implemented in the startup path.
- **The picking container guard is calibrated, not guessed.** `WINDOW_FRAME_FRACTION = 0.35` plus an axis test with an area floor. On the reference capture this moved the median rectangle offered under the cursor from 1,583,435 px (19% of a 3840×2160 screen) to 23,912 px, and precise offers from 28.5% to 66.9%, while costing **zero** useful targets. **Those two numbers are a regression test.**

---

## Reference points

- `GOAL.md` — the living spec. Read the sections you are about to touch.
- `docs/plugin-system-v0.2.0.ko.txt` — the original design document (Korean), kept so the spec can be checked against its source.
- `docs/temporal-protocol.md` (on branch c11-1) — the 840-line design the three implementations were written from, with the measurements that decided it.
- `docs/desktop-duplication.md` (on branch `worktree-agent-aafaf5aa087f2942c`) — the DXGI investigation, 501 lines, with its unverified parts explicitly marked as unverified in §10.
- `docs/temporal-provider-api.md` (on branch c11-2) — implementer's reference for an external provider.
- Evidence packs, **read-only**: `C:/Users/recue/OneDrive/Desktop/CapturePack/CapturePack_2026-07-28_191714/` is the reference two-display capture; `_193038` is the one whose annotation left its own display (#74, fixed).

## Release notes format, from the next release on

Lead with a scannable list, not an essay. `## Added` / `## Fixed` / `## Improved`, one line per entry, **every entry carrying its issue number**, sections with nothing in them omitted. The depth lives in the issue; a reader should get their answer in fifteen seconds. A short paragraph below the lists only for something that changes behaviour people rely on or that they must act on.

## Releasing

`npm run dist` builds an installer locally without publishing; `npm run release` publishes. The user wants **a local installer to test before anything is tagged** — build `0.2.0-rc.1`, hand over the path, and only tag after their feedback. `docs/RELEASING.md` currently documents no rc procedure; add one, including that rc builds are never uploaded so `electron-updater` cannot mistake one for a release.
