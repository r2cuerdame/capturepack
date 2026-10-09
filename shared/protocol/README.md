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

The element picker's own lifecycle, sent from extension 0.1.5 onward. From
0.4.0 the picker is armed by the keyboard shortcut or the icon's context menu;
the toolbar click itself captures the whole page (see `page.captured`). These are
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

### `page.captured` / `page.chunk` / `page.received` / `page.capture.failed`

The toolbar click, from extension 0.4.0 ([#157](https://github.com/r2cuerdame/capturepack/issues/157)):
the extension photographs the WHOLE current page — one viewport at a time,
stitched at the positions the page actually scrolled to, fixed and stuck-sticky
elements shown once, the page's scroll and styles restored afterwards — walks
the document in the same coordinates, and hands the bundle to the app, which
opens it in the same still editor a `Ctrl+Alt+S` capture opens.

The picture is too large for one native messaging frame, so a capture is
three kinds of message correlated by `capture_id`:

```json
{
  "type": "page.captured", "protocol": 1, "timestamp": 1758400000000,
  "capture_id": "p1758400000000-1", "via": "toolbar",
  "tab": { "url": "https://app.example.com/docs", "title": "Docs" },
  "page": {
    "url": "https://app.example.com/docs", "title": "Docs",
    "cssWidth": 1262, "cssHeight": 6500, "pixelWidth": 1893, "pixelHeight": 9750,
    "devicePixelRatio": 1.5, "scale": 1.5,
    "clientWidth": 1263, "clientHeight": 800, "scrollWidth": 1263, "scrollHeight": 6500,
    "tiles": [{ "index": 0, "scrollY": 0, "y": 0, "height": 1200 }],
    "truncated": false, "downscaled": false, "exactScale": true,
    "hiddenRepeating": 2, "captureMs": 6100
  },
  "document": { "scope": "document", "viewport": { "width": 1262, "height": 6500, "devicePixelRatio": 1.5, "scrollX": 0, "scrollY": 0 }, "elements": [] },
  "png": { "bytes": 2481930, "chunks": 7, "chunkChars": 524288 }
}
```

- `page.captured` announces the capture: the page's geometry, the document walk
  in **document scope** (every rectangle in document CSS pixels, `viewport` the
  picture's CSS size), and how many bytes follow in how many chunks.
- `page.chunk` carries `index` and `data`: base64 of the PNG, cut at multiples of
  four characters so the app concatenates the pieces and decodes once. Chunks may
  arrive in any order.
- `page.received` is the app's answer on the same wire, `{ "capture_id", "ok",
  "reason"? }`, sent when the editor is open (or when the bundle was refused:
  a byte count that does not add up, a PNG whose IHDR disagrees with `page`, a
  picture over the size bound, a chunk repeated or out of range). The extension's
  icon shows the outcome and the reason.
- `page.capture.failed` is a diagnostic like `picker.failed`: the extension could
  not capture (`stage`: `inject` for a restricted page, `capture`, `timeout`,
  `restore` when the page could not be put back exactly) and says why.

`page.cssWidth` is chosen so that `cssWidth * scale` is an integer (a few columns
of the scrollbar gutter are given up for it), and `scale` is the device pixel
ratio unless the page had to be kept whole at a smaller scale — so the app's one
placement rule, scale = picture width / viewport width, is exact for a page.

Nothing here runs in the background: a capture starts on the click and nowhere
else, and the bundle goes to the local app and nowhere else.

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
