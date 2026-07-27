# Annotations

Coordinate space: snapshot.png, 640×400 pixels, origin top-left.

Display numbers are computed, never stored: boxes with `numbered: true`, sorted by start_ms
ascending (absent = 0), then z ascending, then annotation_id ascending, numbered from 1. The
same numbers appear in every rendered view and document.

## Box 1 — ann_4b0e2f (numbered)

- **Text:** "Submit button escapes the form card — should end at the card's right edge"
- **Bounds:** (304, 280) size 168×56
- **Lifetime:** none (applies to the whole capture)
- This is the bug: the button rendered past its container's right edge.

## ann_9c31d7 (unnumbered, blur)

- **Text:** "customer email address"
- **Bounds:** (48, 96) size 224×22
- **Blur:** true — this region is sensitive. Blur is non-destructive: snapshot.png keeps the
  original, unredacted pixels; the blur renders only into derived views (annotated replay,
  editor previews). Do not quote the content of this region.

## ann_e5a601 (unnumbered)

- **Text:** "Only at 125% browser zoom — 100% renders fine"
- **Bounds:** (40, 344) size 328×32
- Context box: states the reproduction condition.

No box has tracking enabled and none carries a semantic `target` (both are reserved in format
0.1.0).
