# Conventions

## Comments carry the WHY, with evidence

The codebase is unusually heavily commented, and deliberately so. A comment explains **why the
code is shaped this way**, names the failure it prevents, and where possible quotes the number it
was measured at and the pack or log it came from. Match this density — a terse patch reads as
foreign here.

```ts
// TWO SAMPLES CAN SHARE AN INSTANT (#93). A window straddling two monitors is
// observed once per screen ... Measured on CapturePack_2026-07-29_110219: at
// 26304 ms the same window was 908x634 on one screen and 52x634 on the other.
```

Issue numbers (`#NN`) refer to GitHub issues in this repo and are load-bearing cross-references.

## No estimates, ever

The single strongest rule in this codebase, stated by the user and enforced throughout:

- Never interpolate or average an observation. Return the nearest **recorded** sample and report
  the error.
- Never apply a constant correction derived from one machine. Frame rates and latencies differ
  per desk; a constant that is right here is wrong there.
- Never report a derived number as if it were measured. A metric that can be inflated by something
  other than what it names is worse than no metric — two shipped in this project and both had to
  be withdrawn.
- When an interval is not measured, say so rather than defaulting it to zero.

## Commits

Subject line states the *goal achieved*, not the change made:

```
GOAL: a picked box means the frame it was picked on
GOAL: the ring keeps one clock, and a still screen is not a fault
```

Body: what was reported (quote the user verbatim if they reported it), what was measured, the
cause, the fix, and what is still unproven. `Refs #NN` / `Closes #NN` at the end.
Release commits are `release: vX.Y.Z`.

## i18n

`core/src/shared/i18n.ts` holds **nine** full dictionaries (en, ko, ja, zh, es, fr, de, pt, ru) as
one `Record` per language, all with identical key sets — a missing key is a type error. Every
user-visible string goes in all nine. Markup uses `data-i18n` / `data-i18n-title` /
`data-i18n-placeholder`; `applyDomI18n` fills them.

Beware: Spanish and Portuguese often share an English-looking anchor string. When inserting keys
by text match, verify each block got its own translation.

## Build output is not source

`core/rc*/` are installer outputs and are gitignored. Never commit them — a single directory is
~400 MB.
