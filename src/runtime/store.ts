/**
 * Reactive stores for TypeScript-side state shared with QML (e.g. singletons registered with
 * `engine.registerSingleton`).
 *
 * `createStore(initial)` returns a deep proxy: every property read (including reads of keys
 * that don't exist yet, `in` checks and key enumeration) is tracked by the QML binding that
 * performs it; every write/delete re-evaluates exactly the bindings that read that key. Plain
 * objects and arrays reached through the store are wrapped lazily. Other values (class
 * instances, QML object proxies, functions) are stored as-is.
 *
 * `createPropertyMap()` is a store with a small `QQmlPropertyMap`-like API (`set`, `get`,
 * `keys`, `contains`, `clear`, `toJSON`) whose values are also readable as properties.
 *
 * (solid-js/store cannot be used here: its dist build imports the server copy of solid-js.)
 */
import { batch, createSignal } from "./reactive.ts"
import type { Accessor, Setter } from "./reactive.ts"

const RAW = Symbol("qml.store.raw")
const KEYS = Symbol("qml.store.keys")

type Node = [Accessor<undefined>, Setter<undefined>]

const proxies = new WeakMap<object, object>()
const signals = new WeakMap<object, Map<PropertyKey, Node>>()

function isWrappable(value: unknown): value is object {
  if (typeof value !== "object" || value === null) return false
  if (Array.isArray(value)) return true
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function node(target: object, key: PropertyKey): Node {
  let map = signals.get(target)
  if (!map) {
    map = new Map()
    signals.set(target, map)
  }
  let n = map.get(key)
  if (!n) {
    n = createSignal<undefined>(undefined, { equals: false }) as Node
    map.set(key, n)
  }
  return n
}

function track(target: object, key: PropertyKey): void {
  node(target, key)[0]()
}

function trigger(target: object, key: PropertyKey): void {
  signals.get(target)?.get(key)?.[1](undefined)
}

/** The raw object behind a store proxy (or the value itself). */
export function unwrapStore<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    const raw = (value as { [RAW]?: T })[RAW]
    if (raw !== undefined) return raw
  }
  return value
}

/** Is `value` a store proxy created by {@link createStore}? */
export function isStore(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { [RAW]?: unknown })[RAW] !== undefined
}

function wrap<T>(value: T): T {
  if (!isWrappable(value)) return value
  let proxy = proxies.get(value)
  if (!proxy) {
    proxy = new Proxy(value, handler)
    proxies.set(value, proxy)
  }
  return proxy as T
}

const handler: ProxyHandler<object> = {
  get(target, key, receiver) {
    if (key === RAW) return target
    if (typeof key === "symbol") return Reflect.get(target, key, receiver)
    const own = Object.prototype.hasOwnProperty.call(target, key)
    // Inherited members (array methods, toString, ...) are not tracked per key.
    if (!own && key in target) return Reflect.get(target, key, receiver)
    track(target, key)
    return wrap(Reflect.get(target, key, receiver))
  },
  has(target, key) {
    if (key === RAW) return true
    if (typeof key !== "symbol") track(target, key)
    return Reflect.has(target, key)
  },
  ownKeys(target) {
    track(target, KEYS)
    return Reflect.ownKeys(target)
  },
  getOwnPropertyDescriptor(target, key) {
    const desc = Reflect.getOwnPropertyDescriptor(target, key)
    if (desc && "value" in desc && typeof key !== "symbol") {
      track(target, key)
      return { ...desc, value: wrap(desc.value) }
    }
    return desc
  },
  set(target, key, value) {
    const raw = unwrapStore(value)
    const had = Object.prototype.hasOwnProperty.call(target, key)
    const old = (target as Record<PropertyKey, unknown>)[key]
    const oldLength = Array.isArray(target) ? target.length : 0
    if (!Reflect.set(target, key, raw)) return false
    if (had && Object.is(old, raw)) return true
    batch(() => {
      trigger(target, key)
      if (!had) trigger(target, KEYS)
      if (Array.isArray(target) && key !== "length" && target.length !== oldLength) {
        trigger(target, "length")
        trigger(target, KEYS)
      }
      if (Array.isArray(target) && key === "length") trigger(target, KEYS)
    })
    return true
  },
  deleteProperty(target, key) {
    const had = Object.prototype.hasOwnProperty.call(target, key)
    if (!Reflect.deleteProperty(target, key)) return false
    if (had) {
      batch(() => {
        trigger(target, key)
        trigger(target, KEYS)
      })
    }
    return true
  },
}

/**
 * Create a deep reactive store. Mutate it directly (`store.layout.sidebarCollapsed = true`,
 * `store.items.push(x)`, `delete store.key`); QML bindings that read the touched keys update.
 */
export function createStore<T extends object>(initial: T): T {
  if (!isWrappable(initial)) throw new TypeError("createStore: initial value must be a plain object or array")
  return wrap(unwrapStore(initial))
}

/** The API of {@link createPropertyMap}. Values are also readable/writable as properties. */
export interface PropertyMap {
  /** Set (insert or replace) a value. Plain objects/arrays become deep reactive stores. */
  set(key: string, value: unknown): void
  /** Alias of `set` (QQmlPropertyMap naming). */
  insert(key: string, value: unknown): void
  /** Read a value (tracked; undefined if unset). */
  get(key: string): unknown
  /** Alias of `get` (QQmlPropertyMap naming). */
  value(key: string): unknown
  /** Tracked: does the key exist? */
  contains(key: string): boolean
  /** Remove a key. */
  clear(key: string): void
  /** Tracked list of keys. */
  keys(): string[]
  /** Deep plain snapshot (tracked). */
  toJSON(): Record<string, unknown>
  [key: string]: unknown
}

function snapshot(value: unknown): unknown {
  if (!isWrappable(value)) return value
  if (Array.isArray(value)) return value.map(snapshot)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) out[key] = snapshot((value as Record<string, unknown>)[key])
  return out
}

/**
 * A reactive key/value map (like Qt's `QQmlPropertyMap`): `map.set("layout", {...})` updates
 * bindings reading `map.layout` — including ones that ran while the key was still unset.
 * Method names (`set`, `get`, `keys`, ...) take precedence over same-named keys when read as
 * properties; use `get(key)` for those.
 */
export function createPropertyMap(initial: Record<string, unknown> = {}): PropertyMap {
  const data = createStore<Record<string, unknown>>({ ...initial })
  const methods: Record<string, Function> = {
    set: (key: string, value: unknown) => {
      data[key] = value
    },
    insert: (key: string, value: unknown) => {
      data[key] = value
    },
    get: (key: string) => data[key],
    value: (key: string) => data[key],
    contains: (key: string) => key in data,
    clear: (key: string) => {
      delete data[key]
    },
    keys: () => Object.keys(data),
    toJSON: () => snapshot(data),
  }
  return new Proxy(Object.create(null) as PropertyMap, {
    get(_t, key) {
      if (typeof key === "symbol") return undefined
      if (Object.prototype.hasOwnProperty.call(methods, key)) return methods[key]
      return data[key]
    },
    set(_t, key, value) {
      if (typeof key === "symbol") return false
      data[key] = value
      return true
    },
    has(_t, key) {
      return typeof key === "string" && (Object.prototype.hasOwnProperty.call(methods, key) || key in data)
    },
    deleteProperty(_t, key) {
      if (typeof key === "symbol") return false
      delete data[key]
      return true
    },
    ownKeys() {
      return Object.keys(data)
    },
    getOwnPropertyDescriptor(_t, key) {
      if (typeof key === "symbol" || !(key in data)) return undefined
      return { value: data[key], writable: true, enumerable: true, configurable: true }
    },
  })
}
