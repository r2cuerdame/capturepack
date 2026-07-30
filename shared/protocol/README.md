# CapturePack Protocol v1

The shared message protocol between the CapturePack application and its companions
(Chrome extension today; other integrations later). Both sides speak exactly these
messages — the protocol is versioned together with the app and extension
(CapturePack 0.1.0 = Chrome Extension 0.1.0 = Protocol v1).

Transport: Chrome Native Messaging (length-prefixed JSON over stdio) between the
extension and the CapturePack native host, then local IPC to the application.
No cloud, no server.

## Envelope

Every message is a single JSON object:

| Field | Type | Meaning |
| --- | --- | --- |
| `type` | string | Namespaced event name (`dom.*`, `tab.*`, `host.*`) |
| `timestamp` | number | Milliseconds, sender-relative (capture session time when known) |
| `protocol` | number | Protocol version, `1` |

## Messages (Phase 1)

### `dom.element.selected`

Sent when the user picks an element with the extension's picker.

```json
{
  "type": "dom.element.selected",
  "protocol": 1,
  "timestamp": 18420,
  "tab": { "url": "https://app.example.com/checkout", "title": "Checkout" },
  "element": {
    "tag": "button",
    "id": "save",
    "role": "button",
    "text": "Save",
    "selector": "#save",
    "bounds": { "x": 100, "y": 200, "width": 120, "height": 40 },
    "frameDepth": 0
  },
  "viewport": {
    "width": 1280,
    "height": 720,
    "dpr": 1.5,
    "screenX": 0,
    "screenY": 0,
    "outerWidth": 1280,
    "outerHeight": 800
  }
}
```

- `text` is trimmed and truncated to 200 characters.
- `selector` is the shortest stable CSS selector the generator can produce
  (id → unique attribute path → positional path).
- `bounds` are CSS pixels in the **top frame's** viewport. An element inside an
  iframe is measured in its own frame and translated up the frame chain by
  frames that measure each other; `frameDepth` records how far down it was
  found (0 = top document). Extension 0.1.9 and newer.
- `viewport` is what makes `bounds` placeable at all, and it is required from
  extension 0.1.4 onward. A page cannot know where its browser window is, so it
  reports the size of its own coordinate space and the app derives the rest
  from the window's observed client rectangle. **Do not multiply `bounds` by
  `dpr`**: the snapshot scale is a measurement (`clientWidth / viewport.width`),
  and `dpr` is the cross-check that proves the two describe the same window.
  The app still records a pick that arrives without a `viewport`; it simply
  cannot turn it into a candidate.

### `tab.updated`

Sent on tab activation and title change: `{ "tab": { "url", "title" } }`.

### `url.changed`

Sent on navigation (including SPA history changes in Phase 2): `{ "tab": { "url", "title" } }`.

### `picker.armed` / `picker.disarmed` / `picker.failed`

The element picker's own lifecycle, sent from extension 0.1.5 onward. These are
diagnostics, not pack content: nothing about them is written into a CapturePack.
They exist because every other step of picking already reports itself, and a
pick that never happens is otherwise indistinguishable from a pick that was
refused three processes away.

- `picker.armed` — the content script is injected and waiting for a click.
  Carries the `tab` it armed on.
- `picker.disarmed` — the picker tore itself down (a pick, Escape, or a
  re-arm).
- `picker.failed` — arming did not happen. `reason` is required and carries the
  browser's own message: a restricted page (`chrome://`, the Web Store, a PDF
  viewer), a missing tab, or an injection error.

The application logs all three, counts them, and shows the last one in
Settings › Plugins › Chrome DOM.

### `host.hello`

First message in both directions; carries `{ "app": "capturepack", "version": "0.1.0" }`
so each side can verify versions.

## Rules

- The DOM is never streamed continuously. Messages are sent only at the moment
  information is needed.
- Unknown message types MUST be ignored (forward compatibility).
- A message that is refused MUST be reported by the receiver — silently
  dropping one is what made [#104](https://github.com/r2cuerdame/capturepack/issues/104)
  undiagnosable for two release cycles.
- Breaking changes bump the protocol number.

The JSON Schema for all Phase 1 messages lives in
[`protocol-v1.schema.json`](protocol-v1.schema.json).
