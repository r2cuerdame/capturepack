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

Coordinates are pixels in snapshot.png (640×400), listed in reading order.

1. **Rect** at (304, 280) size 168×56 — "Submit button escapes the form card"
2. **Pin** at (416, 308) — "card's right edge — the button should end here"
3. **Text** at (48, 356) — "Only at 125% browser zoom — 100% renders fine"

## Files

- manifest.json — pack identity, environment, inventory
- snapshot.png — captured frame, 640×400
- annotations.json — the 3 annotations above, as editable data
- timeline.json — capture/annotation/export events
- report.md — this file
