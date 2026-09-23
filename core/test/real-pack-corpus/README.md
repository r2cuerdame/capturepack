# Real-pack regression corpus

`corpus.json` is the committed, privacy-safe release corpus for the five-second
capture and object-picking workflow. Each case began as a saved pack produced by
CapturePack. The distiller keeps only numeric screen/window/control geometry,
closed-vocabulary UIA control types and DOM tags/roles, and the monotonic
hands-off latency printed by that capture. It replaces the raster with neutral
grey and removes all original text, URLs, selectors, ids, classes, HWNDs and
process names.

`npm run check:pick-quality` reconstructs every entry as a normal saved pack,
opens it through `readPackObjectContext`, builds the production `ObjectIndex`,
and gates:

- observed capture-to-painted-editor latency: at most 5,000 ms;
- replay-to-candidate availability in the current build: at most 1,000 ms;
- control availability for cases that originally offered controls;
- an honest window-only result for cases whose recorded trees offered none;
- median offered-control area at most 15% of the frame;
- p90 offered-control area at most 55% of the frame;
- a non-zero precise-target share where controls are expected.

Pixel changes are intentionally not a substitute for those behavioral checks.
The neutral raster is regenerated, and `shape_sha256` protects the reviewed
geometry baseline. A hash change therefore means the distilled behavior shape
changed and needs review; it never gets waved through as a screenshot update.

## Refreshing cases

Select source packs deliberately, find their `[capture] latency ... hands-off`
line in the local production log, then run `distill-real-pack-corpus.mjs` with
one `--case`, `--tags`, `--hands-off` and `--controls` assignment per case. The
tool accepts only explicit source paths and writes only the whitelist described
above. Review the resulting diff and run `npm run check:pick-quality -- --report`.

The `hard_case_inventory` in `corpus.json` must name every known hard-case
class. `coverage-gap` is an explicit release-evidence limitation, not a claim
that the case is handled. Current real evidence covers mixed-DPI, overlays and
a multi-display environment. Full multi-display output, motion, similar-frame
selection and HDR/SDR still need privacy-safe real source packs; companion
deterministic checks are named where they exist.
