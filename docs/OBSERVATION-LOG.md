# One-month observation log

This is the official ledger for the one-month no-manual-reinstall observation:
the operational success criterion in [GOAL.md](../GOAL.md) and a completion
condition of the 2026-12 milestone in [ROADMAP.md](../ROADMAP.md)
([#440](https://github.com/r2cuerdame/capturepack/issues/440)).
[OBSERVATION.md](OBSERVATION.md) owns the evidence rules. This file holds the
dated record of each observation period, the weekly review procedure, and the
verdict rules applied to that record. If the two ever disagree,
OBSERVATION.md wins and this file is corrected.

**Current status: not started.**

No public-release installer completion date and installed version are recorded
here, so no 30-day period is running and nothing in this file is a result. No
earlier observation has a verified start date in this repository; following
OBSERVATION.md, that earlier period is `unknown` and is not continued. Period 1
begins on the next verified public-release install.

Entries are written by, or confirmed with, the person who uses the installed
app. A coding agent or CI job cannot confirm a person's ordinary use and must
not fill the use, reinstall or interruption fields on its own.

## What this record may contain

This file is public. Record only calendar dates (`YYYY-MM-DD`, the user's local
date), app versions, `none`, `unknown`, and a short known cause. Raw log lines,
paths containing a user name, account identifiers, pack contents and
screenshots stay on the machine, as OBSERVATION.md requires. Write `unknown`
for anything the evidence does not establish; a blank field is not an answer.

## Tracked fields

Every period records each of these. The template below carries the same rows.

| Field | How it is recorded |
|---|---|
| Observation start date (day 0) | Date a public-release installer completed, from the installer record or the first `[app] CapturePack <version> starting` log line after that install. If it cannot be verified, no period starts. |
| Starting app version | Version shown in About on day 0. |
| Week 1 review date (due day 7) | Actual date the week 1 review was held. |
| Week 2 review date (due day 14) | Actual date the week 2 review was held. |
| Week 3 review date (due day 21) | Actual date the week 3 review was held. |
| Week 4 review date (due day 28) | Actual date the week 4 review was held. |
| Final verdict date (day 30 or later) | Actual date the final review was held and the verdict applied. |
| End date | Last date the verdict covers: the final verdict date, or the manual-reinstall date for a failed period. |
| Final app version | Version shown in About on the final verdict date. |
| Result | `in progress`, `passed`, `failed` or `inconclusive`, decided by the verdict rules below. |
| Reason for result | Which verdict rule decided it, and the condition that matched. |

## Day counting

Day 0 is the observation start date; day N is N calendar days later. Each review
covers one window:

| Window | Days covered | Review due |
|---|---|---|
| Week 1 (days 0–7) | day 0 through day 7 | day 7 |
| Week 2 (days 8–14) | day 8 through day 14 | day 14 |
| Week 3 (days 15–21) | day 15 through day 21 | day 21 |
| Week 4 (days 22–28) | day 22 through day 28 | day 28 |
| Final (day 29 to verdict) | day 29 through the final verdict date | day 30 or later |

- "At least 30 calendar days" means the final verdict date is day 30 or later.
- A late review records the date it was actually held and still covers its
  whole window. Never backdate a review.
- A review that is not held leaves its window `unknown`. Do not fill it from
  memory at a later review.
- An automatic update does not reset day 0.

## Weekly review procedure

Hold the review at the end of each window, in this order. The review only
reads: it does not change the installed app, its settings, or the release.

1. **About screen.** Record the version shown.
2. **Log coverage.** Open **About → Open logs folder**. Note the earliest and
   latest date across `main.log` and `main.1.log` through `main.5.log`. Logs
   rotate; if the earliest date is after the start of this window, record the
   uncovered dates as `unknown (logs rotated)`.
3. **Log events in the window.** Note only the dates and versions of:
   - `[app] CapturePack <version> starting` — app starts and the version each
     ran. A start is evidence the app ran, not proof of ordinary use.
   - `[updater] downloaded v<version>` followed by a later start at that
     version — an automatic update. `[updater] check/download failed` — an
     updater failure.
   - `[lifecycle] previous run (…) DID NOT exit cleanly` and other
     `[lifecycle]` abnormal-termination warnings — an interruption.
4. **PurplePulse state.** In the environment-matched file (`purplepulse.json`
   for production), record `last_attempt_day` as a daily send attempt only.
   It is never evidence of use, delivery or a successful update. If the file is
   absent, record `unknown`.
5. **Ask the user.** Record, from the user or their own dated notes: which dates
   in this window they used CapturePack in ordinary work; whether they
   downloaded and ran an installer by hand; any interruption they noticed.
6. **Record and judge.** Fill the window's row in the period's review table and
   apply the verdict rules. A manual reinstall ends the period as `failed` at
   this review; do not wait for day 30.

## Weekly checklist

Each review answers every item. An item nobody can answer is `unknown`.

- [ ] **Review date** — the date actually held, and the window covered.
- [ ] **Confirmed ordinary-use dates** — dates the user confirms they used the
  app in ordinary work, `none` if they confirm no use, or `unknown`. Log starts
  and PurplePulse attempts alone are not confirmation.
- [ ] **Automatic update history** — date and from → to version, with the
  evidence (About version change, `[updater] downloaded`, a start at the new
  version); `none`; or `unknown`.
- [ ] **Manual reinstall** — `none` when the user confirms no installer was run
  by hand; otherwise the date and known reason; or `unknown`.
- [ ] **Failure or interruption** — dates and symptom, or `none`, or `unknown`.
  Classify the cause only where logs or installer history support it:
  automatic update failure, crash or unexpected exit, user-initiated reinstall,
  environment/access issue, or unknown.
- [ ] **About version** — the version shown on the review date.
- [ ] **Evidence reviewed** — About version; log date range covered;
  environment-matched `last_attempt_day`.
- [ ] **Unknown dates** — dates in the window that no evidence covers.

## Verdict rules

Apply at every review, in this order. The first rule that matches decides the
result.

1. **Failed** — a manual reinstall occurred at any point in the period.
   Downloading and running an installer by hand is a manual reinstall; an update
   installed by the app's own automatic updater is not. Record its date and
   known reason as the end date and reason. A new period starts only when a new
   public-release installer completes, with its own day 0.
2. **In progress** — no manual reinstall is recorded and the period has not
   yet reached day 30.
3. **Passed** — all of these are true:
   - the start date is verified and the final verdict date is day 30 or later;
   - every window (weeks 1 to 4 and final) had its review held and records at
     least one user-confirmed ordinary-use date;
   - every window records manual reinstall as `none`;
   - the starting version, each automatic update and the final version have
     evidence or an explicit `unknown`.
4. **Inconclusive** — day 30 or later is reached and no manual reinstall is
   recorded, but passed is not met: a review was not held, a window has no
   confirmed ordinary-use date (the app was unused or the use went unrecorded),
   a window records manual reinstall as `unknown`, or a required field is
   blank. Record which condition decided it. Inconclusive is never rounded up
   to passed; a later period follows the start rule in OBSERVATION.md.

A crash or interruption is recorded and investigated as a stability event, but
by itself it is not a manual reinstall and does not decide the result. A missing
log line or PurplePulse attempt is `unknown`, never a crash or a quiet day.

## Period template

When day 0 is verified, copy this block under **Periods** as
`### Period <n>`, fill day 0 and the starting version, and set the result to
`in progress`.

```markdown
### Period N

| Field | Value |
|---|---|
| Observation start date (day 0) | YYYY-MM-DD |
| Starting app version | |
| Week 1 review date (due day 7) | |
| Week 2 review date (due day 14) | |
| Week 3 review date (due day 21) | |
| Week 4 review date (due day 28) | |
| Final verdict date (day 30 or later) | |
| End date | |
| Final app version | |
| Result | in progress |
| Reason for result | |

| Window | Review date | Confirmed ordinary-use dates | Automatic update history | Manual reinstall | Failure or interruption | About version | Evidence reviewed | Unknown dates |
|---|---|---|---|---|---|---|---|---|
| Week 1 (days 0–7) | | | | | | | | |
| Week 2 (days 8–14) | | | | | | | | |
| Week 3 (days 15–21) | | | | | | | | |
| Week 4 (days 22–28) | | | | | | | | |
| Final (day 29 to verdict) | | | | | | | | |
```

## Periods

No period has started.
