# Submit button overflows its container at 125% zoom

- **Created:** 2026-07-27 10:41 (+09:00)
- **Application:** Google Chrome
- **Duration:** screenshot only (no replay)

## Description

Set browser zoom to 125% on the checkout page: the Submit button grows past the right edge of
the form card and covers the order summary text next to it. At 100% zoom everything fits.
Reproduced every time by toggling zoom 100% -> 125%.

## Files

| File | What it is |
|---|---|
| snapshot.png | The captured frame, 640×400 — original pixels, never modified |
| annotations.json | 3 annotation boxes (1 numbered, 1 blurred, 1 plain) — the editable source |
| timeline.json | When the capture and each annotation happened |
| report.md | The full generated narrative of this pack |
| skills/ | Context documents structured for AI readers |
| manifest.json | Pack identity, environment, and file inventory |

## How to use

1. Open `snapshot.png` — this pack is screenshot-only, so there is no `replay_annotated.webm`
   to watch. (In packs with a replay, watch `replay_annotated.webm` first.)
2. Read `report.md` for the full narrative.
3. AI: read the documents in `skills/`, or connect through a CapturePack MCP server.

Note: one annotation box is marked blur ("customer email address"). Blur is non-destructive —
`snapshot.png` contains the original, unredacted pixels; blur renders only into derived views.
Keep that in mind before forwarding this folder.
