# CapturePack landing motion

Remotion source for the two short CapturePack landing-page explainers.

1. **TimeMachine** — no bug reproduction; rewind the replay, then attach object or manual context.
2. **StillContext** — keep `snapshot.png` pixels untouched and store editable context in `annotations.json`.

## Locales

`en`, `ko`, `ja`, `zh`, `es`, `fr`, `de`, `pt`, `ru`

The locale copy lives in `src/copy.ts`. Render-time props use this shape:

```json
{"locale":"ko"}
```

## Requirements

- Node.js and npm
- FFmpeg available on `PATH`
- Windows 10/11 fonts: Segoe UI, Malgun Gothic, Yu Gothic, Microsoft YaHei, and Cascadia Mono

The source intentionally references installed Windows fonts instead of redistributing proprietary font files. On another OS, install equivalent Noto Sans fonts or update `localeFontFamily()` in `src/copy.ts`.

## Preview

```powershell
npm install
npm run typecheck
npm start
```

## Render

Render every locale to MP4, WebM, and WebP posters:

```powershell
npm run render:i18n
```

Render only selected locales:

```powershell
npm run render:i18n -- ko en
```

Output:

```text
out/i18n/<locale>/
  capturepack-time-machine.mp4
  capturepack-time-machine.webm
  capturepack-time-machine-poster.webp
  capturepack-still-context.mp4
  capturepack-still-context.webm
  capturepack-still-context-poster.webp
```

After rendering from this repository location, copy outputs into the static site:

```powershell
npm run publish:assets
```

## Website playback

Use a real `<video>` element instead of GIF. `controls` lets visitors pause and scrub; WebM is preferred and MP4 is the compatibility fallback.

```html
<video controls muted loop playsinline preload="metadata"
       poster="assets/motion/ko/capturepack-time-machine-poster.webp">
  <source src="assets/motion/ko/capturepack-time-machine.webm" type="video/webm">
  <source src="assets/motion/ko/capturepack-time-machine.mp4" type="video/mp4">
</video>
```

Do not autoplay with sound. If autoplay is enabled later, keep `muted` and preserve `controls` so the visitor can stop and inspect the frame.
