/**
 * Minimal stand-in for the Desktop client runtime, for running the real
 * lib/client.js bundle outside a browser.
 *
 * It reproduces the three contracts the card depends on and nothing else: the
 * module loader's factory registration, host observables with
 * useSyncExternalStore semantics, and the renderer's inject-hooks binding (a
 * cached selector hook named `use<Key>`).
 */

'use strict'

const { readFileSync } = require('node:fs')
const path = require('node:path')

/** Directory holding react and the test renderer for this run (see ui.test.cjs). */
const MODULES = process.env.DSH_UI_TEST_MODULES === undefined
  ? '/Users/kogeki/dev/tv-display-manager/node_modules'
  : process.env.DSH_UI_TEST_MODULES
const React = require(path.join(MODULES, 'react'))

/**
 * Register lib/client.js with a fake window and a require limited to the client baseline.
 * @param {object} options
 * @param {string} [options.repoRoot] - package root holding lib/client.js.
 * @param {Record<string, unknown>} options.modules - baseline modules by specifier.
 * @returns A function reading the registered factory and its exports: `() => exports`.
 */
function loadBundle(options) {
  const repoRoot = options.repoRoot === undefined ? path.join(__dirname, '..', '..', '..') : options.repoRoot
  const registered = []
  const previous = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: entry => { registered.push(entry) } } }
  try {
    // Read the shipped artifact as text and evaluate it: lib/client.js lives under a
    // package with `"type": "module"`, so `require` would refuse its CommonJS body.
    const source = readFileSync(path.join(repoRoot, 'lib', 'client.js'), 'utf8')
    const evaluate = new Function('window', source)
    evaluate(globalThis.window)
  } finally {
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
  }
  if (registered.length !== 1) throw new Error('expected exactly one module registration, got ' + registered.length)
  const entry = registered[0]
  if (entry.id !== 'dsh-team-model-policy') throw new Error('bundle id is ' + entry.id)
  let exports
  return () => {
    if (exports === undefined) {
      exports = entry.factory(specifier => {
        if (!Object.prototype.hasOwnProperty.call(options.modules, specifier)) {
          throw new Error('client bundle requested a non-baseline module: ' + specifier)
        }
        return options.modules[specifier]
      })
    }
    return exports
  }
}

/**
 * A host observable snapshot source, the shape slot inject hooks receive.
 * @param initial - first snapshot.
 * @returns The source with `getSnapshot`, `subscribe`, and `set`.
 */
function observable(initial) {
  let snapshot = initial
  const listeners = new Set()
  return {
    getSnapshot: () => snapshot,
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: next => {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/**
 * Reproduce ui-renderer's inject face binding: one cached selector hook per
 * source, named `use<CapitalizedKey>`, plus the plain inject members.
 * @param face - the value the entry's `inject()` returned.
 * @returns Props the renderer would hand the component.
 */
function bindFace(face) {
  const props = {}
  const cache = new WeakMap()
  for (const [name, value] of Object.entries(face)) {
    if (name === 'hooks') continue
    props[name] = value
  }
  for (const [name, source] of Object.entries(face.hooks === undefined ? {} : face.hooks)) {
    const hookName = 'use' + name.charAt(0).toUpperCase() + name.slice(1)
    props[hookName] = selector => {
      // A card exposes its state source as `{ getState, subscribe }`; the renderer
      // binds `getSnapshot` over the same pair.
      const getSnapshot = () => (typeof source.getSnapshot === 'function' ? source.getSnapshot() : source.getState())
      const subscribe = listener => source.subscribe(listener)
      const selected = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      return selector === undefined ? selected : selector(selected)
    }
    void cache
  }
  return props
}

/**
 * Records the injection faces a fake slot service receives.
 * @returns The slot service plus the recorded registrations.
 */
function slotService() {
  const registrations = []
  return {
    registrations,
    service: {
      inject: (name, factory) => {
        const dispose = factory()
        return () => { if (typeof dispose === 'function') dispose() }
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {
          const index = registrations.findIndex(entry => entry.options === options)
          if (index >= 0) registrations.splice(index, 1)
        }
      },
    },
  }
}

module.exports = { loadBundle, observable, bindFace, slotService }
