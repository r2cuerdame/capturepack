# One-month no-manual-reinstall observation

This guide records the operational success criterion in [GOAL.md](../GOAL.md)
and [ROADMAP.md](../ROADMAP.md): install CapturePack from a public release, use
it in ordinary work for a full month, and do not manually reinstall it. The
observation is evidence gathering, not a test that changes the installed app or
its settings. It remains **in progress** until the dates and evidence below
support a complete month.

## Start and review cadence

Start on the date a release installer completes successfully. Record the
installed version and date from the app's About screen or the installer record.
If the existing observation already has a verified start date, continue that
period; do not restart the clock for an automatic update. If the start date or
installation history cannot be verified, mark it unknown and start a new,
explicitly dated observation rather than guessing.

Review once a week and at the end of the month. A successful automatic update
does not count as a manual reinstall and does not reset the start date. Record
any manual reinstall, app failure, or gap in ordinary use on the date it
happened. Do not fill missing days from memory as if they were measured.

## What counts as a pass

Pass only when all of these are true:

1. At least 30 calendar days have elapsed from the verified release-install
   date.
2. The app was used in ordinary work during that period; record the days the
   user confirms, without treating telemetry alone as proof of human use.
3. No manual reinstall occurred. Installing an update delivered by the app's
   automatic updater is allowed; downloading and running an installer by hand
   is a manual reinstall and fails this observation.
4. The starting version, any observed automatic update, and the final version
   have evidence or are explicitly marked unknown.

If a manual reinstall occurs, mark the period **failed**, record its date and
known reason, and begin a new 30-day period only after a new release installer
completes. If the app was not used or evidence is missing, mark the result
**inconclusive**, not passed. Keep the release process and the installed app
unchanged while collecting evidence.

## Local evidence to review

- Confirm the installed version in CapturePack's About screen. The application
  is installed under `%LOCALAPPDATA%\Programs\capturepack` by the standard
  installer; record the version and install date shown by the app or installer
  history. Do not copy the executable or user profile into this record.
- For startup, capture, save, updater, and error history, use **About → Open
  logs folder**. The current log is `logs/main.log` under the app's user-data
  folder (normally `%APPDATA%\CapturePack\logs\main.log`); rotated logs are
  `main.1.log` through `main.5.log` when present. Logs rotate and are local
  diagnostics, so review them during the weekly check and record only relevant
  dates, versions, and outcomes. Do not attach raw logs or packs to this record.
- The optional PurplePulse state file is under the app's user-data folder:
  `purplepulse.json` for production, `purplepulse.test.json` for test, and
  `purplepulse.dev.json` for development. Check only the file matching the
  installed environment. Test and development state is not production evidence.
  Its `last_attempt_day` records a daily send attempt, not confirmed delivery or
  a person's use; it cannot prove uninterrupted use or a successful update.
  PurplePulse is separate from local release verification and must not be used
  to infer days with no record.
- A missing log entry or ping is **unknown**, not proof of a crash or a quiet
  day. Use the app's visible version and the user's dated use/reinstall notes
  for facts that local files cannot establish. Keep the observation local and
  omit account identifiers, file contents, screenshots, and other private data.

## Recording template

Keep one copy for each observation period. Use `unknown` when evidence is not
available; do not invent a date or cause.

```text
Observation start date (release installer completed):
Starting app version:
Review date:
Ordinary-use dates confirmed by user (or unknown):
Automatic update date and from/to versions (or none/unknown):
Manual reinstall date (or none):
Failure or interruption dates and known cause (or none/unknown):
Local evidence reviewed (About version / relevant log dates / environment-matched state file):
End date:
Result: in progress / passed / failed / inconclusive
Reason for result:
```

## Interpreting failures

Record the observed symptom and date first. Classify the cause only when local
logs or installer history support it: automatic update failure, crash or
unexpected exit, user-initiated reinstall, environment/access issue, or
unknown. A crash is a stability event to investigate, but by itself it does
not mean that a manual reinstall occurred. Never infer a cause from a missing
daily ping. The full QA and release checks remain governed by
[Release QA](QA.md) and [Releasing](RELEASING.md); this month-long field
observation is a separate gate.
