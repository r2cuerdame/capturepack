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
   uses the next patch version, for example `0.3.3-rc.1` after stable `0.3.2`;
   reusing `0.3.2-rc.*` would sort below the already-published stable version.
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
$Version = '0.3.2'
Get-FileHash ".\CapturePack-Setup-$Version.exe" -Algorithm SHA256
```

Once that version is public, compare the lowercase hash with the matching line in
`SHA256SUMS.txt` on
[GitHub Releases](https://github.com/r2cuerdame/capturepack/releases). Until the
matching release appears there, it is a candidate rather than a public download.

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
