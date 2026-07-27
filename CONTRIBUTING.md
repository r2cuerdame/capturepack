# Contributing to capturepack

Thanks for helping build CapturePack. This guide is short on purpose — read it once and you know
how the project works.

## Philosophy

CapturePack is a local-first context capture format and toolkit: press `Ctrl+Alt+C`, annotate in
5 seconds, export a `.capturepack` file that any human or LLM can understand. Everything follows
from a few principles — local first, offline first, open format, plugin-based, no cloud, no
login, no database, no AI dependency, minimal dependencies — and one hard rule: **never sacrifice
the 5-second workflow**. If a change adds a server, an account, a heavyweight dependency, or a
second of friction to capture-annotate-export, it doesn't belong here. [GOAL.md](GOAL.md) is the
source of truth for the vision; read it before your first contribution.

## SPEC before code

The file format matters more than any implementation. [SPEC.md](SPEC.md) is authoritative:

- **Any change to the format requires a SPEC.md update in the same PR.** Code that produces or
  consumes something the spec doesn't describe will not be merged.
- The spec is versioned (semver; while pre-1.0, minor versions act as major). Backward
  compatibility is a requirement: generated packs must remain readable forever, and readers must
  tolerate unknown fields, files, and types.
- If SPEC.md prose and the JSON Schemas in [`docs/schemas/`](docs/schemas/) disagree, the prose
  wins — but a format PR should keep both in sync.

## Repository layout

```
capturepack/
├── SPEC.md          # the format specification — source of truth
├── GOAL.md          # vision and principles
├── docs/            # schemas, release process, other documentation
├── core/            # the reference app (Electron): capture, annotate, export
├── plugins/         # plugin implementations (planned)
├── examples/        # example packs — examples/minimal is a complete valid pack
├── tools/           # standalone CLI tools — validate-capturepack.mjs checks a pack against SPEC.md
├── site/            # landing page (GitHub Pages)
└── tests/           # cross-cutting tests, e.g. spec conformance (planned)
```

Directories marked *planned* don't exist yet — creating the first one is a fine contribution.

## Development setup

You need **Node.js 20+** and npm. The app lives in `core/`:

```
cd core
npm install
npm run dev        # build and launch the app
npm run typecheck  # TypeScript check
npm run build      # build only
```

Everything runs locally. There is no backend, no login, nothing to provision.

## Coding guidelines

From [GOAL.md](GOAL.md), and enforced in review:

- Readable code over clever code.
- Composition over inheritance.
- Small modules.
- Plugin-first: core owns nothing except capture; plugins only append metadata.
- Keep dependencies minimal — every new dependency needs a justification.
- Avoid overengineering. Prefer simplicity over features.
- Public APIs (and the plugin interface) should remain stable.

## Proposing format changes

Format changes are the highest-impact changes in this project, so they move deliberately:

1. **Open an issue first** describing the problem the change solves — ideally with a real capture
   scenario where the current format falls short.
2. **Discuss.** Expect pushback on anything that breaks old packs, complicates minimal writers
   (a five-line script must still be able to produce a valid pack), or slows the workflow.
3. **Then open a spec PR** updating SPEC.md (with a version bump per its versioning policy) and
   the schemas in `docs/schemas/`. Implementation can land in the same PR or follow it — but
   never precede it.

## Commits and pull requests

- Keep PRs small and focused: one change per PR.
- Write commit messages that explain *why*, not just what.
- Make sure `npm run typecheck` passes in `core/` before opening a PR.
- Link the issue your PR addresses. For anything non-trivial, an issue-first conversation saves
  everyone time.
- Reviews aim to be fast and friendly; "simpler" is the most common review comment here, and it's
  meant kindly.

We also keep a daily **usage journal** in GitHub Issues (what worked, what hurt, ideas) — reading
recent entries is the best way to find something worth fixing.

## License

capturepack is [MIT licensed](LICENSE). By contributing, you agree that your contributions are
licensed under the MIT License as well. No CLA, no paperwork.
