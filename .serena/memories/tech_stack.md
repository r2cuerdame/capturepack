# Tech stack

- **Electron 36** (Chromium 136). Windows-only in practice; the UIA helper and the native
  messaging registry are `win32`-gated.
- **TypeScript, strict.** `npm run typecheck` is `tsc --noEmit`; there is no emit step from tsc.
- **esbuild** does the bundling (`core/scripts/build.mjs` → `core/dist/`).
- **electron-builder** → NSIS installer. Config is `core/electron-builder.yml`, *not* a `build`
  key in package.json.
- **npm**. Lockfile committed; CI uses `npm ci`.

## Deliberate absences

- **No test framework.** Verification is a set of standalone harnesses under `core/scripts/*-check.mjs`
  that bundle the *shipping* TypeScript with esbuild at run time, so a check can never drift from
  the code it covers. See `mem:task_completion`.
- **No runtime dependencies** in the app beyond Electron itself. Anything else is a devDependency.
- **No native modules.** The registry is written through `reg.exe`; the UIA tree is read through
  `powershell.exe`. Both keep the build free of a per-Electron-version rebuild step.

## Notable platform facts (measured, easy to get wrong)

- `process.stdin` in an Electron **main** process on Windows is already ended at launch. Native
  messaging reads fd 0 directly (`core/src/main/chrome/nativeHost.ts`).
- `VideoFrameCallbackMetadata.captureTime` **is** provided for `getDisplayMedia` on this Chromium,
  and sits ~1.6 ms before `presentationTime`.
- `navigator.mediaDevices` is absent on `data:` URLs (not a secure context); load a `file:` page.
- MediaRecorder WebM reports `duration === Infinity` until parsed to the end; a far seek forces
  Chromium to resolve it.
