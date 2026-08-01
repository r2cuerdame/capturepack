// The cross-frame arithmetic of element picking, without a browser (#104).
//
// WHY THIS EXISTS. A pick made inside an iframe is measured in that frame's
// viewport and has to be carried up to the top document before it means
// anything to the app — and every hop of that is arithmetic that no test can
// reach through a real page. `extensions/chrome/frame-geometry.js` keeps the
// arithmetic as one pure function precisely so it can be handed numbers here.
//
// The rule it has to hold to is the same one the whole product runs on: every
// term is a MEASUREMENT, and two measurements that cannot describe the same box
// produce a refusal rather than a plausible rectangle.
//
//   node scripts/frame-geometry-check.mjs

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

let passed = 0
let failed = 0
function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const HERE = dirname(fileURLToPath(import.meta.url))
const EXTENSION = resolve(HERE, '..', '..', 'extensions', 'chrome')

// The extension file is loaded exactly as a browser loads it — as a script into
// a global — so this checks the shipped bytes, not a copy that can drift.
const sandbox = { window: {} }
runInNewContext(readFileSync(resolve(EXTENSION, 'frame-geometry.js'), 'utf8'), sandbox)
const geometry = sandbox.window.__capturepackFrameGeometry

check('the extension file defines the frame geometry', typeof geometry?.translateFrameRect === 'function')
if (typeof geometry?.translateFrameRect !== 'function') {
  console.log('\nresult: BROKEN — the geometry never loaded\n')
  process.exit(1)
}

const { translateFrameRect } = geometry

function near(actual, expected, tolerance = 1e-9) {
  return typeof actual === 'number' && Math.abs(actual - expected) <= tolerance
}

console.log('\nA frame that is exactly as big as it says it is')
{
  // 800 CSS px wide iframe at (100, 50), no border, no padding, child viewport
  // 800 px: the child's coordinates are the parent's, shifted.
  const out = translateFrameRect({
    hostRect: { x: 100, y: 50, width: 800, height: 600 },
    hostInsets: { left: 0, top: 0, right: 0, bottom: 0 },
    childViewportWidth: 800,
    bounds: { x: 10, y: 20, width: 120, height: 40 },
  })
  check('the scale is 1', near(out?.scale, 1), JSON.stringify(out))
  check('x shifts by the frame position', near(out?.x, 110), JSON.stringify(out))
  check('y shifts by the frame position', near(out?.y, 70), JSON.stringify(out))
  check('the size is unchanged', near(out?.width, 120) && near(out?.height, 40), JSON.stringify(out))
}

console.log('\nBorders and padding move the content box, and are measured')
{
  const out = translateFrameRect({
    hostRect: { x: 100, y: 50, width: 820, height: 620 },
    hostInsets: { left: 6, top: 4, right: 6, bottom: 4 },
    childViewportWidth: 808,
    bounds: { x: 0, y: 0, width: 10, height: 10 },
  })
  // content width 820 - 12 = 808, so the scale is 1 and the origin is inset.
  check('the scale ignores the inset it removed', near(out?.scale, 1), JSON.stringify(out))
  check('the origin starts inside the border and padding',
    near(out?.x, 106) && near(out?.y, 54), JSON.stringify(out))
}

console.log('\nA scaled frame scales the rectangle it contains')
{
  // A 400 px wide iframe rendering a child that believes it is 800 px wide:
  // every child coordinate is worth half a parent pixel.
  const out = translateFrameRect({
    hostRect: { x: 0, y: 0, width: 400, height: 300 },
    hostInsets: { left: 0, top: 0, right: 0, bottom: 0 },
    childViewportWidth: 800,
    bounds: { x: 100, y: 200, width: 40, height: 20 },
  })
  check('the scale is the ratio of the two measurements', near(out?.scale, 0.5), JSON.stringify(out))
  check('the position scales', near(out?.x, 50) && near(out?.y, 100), JSON.stringify(out))
  check('the size scales', near(out?.width, 20) && near(out?.height, 10), JSON.stringify(out))
}

console.log('\nTwo hops compose, because each one is the same measurement')
{
  const inner = translateFrameRect({
    hostRect: { x: 20, y: 10, width: 400, height: 300 },
    hostInsets: { left: 0, top: 0, right: 0, bottom: 0 },
    childViewportWidth: 800,
    bounds: { x: 100, y: 100, width: 40, height: 40 },
  })
  const outer = translateFrameRect({
    hostRect: { x: 5, y: 5, width: 500, height: 400 },
    hostInsets: { left: 0, top: 0, right: 0, bottom: 0 },
    childViewportWidth: 1000,
    bounds: { x: inner.x, y: inner.y, width: inner.width, height: inner.height },
  })
  // inner: 0.5 scale -> (70, 60, 20, 20). outer: 0.5 scale -> (40, 35, 10, 10).
  check('the composed position is the product of both hops',
    near(outer?.x, 40) && near(outer?.y, 35), JSON.stringify({ inner, outer }))
  check('the composed size is the product of both hops',
    near(outer?.width, 10) && near(outer?.height, 10), JSON.stringify({ inner, outer }))
}

console.log('\nA disagreement is refused, never rounded into something plausible')
{
  const cases = [
    ['a frame with no width', { hostRect: { x: 0, y: 0, width: 0, height: 300 }, hostInsets: { left: 0, top: 0, right: 0, bottom: 0 }, childViewportWidth: 800, bounds: { x: 1, y: 1, width: 1, height: 1 } }],
    ['insets wider than the frame', { hostRect: { x: 0, y: 0, width: 10, height: 300 }, hostInsets: { left: 8, top: 0, right: 8, bottom: 0 }, childViewportWidth: 800, bounds: { x: 1, y: 1, width: 1, height: 1 } }],
    ['a child that reports no viewport', { hostRect: { x: 0, y: 0, width: 400, height: 300 }, hostInsets: { left: 0, top: 0, right: 0, bottom: 0 }, childViewportWidth: 0, bounds: { x: 1, y: 1, width: 1, height: 1 } }],
    ['a scale below the physical floor', { hostRect: { x: 0, y: 0, width: 10, height: 300 }, hostInsets: { left: 0, top: 0, right: 0, bottom: 0 }, childViewportWidth: 100000, bounds: { x: 1, y: 1, width: 1, height: 1 } }],
    ['a scale above the physical ceiling', { hostRect: { x: 0, y: 0, width: 10000, height: 300 }, hostInsets: { left: 0, top: 0, right: 0, bottom: 0 }, childViewportWidth: 100, bounds: { x: 1, y: 1, width: 1, height: 1 } }],
    ['a collapsed element', { hostRect: { x: 0, y: 0, width: 400, height: 300 }, hostInsets: { left: 0, top: 0, right: 0, bottom: 0 }, childViewportWidth: 400, bounds: { x: 1, y: 1, width: 0, height: 10 } }],
    ['a non-finite coordinate', { hostRect: { x: Number.NaN, y: 0, width: 400, height: 300 }, hostInsets: { left: 0, top: 0, right: 0, bottom: 0 }, childViewportWidth: 400, bounds: { x: 1, y: 1, width: 1, height: 1 } }],
  ]
  for (const [name, input] of cases) {
    check(name, translateFrameRect(input) === null, JSON.stringify(translateFrameRect(input)))
  }
  check('nothing at all is refused', translateFrameRect(null) === null)
  check('an empty request is refused', translateFrameRect({}) === null)
}

console.log('\nThe picker actually uses it, in every frame')
{
  const contentScript = readFileSync(resolve(EXTENSION, 'content-script.js'), 'utf8')
  const background = readFileSync(resolve(EXTENSION, 'background.js'), 'utf8')
  const manifest = JSON.parse(readFileSync(resolve(EXTENSION, 'manifest.json'), 'utf8'))
  check('the picker is injected into every frame', background.includes('allFrames: true'), background.slice(0, 0))
  // Order is load order in one isolated world: the geometry and the document
  // walker must both be defined before the picker looks for them. The walker
  // joined this list when a pick started carrying the interface it sat in.
  check('the geometry is injected before the picker',
    /files:\s*\[\s*'frame-geometry\.js',\s*'document-snapshot\.js',\s*'content-script\.js'\s*\]/.test(background))
  check('the picker calls the shared geometry',
    contentScript.includes('__capturepackFrameGeometry'))
  check('a pick travels up the frame chain',
    contentScript.includes("__capturepack: 'pick'") && contentScript.includes('window.parent.postMessage'))
  check('a pick is only accepted from a frame this document hosts',
    contentScript.includes('frame.contentWindow === e.source'))
  check('a pick is only accepted while the picker is armed',
    /if \(!window\.__capturepackPickerActive\) return/.test(contentScript))
  check('a failed hop reports itself', contentScript.includes("type: 'picker.failed'"))
  check('the background forwards a content-script failure',
    background.includes("msg.type === 'picker.failed'"))
  // The app asks Chromium to reload an unpacked extension when this number
  // moves, so a wire change that leaves it alone ships a worker that cannot
  // speak the new payload. 0.2.0 was a pick carrying the document it sat in;
  // 0.3.0 adds a second way to arm the picker.
  check('the manifest version moved with the protocol change',
    manifest.version === '0.3.3', manifest.version)
  check('and the document walker ships with it',
    existsSync(resolve(EXTENSION, 'document-snapshot.js')))

  // A KEYBOARD SHORTCUT IS A GESTURE TOO.
  //
  // The toolbar trip was never the point — `activeTab` is, and Chrome grants it
  // for a command shortcut exactly as it does for an action click. What must NOT
  // happen is someone "fixing" the ergonomics by asking for host permissions
  // instead, which would trade two clicks for the ability to read every page the
  // user ever opens. So this pins both: the second entry point exists, and the
  // permission story is unchanged.
  check('a keyboard shortcut can arm the picker',
    manifest.commands !== undefined && manifest.commands['pick-element'] !== undefined,
    JSON.stringify(manifest.commands))
  check('the shortcut suggests a default binding',
    manifest.commands?.['pick-element']?.suggested_key?.default !== undefined)
  check('both entry points call one arming path',
    /function armPicker\(/.test(background) &&
      /chrome\.action\.onClicked\.addListener/.test(background) &&
      /armPicker\(tab, 'toolbar'\)/.test(background) &&
      /commands\.onCommand\.addListener/.test(background))

  // THE ONE-TIME GRANT (#125). CapturePack's capture hotkey is global, so Chrome
  // never sees it and `activeTab` can never apply to it. The user grants the
  // browser ONCE and then presses nothing in Chrome ever again.
  //
  // What must stay true: the grant is OPTIONAL, so installing the extension
  // still shows no warning and nothing is held until the user asks for it.
  check('the browser grant is optional, not demanded at install',
    Array.isArray(manifest.optional_host_permissions) &&
      manifest.optional_host_permissions.includes('<all_urls>') &&
      !('host_permissions' in manifest),
    JSON.stringify({
      optional: manifest.optional_host_permissions,
      demanded: manifest.host_permissions,
    }))
  // THE BUG rc.26 SHIPPED, and the reason this assertion is about AWAIT.
  //
  // `permissions.request` is only allowed inside a LIVE user-gesture context,
  // and an `await` ends it — the continuation runs with no gesture left and
  // Chrome refuses to show the prompt. rc.26 checked `hasBrowserGrant()` first,
  // so three toolbar clicks produced no dialog at all. Asking for a permission
  // already held resolves true and shows nothing, so the check was never needed.
  {
    const listener = background.slice(
      background.indexOf('chrome.action.onClicked.addListener'),
      background.indexOf('chrome.commands'),
    )
    const body = listener.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')
    check('the extension asks for the grant from a real user gesture',
      /permissions\.request\(/.test(body) && /action\.onClicked/.test(background),
      'permissions.request only works inside a gesture; the toolbar click is the one we get')
    check('and nothing is awaited before it, which would end that gesture',
      !/await[\s\S]*?permissions\.request\(/.test(body),
      'an await before the request is exactly how rc.26 produced no prompt at all')
    check('a broken request is reported, not mistaken for the user saying no',
      /grant-request-failed|grant-request-threw/.test(body),
      'rc.26 swallowed the rejection in a catch and looked like a refusal')
  }
  check('and it answers the app only when the grant is held',
    /async function answerDomRequest\(/.test(background) &&
      /if \(!\(await hasBrowserGrant\(\)\)\)/.test(background),
    'without this the extension would try, fail, and look like an empty page')
  check('a withdrawn grant is reported, so a pack can say why it carries no page',
    /permissions\.onRemoved/.test(background) && /browser\.grant/.test(background))
  // THE BUG rc.25 SHIPPED. The extension announced the grant from onAdded and
  // onRemoved only, so an app that started AFTER the user granted — or whose
  // worker MV3 had recycled — believed there was none and never asked for a
  // page. Nothing in the log, nothing in the pack.
  check('the grant is announced on CONNECT, not only when it changes',
    /host\.hello[\s\S]{0,300}hasBrowserGrant\(\)\.then\(announceGrant\)/.test(
      background.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n'),
    ),
    'a state reported only on change is invisible to a process that started later')
  check('activeTab is still the whole permission story — no host permissions',
    !('host_permissions' in manifest) &&
      !manifest.permissions.some((p) => p === '<all_urls>' || p.includes('://')),
    JSON.stringify(manifest.permissions))
  check('and no content script runs without a gesture',
    manifest.content_scripts === undefined,
    'a declared content script would read every matching page unasked')
}

console.log(`\nresult: ${failed === 0 ? 'OK' : 'BROKEN'} — ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
