# CapturePack Native Messaging Host

The bridge between the Chrome extension and the CapturePack application:

```
Chrome Extension  →(Native Messaging, stdio JSON)→  Native Host  →(IPC)→  CapturePack app
```

The extension talks only to CapturePack. No cloud servers.

## How it gets installed

The app's **Settings → Plugins → Chrome DOM** flow:

1. Copies the bundled extension into CapturePack's stable per-user data folder.
2. Generates a silent `capturepack-host.cmd` launcher for the packaged
   `dist/scripts/native-host.js` plain-Node bundle.
3. Writes a manifest using the extension ID Chrome assigned to that stable folder.
4. Registers the manifest for the current user under each supported Chromium browser.
5. Removes the registry keys and host manifest when the user disconnects the integration.

Chrome itself owns the unpacked-extension profile record; removing that record
remains an explicit browser action.

## Developer mode (before the Web Store listing)

1. Open `chrome://extensions`, enable Developer Mode.
2. "Load unpacked" → select `extensions/chrome/`.
3. Open CapturePack Settings. It discovers the loaded path and ID; choose **Connect**.

The checked-in [`com.capturepack.host.json`](com.capturepack.host.json) is a shape-only
template. The app writes the real launcher path and `allowed_origins`; do not register
the placeholder file. Protocol v1 is defined in
[`shared/protocol/`](../../../shared/protocol/README.md).
