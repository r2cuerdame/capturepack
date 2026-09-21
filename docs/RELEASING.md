# Releasing CapturePack

CapturePack releases are published by the manually dispatched
`workflow_dispatch`
[Release workflow](../.github/workflows/release.yml). A branch push or tag push
does **not** publish anything.

The workflow builds on a GitHub-hosted Windows runner, runs the same complete QA
gate used for a local candidate, creates or verifies the requested tag only
after QA passes, stages the exact installer and updater files in a draft, then
publishes only after downloading and byte-verifying every staged asset.
`npm run dist` passes `--publish never`; GitHub Actions must not trigger
electron-builder's implicit CI upload before those checks.

## Before dispatch

1. Update `core/package.json` and `core/package-lock.json` to the same version.
   Stable releases must not retain an `-rc.*` suffix. An external test candidate
   uses the next patch version, for example `1.2.4-rc.1` after stable `1.2.3`;
   reusing a `1.2.3-rc.*` line after `1.2.3` is public would sort below the
   already-published stable version.
2. For a stable release, update `CHANGELOG.md`, every product README and the
   website version/copy. For an RC, add its changelog/release notes but keep the
   README and website on the current stable version until promotion.
3. From a clean checkout, run:

   ```powershell
   cd C:\_Project\capturepack\core
   npm ci
   npm run qa:rc
   ```

   Use Node.js 22.12 or newer, matching `core/package.json` and the Actions
   runners. Electron's development binary is downloaded lazily by the smoke
   when a clean checkout has not run it before.

   Despite its historical script name, `qa:rc` is the full release gate. It
   discovers every `check:*` script, runs type checking, the production build
   and an isolated Electron smoke test.
4. Run `npm audit --omit=dev` and confirm it remains zero. For 0.3.1, compare
   the full development-tree result with
   [DEPENDENCY-AUDIT-0.3.1.md](DEPENDENCY-AUDIT-0.3.1.md); do not hide a new or
   production-scoped advisory.
5. Commit and push the exact source revision intended for release. Confirm that
   `core/package.json`, the lockfile and the changelog all name the same
   version.

## Publish from GitHub Actions

1. Open **GitHub → Actions → Release → Run workflow**.
2. Select the branch/ref containing the exact reviewed commit. The dispatched
   run pins its `GITHUB_SHA`; verify that SHA before publication.
3. Enter a tag matching the package version, for example `vX.Y.Z`.
4. Run the workflow and wait for every step to succeed.

The workflow:

1. Rejects a tag that does not equal `v` + `core/package.json.version`.
2. Runs `npm ci` and `npm run qa:rc`.
3. Runs the local `npm run dist` package command; it does not publish from
   `electron-builder`.
4. Verifies the local release contract, including exact filenames, absence of
   stale installers, `latest.yml` size/sha512 fields and `SHA256SUMS.txt`.
5. Only after QA, packaging and the local contract pass, creates the tag at the
   checked-out commit or verifies that an existing tag points to that exact
   commit.
6. Stages exactly these four files in a draft GitHub Release:
   - `CapturePack-Setup-{version}.exe`
   - `CapturePack-Setup-{version}.exe.blockmap`
   - `latest.yml` (including the sha512 used by `electron-updater`)
   - `SHA256SUMS.txt` for manual verification
7. Downloads all four draft assets, compares their bytes with the verified
   local files, and only then changes the draft to a public release. A package
   version containing a SemVer prerelease suffix is published with
   `prerelease=true` and `latest=false`; a stable version becomes the latest
   release.

The draft is never an availability claim. The release becomes visible only
after the remote four-file contract passes. After it is public, verify its tag,
commit and asset names before deploying website copy that calls the version
available. A prerelease may be shared by direct URL for testing, but the website
and `/releases/latest` continue to name the stable release.

## Verify a published download

Set the version you just published:

```powershell
$Version = 'X.Y.Z'
Get-FileHash ".\CapturePack-Setup-$Version.exe" -Algorithm SHA256
```

Once that version is public, compare the lowercase hash with the matching line in
`SHA256SUMS.txt` on
[GitHub Releases](https://github.com/r2cuerdame/capturepack/releases). Until the
matching release appears there, it is a candidate rather than a public download.

## Publish to WinGet

CapturePack is submitted to the Windows Package Manager community repository
([microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs)) as
`r2cuerdame.CapturePack`. WinGet installs the same artifact the release
workflow published — the per-user, one-click NSIS installer — so nothing is
built or re-uploaded for WinGet, and a release is never created only for it.

What the shipped installer is, from evidence rather than assumption:

| Manifest field | Value | Where it comes from |
|---|---|---|
| `InstallerType` | `nullsoft` | `core/electron-builder.yml` `win.target: nsis`; WinGet passes `/S` for silent install and uninstall, and electron-builder's one-click template does not launch the app when silent |
| `Scope` | `user` | `nsis.perMachine: false`; the installer writes `HKCU` and `%LOCALAPPDATA%\Programs\capturepack` and never elevates |
| `Architecture` | `x64` | the packaged `CapturePack.exe` is an x64 PE (the NSIS stub itself is 32-bit, as always) |
| `ProductCode` | `e2882de7-4701-50c8-9b29-3229ccb6fbcc` | electron-builder's uninstall key: UUID v5 of `appId` in its fixed namespace; stable across versions, so `winget upgrade` finds the existing install |
| `DisplayName` / `Publisher` / `DisplayVersion` | `CapturePack X.Y.Z` / `r2cuerdame` / `X.Y.Z` | what the installer writes under `HKCU\...\Uninstall\<ProductCode>` |
| `InstallerUrl` / `InstallerSha256` | the `vX.Y.Z` release asset and `SHA256SUMS.txt` | published release assets only |
| `ReleaseDate` | the day of `latest.yml` `releaseDate` | published release asset |

There is no command-line alias and nothing is added to `PATH`: CapturePack is a
tray application. The installer is unsigned (see [Code signing](#code-signing));
WinGet verifies the SHA-256 in the manifest against the downloaded bytes.

The manifests are generated, never typed. After the GitHub Release is public,
from the checkout of the released tag:

```powershell
cd C:\_Project\capturepack\core
gh release download vX.Y.Z --pattern latest.yml --pattern SHA256SUMS.txt --dir $env:TEMP\capturepack-winget
npm run winget:manifest -- --latest $env:TEMP\capturepack-winget\latest.yml --sha256sums $env:TEMP\capturepack-winget\SHA256SUMS.txt --out $env:TEMP\capturepack-winget
winget validate --manifest $env:TEMP\capturepack-winget\manifests\r\r2cuerdame\CapturePack\X.Y.Z
```

The generator refuses a prerelease version, a `SHA256SUMS.txt` that names a
different installer, a `package.json` that is not at the released version, and
a changelog without that version's section; `npm run check:winget-manifest`
(part of `qa:rc`) proves those refusals and the derivations above on every run.

Then, in the `r2cuerdame/winget-pkgs` fork of microsoft/winget-pkgs, create a
branch `capturepack-X.Y.Z` from upstream `master`, add the three files under
`manifests/r/r2cuerdame/CapturePack/X.Y.Z/`, push, and open a pull request to
`microsoft/winget-pkgs` titled `New package: r2cuerdame.CapturePack version
X.Y.Z` (or `New version: …` once a version is merged). Microsoft's validation
pipeline downloads the installer and runs it silently; a moderator then
approves. Until that PR is merged and `winget search r2cuerdame.CapturePack`
returns the version, WinGet availability is a submission, not a claim — do not
add `winget install` to the README before that.

Submissions so far:

- 0.5.0 — [microsoft/winget-pkgs#429924](https://github.com/microsoft/winget-pkgs/pull/429924)
  (validation passed, awaiting moderator approval).
- 0.5.1 — [microsoft/winget-pkgs#438314](https://github.com/microsoft/winget-pkgs/pull/438314)
  (issue [#153](https://github.com/r2cuerdame/capturepack/issues/153)).

After a merge, verify on a Windows machine:

```powershell
winget source update
winget install --id r2cuerdame.CapturePack --exact
```

and confirm `winget list --id r2cuerdame.CapturePack` reports the version.

## How users receive updates

When automatic update checks are enabled, the app checks GitHub Releases for a
newer stable version. A downloaded update is applied on restart/quit; the user
is not force-restarted while working. The automatic check can be disabled in
Settings → General, and **Check for updates** remains available from the tray.
There is no separate CapturePack update server.

## Code signing

Windows builds are currently unsigned, so SmartScreen can warn on first run.
`electron-updater` verifies the sha512 declared by `latest.yml`, and every
release also publishes `SHA256SUMS.txt` for manual verification.

When a signing certificate becomes available, configure the GitHub workflow and
`core/electron-builder.yml`; never upload a differently built local executable
under an existing release.

## Failure and rollback

- QA failure leaves no new tag because the workflow creates the tag only after
  the gate succeeds.
- A tag that already points elsewhere is rejected instead of being moved.
- A failed upload or remote byte comparison leaves the release as a draft;
  installed clients cannot discover it.
- A failed download or integrity mismatch leaves the installed version in
  place.
- Never retag a bad public version. Fix forward with a higher version, run the
  full gate again, and publish a new release.
- Removing a bad GitHub Release can stop new discovery, but it is not a rollback
  for machines that already downloaded it.

## Milestone hygiene at release

A published version closes its milestone, and a milestone is closed only when it
is empty. Before closing it, move every still-open issue in it to a **named
later milestone** — never leave it in the milestone of a version that has
already shipped, and never leave it with no milestone at all.

This was written after `v0.2.0 - temporal plugin system and Chrome extension`
was found holding **16 open issues** while 0.3.3 was the public release: the one
list that is supposed to say what a version contains had come to mean nothing,
and four issues had no milestone at all. Renaming a shipped milestone is not the
repair — 15 issues closed under that name and renaming rewrites their history.
Move the open ones out, then close it with a description saying what superseded
it.

## Packaged QA telemetry

Before launching a packaged build for verification, set:

```powershell
$env:CAPTUREPACK_TELEMETRY_ENVIRONMENT = 'test'
```

The field harness also forces `test` when `CAPTUREPACK_FIELD_QA=1`, even if an
inherited telemetry override says `prod`. Test and development modes keep their
identity and daily attempt state in `purplepulse.test.json` and
`purplepulse.dev.json`; production continues to use the existing
`purplepulse.json`. Unknown overrides disable collection rather than silently
sending production data. Unpackaged development runs remain uncounted.

This separation prevents QA from creating production users or consuming a real
user's production daily ping. It does not replace the installed capture and
long-run release acceptance gates.
