# Handoff prompt — paste this to the next agent

You are taking over CapturePack at `C:\_Project\capturepack`.

Read these before changing anything:

1. `docs/HANDOFF.md`
2. `docs/README.md`
3. `GOAL.md`
4. `SPEC.md`
5. `ARCHITECTURE.md`
6. `docs/QA.md`
7. the current files and `git diff`

The current public Windows release is stable `v0.3.3`, built from
`b7e0c695d5f2c018e2c10fcf83936d1d42f7a0d4`. Do not move that tag or replace
its assets. `main` may contain documentation-only commits after the tag.

The primary unresolved correctness problem is
[issue #89](https://github.com/r2cuerdame/capturepack/issues/89): object/context
overlays can lead encoded video by a display-specific amount. The measured
focused-display lead was about 125 ms in one moving capture, while another
display retained a different residual. Do not hard-code a global offset,
interpolate observed object tracks, or claim sync from a stationary sample.
Build a moving regression and measure source-frame time against encoded PTS per
display.

Before claiming a change works:

```powershell
cd C:\_Project\capturepack\core
npm ci
npm run qa:rc
npm audit --omit=dev
```

The automated gate has 65 steps, but it does not replace the physical Windows
matrix in `docs/QA.md`. A real Desktop Duplication fallback, sustained FPS/gap
measurements, physical three-display behavior, and full hotkey-to-pack E2E
remain field work unless you produce new evidence.

Safety and product boundaries:

- Run `git status` and inspect current diffs before editing; preserve concurrent
  changes and never reset or clean them away.
- Never synthesize the owner's global capture hotkeys or mouse input.
- Do not modify the installed app, live `%APPDATA%\CapturePack` state, or packs
  under `C:\_CapturePack`.
- Use isolated profiles and disabled global shortcuts for headed QA.
- Preserve original media, unknown pack files, local/offline behavior, and the
  read-only saved-pack MCP boundary.
- Never invent unobserved object state or call a failed capture successful.
- Plugin and derived-render failure must not block the source pack save.
- Do not commit installers, release directories, logs, backups, or private
  CapturePacks.
- Do not publish, retag, or change external services without explicit owner
  authorization.

Report to the owner in Korean, lead with the measured result, and list anything
that remains unverified.
