# Safety rules for working on this machine

These are the user's standing constraints. They exist because each was violated once.

## Never touch

- **Never synthesize keyboard or mouse input.** Especially never `Ctrl+Alt+C` — the installed
  CapturePack owns that accelerator and an agent once fired a real capture on the user's desktop.
- **Never stop, restart, modify or reconfigure the INSTALLED app**
  (`%LOCALAPPDATA%\Programs\CapturePack`). Never write to `%APPDATA%\CapturePack`. Reading its log
  is fine and is often the fastest diagnosis.
- **Never write, move or delete anything under the user's output folder**
  (`OneDrive\Desktop\CapturePack`). Packs there are evidence — read only.
- Never kill the user's other applications to test a theory.
- Do not push, tag or open PRs without an explicit instruction. Building an installer is fine;
  publishing one is not.

## Headed runs

Always a detached Electron run with its own profile, and always torn down:

```
npx electron . --user-data-dir=<tmp> --output-dir=<tmp> --no-global-shortcut --no-login-item
```

A capture opens a fullscreen editor over whatever the user is doing — keep such runs short and
kill them as soon as the measurement is taken. Kill only PIDs whose command line you have verified
carries your own marker; see the process-hunting recipe in `mem:suggested_commands`.

Tear down every watchdog, scheduled task and Start Menu shortcut a run creates. The context host
(`powershell.exe` running `context-host.ps1`) can outlive its parent — check for it separately.

## Reading a pack the user just made

The export writes over several seconds. A folder read too early has a half-written manifest and
zero annotations; the media file names change from `.mp4` to `.webm` mid-write. Confirm
`manifest.json` parses and `plugins/` is populated before drawing conclusions from it.
