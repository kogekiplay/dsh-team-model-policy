/**
 * A tiny DOM renderer for the card tests.
 *
 * The suite must run from the package checkout alone (no dev dependencies), so
 * instead of a test renderer it mounts the real component with ordinary
 * `react-dom` into a hand-built DOM and observes the result through React's
 * stable DOM contract: `data-*` hooks, control types, and text content.
 *
 * The document here implements only what react-dom 19 touches while mounting,
 * updating, and unmounting a small form: node creation and tree mutation, the
 * attribute and property writes React performs, and event dispatch.
 */

'use strict'

const path = require('node:path')

/** Directory holding react and react-dom for this run (see ui.test.cjs). */
const MODULES = process.env.DSH_UI_TEST_MODULES === undefined
  ? '/Users/kogeki/dev/tv-display-manager/node_modules'
  : process.env.DSH_UI_TEST_MODULES
const React = require(path.join(MODULES, 'react'))
const ReactDOMClient = require(path.join(MODULES, 'react-dom/client'))
// react-dom reads global `window` (scheduling, deep focus) and needs it before require.
class FakeHTMLElement {
  constructor() { throw new Error('FakeHTMLElement is only a brand for react-dom instanceof checks') }
}
class FakeNodeBase {}
globalThis.Node = FakeNodeBase
globalThis.HTMLElement = FakeHTMLElement
globalThis.HTMLIFrameElement = class HTMLIFrameElement {}
if (globalThis.window === undefined) {
  globalThis.window = {
    event: undefined,
    HTMLElement: FakeHTMLElement,
    Node: FakeNodeBase,
    HTMLIFrameElement: globalThis.HTMLIFrameElement,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  }
}
const ReactDOM = require(path.join(MODULES, 'react-dom'))
const { createRoot } = ReactDOMClient

class FakeNode extends FakeNodeBase {
  constructor(nodeType, nodeName) {
    super()
    this.nodeType = nodeType
    this.nodeName = nodeName
    this.tagName = nodeName
    this.namespaceURI = undefined
    this.childNodes = []
    this.parentNode = null
    /** Attribute mirror: React writes DOM `value`/`checked` properties and `disabled` as empty attributes. */
    this.attributes = new Map()
    this.value = ''
    this.checked = false
    this.style = {}
    this.listeners = new Map()
    this._text = ''
    this.ownerDocument = undefined
  }

  get children() { return this.childNodes.filter(child => child.nodeType === 1) }
  get firstChild() { return this.childNodes[0] === undefined ? null : this.childNodes[0] }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] === undefined ? null : this.childNodes[this.childNodes.length - 1] }
  get nextSibling() {
    if (this.parentNode === null) return null
    const index = this.parentNode.childNodes.indexOf(this)
    return this.parentNode.childNodes[index + 1] === undefined ? null : this.parentNode.childNodes[index + 1]
  }

  get textContent() {
    if (this.nodeType === 3) return this._text
    return this.childNodes.map(child => child.textContent).join('')
  }

  set textContent(value) {
    if (this.nodeType === 3) { this._text = String(value); return }
    for (const child of this.childNodes) child.parentNode = null
    this.childNodes = []
    if (value !== '' && value !== null && value !== undefined) {
      const textNode = new FakeNode(3, '#text')
      textNode._text = String(value)
      textNode.parentNode = this
      textNode.ownerDocument = this.ownerDocument
      this.childNodes.push(textNode)
    }
  }

  appendChild(child) {
    if (child.nodeType === 11) {
      for (const grand of [...child.childNodes]) this.appendChild(grand)
      return child
    }
    if (child.parentNode !== null) child.parentNode.removeChild(child)
    child.parentNode = this
    child.ownerDocument = this.ownerDocument
    this.childNodes.push(child)
    return child
  }

  insertBefore(child, before) {
    if (before === null || before === undefined) return this.appendChild(child)
    if (child.parentNode !== null) child.parentNode.removeChild(child)
    child.parentNode = this
    child.ownerDocument = this.ownerDocument
    const index = this.childNodes.indexOf(before)
    this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, child)
    return child
  }

  removeChild(child) {
    const index = this.childNodes.indexOf(child)
    if (index >= 0) {
      this.childNodes.splice(index, 1)
      child.parentNode = null
    }
    return child
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value))
    // React reads `disabled` through a property descriptor on writable hosts;
    // mirroring the attribute keeps both views of the control consistent.
    if (name === 'disabled') this.disabled = true
    if (name === 'value') this.value = String(value)
    if (name === 'checked') this.checked = true
  }

  removeAttribute(name) {
    this.attributes.delete(name)
    if (name === 'disabled') this.disabled = false
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null }
  hasAttribute(name) { return this.attributes.has(name) }
  getAttributeNames() { return [...this.attributes.keys()] }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(listener)
  }

  removeEventListener(type, listener) {
    if (this.listeners.has(type)) this.listeners.get(type).delete(listener)
  }

  /** Build and dispatch one event; `bubbles` events walk up to the document. */
  dispatchEvent(event) {
    event.target = event.target === undefined || event.target === null ? this : event.target
    event.currentTarget = this
    const handler = this.listeners.get(event.type)
    if (handler !== undefined) for (const listener of [...handler]) listener.call(this, event)
    if (event.bubbles === true && this.parentNode !== null) this.parentNode.dispatchEvent(event)
    return !event.defaultPrevented
  }

  contains(other) {
    let node = other
    while (node !== null && node !== undefined) {
      if (node === this) return true
      node = node.parentNode
    }
    return false
  }
}

/**
 * Mount React children into a fresh container.
 * @returns handles for reading the tree, dispatching events, and unmounting.
 */
function mount(element, options) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = options !== undefined && options.act === true
  const document = {
    nodeType: 9,
    addEventListener: () => {},
    removeEventListener: () => {},
    createElement: name => {
      const node = new FakeNode(1, name.toUpperCase())
      node.ownerDocument = document
      return node
    },
    createElementNS: (_ns, name) => {
      const node = new FakeNode(1, name.toUpperCase())
      node.ownerDocument = document
      return node
    },
    createTextNode: text => {
      const node = new FakeNode(3, '#text')
      node._text = String(text)
      node.ownerDocument = document
      return node
    },
    createComment: text => {
      const node = new FakeNode(8, '#comment')
      node._text = String(text)
      node.ownerDocument = document
      return node
    },
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  ReactDOM.flushSync(() => { root.render(element) })
  return {
    document,
    container,
    flush: () => { ReactDOM.flushSync(() => {}) },
    rerender: next => { ReactDOM.flushSync(() => { root.render(next) }) },
    unmount: () => { ReactDOM.flushSync(() => { root.unmount() }) },
    text: () => container.textContent,
    all: predicate => {
      const out = []
      const walk = node => {
        if (predicate(node)) out.push(node)
        for (const child of node.childNodes) walk(child)
      }
      walk(container)
      return out
    },
    button: label => {
      const found = []
      const walk = node => {
        if (node.nodeName === 'BUTTON' && node.textContent === label) found.push(node)
        for (const child of node.childNodes) walk(child)
      }
      walk(container)
      return found[0]
    },
  }
}

/**
 * Dispatch a trusted-shaped event with bubbles and a mutable target value.
 * @param {FakeNode} node - the event target.
 * @param {string} type - event type.
 * @param {object} [props] - extra fields, such as `{ target: { value } }`.
 */
function fire(node, type, props) {
  const event = Object.assign({
    type,
    bubbles: type !== 'focus' && type !== 'blur' && type !== 'change' || props !== undefined && props.bubbles === true,
    cancelable: true,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() {},
    persist() {},
    nativeEvent: { isTrusted: true },
    timeStamp: Date.now(),
    isTrusted: true,
  }, props === undefined ? {} : props)
  node.dispatchEvent(event)
}

module.exports = { mount, fire, React, ReactDOM }
