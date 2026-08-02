// The native messaging host as PLAIN NODE (bug: "재설치할때마다 연결이 안돼",
// second act).
//
// THE ELECTRON BINARY CANNOT BE A NATIVE MESSAGING HOST. Measured, not
// suspected: `electron.exe` writes `\r\n` — two bytes — to stdout ~30 ms after
// launch, BEFORE the main script runs, with no app loaded at all. Chrome reads
// a host's stdout as length-prefixed frames from byte zero, so those two bytes
// become the first half of a length word, the length comes out garbage, and
// Chrome kills the port. The extension redials on its 2 s backoff, a fresh
// host writes a fresh `\r\n`, and the log fills with connects every ~2.3 s —
// seventeen of them in the report that led here. Nothing in JS can prevent
// bytes written before JS runs.
//
// `ELECTRON_RUN_AS_NODE=1` boots the same binary as plain Node — no Chromium,
// no console attach, and a measured ZERO bytes of unsolicited stdout. So the
// registered host is a one-line launcher that sets that variable and runs this
// file: the app's own binary re-entered as Node, no second runtime, no second
// version.
//
// This file must therefore never import from 'electron', and lands in
// dist/scripts/ (asarUnpack) because plain Node cannot read an asar.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { runNativeHostMode } from './nativeHost'

const appData = process.env['APPDATA']
const installerStandingDown =
  appData !== undefined &&
  fs.existsSync(path.join(appData, 'CapturePack', 'supervision-standdown'))

if (installerStandingDown) {
  // Chrome may have cached the registration just before setup removed it.
  // Never reconnect or keep CapturePack.exe alive while its files are replaced.
  //
  // THE FLAG IS NOT THE WATCHDOG, DESPITE ITS NAME (#80). It is written by
  // build/installer.nsh and cleared by the next live main process
  // (index.ts clearInstallerStandDown) — the installer telling the browser to
  // let go, and the app saying setup is over. The process supervisor is gone;
  // this handshake is untouched, name included, so an in-flight upgrade from
  // 0.3.4 still stands that build's watchdog down too.
  process.exit(0)
} else {
  void runNativeHostMode().then(
    () => process.exit(0),
    () => process.exit(0),
  )
}
