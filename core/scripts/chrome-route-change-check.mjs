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

console.log('Chrome SPA route change regression: 3 scenarios passed')
