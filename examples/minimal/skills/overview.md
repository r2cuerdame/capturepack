# Pack overview

**Title:** Submit button overflows its container at 125% zoom
**Captured:** 2026-07-27 10:41 (+09:00) on Windows 11, focused app Google Chrome.
**Media:** screenshot only (640×400 snapshot.png); no replay, no annotated replay.

The user reports a CSS layout bug: at 125% browser zoom the Submit button on a checkout page
overflows the right edge of its form card and covers the order summary next to it. At 100% zoom
the layout is correct. Reproduction is deterministic (toggle zoom 100% -> 125%).

Where to look:

- `snapshot.png` shows the broken state at 125% zoom.
- Box 1 (the only numbered box) marks the overflowing Submit button at (304, 280), 168×56.
- A plain box near the bottom repeats the zoom condition.

Counts: 3 annotation boxes (1 numbered, 1 blurred, 1 plain), 5 timeline events, 0 plugins.

Blur present: yes — one box marks the customer email address as sensitive. snapshot.png is NOT
redacted (blur is non-destructive and renders only into derived views), so treat the raw image
as containing that email address.
