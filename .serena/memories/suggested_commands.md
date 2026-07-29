# Commands

All app commands run from `core/`. Repo-level tools run from the repo root.

## Build and check

```
npm run typecheck          # tsc --noEmit
npm run build              # esbuild -> core/dist
npm run dev                # build + electron .
npm run dist               # electron-builder --win nsis
npm run release            # electron-builder --win --publish always (CI only)
```

There is no `npm test`. Run the harnesses directly — see `mem:task_completion` for the full list
and when each applies.

## Validating a pack

```
node tools/validate-capturepack.mjs examples/minimal
node tools/validate-capturepack.mjs "<path to a CapturePack_* folder>"
```

Exit 0 = VALID. This is the executable half of SPEC.md; a format change is not done until the
validator enforces it.

## Running the app without disturbing the installed one

The installed CapturePack holds the single-instance lock **per user-data dir**, so a dev run needs
its own. Use the `=` form — the space-separated form is silently ignored and the process exits.

```
npx electron . --user-data-dir=<dir> --output-dir=<dir> --no-global-shortcut --no-login-item
```

Useful switches: `--smoke` (settings load only, exits 0 — the CI smoke test),
`--capture-now[=SECONDS]`, `--native-host` (Chrome native messaging mode),
`--show-settings|--show-history|--show-about|--show-welcome`, `--no-context-host`,
`--simulate-no-frames`, `--simulate-uncaught-error`.

Read `mem:app/safety` before launching a headed run.

## Windows shell notes

- The Bash tool is Git Bash; the PowerShell tool is **Windows PowerShell 5.1** — no `&&`, no `??`,
  no ternary. Chain with `A; if ($?) { B }`.
- Finding processes started by a test run (the reliable way — `Get-Process | ... .Path` misses
  them):
  `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*<marker>*' }`
- The installed app's log (read-only): `%APPDATA%\CapturePack\logs\main.log`.
