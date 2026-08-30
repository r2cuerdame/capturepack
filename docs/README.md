# CapturePack documentation

This directory contains the operational, integration, release, and historical
documentation for CapturePack. Start with the current sources below; archived
documents preserve evidence but are not instructions for the current release.

## Start here

| Document | Purpose |
|---|---|
| [Handoff](HANDOFF.md) | Current release state, known problems, safety boundaries, and next work |
| [Handoff prompt](HANDOFF-PROMPT.md) | Short prompt to paste to the next engineering agent |
| [Product goal](../GOAL.md) | Product intent and measured design decisions |
| [Pack specification](../SPEC.md) | Normative open-format contract |
| [Architecture](../ARCHITECTURE.md) | Current process, capture, storage, and rendering boundaries |
| [Roadmap](../ROADMAP.md) | Current baseline and future work |
| [Changelog](../CHANGELOG.md) | Shipped application changes by version |

The application version and pack format version are separate. CapturePack
application `0.4.4` can generate packs using newer additive format versions;
the optional offline viewer is defined for compatible packs at format `0.5.0`
or newer, and a pack declares up to `0.8.0` when it carries input events. Plugin
payloads carry their own versions — `windows-uia` is at `0.5.0` since it began
persisting each window's client rectangle.

**Current state.** `0.4.4` is the public release and `main` carries it. History
can create a reviewed `capturepack-share` `.share.zip` whose only media are
declared annotated PNG stills; a generated README, offline viewer and minimal
inventory accompany them. The writer deterministically re-encodes their pixels
and derives every review thumbnail from those exact outbound bytes; every still
also opens lazily at full-resolution 1:1. Malformed/partial display lanes and
raced destination names fail closed. The copy excludes originals, every video
container and structured pack context. This is visual risk reduction, not proof
that an image is secret-free, so every included still and visible label must be
reviewed before sending. A full `.zip` remains the complete originals-included
distribution. A video CapturePack now
describes every screen rather than one screen plus others — `media.displays` is
always present, each entry states its own measured frame, and an annotation on a
second screen is defined in the format as pixels in that screen's image
(format `0.7.0`, [#75](https://github.com/r2cuerdame/capturepack/issues/75)). The
timeline records what moved: mouse and window events on the replay clock, and
never a keystroke (format `0.8.0`,
[#12](https://github.com/r2cuerdame/capturepack/issues/12)). And a saved pack's
browser page can be read back at all, which it could not before
([#136](https://github.com/r2cuerdame/capturepack/issues/136) — 6,091 element
rectangles across the author's own packs recovered as one).

`GOAL.md` is the design record; [Handoff](HANDOFF.md) carries the verified state
and the next order. Open work is grouped by milestone in the
[issues](https://github.com/r2cuerdame/capturepack/issues). One thing the format
work does not settle remains open: a real three-screen capture
([#76](https://github.com/r2cuerdame/capturepack/issues/76)).

## Development and QA

| Document | Purpose |
|---|---|
| [Contributing](../CONTRIBUTING.md) | Repository and contribution workflow |
| [Release QA](QA.md) | Deterministic gates, forensic pack checks, and manual Windows matrix |
| [Releasing](RELEASING.md) | Manual verified-draft publication workflow |
| [Code signing](CODE_SIGNING.md) | Current unsigned-build policy and signing plan |
| [0.3.1 dependency audit](DEPENDENCY-AUDIT-0.3.1.md) | Production/dev dependency findings for that release line |
| [DXGI timing reference](DXGI_TIMING_REFERENCE.md) | Windows capture timing evidence and terminology |

## Integrations and schemas

| Document | Purpose |
|---|---|
| [MCP](MCP.md) | Loopback, read-only tools for already-saved packs |
| [Temporal provider API](temporal-provider-api.md) | Provider contract and timing rules |
| [Manifest schema](schemas/manifest.schema.json) | Machine-readable manifest validation |
| [Annotations schema](schemas/annotations.schema.json) | Machine-readable annotation validation |
| [Timeline schema](schemas/timeline.schema.json) | Machine-readable event timeline validation |
| [Share Copy schema](schemas/share.schema.json) | Closed inventory for reviewed-stills-only `.share.zip` files |

## Release notes

- [0.3.3](releases/0.3.3.md) — historical release notes.
- [0.3.3-rc.1](releases/0.3.3-rc.1.md) — historical prerelease notes.

## Historical material

- [CapturePack v0.2.0 handoff](HANDOFF-v0.2.0.md) is an archived engineering
  snapshot. It must not override the current handoff, QA, specification, or
  release process.
- `plugin-system-v0.2.0.ko.txt` is the original Korean plugin-system design
  record. Check current code and `temporal-provider-api.md` before implementing
  against it.

When documents disagree, treat `SPEC.md` as normative for pack compatibility,
the current code and tests as implementation evidence, and `GOAL.md` as the
living product decision record. Fix contradictions rather than silently
choosing whichever text is convenient.
