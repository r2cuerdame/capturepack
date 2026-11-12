# CapturePack 0.6.1 candidate dependency audit

Audit date: 2026-11-12. Scope: `core/package-lock.json` for the 0.6.1 release
candidate. Re-run both commands on the exact revision selected for release; this
record describes the audited lockfile, not a permanent claim about npm advisory
data.

## Production boundary

```powershell
cd C:\_Project\capturepack\core
npm audit --omit=dev
```

Result: **0 vulnerabilities** across the installed production dependency
boundary. `npm ls --omit=dev --depth=0` reported:

- `@modelcontextprotocol/sdk` 1.32.2
- `adm-zip` 0.6.1
- `electron-updater` 6.8.9
- `zod` 4.6.7

The matching `package.json` ranges remain unchanged; the lockfile now resolves
patched releases for the 0.6.1 candidate.

## Development/build boundary

`npm audit fix` reduced the full-tree report to **6 moderate vulnerabilities**,
all in `minimatch` under the `electron-builder` build-tool graph through
`app-builder-lib` and `@electron/universal`. npm offers a fix only with
`npm audit fix --force`, which would downgrade `electron-builder` to 25.1.0
from the project's 26.x line (the audited lockfile resolves 26.18.1). That breaking downgrade was not applied.

These findings remain visible as build-tool exposure; they are outside the
installed production dependency boundary. Recheck the full tree before release
and revisit when a non-regressive compatible fix is available.
