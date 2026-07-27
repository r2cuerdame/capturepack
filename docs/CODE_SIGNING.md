# Code Signing Policy

This document is CapturePack's published code signing policy, as required by the
[SignPath Foundation](https://signpath.org/) OSS program.

## Signing status

Windows releases of CapturePack are currently **unsigned**. Windows SmartScreen will warn
when running the installer; choose *More info → Run anyway*. Every release also publishes
`SHA256SUMS.txt` so you can verify the installer yourself:

```powershell
Get-FileHash .\CapturePack-Setup-<version>.exe -Algorithm SHA256
```

An application for free OSS code signing is pending. Once granted, this document will
state the certificate issuer and the signed artifacts.

## Team roles

CapturePack is maintained by a single maintainer today:

| Role | Person |
| --- | --- |
| Author (writes code) | [@r2cuerdame](https://github.com/r2cuerdame) |
| Reviewer (reviews changes before release) | [@r2cuerdame](https://github.com/r2cuerdame) |
| Approver (approves each signing request) | [@r2cuerdame](https://github.com/r2cuerdame) |

Additional maintainers will be listed here as they join, with their roles.

- All maintainer accounts have **multi-factor authentication** enabled on GitHub.
- Every release is **manually approved** before signing — releases are never signed
  automatically without a human approval step.

## Build and release process

Builds are fully reproducible from public source; no artifact is ever built or uploaded
from a developer machine:

1. A maintainer bumps the version in `core/package.json` and pushes a `vX.Y.Z` tag.
2. [`.github/workflows/release.yml`](../.github/workflows/release.yml) runs on
   GitHub-hosted Windows runners: `npm ci` → typecheck → build → `electron-builder`.
3. The workflow publishes the installer, `latest.yml` (used by the auto-updater), and
   `SHA256SUMS.txt` to the GitHub Release.

The only source of a CapturePack binary is
[github.com/r2cuerdame/capturepack/releases](https://github.com/r2cuerdame/capturepack/releases)
and the download button on [capturepack.dev](https://capturepack.dev), which links to it.

## Privacy

CapturePack is local-first and collects nothing:

- **No telemetry, no analytics, no accounts, no cloud.** The app never uploads captures,
  usage data, or crash reports.
- Captures (screen recordings, screenshots, annotations) are written only to the output
  folder the user chooses on their own machine.
- The only outbound network request is the update check against the GitHub Releases API
  (`https://github.com/r2cuerdame/capturepack`), which can be disabled in
  Settings → General → *Check for updates automatically*.
- The bundled MCP server binds to `127.0.0.1` only, is read-only, rejects non-loopback
  `Host`/`Origin` headers, and can be disabled in Settings → MCP.

## What the app does

CapturePack keeps a rolling ~30-second screen replay buffer in memory so a user can press
a hotkey *after* a problem occurs, annotate the frozen replay, and save a self-contained
context folder to disk. It is a screen-capture and annotation tool: it does not scan,
probe, or circumvent any security measure, and it does not modify system settings.
Uninstalling is done through the standard Windows *Apps & features* entry.

## Third-party components

CapturePack bundles Electron and a small number of MIT/Apache-licensed npm packages
(`electron-updater`, `adm-zip`, `@modelcontextprotocol/sdk`, `zod`). All of them are open
source; CapturePack contains no proprietary code. The project itself is
[MIT licensed](../LICENSE) with no commercial dual-licensing.

## Reporting problems

Security or signing concerns: open an issue at
[github.com/r2cuerdame/capturepack/issues](https://github.com/r2cuerdame/capturepack/issues).
