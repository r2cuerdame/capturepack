# CapturePack localized motion assets

다국어 랜딩용 설명 영상이다. GIF가 아니라 실제 `<video>` 자산이므로 사용자가 일시정지하거나 타임라인을 이동해 볼 수 있다.

## 언어

- `en` English
- `ko` 한국어
- `ja` 日本語
- `zh` 简体中文
- `es` Español
- `fr` Français
- `de` Deutsch
- `pt` Português
- `ru` Русский

각 언어 폴더에는 타임머신 설명과 원본 보존 설명의 WebM, MP4, WebP 포스터가 들어 있다.

## 권장 마크업

```html
<video controls muted loop playsinline preload="metadata"
       poster="assets/motion/ko/capturepack-time-machine-poster.webp">
  <source src="assets/motion/ko/capturepack-time-machine.webm" type="video/webm">
  <source src="assets/motion/ko/capturepack-time-machine.mp4" type="video/mp4">
</video>
```

- WebM(VP9)을 우선 사용한다.
- MP4(H.264)는 브라우저 호환용 fallback이다.
- `controls`를 유지해야 방문자가 일시정지·탐색할 수 있다.
- 자동재생을 추가할 경우에도 `muted`, `playsinline`, `controls`를 유지한다.
- Remotion 원본 소스는 저장소의 `tools/site-motion/`에 있다.
