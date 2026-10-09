# Real-pack regression corpus

`corpus.json` contains privacy-safe geometry distilled from four saved packs.
It retains no original pixels, text, URLs, selectors, ids, classes, HWNDs or
process names. The historical capture hands-off time is provenance only.

Run `npm run check:pick-quality` from `core`. It reconstructs each pack and
checks the current build through `readPackObjectContext`, `frameAt` and
`ObjectIndex.forDisplay`. The candidate clock ends when the indexes exist;
the grid sweep is outside that clock. Per-case release limits are:

- replay to candidates <= committed baseline × 1.5 + 40 ms scheduling allowance;
- median and p90 offered-control area <= baseline × 1.5;
- precise-target share >= baseline × 0.8;
- control coverage >= baseline × 0.9;
- an exact window-only result where the source pack offered no controls.

The four baselines were measured on the healthy issue branch with a 16 px
grid. Each is committed beside its distilled pack. Changing geometry requires
reviewing `shape_sha256`; changing a baseline requires a reviewed healthy run.
Neutral pixels make visual changes independent of the behavior checks.

**Coverage gaps:** This saved-pack gate cannot measure capture to painted editor.
The source-run values must never be counted against five seconds. The Windows
`capture-e2e` job now checks the release build's live monotonic log against
5,000 ms after the editor becomes visible.
The committed browser cases have no DOM payload, so they test UIA candidates,
while `check:dom` and `check:pack-readback` separately test the DOM path. Full
multi-display output, motion, similar frames and HDR/SDR also lack real-pack
cases; their companion checks are listed in the inventory where available.

## Refreshing cases

Select source packs deliberately, find their `[capture] latency ... hands-off`
line in the local production log, then run `distill-real-pack-corpus.mjs` with
`--case`, `--tags`, `--hands-off`, `--controls` and `--baseline` for each case.
The baseline order is `replay-ms,median-fraction,p90-fraction,precise-share,control-share`.
Review the generated diff and run `npm run check:pick-quality -- --report`.
