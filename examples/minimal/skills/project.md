# What is a CapturePack?

A CapturePack is a local-first context package that explains a visual situation — usually a
bug — to humans and to LLMs. It is a plain folder (optionally zipped as `.capturepack`, a
standard ZIP) of well-known files. The format specification lives at
https://github.com/r2cuerdame/capturepack (SPEC.md, format 0.1.0).

How this folder is laid out:

- `manifest.json` — REQUIRED entry point: identity, environment, media inventory.
- `snapshot.png` — REQUIRED captured frame; defines the annotation coordinate space. Original
  pixels, never modified.
- `replay.webm` — optional last ~30 s before capture (absent here: screenshot-only pack).
- `replay_annotated.webm` — optional rendering of the replay with annotations burned in
  (absent here — it only exists when there is a replay).
- `annotations.json` — annotation boxes: bounds + text + optional number, blur, lifetime.
  The single source of truth for annotations; rendered views are derived from it.
- `timeline.json` — machine-readable event log.
- `report.md` — generated narrative for humans and LLMs.
- `README.md` — human-first entry point.
- `skills/` — these AI-first documents.
- `plugins/` — optional structured metadata from plugins (none here).

Reading rules: trust `manifest.json` for filenames; skip what you do not recognize; the JSON
files win over any generated document, including this one.
