# Definition of done

Run from `core/` unless noted. All of these pass before a change is called finished.

```
npx tsc --noEmit
npm run build

node scripts/past-picking-check.mjs        # 16 checks — picking against the frozen ring
node scripts/track-render-check.mjs        # 27 checks — where a tracked box is at time T
node scripts/ring-prune-check.mjs          #  6 checks — ring budget / prune / degrade
node scripts/surface-restore-check.mjs     # 11 checks — restore between samples
node scripts/chrome-bridge-check.mjs       #  8 checks — extension wire, end to end (slow: starts the real app twice)

npx electron . --smoke --user-data-dir=<tmp> --output-dir=<tmp> --no-global-shortcut --no-login-item
node ../tools/validate-capturepack.mjs ../examples/minimal
```

Each harness prints `result: OK — N passed, 0 failed` and exits non-zero on failure. They bundle
the shipping TypeScript at run time, so they cannot drift from the code.

## Beyond the green checks

- **A fix is not a fix until it is measured.** Green harnesses prove no regression; they do not
  prove the reported symptom is gone. State the number, and where it came from (a pack folder, a
  log line, a rendered frame). See the anti-estimation rules in `mem:conventions`.
- **A validator rule for anything new in the format.** If a change adds a field or an invariant to
  a pack, `tools/validate-capturepack.mjs` must be able to fail a pack that breaks it.
- **Docs follow the fix**: GOAL.md for the design, SPEC.md for the format, a GitHub issue carrying
  cause / fix / measurement.
- `chrome-bridge-check.mjs` starts real Electron processes. If it is interrupted, sweep for
  leftovers — see the process-hunting recipe in `mem:suggested_commands`.
