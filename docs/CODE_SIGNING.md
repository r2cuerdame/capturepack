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

Public artifacts are built from public source on GitHub-hosted Windows runners;
release binaries are not uploaded from a developer machine:

1. A maintainer updates `core/package.json` and `core/package-lock.json`, runs the
   complete local QA gate, and pushes the reviewed source revision.
2. A maintainer manually runs
   [`.github/workflows/release.yml`](../.github/workflows/release.yml) with a
   matching `vX.Y.Z` input and the exact source ref. A branch or tag push alone
   never publishes a release.
3. The workflow verifies the version, runs `npm ci` and `npm run qa:rc`,
   packages locally, and verifies the exact installer/updater metadata.
4. Only after QA, packaging and that local contract pass, it creates or
   verifies the tag at the checked-out commit.
5. It stages exactly the installer, its blockmap, `latest.yml` and
   `SHA256SUMS.txt` in a draft GitHub Release.
6. It downloads all four staged assets, compares them byte-for-byte with the
   verified local files, and only then makes the draft public.

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

When Live recording is enabled, CapturePack keeps a rolling screen replay in
memory (30 seconds by default) so a user can press a hotkey *after* a problem
occurs, annotate the frozen replay, and save a self-contained context folder.
It can also create an explicit region or full-virtual-desktop image pack.

Built-in Windows UI Automation reads accessibility metadata for object picking;
the optional Chrome preview extension reads selector/role/text/URL only for an
explicit browser pick. CapturePack does not bypass access controls or modify
system security settings. Uninstalling is done through the standard Windows
*Apps & features* entry.

## Third-party components

CapturePack bundles Electron and a small number of MIT/Apache-licensed npm packages
(`electron-updater`, `adm-zip`, `@modelcontextprotocol/sdk`, `zod`). All of them are open
source; CapturePack contains no proprietary code. The project itself is
[MIT licensed](../LICENSE) with no commercial dual-licensing.

## Reporting problems

Security or signing concerns: open an issue at
[github.com/r2cuerdame/capturepack/issues](https://github.com/r2cuerdame/capturepack/issues).
