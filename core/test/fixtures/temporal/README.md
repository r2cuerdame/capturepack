# Temporal picking evidence

`evidence.json` is four real CapturePacks taken on one two-monitor desk within
two minutes of each other — **geometry and identity only, never a pixel**.

| pack | captured | replay | windows | elements |
|---|---|---|---|---|
| `CapturePack_2026-07-28_191502` | 19:15:02 +09:00 | 20.0 s | 9 | 447 |
| `CapturePack_2026-07-28_191530` | 19:15:30 +09:00 | 27.2 s | 9 | 449 |
| `CapturePack_2026-07-28_191558` | 19:15:58 +09:00 | 28.2 s | 9 | 450 |
| `CapturePack_2026-07-28_191714` | 19:17:14 +09:00 | 30.0 s | 10 | 451 |

Regenerate with (the packs are only ever read):

```
node scripts/make-temporal-fixture.mjs <pack-dir> <pack-dir> ...
```

## Why four packs and not one

Every pack written before v0.2.0 records object structure at **exactly one
instant** — the moment the hotkey was pressed, which is the END of its replay.
So a single pack cannot answer "what was here twenty seconds ago", and a harness
built on one could only ever test the capture instant.

These four were taken 28 s, 28 s and 76 s apart, which means **one pack's
capture instant falls inside the previous pack's replay ring**:

```
_191530's ring [0, 27186] ms  holds  _191502's instant at t = -20 ms
_191558's ring [0, 28215] ms  holds  _191530's instant at t = +19 ms
```

`test/temporal/check.mjs` assembles those pairs into one ring each and asks
picking about both ends of it. That is real evidence of a real desktop at two
real times, not a synthesised timeline.

## What each ring proves

- **`_191530`** — the Windows taskbar news headline
  (`Text` / `TextBlock` / `[속보] 코스피 장중 6000 붕괴…`, the only element in
  the whole fixture whose identity is unique at both times AND whose rectangle
  changed) sits at `(77, 2123, 147, 24)` at the start of the ring and
  `(77, 2100, 147, 24)` 27.2 s later. Picking must offer it at BOTH rectangles,
  each at its own time — and the v0.1.x index, which knew only the capture
  instant, offers the neighbouring weather text at the earlier point instead.
- **`_191558`** — the Orca window came to the front over Docker Desktop between
  the two observations (z 4 → topmost, Docker 3 → 4). One point inside both
  windows must therefore resolve to Docker Desktop at the earlier time and to an
  Orca control at the later one. This is #66's failing case with real data.
- **`_191714`** (the reference capture) — the #58 picking-quality sweep, and the
  honesty check: at `snapshot_t_ms = 4515`, the moment this pack's own
  annotation was drawn, the frame reports `single-instant` and offers nothing
  rather than handing back rectangles from 25,485 ms away.

## What the evidence does NOT contain

**No window moved and no window was resized** across all four captures, and
exactly **one** uniquely-identified control changed position. The desk was
otherwise idle. So this fixture proves that picking follows time where the
evidence moves; it does not exercise a continuously moving window, and the
rigid-body re-anchor that a live surface timeline will depend on is not measured
here.
