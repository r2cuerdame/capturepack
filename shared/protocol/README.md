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
    "bounds": { "x": 100, "y": 200, "width": 120, "height": 40 }
  }
}
```

- `text` is trimmed and truncated to 200 characters.
- `bounds` are CSS pixels in the viewport; multiply by `devicePixelRatio` for
  screen pixels.
- `selector` is the shortest stable CSS selector the generator can produce
  (id → unique attribute path → positional path).

### `tab.updated`

Sent on tab activation and title change: `{ "tab": { "url", "title" } }`.

### `url.changed`

Sent on navigation (including SPA history changes in Phase 2): `{ "tab": { "url", "title" } }`.

### `host.hello`

First message in both directions; carries `{ "app": "capturepack", "version": "0.1.0" }`
so each side can verify versions.

## Rules

- The DOM is never streamed continuously. Messages are sent only at the moment
  information is needed.
- Unknown message types MUST be ignored (forward compatibility).
- Breaking changes bump the protocol number.

The JSON Schema for all Phase 1 messages lives in
[`protocol-v1.schema.json`](protocol-v1.schema.json).
