# Submit button overflows its container at 125% zoom

- **Captured:** 2026-07-27 10:41 (+09:00)
- **Pack ID:** 9c1f4a7e-3b2d-4e6f-8a90-6d5c4b3a2f1e
- **Generator:** capturepack-examples 0.1.0

## Note

Set browser zoom to 125% on the checkout page: the Submit button grows past the right edge of
the form card and covers the order summary text next to it. At 100% zoom everything fits.
Reproduced every time by toggling zoom 100% -> 125%.

## Environment

- **OS:** windows 11 Pro 26200
- **Screens:** 1920×1080 @ 1.0
- **Focused app:** Google Chrome
- **Replay:** none (screenshot only)

## Annotations

Coordinates are pixels in snapshot.png (640×400). Numbers are the computed display numbers
(SPEC §8.5) — identical in every rendered view.

1. entire capture — "Submit button escapes the form card — should end at the card's right
   edge" — box at (304, 280) size 168×56
- "customer email address" — box at (48, 96) size 224×22, blur
- "Only at 125% browser zoom — 100% renders fine" — box at (40, 344) size 328×32

1 box is marked blur. snapshot.png contains the original, unredacted pixels; blur is rendered
only in derived views (this pack has no replay, so no annotated replay exists).

## Files

- manifest.json — pack identity, environment, inventory
- snapshot.png — captured frame, 640×400 (original pixels, never modified)
- annotations.json — the 3 annotation boxes above, as editable data
- timeline.json — capture/annotation/save events
- README.md — human-first entry point
- skills/ — AI-first context documents
- report.md — this file
