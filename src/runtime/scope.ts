/**
 * Name resolution for QML scripts.
 *
 * A `QmlScope` is an ordered list of layers wrapped in a Proxy that is used as the `with`
 * target of every compiled script (see `expression.ts`). The Proxy implements:
 * - `has(name)`: true iff some layer resolves `name`. Unresolved names return false so real JS
 *   globals (`Math`, `JSON`, `console`, `setTimeout`, `Date`, ...) fall through.
 * - `get(name)`: the first matching layer's value. QmlObject layers read through
 *   `QmlObject.getMember`, so property reads are tracked by solid.
 * - `set(name, v)`: assigns through the first layer that resolves `name` (QmlObject → `set()`,
 *   which breaks bindings). Unresolved names never reach the proxy: the strict script body
 *   throws a ReferenceError instead.
 *
 * The engine builds the standard chain for an object in a component context (`buildObjectScope`):
 *   1. the scope object (properties, methods, signals, property groups)
 *   2. `parent`
 *   3. context properties (object-level, then per component context: `index`, `modelData`, ...)
 *   4. ids of the component context, 5. the context's root object — repeated for enclosing
 *      contexts (delegates see the ids/root of the document they are declared in)
 *   6. engine globals (`Qt`, `qsTr`, user globals) and type statics (`Text.WordWrap`)
 *   7. JS globals (by falling through)
 */
import { QmlObject } from "./object.ts"
import type { ComponentContext } from "./types.ts"

export { createQtGlobal, QtBinding } from "./qt.ts"
export type { QtGlobal } from "./qt.ts"

/** One layer of a scope chain. */
export interface ScopeLayer {
  readonly kind: "layer"
  /** Debug label. */
  readonly label: string
  has(name: string): boolean
  get(name: string): unknown
  /** Assign; only called when `has(name)` is true. Throw to reject. */
  set(name: string, value: unknown): void
}

/** Anything `createScope` accepts: a layer, a QmlObject (its members) or a plain record. */
export type ScopeLayerInput = ScopeLayer | QmlObject | Record<string, unknown>

type Lazy<T> = T | (() => T)

function resolveLazy<T>(value: Lazy<T>): T {
  return typeof value === "function" ? (value as () => T)() : value
}

function isLayer(value: unknown): value is ScopeLayer {
  return typeof value === "object" && value !== null && (value as ScopeLayer).kind === "layer"
}

/** Properties, methods, signals and groups of an object (lazy: may resolve to null). */
export function objectLayer(object: Lazy<QmlObject | null>, label = "object"): ScopeLayer {
  return {
    kind: "layer",
    label,
    has: (name) => resolveLazy(object)?.hasMember(name) ?? false,
    get: (name) => resolveLazy(object)?.getMember(name),
    set: (name, value) => resolveLazy(object)!.setMember(name, value),
  }
}

/**
 * A plain record of values (context properties, globals, signal arguments). Getters on the
 * record are honoured (and may track reactive reads). Assignments write the record.
 */
export function recordLayer(record: Lazy<Record<string, unknown> | null | undefined>, label = "record"): ScopeLayer {
  return {
    kind: "layer",
    label,
    has: (name) => {
      const r = resolveLazy(record)
      return !!r && name in r
    },
    get: (name) => resolveLazy(record)?.[name],
    set: (name, value) => {
      const r = resolveLazy(record)
      if (r) r[name] = value
    },
  }
}

/** The ids of a component context; values are the objects' proxies. Ids are not assignable. */
export function idsLayer(context: ComponentContext): ScopeLayer {
  return {
    kind: "layer",
    label: "ids",
    has: (name) => context.ids.has(name),
    get: (name) => context.ids.get(name)?.proxy,
    set: (name) => {
      throw new TypeError(`Cannot assign to id "${name}"`)
    },
  }
}

/** Resolves exactly the name `parent` to the object's (tracked) parent proxy. */
export function parentLayer(object: QmlObject): ScopeLayer {
  return {
    kind: "layer",
    label: "parent",
    has: (name) => name === "parent",
    get: () => object.trackParent()?.proxy ?? null,
    set: (_name, value) => {
      const p = value === null || value === undefined ? null : (value as { __qml?: QmlObject }).__qml
      if (p instanceof QmlObject) p.appendChild(object)
      else object.parent?.removeChild(object)
    },
  }
}

/** Normalise a `createScope` input to a layer. */
export function toLayer(input: ScopeLayerInput): ScopeLayer {
  if (isLayer(input)) return input
  if (input instanceof QmlObject) return objectLayer(input)
  return recordLayer(input)
}

/**
 * A scope chain plus its `with`-target Proxy. Immutable: `extend()` returns a new scope with
 * an extra innermost layer (used for per-call signal parameters).
 */
export class QmlScope {
  /** The Proxy passed as `__scope` to compiled scripts. */
  readonly proxy: object
  readonly layers: readonly ScopeLayer[]

  constructor(
    layers: readonly ScopeLayer[],
    /** `this` inside scripts (the scope object's proxy). */
    readonly thisValue: unknown = undefined,
  ) {
    this.layers = layers
    const find = (name: string): ScopeLayer | undefined => {
      for (const layer of layers) if (layer.has(name)) return layer
      return undefined
    }
    this.proxy = new Proxy(Object.create(null) as object, {
      has(_t, key) {
        return typeof key === "string" && find(key) !== undefined
      },
      get(_t, key) {
        // `with` consults Symbol.unscopables; everything else symbolic is unknown.
        if (typeof key !== "string") return undefined
        return find(key)?.get(key)
      },
      set(_t, key, value) {
        if (typeof key !== "string") return false
        const layer = find(key)
        if (!layer) throw new ReferenceError(`${key} is not defined`)
        layer.set(key, value)
        return true
      },
      deleteProperty() {
        return false
      },
    })
  }

  /** Resolve a name without evaluating a script (tracked like a script read). */
  lookup(name: string): unknown {
    for (const layer of this.layers) if (layer.has(name)) return layer.get(name)
    return undefined
  }

  has(name: string): boolean {
    return this.layers.some((l) => l.has(name))
  }

  /** New scope with `values` as the innermost layer (e.g. signal parameters). */
  extend(values: Record<string, unknown> | ScopeLayer): QmlScope {
    return new QmlScope([toLayer(values), ...this.layers], this.thisValue)
  }
}

/** Build a scope from layers (QmlObjects, plain records or explicit layers), first match wins. */
export function createScope(chain: readonly ScopeLayerInput[], thisValue?: unknown): QmlScope {
  return new QmlScope(chain.map(toLayer), thisValue)
}

/**
 * The standard chain for `object` evaluated in `context` (see module docs), ending with
 * `globals` (engine globals: `Qt`, user context, type statics).
 */
export function buildObjectScope(object: QmlObject, context: ComponentContext, globals: readonly ScopeLayer[]): QmlScope {
  const layers: ScopeLayer[] = [
    objectLayer(object, "scope object"),
    parentLayer(object),
    recordLayer(() => object.contextProperties, "object context"),
  ]
  for (let ctx: ComponentContext | null = context; ctx; ctx = ctx.parent) {
    const c = ctx
    layers.push(recordLayer(() => c.contextProperties, "context properties"))
    layers.push(idsLayer(c))
    layers.push(objectLayer(() => (c.root === object ? null : c.root), "component root"))
  }
  layers.push(...globals)
  return new QmlScope(layers, object.proxy)
}
