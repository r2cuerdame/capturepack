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

## 이번 변화(0.4.0)와의 관계

**재렌더가 필요 없다.** 두 편의 서사를 전수 확인했다: `copy.ts`와 `Root.tsx`에
추적·따라가기·모니터 넘나들기를 주장하는 문구가 한 건도 없다.

- `capturepack-time-machine` — "No re-run. Rewind. Pick. Explain." 되감아서 그
  프레임에서 고르는 동작은 그대로 살아 있다(`frameAt`). 여전히 사실이다.
- `capturepack-still-context` — "Original pixels. Editable context." 이쪽은
  애초에 정지 화면 이야기였고, 0.4.0이 강화한 방향과 같다.

없어진 것은 **고른 뒤 상자가 객체를 따라가는 것**뿐이고, 두 영상 모두 그것을
보여주거나 주장하지 않는다.

**다만 새로 생긴 것을 아직 보여주지 않는다.** 브라우저에서 픽 하나가 그 페이지의
보이던 요소 전부를 담아온다는 것(SPEC §11.4의 `document`)은 영상에 없다. 그것은
틀린 말이 아니라 빠진 말이므로, 고치는 일이 아니라 만드는 일이다. 세 번째 편을
쓸 때 다루면 된다.
