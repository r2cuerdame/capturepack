# CapturePack 0.3.1 dependency audit

Audit date: 2026-07-30. Scope: `core/package-lock.json` for the 0.3.1 release
candidate. Re-run these commands on the exact revision selected for release;
this file is evidence for that revision, not a permanent claim about the npm
ecosystem.

## Production boundary

```powershell
cd C:\_Project\capturepack\core
npm audit --omit=dev
```

Result: **0 vulnerabilities** across the installed production dependency
boundary.

The release updates:

- `adm-zip` 0.6.0, addressing CVE-2026-39244.
- `@modelcontextprotocol/sdk` 1.30.0 and `@hono/node-server` 2.0.12,
  addressing GHSA-frvp-7c67-39w9.
- Electron 43.2.0 and esbuild 0.28.1.

Electron 43 requires Node.js 22.12 or newer for its npm tooling. The package and
both GitHub Actions workflows declare that floor. Electron 42+ also removed the
binary `postinstall`; the RC smoke resolves the package and therefore exercises
the supported lazy download path on a clean dependency install.

## Development/build boundary

A full `npm audit` reports **16 high-severity advisories**. Every reported path
is in the development-only tree rooted at `electron-builder` 26.15.3; these
packages build the Windows artifact and are not bundled into the installed
CapturePack runtime.

npm currently labels `electron-builder` 25.1.8 as the available forced change.
That is a downgrade from the current 26.15.3 release line, not a fixed upgrade
of the current/latest line. It was not applied automatically. Treat the 16
findings as open build-tool exposure, monitor upstream, and re-evaluate when a
non-regressive fixed release is available.

This distinction does not erase the findings: the release record keeps both
numbers visible — zero for `--omit=dev`, 16 high for the full development tree.
It only prevents development tooling advisories from being described as
installed-product runtime vulnerabilities.
