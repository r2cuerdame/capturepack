// WHAT WAS ON THE SCREEN, AS STRUCTURE (GOAL "The still carries the context").
//
// The picker records the one element someone clicked. This records the whole
// interface that was visible at the captured instant: every element the user
// could see, what it is, where it sat, and what it said.
//
// It exists because a still has no clock to disagree with. A replay had to
// spend its budget keeping up with fifteen frames a second; a frozen frame can
// spend all of it once, on depth.
//
// ---------------------------------------------------------------------------
// WHAT IT REFUSES TO RECORD, AND WHY THAT LINE IS EXACTLY THERE
// ---------------------------------------------------------------------------
//
// The justification for recording visible text at all is that `snapshot.png`
// already contains those pixels: a person holding the pack can read the words
// off the picture, so writing them down adds no exposure the pack did not
// already have. That argument is the whole licence, and it fails the moment
// anything is recorded that the picture does NOT contain. So:
//
//  - Nothing outside the captured raster. A normal still admits only the
//    viewport; an explicit toolbar full-page image admits its document rectangle.
//  - No value of any `input`, `textarea` or `select`. A half-typed password, a
//    card number, a search someone did not run — the picture may show dots or
//    nothing at all, and the DOM knows the characters.
//  - Nothing at all from a `type="password"` field beyond that one is there.
//  - No text from a hidden element: a collapsed panel, a closed menu, a
//    `hidden` template. The user cannot see it, so neither can the pack.
//  - No attribute sweeping. `data-*` and friends routinely carry tokens, ids
//    and internal state; an allowlist of `id`, `class`, `role`, `name`,
//    `type`, `placeholder`, `alt`, `title`, `href` is what gets through.
//
// `href` is on that list deliberately: a link's destination is visible to
// anyone who hovers it, and it is most of what makes a page legible to a
// reader. It is truncated like every other string.
//
// ---------------------------------------------------------------------------

;(() => {
  const MAX_ELEMENTS = 4000
  const MAX_TEXT = 200
  const MAX_ATTR = 300
  const MIN_SIZE_PX = 2

  /** Attributes worth keeping. Everything else is refused by omission. */
  const ATTRIBUTES = ['id', 'class', 'role', 'name', 'type', 'placeholder', 'alt', 'title', 'href']

  const IMPLICIT_ROLE = {
    button: 'button', a: 'link', input: 'textbox', select: 'listbox',
    textarea: 'textbox', img: 'img', nav: 'navigation', main: 'main',
    header: 'banner', footer: 'contentinfo', h1: 'heading', h2: 'heading',
    h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
    table: 'table', ul: 'list', ol: 'list', li: 'listitem', form: 'form',
  }

  const clip = (value, max) => {
    const s = String(value == null ? '' : value).trim()
    return s.length > max ? s.slice(0, max) : s
  }

  /**
   * The element's OWN words, not its descendants'.
   *
   * `innerText` on a container returns the whole subtree, so recording it for
   * every ancestor would write the page out once per nesting level — a page's
   * worth of duplicated text, and a `<body>` entry containing everything.
   */
  const ownText = (el) => {
    let out = ''
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) out += node.nodeValue
      if (out.length > MAX_TEXT * 2) break
    }
    return clip(out.replace(/\s+/gu, ' '), MAX_TEXT)
  }

  /** Visible to the user, in the sense the picture can corroborate. */
  const visibility = (el, rect, style, fullPage) => {
    if (style.visibility === 'hidden' || style.display === 'none') return 'hidden'
    if (style.opacity === '0') return 'hidden'
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return 'hidden'
    // Everything above this line is INHERITED and prunes the subtree. Everything
    // below is about this element's own box, which its children do not share.
    if (rect.width < MIN_SIZE_PX || rect.height < MIN_SIZE_PX) return 'offscreen'
    // A normal still contains the viewport. A toolbar full-page capture contains
    // the complete document rectangle, so document-space boxes are admissible
    // there — but never anything outside the pixels the bundle actually holds.
    const left = fullPage ? rect.left + window.scrollX : rect.left
    const top = fullPage ? rect.top + window.scrollY : rect.top
    const right = left + rect.width
    const bottom = top + rect.height
    const limitWidth = fullPage
      ? Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0)
      : window.innerWidth
    const limitHeight = fullPage
      ? Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0)
      : window.innerHeight
    if (bottom <= 0 || right <= 0) return 'offscreen'
    if (top >= limitHeight || left >= limitWidth) return 'offscreen'
    return 'visible'
  }

  const isSecret = (el) =>
    el.tagName === 'INPUT' && String(el.getAttribute('type') || '').toLowerCase() === 'password'

  const HOLDS_A_VALUE = { INPUT: true, TEXTAREA: true, SELECT: true }

  /** Not recordable here, but its descendants still might be. */
  const SKIP = Object.freeze({ skip: true })

  function describe(el, index, fullPage) {
    const rect = el.getBoundingClientRect()
    const style = window.getComputedStyle(el)
    const state = visibility(el, rect, style, fullPage)
    // null prunes the subtree; SKIP records nothing and keeps walking.
    if (state === 'hidden') return null
    if (state !== 'visible') return SKIP

    const tag = el.tagName.toLowerCase()
    const out = {
      i: index,
      tag,
      role: el.getAttribute('role') || IMPLICIT_ROLE[tag] || '',
      // Viewport coordinates. The host translates them into the display's
      // pixels using the same client rectangle the picker already uses.
      bounds: {
        x: Math.round(rect.left + (fullPage ? window.scrollX : 0)),
        y: Math.round(rect.top + (fullPage ? window.scrollY : 0)),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    }

    const secret = isSecret(el)
    for (const name of ATTRIBUTES) {
      // A password field's own attributes can name the account it belongs to;
      // that it exists, and where, is the entire record.
      if (secret && name !== 'type') continue
      if (!el.hasAttribute(name)) continue
      const value = clip(el.getAttribute(name), MAX_ATTR)
      if (value !== '') out[name] = value
    }

    if (HOLDS_A_VALUE[el.tagName] === true) {
      // Never the value. Whether the user has put SOMETHING there is visible in
      // the picture and is sometimes the whole bug, so that much is recorded.
      out.filled = !secret && String(el.value || '') !== ''
      if (secret) out.secret = true
      return out
    }

    const text = ownText(el)
    if (text !== '') out.text = text
    return out
  }

  /**
   * Walk the document in order, refusing subtrees rather than elements where a
   * whole branch is invisible — a closed menu costs one refusal, not one per
   * item inside it.
   */
  function walk(fullPage) {
    const elements = []
    let truncated = false
    let visited = 0
    const stack = [document.documentElement]
    while (stack.length > 0) {
      const el = stack.pop()
      if (el === undefined || el === null) continue
      visited += 1
      if (elements.length >= MAX_ELEMENTS) {
        truncated = true
        break
      }
      const described = describe(el, elements.length, fullPage)
      // TWO DIFFERENT REFUSALS, AND CONFLATING THEM COST A WHOLE PAGE.
      //
      // `display: none`, `visibility: hidden`, `aria-hidden` and `opacity: 0`
      // are INHERITED — a subtree under one of them is genuinely invisible, and
      // skipping it whole is what keeps a page of collapsed menus cheap.
      //
      // A zero-sized or off-screen BOX is not inherited. An absolutely
      // positioned child escapes its parent's box entirely, so a container with
      // no height can contain the entire visible page. Measured on youtube.com:
      // `<html>` has zero height because every child is positioned, the walk
      // refused it as "hidden", and the document came out with **0 elements
      // after visiting 1** — the whole page, thrown away by its root.
      //
      // So a box that cannot be recorded is skipped as an ELEMENT and still
      // descended into. Only inherited invisibility prunes.
      if (described === null) continue
      if (described !== SKIP) elements.push(described)
      const children = el.children
      for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i])
    }
    return { elements, truncated, visited }
  }

  window.__capturepackDocumentSnapshot = (options = {}) => {
    const fullPage = options.fullPage === true
    const started = Date.now()
    const { elements, truncated, visited } = walk(fullPage)
    const documentWidth = Math.max(
      document.documentElement.scrollWidth,
      document.body?.scrollWidth || 0,
      window.innerWidth,
    )
    const documentHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight || 0,
      window.innerHeight,
    )
    return {
      // The space the bounds are in, so the host never has to guess.
      viewport: {
        width: fullPage ? documentWidth : window.innerWidth,
        height: fullPage ? documentHeight : window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
        scrollX: fullPage ? 0 : Math.round(window.scrollX),
        scrollY: fullPage ? 0 : Math.round(window.scrollY),
      },
      url: location.href,
      title: document.title,
      elements,
      truncated,
      visitedCount: visited,
      elapsedMs: Date.now() - started,
      // Stated in the payload rather than only in this comment, so a reader of
      // the pack knows what is missing without reading our source.
      omitted: [
        'the value of every input, textarea and select',
        'everything but the presence of a password field',
        'text of elements the user could not see',
        fullPage
          ? 'elements outside the captured document rectangle'
          : 'elements outside the viewport',
        'attributes outside the recorded allowlist',
      ],
    }
  }
})()
