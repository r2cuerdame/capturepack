# Releasing CapturePack

Releases are fully automated: push a version tag and GitHub Actions builds, packages,
and publishes the Windows installer plus updater metadata. Running apps pick up the
update automatically.

## Cutting a release

1. Bump the version in `core/package.json` (e.g. `0.1.0` → `0.2.0`).
2. Commit the bump:

   ```
   git add core/package.json
   git commit -m "release: v0.2.0"
   ```

3. Tag with a `v` prefix matching the package version, and push:

   ```
   git tag v0.2.0
   git push && git push --tags
   ```

That is all. The tag push triggers `.github/workflows/release.yml`, which:

1. Runs `npm ci`, `npm run typecheck`, and `npm run build` on `windows-latest`.
2. Runs `npm run release` (`electron-builder --win --publish always`), which packages
   the NSIS installer and publishes to a GitHub Release for the tag:
   - `CapturePack-Setup-{version}.exe` — the installer.
   - `latest.yml` — updater metadata containing the installer's sha512, which
     `electron-updater` verifies before applying an update.
3. Computes SHA-256 of every `.exe` in `core/release` and uploads a `SHA256SUMS.txt`
   to the same release, so downloads can be verified by hand.

The release is published immediately (not a draft).

## How users get the update

The app checks GitHub Releases on start. When a newer version is published, the running
app downloads it in the background and shows a notification with
**[Restart and update]** / **[Later]**. Choosing Later defers the install; the update is
applied when the app quits or restarts. No manual reinstall, no separate update server.

## Verifying a download manually

```powershell
Get-FileHash CapturePack-Setup-0.2.0.exe -Algorithm SHA256
```

Compare against the matching line in `SHA256SUMS.txt` on the release page.

## Code signing

**Not configured yet.** Builds are unsigned, so Windows SmartScreen will warn on first
run of the installer ("Windows protected your PC" → More info → Run anyway). Updates
are still integrity-checked: `electron-updater` verifies the sha512 from `latest.yml`
before installing.

**TODO** — when a code signing certificate is available:

- Add the certificate (or a cloud signing service token) as repository secrets and wire
  `win.certificateFile`/`certificatePassword` or a `signtool` hook into
  `core/electron-builder.yml`.
- This removes the SmartScreen warning (immediately with an EV certificate; over time,
  as reputation accrues, with a standard OV certificate) and lets Windows attribute the
  binary to a verified publisher.
- `electron-updater` will additionally verify the publisher name of downloaded updates
  once builds are signed, closing the gap between "hash matches" and "hash matches and
  came from us".

## Rollback and failure behavior

- `electron-updater` keeps the currently installed version in place until the new
  installer runs successfully on quit. A failed download or a hash mismatch means the
  update is discarded and the existing version keeps running.
- If a published release turns out to be bad, cut a new release with a higher version
  number (e.g. `v0.2.1` re-tagging the last good code). Apps on the bad version will
  update forward to it. Deleting the bad GitHub Release stops new installs from
  picking it up.
