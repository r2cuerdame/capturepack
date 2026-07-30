// Deterministic, continuously moving Windows desktop fixture.
//
// Run with Electron, never plain Node. One animated, mouse-transparent window
// fills every physical display. A small uniquely titled window moves through
// every display on a deterministic cycle while its expected physical and
// per-display snapshot coordinates are written beside the field report.
const { app, BrowserWindow, screen } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { movementDisplayOrder } = require('./windows-replay-field-order.cjs')

function argument(name, fallback = null) {
  const prefix = `--${name}=`
  const found = process.argv.find((value) => value.startsWith(prefix))
  return found === undefined ? fallback : found.slice(prefix.length)
}

const layoutPath = argument('layout')
const movementPath = argument('movement')
const stopFile = argument('stop-file')
const runId = argument('run-id', `field-${process.pid}`)
const requestedStartDisplayId = argument('start-display-id')
const requestedCycleMs = Number(argument('cycle-ms', '9000'))
const cycleMs =
  Number.isFinite(requestedCycleMs) && requestedCycleMs >= 3000
    ? requestedCycleMs
    : 9000
const targetTitle = `CapturePack QA Moving Target ${runId}`

if (layoutPath === null || movementPath === null || stopFile === null) {
  console.error('layout, movement, and stop-file arguments are required')
  process.exit(2)
}

app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

let movementStream = null
let stopping = false

function physicalRect(bounds) {
  try {
    return screen.dipToScreenRect(null, bounds)
  } catch {
    return null
  }
}

function intersect(left, right) {
  const x = Math.max(left.x, right.x)
  const y = Math.max(left.y, right.y)
  const rightEdge = Math.min(left.x + left.width, right.x + right.width)
  const bottom = Math.min(left.y + left.height, right.y + right.height)
  if (rightEdge <= x || bottom <= y) return null
  return {
    x,
    y,
    width: rightEdge - x,
    height: bottom - y,
  }
}

function backgroundHtml(index, displayId) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>CapturePack QA Surface ${index}</title>
<style>
html,body,canvas{margin:0;width:100%;height:100%;overflow:hidden;background:#0b1020}
canvas{display:block}
</style></head><body><canvas></canvas><script>
const canvas=document.querySelector('canvas');
const context=canvas.getContext('2d',{alpha:false});
let width=0,height=0;
function size(){
  const scale=devicePixelRatio||1;
  width=Math.max(1,Math.round(innerWidth*scale));
  height=Math.max(1,Math.round(innerHeight*scale));
  if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height}
}
function paint(now){
  size();
  const phase=now/1000;
  const gradient=context.createLinearGradient(0,0,width,height);
  gradient.addColorStop(0,'hsl('+((phase*43+${index * 47})%360)+' 72% 22%)');
  gradient.addColorStop(1,'hsl('+((phase*71+160+${index * 23})%360)+' 70% 10%)');
  context.fillStyle=gradient;context.fillRect(0,0,width,height);
  const cell=Math.max(32,Math.round(Math.min(width,height)/12));
  for(let y=-cell;y<height+cell;y+=cell){
    for(let x=-cell;x<width+cell;x+=cell){
      const dx=(x+phase*170+${index * 31})%(cell*2);
      const dy=(y+phase*110+${index * 19})%(cell*2);
      context.fillStyle=((x/cell+y/cell)&1)?'#ffffff22':'#00d4ff28';
      context.fillRect(dx-cell,dy-cell,cell*.72,cell*.72);
    }
  }
  const px=(Math.sin(phase*2.7+${index})*.42+.5)*width;
  const py=(Math.cos(phase*2.1+${index})*.38+.5)*height;
  context.fillStyle='#ffcc33';context.beginPath();context.arc(px,py,Math.max(18,cell*.35),0,Math.PI*2);context.fill();
  context.font=Math.max(20,Math.round(cell*.42))+'px system-ui';
  context.fillStyle='#fff';context.fillText('CapturePack field display ${index} · id ${displayId}',32,52);
  context.fillText('continuous motion '+phase.toFixed(3)+' s',32,96);
  requestAnimationFrame(paint);
}
requestAnimationFrame(paint);
</script></body></html>`
}

function targetHtml() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${targetTitle}</title>
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#ff2d73;color:white;font-family:system-ui}
body{box-sizing:border-box;display:grid;place-items:center}
.box{text-align:center;font-weight:800;font-size:22px;text-shadow:0 2px 4px #0008}
.pulse{width:42px;height:42px;margin:12px auto;border-radius:50%;background:#ffe66d;animation:p .42s linear infinite alternate}
@keyframes p{to{transform:scale(.45) rotate(90deg);border-radius:8px;background:#30f2a2}}
</style></head><body><div class="box">Known moving window<div class="pulse"></div>${runId}</div></body></html>`
}

async function stopGracefully(windows) {
  if (stopping) return
  stopping = true
  for (const window of windows) {
    if (!window.isDestroyed()) window.destroy()
  }
  if (movementStream !== null) {
    await new Promise((resolve) => movementStream.end(resolve))
  }
  app.quit()
}

app.whenReady().then(async () => {
  const displays = screen.getAllDisplays()
  if (displays.length === 0) throw new Error('Electron reported no displays')
  const primary = screen.getPrimaryDisplay()
  const cursor = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const movementOrder = movementDisplayOrder(
    displays,
    String(primary.id),
    requestedStartDisplayId,
  )
  const layout = {
    schema: 'capturepack.windows-replay-field-layout',
    version: 1,
    run_id: runId,
    target_title: targetTitle,
    observed_at: new Date().toISOString(),
    primary_display_id: String(primary.id),
    cursor_display_id: String(cursor.id),
    movement_start_display_id: movementOrder.startDisplayId,
    movement_display_order_ids: movementOrder.displays.map((display) => String(display.id)),
    displays: displays.map((display, zeroBased) => ({
      index: zeroBased + 1,
      id: String(display.id),
      label: display.label,
      bounds_dip: { ...display.bounds },
      work_area_dip: { ...display.workArea },
      physical_bounds: physicalRect(display.bounds),
      scale_factor: display.scaleFactor,
      rotation: display.rotation,
      internal: display.internal,
    })),
  }
  fs.mkdirSync(path.dirname(layoutPath), { recursive: true })
  fs.writeFileSync(layoutPath, `${JSON.stringify(layout, null, 2)}\n`, 'utf8')
  movementStream = fs.createWriteStream(movementPath, { flags: 'a', encoding: 'utf8' })

  const windows = []
  for (const [zeroBased, display] of displays.entries()) {
    const window = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      hasShadow: false,
      focusable: false,
      fullscreenable: false,
      movable: false,
      resizable: false,
      skipTaskbar: true,
      show: false,
      backgroundColor: '#0b1020',
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        sandbox: true,
      },
    })
    window.setIgnoreMouseEvents(true)
    await window.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(
        backgroundHtml(zeroBased + 1, display.id),
      )}`,
    )
    window.showInactive()
    windows.push(window)
  }

  const minimumWidth = Math.min(...displays.map((display) => display.bounds.width))
  const minimumHeight = Math.min(...displays.map((display) => display.bounds.height))
  const targetWidth = Math.max(220, Math.min(420, minimumWidth - 80))
  const targetHeight = Math.max(140, Math.min(240, minimumHeight - 80))
  const target = new BrowserWindow({
    width: targetWidth,
    height: targetHeight,
    title: targetTitle,
    frame: false,
    hasShadow: false,
    focusable: false,
    fullscreenable: false,
    resizable: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    backgroundColor: '#ff2d73',
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  target.setIgnoreMouseEvents(true)
  await target.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(targetHtml())}`)
  target.showInactive()
  windows.push(target)

  const beganAtMonotonicMs = performance.now()
  const perDisplayMs = Math.max(1000, cycleMs / displays.length)
  const movementTimer = setInterval(() => {
    const elapsedMs = performance.now() - beganAtMonotonicMs
    const displaySlot = Math.floor(elapsedMs / perDisplayMs) % displays.length
    const display = movementOrder.displays[displaySlot]
    if (display === undefined || target.isDestroyed()) return
    const localPhase = (elapsedMs % perDisplayMs) / perDisplayMs
    const margin = Math.min(40, Math.max(8, Math.floor(display.bounds.width / 20)))
    const horizontal = Math.max(0, display.bounds.width - targetWidth - margin * 2)
    const vertical = Math.max(0, display.bounds.height - targetHeight - margin * 2)
    // Spend the last quarter physically crossing to the next display instead
    // of teleporting at the slot boundary. On adjacent monitors this produces
    // real split-window samples on both displays; with a configured desktop
    // gap it honestly passes through the gap and reappears on the next screen.
    const crossingStartsAt = 0.72
    const nextDisplay =
      movementOrder.displays[(displaySlot + 1) % displays.length] ?? display
    const nextMargin = Math.min(
      40,
      Math.max(8, Math.floor(nextDisplay.bounds.width / 20)),
    )
    const withinPhase = Math.min(1, localPhase / crossingStartsAt)
    const crossPhase = Math.max(
      0,
      Math.min(1, (localPhase - crossingStartsAt) / (1 - crossingStartsAt)),
    )
    const currentEnd = {
      x: display.bounds.x + margin + horizontal,
      y: display.bounds.y + margin + vertical * 0.5,
    }
    const nextStart = {
      x: nextDisplay.bounds.x + nextMargin,
      y: nextDisplay.bounds.y
        + nextMargin
        + Math.max(
          0,
          nextDisplay.bounds.height - targetHeight - nextMargin * 2,
        ) * 0.5,
    }
    const inside = {
      x: display.bounds.x + margin + horizontal * withinPhase,
      y: display.bounds.y
        + margin
        + vertical * (0.5 + 0.42 * Math.sin(withinPhase * Math.PI * 2)),
    }
    const bounds = {
      x: Math.round(
        localPhase < crossingStartsAt
          ? inside.x
          : currentEnd.x + (nextStart.x - currentEnd.x) * crossPhase,
      ),
      y: Math.round(
        localPhase < crossingStartsAt
          ? inside.y
          : currentEnd.y + (nextStart.y - currentEnd.y) * crossPhase,
      ),
      width: targetWidth,
      height: targetHeight,
    }
    target.setBounds(bounds, false)
    const targetPhysical = physicalRect(bounds)
    const expected = targetPhysical === null
      ? []
      : layout.displays.flatMap((item) => {
          if (item.physical_bounds === null) return []
          const clipped = intersect(targetPhysical, item.physical_bounds)
          if (clipped === null) return []
          const snapshotWidth = Math.round(item.bounds_dip.width * item.scale_factor)
          const snapshotHeight = Math.round(item.bounds_dip.height * item.scale_factor)
          const sx = snapshotWidth / item.physical_bounds.width
          const sy = snapshotHeight / item.physical_bounds.height
          return [{
            display_id: item.id,
            display_index: item.index,
            bounds_snapshot: {
              x: Math.max(0, Math.round((clipped.x - item.physical_bounds.x) * sx)),
              y: Math.max(0, Math.round((clipped.y - item.physical_bounds.y) * sy)),
              width: Math.max(0, Math.round(clipped.width * sx)),
              height: Math.max(0, Math.round(clipped.height * sy)),
            },
          }]
        })
    movementStream.write(`${JSON.stringify({
      wall_time_ms: Date.now(),
      elapsed_ms: Math.round(elapsedMs),
      active_display_id: String(display.id),
      bounds_dip: bounds,
      bounds_physical: targetPhysical,
      expected,
    })}\n`)
  }, 16)

  const stopTimer = setInterval(() => {
    if (!fs.existsSync(stopFile)) return
    clearInterval(stopTimer)
    clearInterval(movementTimer)
    void stopGracefully(windows)
  }, 250)
}).catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
  app.quit()
})
