# CapturePack Native Messaging Host

The bridge between the Chrome extension and the CapturePack application:

```
Chrome Extension  →(Native Messaging, stdio JSON)→  Native Host  →(IPC)→  CapturePack app
```

The extension talks only to CapturePack. No cloud servers.

## How it gets installed

Users never set this up by hand. The CapturePack installer automatically:

1. Installs the native host executable alongside the app.
2. Generates the manifest from [`com.capturepack.host.json`](com.capturepack.host.json)
   (filling in the real executable path and extension ID).
3. Registers it under
   `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.capturepack.host`.
4. Cleans up the registry key and manifest on uninstall.

Status, health checks, and reinstall live in the app: **Settings → Plugins → Chrome DOM**.

## Developer mode (before the Web Store listing)

1. Open `chrome://extensions`, enable Developer Mode.
2. "Load unpacked" → select `extensions/chrome/`.
3. Note the generated extension ID and put it into `allowed_origins` in the manifest,
   then register the manifest path in the registry key above (the app's Plugin Manager
   automates this once implemented — see the app-side host integration task).

The host executable ships with the app (not yet implemented — protocol v1 is defined in
[`shared/protocol/`](../../../shared/protocol/README.md)).
