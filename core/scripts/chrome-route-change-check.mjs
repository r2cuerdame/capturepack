import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const source = readFileSync(path.join(root, 'extensions/chrome/route-change.js'), 'utf8')
const context = { Date, URL, self: {} }
vm.runInNewContext(source, context, { filename: 'route-change.js' })
const forwarded = []
const activeTab = { id: 7, active: true, url: 'https://example.test/newest', title: 'Newest' }
const tabs = { get: async () => activeTab }
const send = (message) => forwarded.push(message)

await context.self.capturepackRouteChanged(
  { url: 'https://example.test/older', title: 'Old title' },
  { tab: { id: 7 } }, tabs, send, 1,
)
assert.equal(forwarded.length, 1, 'same-origin route hint is delivered when tab URL has advanced')
assert.equal(forwarded[0].tab.url, activeTab.url, 'the latest browser URL is delivered')
assert.equal(forwarded[0].tab.title, activeTab.title, 'the latest browser title is delivered')

activeTab.active = false
await context.self.capturepackRouteChanged({ url: activeTab.url }, { tab: { id: 7 } }, tabs, send, 1)
assert.equal(forwarded.length, 1, 'inactive-tab hints are discarded')

activeTab.active = true
await context.self.capturepackRouteChanged(
  { url: 'https://other.test/late' }, { tab: { id: 7 } }, tabs, send, 1,
)
assert.equal(forwarded.length, 1, 'cross-origin late hints are discarded')

for (const [msg, sender, description] of [
  [undefined, { tab: { id: 7 } }, 'missing message is discarded'],
  [{}, undefined, 'missing sender is discarded'],
  [{ url: activeTab.url }, {}, 'missing sender tab is discarded'],
  [{ url: activeTab.url }, { tab: {} }, 'missing sender tab id is discarded'],
]) {
  await assert.doesNotReject(
    context.self.capturepackRouteChanged(msg, sender, tabs, send, 1), description,
  )
  assert.equal(forwarded.length, 1, description)
}

await context.self.capturepackRouteChanged(
  { url: activeTab.url }, { tab: { id: 7 } }, { get: async () => { throw new Error('closed tab') } }, send, 1,
)
assert.equal(forwarded.length, 1, 'closed tabs are discarded')

for (const url of ['', 'not a URL']) {
  await context.self.capturepackRouteChanged(
    { url }, { tab: { id: 7 } }, { get: async () => ({ active: true, url, title: 'Unreadable' }) }, send, 1,
  )
  assert.equal(forwarded.length, 1, `unreadable current URL is discarded (${url || 'empty'})`)
}

const longUrl = `https://example.test/${'x'.repeat(3000)}`
const longTitle = 'T'.repeat(700)
await context.self.capturepackRouteChanged(
  { url: longUrl }, { tab: { id: 7 } },
  { get: async () => ({ active: true, url: longUrl, title: longTitle }) }, send, 1,
)
assert.equal(forwarded.length, 2, 'a valid long route hint is delivered')
assert.equal(forwarded[1].tab.url.length, 2048, 'forwarded URL is capped at 2,048 characters')
assert.equal(forwarded[1].tab.title.length, 512, 'forwarded title is capped at 512 characters')

// The app recopies the extension folder only when the manifest version moves
// (syncExtensionIfChanged), so a fix the version leaves alone never reaches an
// installed browser. 0.4.3 shipped the worker that dropped the raced hint.
const background = readFileSync(path.join(root, 'extensions/chrome/background.js'), 'utf8')
assert.equal(background.match(/importScripts\('route-change\.js'\)/gu)?.length, 1,
  'the worker loads the route resolver exactly once')
assert.match(background, /self\.capturepackRouteChanged\(msg, sender, chrome\.tabs, send, PROTOCOL\)/u,
  'the worker hands route hints to the resolver under test')
const manifest = JSON.parse(readFileSync(path.join(root, 'extensions/chrome/manifest.json'), 'utf8'))
const [major, minor, patch] = manifest.version.split('.').map(Number)
assert.ok(major > 0 || minor > 4 || (minor === 4 && patch > 3),
  `the manifest version moved past 0.4.3 so installed copies resync (found ${manifest.version})`)

console.log('Chrome SPA route change regression: invalid inputs, closed tabs, URL/title bounds, and existing delivery cases passed')
