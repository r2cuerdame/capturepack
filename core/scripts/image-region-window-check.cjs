// Native-window regressions for selector coverage and hidden editor bootstrap.
//
// Pure geometry was already correct while Electron silently shrank both
// selector HWNDs to the primary work area. This check creates the same
// frameless windows on every real display and verifies the actual native DIP
// bounds while hidden and after activation. It also proves that the editor's
// explicitly unthrottled hidden window can cross its two-frame paint ACK.
// Windows remain transparent and no capture is saved.
const { app, BrowserWindow, screen } = require('electron')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')

let failed = 0
const windows = []
const selectorWindows = []

function check(ok, message, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${message}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

function sameBounds(actual, expected) {
  return actual.x === expected.x
    && actual.y === expected.y
    && actual.width === expected.width
    && actual.height === expected.height
}

app.whenReady().then(async () => {
  const production = readFileSync(
    resolve(__dirname, '..', 'src', 'main', 'imageRegionSelector.ts'),
    'utf8',
  )
  const sessionProduction = readFileSync(
    resolve(__dirname, '..', 'src', 'main', 'session.ts'),
    'utf8',
  )
  check(
    production.includes('resizable: true')
      && production.includes('thickFrame: false')
      && production.includes("win.on('will-resize', (event) => event.preventDefault())"),
    'production selector keeps resizable construction without native edge hit zones',
  )

  const displays = screen.getAllDisplays()
  check(displays.length > 0, 'Electron exposes at least one native display')

  for (const display of displays) {
    const win = new BrowserWindow({
      ...display.bounds,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      opacity: 0,
      resizable: true,
      thickFrame: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      webPreferences: {
        paintWhenInitiallyHidden: false,
      },
    })
    windows.push(win)
    selectorWindows.push({ win, display })
    win.on('will-resize', (event) => event.preventDefault())
    win.setBounds(display.bounds)
    const hidden = win.getBounds()
    check(
      sameBounds(hidden, display.bounds),
      `hidden selector window covers display ${display.id}, including taskbar and portrait tail`,
      `expected ${JSON.stringify(display.bounds)}, got ${JSON.stringify(hidden)}`,
    )
    win.showInactive()
    const visible = win.getBounds()
    check(
      sameBounds(visible, display.bounds),
      `shown selector window keeps display ${display.id} bounds after native activation`,
      `expected ${JSON.stringify(display.bounds)}, got ${JSON.stringify(visible)}`,
    )
  }

  for (const focused of selectorWindows) {
    focused.win.show()
    focused.win.focus()
    await new Promise((resolveTurn) => setImmediate(resolveTurn))
    for (const candidate of selectorWindows) {
      const activated = candidate.win.getBounds()
      check(
        sameBounds(activated, candidate.display.bounds),
        `focused selector activation keeps display ${candidate.display.id} bounds`,
        `focused ${focused.display.id}; expected ${JSON.stringify(candidate.display.bounds)}, got ${JSON.stringify(activated)}`,
      )
    }
  }

  check(
    sessionProduction.includes('backgroundThrottling: false')
      && sessionProduction.includes('editor.webContents.setBackgroundThrottling(true)'),
    'production editor unthrottles only its hidden paint handshake',
  )
  const paintProbe = new BrowserWindow({
    show: false,
    webPreferences: {
      backgroundThrottling: false,
    },
  })
  windows.push(paintProbe)
  await paintProbe.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent('<title>CapturePack paint probe</title>')}`,
  )
  const painted = await Promise.race([
    paintProbe.webContents.executeJavaScript(
      'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))',
    ),
    new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
  ])
  check(
    painted === true,
    'a hidden editor can cross the two-frame paint boundary before its native window is revealed',
  )
  paintProbe.webContents.setBackgroundThrottling(true)
}).catch((error) => {
  failed += 1
  console.error(error)
}).finally(() => {
  for (const win of windows) {
    if (!win.isDestroyed()) win.destroy()
  }
  console.log(
    failed === 0
      ? '\nimage-region-window-check ok'
      : `\nimage-region-window-check FAILED (${failed})`,
  )
  app.exit(failed === 0 ? 0 : 1)
})
