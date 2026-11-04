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
  // `shadowRoot` is what a page script sees: the root for an OPEN shadow tree,
  // null for a closed one or none at all. `shadowThrows` stands in for a host
  // object that refuses to be read.
  if (options.shadow !== undefined) {
    node.shadowRoot = { host: node, children: [...options.shadow], childNodes: [...options.shadow] }
  } else if (options.closedShadow !== undefined) {
    node.shadowRoot = null
  }
  if (options.shadowThrows === true) {
    Object.defineProperty(node, 'shadowRoot', {
      get() {
        throw new Error('SecurityError: Blocked a frame from accessing a cross-origin object')
      },
    })
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
  // ONLY INHERITED INVISIBILITY PRUNES A SUBTREE.
  //
  // These five are inherited: nothing under them can be seen, so refusing the
  // branch whole is both correct and what keeps a page of collapsed menus cheap.
  // A zero-sized or off-screen BOX is NOT inherited and is tested separately
  // below — conflating the two threw away an entire page (#128).
  const hiddenWays = [
    ['display:none', { style: { display: 'none' } }],
    ['visibility:hidden', { style: { visibility: 'hidden' } }],
    ['opacity:0', { style: { opacity: '0' } }],
    ['the hidden attribute', { attrs: { hidden: '' } }],
    ['aria-hidden', { attrs: { 'aria-hidden': 'true' } }],
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

  // A BOX WITH NO SIZE IS NOT A HIDDEN BRANCH (#128).
  //
  // An absolutely positioned child escapes its parent's box entirely, so a
  // container with no height routinely contains the whole visible page.
  // Measured on youtube.com: `<html>` has zero height because every child is
  // positioned, the walk refused it as hidden, and the document arrived with
  // **0 elements after visiting 1**. The page, discarded by its own root.
  const boxOnly = [
    ['a zero-sized box', { rect: { left: 0, top: 0, width: 0, height: 0 } }],
    ['scrolled off the top', { rect: { left: 10, top: -900, width: 100, height: 20 } }],
    ['past the right edge', { rect: { left: 4000, top: 10, width: 100, height: 20 } }],
  ]
  for (const [label, options] of boxOnly) {
    const snap = snapshotOf(
      el('html', {
        children: [
          el('div', {
            ...options,
            children: [
              el('span', {
                rect: { left: 10, top: 10, width: 200, height: 20 },
                text: 'VISIBLE-CHILD-TEXT',
              }),
            ],
          }),
        ],
      }),
    )
    check(
      `${label}: the box itself is not recorded`,
      !snap.elements.some((e) => e.bounds.width === (options.rect?.width ?? -1)
        && e.bounds.height === (options.rect?.height ?? -1)
        && e.tag === 'div'),
    )
    check(
      `${label}: but a visible child underneath still is`,
      JSON.stringify(snap).includes('VISIBLE-CHILD-TEXT'),
      JSON.stringify(snap.elements),
    )
  }

  // The exact shape that broke: a zero-height root over a real page.
  {
    const snap = snapshotOf(
      el('html', {
        rect: { left: 0, top: 0, width: 1184, height: 0 },
        children: [
          el('div', {
            rect: { left: 0, top: 0, width: 1184, height: 814 },
            children: [el('span', { text: 'YOUTUBE-STYLE-PAGE' })],
          }),
        ],
      }),
    )
    check(
      'a zero-height ROOT does not discard the document',
      snap.elements.length > 0 && JSON.stringify(snap).includes('YOUTUBE-STYLE-PAGE'),
      `${String(snap.elements.length)} element(s), visited ${String(snap.visitedCount)}`,
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

console.log('\nAn open shadow tree is part of the visible page (#345)')
{
  // A web component draws its UI inside its shadow root, so `el.children` of
  // the host is the light DOM it was given and not what the user sees. Before
  // this, a page built from components (youtube.com is one) came out as a list
  // of hosts with nothing inside them.
  const snap = snapshotOf(
    el('html', {
      children: [
        el('video-player', {
          attrs: { id: 'player' },
          rect: { left: 0, top: 0, width: 640, height: 360 },
          shadow: [
            el('button', { attrs: { class: 'play' }, text: 'SHADOW-PLAY-BUTTON' }),
            el('control-bar', {
              rect: { left: 0, top: 320, width: 640, height: 40 },
              shadow: [el('span', { text: 'NESTED-SHADOW-TIME' })],
            }),
          ],
          children: [el('p', { text: 'SLOTTED-LIGHT-CAPTION' })],
        }),
      ],
    }),
  )
  const button = find(snap, 'button')[0]
  check(
    'an element inside an open shadow root is recorded',
    button?.text === 'SHADOW-PLAY-BUTTON' && button.role === 'button' && button.class === 'play',
    JSON.stringify(snap.elements),
  )
  check(
    'a shadow tree inside a shadow tree is recorded too',
    JSON.stringify(snap).includes('NESTED-SHADOW-TIME'),
    JSON.stringify(snap.elements),
  )
  check(
    'and the light children the host was given still are',
    JSON.stringify(snap).includes('SLOTTED-LIGHT-CAPTION'),
    JSON.stringify(snap.elements),
  )
  const order = snap.elements.map((e) => e.tag)
  check(
    'the host comes before what it draws',
    order.indexOf('video-player') !== -1 && order.indexOf('video-player') < order.indexOf('button'),
    JSON.stringify(order),
  )
  check(
    'every element is numbered once, in walk order',
    snap.elements.every((e, i) => e.i === i),
    JSON.stringify(snap.elements.map((e) => e.i)),
  )
}

console.log('\nA shadow tree keeps every refusal')
{
  const snap = snapshotOf(
    el('html', {
      children: [
        el('login-form', {
          shadow: [
            el('input', { attrs: { type: 'text', name: 'user' }, value: 'SHADOW-TYPED-NAME' }),
            el('input', { attrs: { type: 'password', name: 'shadow-account' }, value: 'SHADOW-HUNTER2' }),
            el('div', {
              attrs: { 'data-token': 'SHADOW-TOKEN' },
              style: { display: 'none' },
              children: [el('span', { text: 'SHADOW-COLLAPSED-TEXT' })],
            }),
          ],
        }),
        el('closed-menu', {
          attrs: { 'aria-hidden': 'true' },
          shadow: [el('span', { text: 'UNDER-A-HIDDEN-HOST' })],
        }),
      ],
    }),
  )
  const serialized = JSON.stringify(snap)
  check('no value typed into a shadow field', !serialized.includes('SHADOW-TYPED-NAME'))
  check(
    'a shadow password field is a password field',
    !serialized.includes('SHADOW-HUNTER2') && !serialized.includes('shadow-account')
      && find(snap, 'input').some((i) => i.secret === true),
    JSON.stringify(find(snap, 'input')),
  )
  check(
    'hidden inside a shadow tree is hidden',
    !serialized.includes('SHADOW-COLLAPSED-TEXT') && !serialized.includes('SHADOW-TOKEN'),
  )
  check(
    'a hidden host hides the tree it draws',
    !serialized.includes('UNDER-A-HIDDEN-HOST'),
  )
}

console.log('\nWhat a page script cannot reach is skipped, never an error')
{
  let snap = null
  let thrown = null
  try {
    snap = snapshotOf(
      el('html', {
        children: [
          // A closed root: `shadowRoot` is null to anyone but its owner.
          el('closed-widget', { text: 'CLOSED-HOST-LABEL', closedShadow: [el('span', { text: 'CLOSED-INSIDE' })] }),
          el('hostile-host', { text: 'THROWING-HOST-LABEL', shadowThrows: true }),
          el('p', { text: 'AFTER-THE-UNREACHABLE' }),
        ],
      }),
    )
  } catch (error) {
    thrown = error
  }
  check('the walk completes', thrown === null, String(thrown))
  const serialized = JSON.stringify(snap)
  check('a closed root contributes nothing', !serialized.includes('CLOSED-INSIDE'))
  check(
    'its host, and one whose root cannot be read, are still recorded',
    serialized.includes('CLOSED-HOST-LABEL') && serialized.includes('THROWING-HOST-LABEL'),
    JSON.stringify(snap?.elements),
  )
  check('and so is the page after them', serialized.includes('AFTER-THE-UNREACHABLE'))
}

console.log('\nThe cap counts shadow elements like any other')
{
  const many = Array.from({ length: 4100 }, (_, i) => el('li', { text: `row ${String(i)}` }))
  const snap = snapshotOf(el('html', { children: [el('long-list', { shadow: many })] }))
  check(
    'a shadow tree past the cap stops at the cap and says so',
    snap.elements.length === 4000 && snap.truncated === true,
    `${String(snap.elements.length)} element(s), truncated ${String(snap.truncated)}`,
  )
  check(
    'and what it did record came from inside the shadow tree',
    find(snap, 'li').length === 3998,
    `${String(find(snap, 'li').length)} li`,
  )
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
    'including the shadow trees a page keeps closed to every script',
    snap.omitted.some((s) => s.includes('closed shadow root')),
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
