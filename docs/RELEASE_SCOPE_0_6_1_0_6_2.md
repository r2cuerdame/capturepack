# Next-release scope — 0.6.1 candidate and 0.6.2 plan (#445)

This document fixes where the 0.6.1 candidate ends and the 0.6.2 plan begins,
and gives each stage completion conditions that a check, a CI step or a
recorded field result can settle. It is not a release note and not a release
claim: **0.6.0 is the current stable release**, `core/package.json` still
builds `0.6.0`, and 0.6.1 is published only when a person runs the Release
workflow ([RELEASING.md](RELEASING.md)).

`check:docs` holds this document to the repository: every check it names must
exist, the count it states must be the count the gate discovers, the five-second
condition must stay in every stage, and the workflow triggers it describes must
match the workflow files. Prose is still judged by the reader.

## How a condition is settled

| Kind | Settled by | Where it runs |
|---|---|---|
| Automated | A `check:*` script in `core/package.json` that `qa-gate.mjs` discovers | `npm run qa:checks` locally; `npm run qa:rc` in the CI `build` job and the Release workflow |
| CI | A step of [ci.yml](../.github/workflows/ci.yml) on a real Windows runner | Every push to `main` and every pull request |
| Release | A step of [release.yml](../.github/workflows/release.yml) | Only when a person dispatches it |
| Field | A measurement on real hardware, a real install or a real month | Recorded by a person; unverified until recorded |

The gate discovers 102 checks today. `npm run qa:checks` runs those 102 plus type
checking (103 steps); `npm run qa:rc` adds the production build and the
isolated Electron smoke (105 steps). The count moves when a check is added, and
this document must move with it.

## Standing condition — the five-second workflow

```
Ctrl+Alt+C  →  capture  →  5-second annotation  →  save folder  →  share from History
```

This condition is part of **every** stage below and is judged on its own. A stage
whose feature checks all pass has still not passed while this condition fails or
has not been run.

| Requirement | Settled by |
|---|---|
| The hands-off time from trigger to a painted editor is counted honestly: no stage counted twice, no backwards clock, no human selection time billed to the app, no total for an editor that never opened | `check:capture-latency` (automated) |
| A live capture reaches a painted editor within 5000 ms | `assert-live-capture-latency.mjs <main.log> 5000` in the CI `capture-e2e` job and in the Release workflow's "Gate live capture to painted editor" step |
| Save-time context collection cannot hold capture open: each collector has a 100 ms deadline and fails open, and a failed plugin write still returns well inside five seconds | `check:git-plugin`, `check:console-plugin` |
| A capture whose sources are durable reports saved, and one that saved nothing says so | `check:save-now` (automated); `--save-now` exit codes in the CI `capture-e2e` job |

The live 5000 ms assertion needs a real display. A headless or locked-desktop
run reports it as unverified, never as passed.

## 0.6.1 candidate — scope and completion conditions

Status: in the source baseline and listed under "0.6.1 — Candidate (not
released)" in [CHANGELOG.md](../CHANGELOG.md). Nothing below is in a published
installer yet.

| # | Scope | Completion condition | Settled by |
|---|---|---|---|
| 1 | Open Shadow DOM traversal ([#345](https://github.com/r2cuerdame/capturepack/issues/345)) | The document snapshot records what open shadow roots draw, nested roots included, with the host before its contents; password, typed-value and hidden refusals hold inside a shadow tree. The picker highlights and picks an element inside an open root and names it through each boundary (`host >>> inner`); a closed root is picked as its host and nothing inside it is read | `check:document-snapshot`, `check:chrome-bridge` |
| 2 | Single-page route detection | The tab's current URL and title are forwarded, never the hint's; inactive-tab, cross-origin, closed-tab, unreadable-URL and malformed hints are dropped without throwing; a long route is delivered with the URL capped at 2,048 characters and the title at 512 | `check:chrome-route-change` |
| 3 | Git context saved safely ([#442](https://github.com/r2cuerdame/capturepack/issues/442)) | Repository, branch, commit, dirty flag and changed paths are collected within 100 ms or omitted. State and metadata go through a temporary file and an atomic replace, metadata last. A failed write leaves no declaration, no temporary file and no unpublished directory, keeps a plugin an earlier write published, and the capture still saves | `check:git-plugin` |
| 4 | Opaque Share Copy masking | Each blur active at a still's time is filled with solid `#1a1a1a` and the label gutter is cleared where it is active; pixels outside it are kept; Share Copy still holds only declared annotated stills re-encoded from pixels | `check:share-bundle` |
| 5 | No regression anywhere | `npm run qa:checks` finishes with all 102 discovered checks passing and type checking clean — zero failures, zero skipped checks | The whole gate |
| 6 | Five-second workflow | The standing condition above, on the candidate's own head | See the standing condition |

Promoting the candidate to 0.6.1 is a separate act that this document does not
perform: bump `core/package.json` and the lockfile, date the changelog heading,
move the READMEs and the website to the new version, run `npm run qa:rc` on the
exact source, then a person dispatches the Release workflow
([RELEASING.md](RELEASING.md)).

## 0.6.2 plan — acceptance criteria (planning only)

This is the 2026-12 milestone in [ROADMAP.md](../ROADMAP.md) and
[HANDOFF.md](HANDOFF.md). The console prototype and its deterministic check are
implemented in source; merge and release remain separate gates.

### Console context plugin

| # | Completion condition |
|---|---|
| 1 | A console host may provide its bounded output snapshot through `CAPTUREPACK_CONSOLE_OUTPUT`; the app writes `plugins/console/` with a `meta.json` whose `name` is `console` and whose `version` is set, plus `output.log` and `state.json`, and declares the same plugin name and path ([SPEC.md §11](../SPEC.md#11-plugins)). The opt-in source avoids scraping unrelated processes or terminal windows |
| 2 | Deadline: collection has a 100 ms deadline and cannot hold capture open beyond it |
| 3 | Success: a successful collection writes the declared payload and metadata |
| 4 | Absent or denied access: no plugin is added, nothing is declared, and the save does not fail |
| 5 | Timeout: a collection that exceeds 100 ms is abandoned and the save does not fail |
| 6 | Atomic-write failure: no partial plugin declaration and no temporary file are left, and the save does not fail |
| 7 | A new deterministic console check in `core/package.json` asserts outcomes 3–6. Adding it raises the discovered count to 101, and the documents that state the count change with it |
| 8 | No regression: `check:spec`, `check:validator`, `check:docs` and all 101 discovered checks passing |
| 9 | Five-second workflow: the standing condition above, judged on its own |

### One month without a manual reinstall

| # | Completion condition |
|---|---|
| 1 | The period starts only after a public-release installer completes, with its actual date and installed version recorded as day 0 |
| 2 | Weekly reviews and a verdict at day 30 or later record confirmed ordinary-use dates, automatic updates, any manual reinstall, interruptions and the evidence reviewed |
| 3 | The verdict follows the ledger's rules: a manual reinstall fails the period; passing needs at least 30 calendar days of confirmed ordinary use and evidence for the starting and final versions; missing dates or evidence make it inconclusive, never guessed |
| 4 | The rules live in [OBSERVATION.md](OBSERVATION.md) and the dated record in [OBSERVATION-LOG.md](OBSERVATION-LOG.md), which stays `not started` until that install is verified. `check:docs` keeps every field, review window and verdict rule in the ledger |
| 5 | Five-second workflow: the standing condition above, still judged on its own while the month runs |

Planned additional cost: 0. Existing local resources and the existing CI only.

## Publication contract

| Workflow | Trigger | What it does | Who runs it |
|---|---|---|---|
| [pages.yml](../.github/workflows/pages.yml) | A push to `main` that touches `site/**` or the workflow itself, or `workflow_dispatch` | Uploads `site/` to GitHub Pages ([capturepack.dev](https://capturepack.dev/)). This is the official web deployment | Runs on merge; observed, not dispatched by automation |
| [release.yml](../.github/workflows/release.yml) | `workflow_dispatch` only, with a tag input | Refuses a tag other than `v` + `core/package.json` version and refuses to replace a public release; runs `npm run qa:rc`, the live five-second gate, packaging and the release contract check; publishes only after byte-verifying the draft | A person |
| [ci.yml](../.github/workflows/ci.yml) | Push to `main` or a release branch, and pull requests | `build` (the full gate), `capture-e2e` (live capture and the five-second assertion), `spec-validate` | Runs automatically; publishes nothing |

A merge to `main` never publishes an installer. The website keeps naming the last
published version (`PUBLIC_VERSION` in `site/validate.mjs`, held by
`check:site`) until the Release workflow has published the next one.

## Desktop-only conditions

These need a real display, a real browser or a real install and cannot be
settled by a headless or locked-desktop run. Report each one as unverified until
it is recorded:

- the live capture-to-painted-editor time (CI `capture-e2e`, Release workflow);
- the pack half of `npm run qa:chrome-bridge`, which records the desktop for
  12 seconds (the gate runs only its wire half);
- installer, auto-update and the one-month observation;
- the manual Windows matrix in [QA.md](QA.md).
