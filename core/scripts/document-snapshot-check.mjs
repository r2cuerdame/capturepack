// WHAT THE DOCUMENT SNAPSHOT REFUSES TO RECORD (GOAL "The still carries the context").
//
// The licence for recording a page's visible text is that snapshot.png already
// contains those pixels: a person holding the pack can read the words off the
// image, so writing them down adds no exposure the pack did not already have.
//
// That argument is the whole permission, and it fails the instant anything is
// recorded that the picture does NOT contain. Every case below is that line,
// and none of them is a preference — a pack that quietly carries a half-typed
// password is more dangerous to forward than it looks, and README's warning
// about blur must not have to grow a second paragraph about text.
//
//   node scripts/document-snapshot-check.mjs

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

let passed = 0
let failed = 0

function check(name, condition, detail = '') {
  if (condition) passed += 1
  else failed += 1
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

// ---------------------------------------------------------------------------
// The smallest DOM the walker can be held to. Nodes declare their own geometry
// and style, so a case says exactly what it means without a browser.
// ---------------------------------------------------------------------------

function el(tag, options = {}) {
  const node = {
    tagName: tag.toUpperCase(),
    attrs: options.attrs ?? {},
    rect: options.rect ?? { left: 10, top: 10, width: 100, height: 20 },
    style: options.style ?? {},
    value: options.value,
    ownText: options.text ?? '',
    childNodes: [],
    children: [],
  }
  if (node.ownText !== '') {
    node.childNodes.push({ nodeType: 3, nodeValue: node.ownText })
  }
  for (const child of options.children ?? []) {
    node.children.push(child)
    node.childNodes.push(child)
  }
  node.getBoundingClientRect = () => ({
    ...node.rect,
    right: node.rect.left + node.rect.width,
    bottom: node.rect.top + node.rect.height,
  })
  node.hasAttribute = (n) => Object.prototype.hasOwnProperty.call(node.attrs, n)
  node.getAttribute = (n) => (node.hasAttribute(n) ? node.attrs[n] : null)
  return node
}

function snapshotOf(root) {
  const script = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extensions', 'chrome', 'document-snapshot.js'),
    'utf8',
  )
  const sandbox = {
    Node: { TEXT_NODE: 3 },
    document: { documentElement: root, title: 'Fixture' },
    location: { href: 'https://example.invalid/page' },
    Date,
    Math,
    String,
    Object,
    Array,
  }
  sandbox.window = sandbox
  sandbox.innerWidth = 1000
  sandbox.innerHeight = 800
  sandbox.devicePixelRatio = 1
  sandbox.scrollX = 0
  sandbox.scrollY = 0
  sandbox.getComputedStyle = (node) => ({
    visibility: node.style.visibility ?? 'visible',
    display: node.style.display ?? 'block',
    opacity: node.style.opacity ?? '1',
  })
  runInNewContext(script, sandbox)
  return sandbox.window.__capturepackDocumentSnapshot()
}

const find = (snap, tag) => snap.elements.filter((e) => e.tag === tag)

console.log('A value is never recorded, whatever the field')
{
  const snap = snapshotOf(
    el('html', {
      children: [
        el('input', { attrs: { type: 'text', name: 'card' }, value: '4111111111111111' }),
        el('textarea', { attrs: { name: 'note' }, value: 'a half-written message' }),
        el('input', { attrs: { type: 'search', name: 'q' }, value: '' }),
      ],
    }),
  )
  const serialized = JSON.stringify(snap)
  check(
    'a card number typed into a text field does not reach the pack',
    !serialized.includes('4111111111111111'),
  )
  check(
    'nor the contents of a textarea',
    !serialized.includes('half-written'),
  )
  // Whether the user had put SOMETHING there is visible in the picture, and is
  // sometimes the whole bug — so that much, and only that much, is recorded.
  const inputs = find(snap, 'input')
  check(
    'but whether a field was filled is recorded, because the picture shows it',
    inputs[0]?.filled === true && inputs[1]?.filled === false,
    JSON.stringify(inputs.map((i) => i.filled)),
  )
  check(
    'and the field still identifies itself',
    inputs[0]?.name === 'card' && inputs[0]?.type === 'text',
    JSON.stringify(inputs[0]),
  )
}

console.log('\nA password field records that it exists, and nothing else')
{
  const snap = snapshotOf(
    el('html', {
      children: [
        el('input', {
          attrs: { type: 'password', name: 'account-password', id: 'pw', placeholder: 'Your password' },
          value: 'hunter2',
        }),
      ],
    }),
  )
  const pw = find(snap, 'input')[0]
  const serialized = JSON.stringify(snap)
  check('the value is absent', !serialized.includes('hunter2'))
  check(
    'so is every attribute that could name the account it belongs to',
    !serialized.includes('account-password') && !serialized.includes('Your password')
      && pw?.id === undefined && pw?.name === undefined && pw?.placeholder === undefined,
    JSON.stringify(pw),
  )
  check(
    'what remains is that a password field was there, and where',
    pw?.secret === true && pw?.type === 'password' && typeof pw?.bounds?.x === 'number',
    JSON.stringify(pw),
  )
  check(
    'and it is not reported as filled, which would leak whether one was typed',
    pw?.filled !== true,
    JSON.stringify(pw?.filled),
  )
}

console.log('\nWhat the user could not see is not in the pack')
{
  const hiddenWays = [
    ['display:none', { style: { display: 'none' } }],
    ['visibility:hidden', { style: { visibility: 'hidden' } }],
    ['opacity:0', { style: { opacity: '0' } }],
    ['the hidden attribute', { attrs: { hidden: '' } }],
    ['aria-hidden', { attrs: { 'aria-hidden': 'true' } }],
    ['a zero-sized box', { rect: { left: 0, top: 0, width: 0, height: 0 } }],
    ['scrolled off the top', { rect: { left: 10, top: -900, width: 100, height: 20 } }],
    ['past the right edge', { rect: { left: 4000, top: 10, width: 100, height: 20 } }],
  ]
  for (const [label, options] of hiddenWays) {
    const snap = snapshotOf(
      el('html', {
        children: [
          el('div', {
            ...options,
            children: [el('span', { text: 'SECRET-COLLAPSED-TEXT' })],
          }),
        ],
      }),
    )
    check(
      `${label}: neither it nor its children are recorded`,
      !JSON.stringify(snap).includes('SECRET-COLLAPSED-TEXT'),
    )
  }
}

console.log('\nAttributes are an allowlist, not a sweep')
{
  const snap = snapshotOf(
    el('html', {
      children: [
        el('div', {
          attrs: {
            id: 'panel',
            class: 'card wide',
            'data-session-token': 'eyJhbGciOiJIUzI1NiJ9.SECRET',
            'data-user-id': '99182',
            onclick: 'doThing()',
          },
          text: 'Visible label',
        }),
      ],
    }),
  )
  const div = find(snap, 'div')[0]
  const serialized = JSON.stringify(snap)
  check(
    'a token in a data attribute does not reach the pack',
    !serialized.includes('SECRET') && !serialized.includes('99182'),
  )
  check(
    'nor an inline handler',
    !serialized.includes('doThing'),
  )
  check(
    'while id and class, which the picture cannot show but a reader needs, do',
    div?.id === 'panel' && div?.class === 'card wide',
    JSON.stringify(div),
  )
}

console.log('\nText is recorded once, where it belongs')
{
  const snap = snapshotOf(
    el('html', {
      children: [
        el('main', {
          text: 'Outer words',
          children: [el('p', { text: 'Inner words' })],
        }),
      ],
    }),
  )
  const main = find(snap, 'main')[0]
  const p = find(snap, 'p')[0]
  // innerText on a container returns the whole subtree, so recording it per
  // ancestor writes the page out once per nesting level — and gives <body> a
  // copy of everything.
  check(
    'a container carries its own words, not its descendants',
    main?.text === 'Outer words' && !String(main?.text).includes('Inner'),
    JSON.stringify(main?.text),
  )
  check('and the descendant carries its own', p?.text === 'Inner words', JSON.stringify(p?.text))
}

console.log('\nThe payload says what it left out')
{
  const snap = snapshotOf(el('html', { children: [el('p', { text: 'hi' })] }))
  check(
    'the omissions travel with the data, not only in our source',
    Array.isArray(snap.omitted)
      && snap.omitted.some((s) => s.includes('input'))
      && snap.omitted.some((s) => s.includes('password'))
      && snap.omitted.some((s) => s.includes('could not see')),
    JSON.stringify(snap.omitted),
  )
  check(
    'and so does the space the rectangles are in',
    snap.viewport?.width === 1000 && snap.viewport?.height === 800,
    JSON.stringify(snap.viewport),
  )
  check(
    'a walk that hit its cap says so rather than looking complete',
    snap.truncated === false && typeof snap.visitedCount === 'number',
    `truncated ${String(snap.truncated)}, visited ${String(snap.visitedCount)}`,
  )
}

console.log(
  `\n${failed === 0 ? 'PASS' : 'FAIL'} — document snapshot: ${passed} passed, ${failed} failed`,
)
process.exitCode = failed === 0 ? 0 : 1
