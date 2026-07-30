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
application `0.3.3` can generate packs using newer additive format versions;
the optional offline viewer is defined for compatible packs at format `0.5.0`
or newer.

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

## Release notes

- [0.3.3](releases/0.3.3.md) — current stable release.
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
