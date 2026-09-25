/**
 * QmlObject — the runtime object model.
 *
 * Every QML object (visual or not) is a `QmlObject` (or subclass). It owns:
 * - properties backed by solid signals (tracked reads, `${name}Changed` signals, bindings),
 * - signals with ordered handler lists (handler errors are logged, never thrown to the emitter),
 * - methods (called with `this` = the object's value proxy),
 * - a child list (visual and non-visual children, in declaration order),
 * - a solid owner root so all bindings/watchers are disposed on `destroy()`.
 *
 * JavaScript never sees a raw `QmlObject`: scripts get `obj.proxy`, a value Proxy whose
 * property reads are tracked and whose writes go through `set()` (breaking bindings, like Qt).
 *
 * Extension points for types (override in subclasses):
 * - `onChildAdded(child, index)` / `onChildRemoved(child, index)` — keep a renderable tree in sync.
 * - `onCompleted()` — called after the whole component tree is built and bound.
 * - `connectHandler(spec)` — how `onXxx:` handlers attach (Connections overrides this).
 * - `attachHandler(type, name, spec)` — attached handlers such as `Keys.onPressed`.
 * - `setAttached(type, name, value)` — attached properties such as `Layout.fillWidth`.
 * - `destroy()` — override to release resources; always call `super.destroy()`.
 */
import { batch, createComputed, createRoot, createSignal, getOwner, untrack } from "./reactive.ts"
import type { Accessor, Owner, Setter } from "./reactive.ts"
import { createHandler } from "./expression.ts"
import type { CompiledScript } from "./expression.ts"
import type { QmlEngine } from "./engine.ts"
import type { QmlScope } from "./scope.ts"
import type { BindingSource, ComponentContext, HandlerSpec, PropertyOptions, PropertyType } from "./types.ts"

/** Marker returned by `Qt.binding(fn)`; assigning it to a property (re)establishes a binding. */
export class QtBinding {
  constructor(readonly fn: () => unknown) {}
}

/** Number of evaluations of one binding within one synchronous flush treated as a binding loop. */
const BINDING_LOOP_LIMIT = 10_000

interface BindingRecord {
  dispose: () => void
  disposed: boolean
  /** Last logged error message; the same error is logged only once. */
  lastError: string | null
  runs: number
  resetScheduled: boolean
}

interface PropertySlot {
  readonly name: string
  type: PropertyType
  readonly: boolean
  required: boolean
  /** True once the property was assigned or bound (for `required` checks). */
  assigned: boolean
  read: Accessor<unknown>
  store: Setter<unknown>
  coerce: (value: unknown) => unknown
  onChange?: (value: unknown, old: unknown) => void
  binding: BindingRecord | null
  /** `property alias name: target.prop` */
  alias?: { target: QmlObject; prop: string }
}

interface Connection {
  fn: (...args: unknown[]) => unknown
  /** Original function passed by JS `signal.connect(fn)`, for `disconnect(fn)`. */
  key: unknown
  active: boolean
}

interface SignalSlot {
  readonly name: string
  params: string[]
  handlers: Connection[]
}

/** A callable signal emitter as seen from JS: `clicked()`, `clicked.connect(fn)`. */
export interface SignalEmitter {
  (...args: unknown[]): void
  connect(target: unknown, method?: unknown): void
  disconnect(target: unknown, method?: unknown): void
}

const proxyTargets = new WeakMap<object, QmlObject>()

/** Default value for a declared property type. */
export function defaultValueFor(type: PropertyType): unknown {
  switch (type) {
    case "int":
    case "real":
    case "double":
    case "number":
      return 0
    case "string":
    case "url":
      return ""
    case "bool":
      return false
    case "list":
      return []
    default:
      if (type.startsWith("list<")) return []
      // Declared object types (`property Item foo`) default to null, `var`/`color` to undefined.
      return /^[A-Z]/.test(type) ? null : undefined
  }
}

/** Built-in coercion for a declared property type (identity for passthrough types). */
export function coercionFor(type: PropertyType): (value: unknown) => unknown {
  switch (type) {
    case "int":
      return (v) => {
        const n = Math.trunc(Number(v ?? 0))
        return Number.isNaN(n) ? 0 : n
      }
    case "real":
    case "double":
    case "number":
      return (v) => Number(v ?? 0)
    case "string":
    case "url":
      return (v) => (v === null || v === undefined ? "" : String(v))
    case "bool":
      return (v) => Boolean(v)
    default:
      return identity
  }
}

const identity = (v: unknown): unknown => v

/**
 * Resolve a handler name to its signal name: `onClicked` → `clicked`,
 * `onWidthChanged` → `widthChanged`, `border.onColorChanged` → `border.colorChanged`.
 * Returns null if the name is not a handler name.
 */
export function handlerToSignalName(handlerName: string): string | null {
  const dot = handlerName.lastIndexOf(".")
  const prefix = dot >= 0 ? handlerName.slice(0, dot + 1) : ""
  const last = handlerName.slice(dot + 1)
  if (!isHandlerName(last)) return null
  return prefix + last.charAt(2).toLowerCase() + last.slice(3)
}

/** `onFoo` style name (`on` followed by an uppercase letter, digit or underscore). */
export function isHandlerName(name: string): boolean {
  return /^on[A-Z0-9_]/.test(name)
}

/** True for a raw QmlObject (not its proxy). */
export function isQmlObject(value: unknown): value is QmlObject {
  return value instanceof QmlObject
}

/** Unwrap a QmlObject value proxy (or pass through a raw QmlObject). Anything else → null. */
export function toQmlObject(value: unknown): QmlObject | null {
  if (value instanceof QmlObject) return value
  if (value !== null && (typeof value === "object" || typeof value === "function")) {
    return proxyTargets.get(value as object) ?? null
  }
  return null
}

/** The JS-facing value for a QmlObject (its proxy); other values pass through. */
export function toJsValue(value: unknown): unknown {
  return value instanceof QmlObject ? value.proxy : value
}

export class QmlObject {
  /** Type name as registered / written (`"Rectangle"`, `"Timer"`, `"MyButton"`). */
  readonly typeName: string
  readonly engine: QmlEngine
  /** The QML `id`, if any (informational; lookup goes through the component context). */
  id?: string
  /** All child objects in declaration order (visual and non-visual). Mutate via append/removeChild. */
  readonly children: QmlObject[] = []
  /**
   * Public value proxy. Scripts only ever see this: property reads are tracked, writes call
   * `set()`. Also exposes methods, signals (callable emitters), `parent`, `children`,
   * `destroy()` and the raw object under `__qml`.
   */
  readonly proxy: any
  /** The component instantiation this object was created in (ids, root object, context props). */
  component: ComponentContext
  /** Object-level context properties (e.g. `{ index, modelData }` on a delegate root). */
  contextProperties: Record<string, unknown> | null = null
  /**
   * Allow `set()` on undeclared properties without a warning (they become `var` properties).
   * Used by e.g. ListElement.
   */
  allowDynamicProperties = false
  /**
   * Name of the `default property`: set by the engine when a document declares one, or by a
   * native type in its constructor. For native types, inline child objects go to this property
   * instead of `children`: a Component-typed one captures the child as a Component (Repeater's
   * `delegate`), anything else receives the child's proxy (appended for list properties).
   */
  defaultPropertyName: string | null = null

  private readonly props = new Map<string, PropertySlot>()
  private readonly signals = new Map<string, SignalSlot>()
  private readonly methods = new Map<string, Function>()
  private readonly boundMethods = new Map<string, Function>()
  private readonly emitters = new Map<string, SignalEmitter>()
  private readonly groups = new Set<string>()
  private readonly groupProxies = new Map<string, object>()
  private readonly disposers = new Set<() => void>()
  private readonly owned: QmlObject[] = []
  private readonly warnedProps = new Set<string>()
  private readonly owner: Owner
  private readonly disposeRoot: () => void
  private readonly readParent: Accessor<QmlObject | null>
  private readonly storeParent: Setter<QmlObject | null>
  private readonly readChildrenVersion: Accessor<number>
  private readonly storeChildrenVersion: Setter<number>
  private _parent: QmlObject | null = null
  private _completed = false
  private _destroying = false
  private _destroyed = false

  constructor(engine: QmlEngine, typeName: string) {
    this.engine = engine
    this.typeName = typeName
    this.component = engine.rootContext
    let owner: Owner | null = null
    let dispose: () => void = () => {}
    createRoot((d) => {
      owner = getOwner()
      dispose = d
    }, null)
    this.owner = owner!
    this.disposeRoot = dispose
    ;[this.readParent, this.storeParent] = createSignal<QmlObject | null>(null, { equals: false })
    ;[this.readChildrenVersion, this.storeChildrenVersion] = createSignal(0)
    this.proxy = this.createValueProxy()
    proxyTargets.set(this.proxy, this)

    this.defineProperty("objectName", { type: "string" })
    // Attached `Component.onCompleted` / `Component.onDestruction` are internal signals.
    this.defineSignal("Component.completed")
    this.defineSignal("Component.destruction")
  }

  // ---------------------------------------------------------------------------------------------
  // Tree

  /** Parent object (untracked). Scripts reading `parent` are tracked. */
  get parent(): QmlObject | null {
    return this._parent
  }

  /** Tracked read of `parent` (use inside bindings/watchers). */
  trackParent(): QmlObject | null {
    this.readParent()
    return this._parent
  }

  /** Tracked read of the children list (use inside bindings/watchers). */
  trackChildren(): readonly QmlObject[] {
    this.readChildrenVersion()
    return this.children
  }

  /**
   * Insert `child` at `index` (default: end) in `children`, set its parent and call
   * `onChildAdded(child, actualIndex)`. Reparents if the child already has a parent.
   * `index` counts *all* children, visual or not; visual types map it to renderable order.
   */
  appendChild(child: QmlObject, index?: number): void {
    if (child === this) throw new Error("QML: an object cannot be its own child")
    if (child._parent) child._parent.removeChild(child)
    const len = this.children.length
    const at = index === undefined || index > len ? len : Math.max(0, Math.trunc(index))
    this.children.splice(at, 0, child)
    child._parent = this
    child.storeParent(() => this as QmlObject)
    this.storeChildrenVersion((v) => v + 1)
    untrack(() => this.onChildAdded(child, at))
  }

  /** Remove `child` from `children`, clear its parent and call `onChildRemoved`. */
  removeChild(child: QmlObject): void {
    const at = this.children.indexOf(child)
    if (at < 0) return
    this.children.splice(at, 1)
    child._parent = null
    child.storeParent(null)
    this.storeChildrenVersion((v) => v + 1)
    untrack(() => this.onChildRemoved(child, at))
  }

  /** Objects owned but not children (object-valued properties); destroyed with this object. */
  ownObject(obj: QmlObject): void {
    if (!this.owned.includes(obj)) this.owned.push(obj)
  }

  // ---------------------------------------------------------------------------------------------
  // Properties

  hasProperty(name: string): boolean {
    return this.props.has(name)
  }

  /** Declared type of a property (`undefined` if unknown). Aliases report the target's type. */
  propertyType(name: string): PropertyType | undefined {
    const slot = this.props.get(name)
    if (!slot) return undefined
    return slot.alias ? slot.alias.target.propertyType(slot.alias.prop) : slot.type
  }

  isReadonly(name: string): boolean {
    const slot = this.props.get(name)
    if (!slot) return false
    return slot.alias ? slot.alias.target.isReadonly(slot.alias.prop) : slot.readonly
  }

  /** Names of all defined properties (including dotted grouped/attached names). */
  propertyNames(): string[] {
    return [...this.props.keys()]
  }

  /**
   * Define a property backed by a solid signal, plus its `${name}Changed` signal.
   * Redefining an existing property updates its options (and value, if given) in place.
   * Dotted names (`"border.width"`) define grouped properties, readable in JS as `border.width`.
   */
  defineProperty(name: string, opts: PropertyOptions = {}): void {
    const type = opts.type ?? "var"
    const coerce = opts.coerce ?? coercionFor(type)
    const existing = this.props.get(name)
    if (existing && !existing.alias) {
      existing.type = type
      existing.coerce = coerce
      existing.readonly = opts.readonly ?? existing.readonly
      existing.required = opts.required ?? existing.required
      if (opts.onChange) existing.onChange = opts.onChange
      if ("value" in opts) this.writeSlot(existing, opts.value)
      return
    }
    const initial = "value" in opts ? coerce(opts.value) : defaultValueFor(type)
    const [read, store] = createSignal<unknown>(initial, { equals: false })
    this.props.set(name, {
      name,
      type,
      readonly: !!opts.readonly,
      required: !!opts.required,
      assigned: false,
      read,
      store,
      coerce,
      onChange: opts.onChange,
      binding: null,
    })
    this.defineSignal(`${name}Changed`)
    this.registerGroups(name)
  }

  /**
   * `property alias name: target.targetProp`. Reads, writes, bindings and change notifications
   * are forwarded to the target property. With `targetProp` null/empty, aliases the object itself
   * (a read-only property holding the target's proxy).
   */
  defineAlias(name: string, target: QmlObject, targetProp?: string | null): void {
    if (!targetProp) {
      this.defineProperty(name, { type: "var", value: target.proxy, readonly: true })
      return
    }
    if (!target.hasProperty(targetProp)) {
      throw new Error(`QML: alias "${name}" refers to unknown property "${targetProp}" of ${target}`)
    }
    const [read, store] = createSignal<unknown>(undefined)
    this.props.get(name)?.binding?.dispose()
    this.props.set(name, {
      name,
      type: "alias",
      readonly: false,
      required: false,
      assigned: false,
      read,
      store,
      coerce: identity,
      binding: null,
      alias: { target, prop: targetProp },
    })
    this.defineSignal(`${name}Changed`)
    this.registerGroups(name)
    const disconnect = target.connect(`${targetProp}Changed`, (...args) => this.emit(`${name}Changed`, ...args))
    this.disposers.add(disconnect)
  }

  /** Tracked read. Unknown properties read as `undefined`. */
  get(name: string): unknown {
    const slot = this.props.get(name)
    if (!slot) return undefined
    if (slot.alias) return slot.alias.target.get(slot.alias.prop)
    return slot.read()
  }

  /** Untracked read. */
  peek(name: string): unknown {
    return untrack(() => this.get(name))
  }

  /**
   * QML/JS assignment semantics: breaks any binding, coerces, stores and emits
   * `${name}Changed` if the value changed (`!Object.is`). Assigning a `Qt.binding(fn)` value
   * re-establishes a binding instead. Throws a TypeError for read-only properties. Unknown
   * properties are defined as `var` (with a warning unless `allowDynamicProperties`).
   */
  set(name: string, value: unknown): void {
    if (value instanceof QtBinding) {
      this.bind(name, value.fn)
      return
    }
    const slot = this.ensureSlot(name)
    if (slot.alias) {
      slot.alias.target.set(slot.alias.prop, value)
      return
    }
    if (slot.readonly) throw new TypeError(`Cannot assign to read-only property "${name}"`)
    this.disposeBinding(slot)
    this.writeSlot(slot, value)
  }

  /**
   * Low-level store for type implementations: coerces, stores and notifies, but ignores
   * `readonly` and does NOT break an existing binding. Defines unknown properties silently.
   * Use for read-only outputs (`count`, layout results) and C++-setter-like updates.
   */
  write(name: string, value: unknown): void {
    let slot = this.props.get(name)
    if (!slot) {
      this.defineProperty(name)
      slot = this.props.get(name)!
    }
    if (slot.alias) {
      slot.alias.target.write(slot.alias.prop, value)
      return
    }
    this.writeSlot(slot, value)
  }

  /**
   * Bind `name` reactively. `source` is a compiled QML script (evaluated in `scope`, default:
   * this object's scope in its component) or a plain function (called with `this` = proxy).
   * Replaces any existing binding. Evaluation errors are logged once and the previous value
   * is kept; binding loops are detected, logged and the binding is dropped.
   * Bindings bypass `readonly` (used for declaration initialisers).
   */
  bind(name: string, source: BindingSource, scope?: QmlScope | QmlObject): void {
    const slot = this.ensureSlot(name)
    if (slot.alias) {
      const resolved = typeof source === "function" ? scope : this.resolveScope(scope)
      slot.alias.target.bind(slot.alias.prop, source, resolved)
      return
    }
    this.disposeBinding(slot)
    slot.assigned = true

    let evaluate: () => unknown
    if (typeof source === "function") {
      const fn = source
      evaluate = () => fn.call(this.proxy)
    } else {
      const compiled: CompiledScript = source
      const sc = this.resolveScope(scope)
      evaluate = () => compiled.evaluate(sc)
    }

    const record: BindingRecord = { dispose: () => {}, disposed: false, lastError: null, runs: 0, resetScheduled: false }
    slot.binding = record
    createRoot((dispose) => {
      record.dispose = () => {
        record.disposed = true
        dispose()
      }
      createComputed(() => {
        if (record.disposed) return
        if (++record.runs > BINDING_LOOP_LIMIT) {
          this.engine.reportError(new Error(`QML: binding loop detected for property "${name}"`), this.describe())
          untrack(() => record.dispose())
          if (slot.binding === record) slot.binding = null
          return
        }
        if (!record.resetScheduled) {
          record.resetScheduled = true
          queueMicrotask(() => {
            record.runs = 0
            record.resetScheduled = false
          })
        }
        let value: unknown
        try {
          value = evaluate()
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (record.lastError !== msg) {
            record.lastError = msg
            this.engine.reportError(err, `${this.describe()}: binding for "${name}"`)
          }
          return
        }
        record.lastError = null
        untrack(() => this.writeSlot(slot, value))
      })
    }, this.owner)
  }

  /** Remove the binding on `name` (keeps the current value). */
  unbind(name: string): void {
    const slot = this.props.get(name)
    if (!slot) return
    if (slot.alias) return slot.alias.target.unbind(slot.alias.prop)
    this.disposeBinding(slot)
  }

  hasBinding(name: string): boolean {
    const slot = this.props.get(name)
    if (!slot) return false
    if (slot.alias) return slot.alias.target.hasBinding(slot.alias.prop)
    return slot.binding !== null
  }

  // ---------------------------------------------------------------------------------------------
  // Signals

  /** Declare a signal. Params are the names injected into block/expression handlers. */
  defineSignal(name: string, params: string[] = []): void {
    const existing = this.signals.get(name)
    if (existing) {
      existing.params = params
      return
    }
    this.signals.set(name, { name, params, handlers: [] })
  }

  hasSignal(name: string): boolean {
    return this.signals.has(name)
  }

  /** Declared parameter names of a signal (empty for unknown signals). */
  signalParams(name: string): readonly string[] {
    return this.signals.get(name)?.params ?? []
  }

  /** Names of all signals, including implicit `${prop}Changed` ones. */
  signalNames(): string[] {
    return [...this.signals.keys()]
  }

  /**
   * Call all handlers in connection order. Each handler runs untracked inside a solid `batch`
   * (multi-assignments don't glitch). A throwing handler is logged and does not stop the others.
   */
  emit(name: string, ...args: unknown[]): void {
    const slot = this.signals.get(name)
    if (!slot || slot.handlers.length === 0) return
    const list = slot.handlers.slice()
    batch(() => {
      for (const conn of list) {
        if (!conn.active) continue
        try {
          untrack(() => conn.fn(...args))
        } catch (err) {
          this.engine.reportError(err, `${this.describe()}: handler for signal "${name}"`)
        }
      }
    })
  }

  /** Connect a handler; returns a disconnect function. Unknown signals are declared on the fly. */
  connect(name: string, handler: (...args: unknown[]) => unknown, key?: unknown): () => void {
    let slot = this.signals.get(name)
    if (!slot) {
      this.defineSignal(name)
      slot = this.signals.get(name)!
    }
    const conn: Connection = { fn: handler, key: key ?? handler, active: true }
    slot.handlers.push(conn)
    const s = slot
    return () => {
      conn.active = false
      const i = s.handlers.indexOf(conn)
      if (i >= 0) s.handlers.splice(i, 1)
    }
  }

  /** Disconnect handlers previously connected with `key` (the function passed to `connect`). */
  disconnect(name: string, key: unknown): void {
    const slot = this.signals.get(name)
    if (!slot) return
    for (const conn of slot.handlers.filter((c) => c.key === key)) {
      conn.active = false
      slot.handlers.splice(slot.handlers.indexOf(conn), 1)
    }
  }

  /**
   * Attach an `onXxx:` handler written on this object. The default resolves the signal
   * (`onClicked` → `clicked`, `onWidthChanged` → `widthChanged`) and connects a handler that
   * injects the signal's named params. Returns false if there is no such signal.
   * Override for types that route handlers elsewhere (e.g. Connections).
   */
  connectHandler(spec: HandlerSpec): boolean {
    const signal = this.resolveHandlerSignal(spec.name)
    if (signal === null) return false
    this.connect(signal, createHandler(spec.compiled, spec.scope, this.signalParams(signal)))
    return true
  }

  /** Signal name a handler name refers to on this object, or null. */
  resolveHandlerSignal(handlerName: string): string | null {
    const signal = handlerToSignalName(handlerName)
    if (signal === null) return null
    if (this.hasSignal(signal)) return signal
    // `onURLChanged` style: keep the original capitalisation.
    const dot = handlerName.lastIndexOf(".")
    const raw = handlerName.slice(0, dot + 1) + handlerName.slice(dot + 3)
    return this.hasSignal(raw) ? raw : null
  }

  // ---------------------------------------------------------------------------------------------
  // Methods

  /** Define a method. It is called with `this` = the object's value proxy. */
  defineMethod(name: string, fn: Function): void {
    this.methods.set(name, fn)
    this.boundMethods.delete(name)
  }

  hasMethod(name: string): boolean {
    return this.methods.has(name)
  }

  methodNames(): string[] {
    return [...this.methods.keys()]
  }

  /** Call a method by name (errors propagate to the caller). */
  call(name: string, ...args: unknown[]): unknown {
    const fn = this.methods.get(name)
    if (!fn) throw new TypeError(`${this.describe()}: no method "${name}"`)
    return fn.apply(this.proxy, args)
  }

  // ---------------------------------------------------------------------------------------------
  // Attached properties / handlers (extension points)

  /**
   * Attached handler such as `Keys.onPressed: ...`. `Component.onCompleted/onDestruction` are
   * handled by the engine and never reach this. Visual types override; the default warns.
   */
  attachHandler(attachedType: string, handlerName: string, spec: HandlerSpec): void {
    void spec
    this.engine.warn(`${this.describe()}: attached handler "${attachedType}.${handlerName}" is not supported`)
  }

  /**
   * Attached property value such as `Layout.fillWidth: true`. Called reactively by the engine
   * whenever a bound value changes. Default: store it as property `"Layout.fillWidth"`, so it
   * is readable in JS as `item.Layout.fillWidth`.
   */
  setAttached(attachedType: string, name: string, value: unknown): void {
    this.write(`${attachedType}.${name}`, value)
  }

  // ---------------------------------------------------------------------------------------------
  // Lifecycle

  get isCompleted(): boolean {
    return this._completed
  }

  get isDestroyed(): boolean {
    return this._destroyed
  }

  /** True while `destroy()` is running (children skip detaching from a dying parent). */
  get isDestroying(): boolean {
    return this._destroying
  }

  /**
   * Engine-internal: mark construction complete, check required properties, call
   * `onCompleted()` and emit `Component.completed`. Idempotent.
   */
  completeConstruction(): void {
    if (this._completed || this._destroyed) return
    this._completed = true
    for (const slot of this.props.values()) {
      if (slot.required && !slot.assigned) {
        this.engine.warn(`${this.describe()}: required property "${slot.name}" was not initialized`)
      }
    }
    try {
      untrack(() => this.onCompleted())
    } catch (err) {
      this.engine.reportError(err, `${this.describe()}: onCompleted`)
    }
    this.emit("Component.completed")
  }

  /**
   * Run `fn` reactively in this object's owner: it re-runs when anything it reads changes and
   * is disposed on `destroy()`. Errors are logged. Returns a disposer.
   */
  watch(fn: () => void): () => void {
    let dispose: () => void = () => {}
    createRoot((d) => {
      dispose = d
      createComputed(() => {
        try {
          fn()
        } catch (err) {
          this.engine.reportError(err, `${this.describe()}: watcher`)
        }
      })
    }, this.owner)
    const stop = (): void => {
      this.disposers.delete(stop)
      dispose()
    }
    this.disposers.add(stop)
    return stop
  }

  /** Register a cleanup to run on `destroy()`. */
  onDestroy(fn: () => void): void {
    this.disposers.add(fn)
  }

  /**
   * Destroy: emits `Component.destruction`, destroys children and owned objects, disposes all
   * bindings/watchers, detaches from the parent (`parent.onChildRemoved`) and drops all signal
   * connections. Subclasses override to release resources and must call `super.destroy()`.
   */
  destroy(): void {
    if (this._destroyed || this._destroying) return
    this._destroying = true
    this.emit("Component.destruction")
    for (const child of this.children.slice()) child.destroy()
    for (const obj of this.owned.splice(0)) obj.destroy()
    for (const slot of this.props.values()) this.disposeBinding(slot)
    for (const dispose of [...this.disposers]) {
      try {
        dispose()
      } catch (err) {
        this.engine.reportError(err, `${this.describe()}: destroy`)
      }
    }
    this.disposers.clear()
    this.disposeRoot()
    const parent = this._parent
    if (parent && !parent._destroying) parent.removeChild(this)
    this.children.length = 0
    for (const sig of this.signals.values()) {
      for (const c of sig.handlers) c.active = false
      sig.handlers.length = 0
    }
    this._destroyed = true
    this._destroying = false
    this.engine.objectDestroyed(this)
  }

  /** Called after a child was inserted at `index` of `children`. */
  protected onChildAdded(child: QmlObject, index: number): void {
    void child
    void index
  }

  /** Called after a child was removed (it was at `index`). */
  protected onChildRemoved(child: QmlObject, index: number): void {
    void child
    void index
  }

  /** Called once after the whole component tree is built and bound (children first). */
  protected onCompleted(): void {}

  // ---------------------------------------------------------------------------------------------
  // Scope / JS access

  /** This object's default scope (scope object = this, in its component context). */
  get scope(): QmlScope {
    return this.engine.scopeFor(this)
  }

  /** Is `name` a property, method, signal or property group of this object? */
  hasMember(name: string): boolean {
    return this.props.has(name) || this.methods.has(name) || this.signals.has(name) || this.groups.has(name)
  }

  /** JS-facing member value: tracked property read, bound method, signal emitter or group proxy. */
  getMember(name: string): unknown {
    if (this.props.has(name)) return this.get(name)
    if (this.methods.has(name)) return this.boundMethod(name)
    if (this.signals.has(name)) return this.signalEmitter(name)
    if (this.groups.has(name)) return this.groupProxy(name)
    return undefined
  }

  /** JS assignment to a member. Methods and signals are not assignable. */
  setMember(name: string, value: unknown): void {
    if (!this.props.has(name) && (this.methods.has(name) || this.signals.has(name))) {
      throw new TypeError(`Cannot assign to ${this.methods.has(name) ? "method" : "signal"} "${name}"`)
    }
    this.set(name, value)
  }

  /** A method bound to this object's proxy (stable identity). */
  boundMethod(name: string): Function | undefined {
    let fn = this.boundMethods.get(name)
    if (!fn) {
      const method = this.methods.get(name)
      if (!method) return undefined
      fn = method.bind(this.proxy)
      this.boundMethods.set(name, fn!)
    }
    return fn
  }

  /** Callable emitter for a signal (stable identity), with `connect`/`disconnect`. */
  signalEmitter(name: string): SignalEmitter {
    let emitter = this.emitters.get(name)
    if (!emitter) {
      const self = this
      const e = ((...args: unknown[]) => self.emit(name, ...args)) as SignalEmitter
      e.connect = (target: unknown, method?: unknown) => {
        const fn = resolveSlot(target, method)
        self.connect(name, fn, method ?? target)
      }
      e.disconnect = (target: unknown, method?: unknown) => self.disconnect(name, method ?? target)
      this.emitters.set(name, e)
      emitter = e
    }
    return emitter
  }

  toString(): string {
    return this.describe()
  }

  /** `TypeName(id)` for messages. */
  describe(): string {
    return this.id ? `${this.typeName}(${this.id})` : this.typeName
  }

  // ---------------------------------------------------------------------------------------------
  // Internals

  private resolveScope(scope: QmlScope | QmlObject | undefined): QmlScope {
    if (scope instanceof QmlObject) return this.engine.scopeFor(scope)
    return scope ?? this.engine.scopeFor(this)
  }

  private ensureSlot(name: string): PropertySlot {
    let slot = this.props.get(name)
    if (!slot) {
      if (!this.allowDynamicProperties && !this.warnedProps.has(name)) {
        this.warnedProps.add(name)
        this.engine.warn(`${this.describe()}: assigning to undeclared property "${name}" (defined as var)`)
      }
      this.defineProperty(name)
      slot = this.props.get(name)!
    }
    return slot
  }

  private disposeBinding(slot: PropertySlot): void {
    if (slot.binding) {
      const b = slot.binding
      slot.binding = null
      b.dispose()
    }
  }

  private writeSlot(slot: PropertySlot, value: unknown): void {
    slot.assigned = true
    const v = slot.coerce(value)
    const old = untrack(slot.read)
    if (Object.is(old, v)) return
    slot.store(() => v)
    if (slot.onChange) {
      try {
        untrack(() => slot.onChange!(v, old))
      } catch (err) {
        this.engine.reportError(err, `${this.describe()}: onChange for "${slot.name}"`)
      }
    }
    this.emit(`${slot.name}Changed`, v, old)
  }

  private registerGroups(name: string): void {
    let dot = name.indexOf(".")
    while (dot > 0) {
      this.groups.add(name.slice(0, dot))
      dot = name.indexOf(".", dot + 1)
    }
  }

  private groupProxy(prefix: string): object {
    let p = this.groupProxies.get(prefix)
    if (!p) {
      const self = this
      const full = (key: string): string => `${prefix}.${key}`
      p = new Proxy(Object.create(null) as object, {
        get(_t, key) {
          if (typeof key !== "string") return undefined
          return self.hasMember(full(key)) ? self.getMember(full(key)) : undefined
        },
        set(_t, key, value) {
          if (typeof key !== "string") return false
          self.set(full(key), value)
          return true
        },
        has(_t, key) {
          return typeof key === "string" && self.hasMember(full(key))
        },
        ownKeys() {
          return self.memberKeysUnder(prefix)
        },
        getOwnPropertyDescriptor(_t, key) {
          if (typeof key !== "string" || !self.hasMember(full(key))) return undefined
          return { enumerable: true, configurable: true, writable: true, value: self.getMember(full(key)) }
        },
      })
      this.groupProxies.set(prefix, p)
    }
    return p
  }

  private memberKeysUnder(prefix: string): string[] {
    const keys = new Set<string>()
    const start = prefix ? prefix + "." : ""
    for (const name of this.props.keys()) {
      if (!name.startsWith(start)) continue
      const rest = name.slice(start.length)
      keys.add(rest.split(".")[0]!)
    }
    return [...keys]
  }

  private createValueProxy(): any {
    const self = this
    return new Proxy(Object.create(null) as object, {
      get(_t, key) {
        if (typeof key === "symbol") {
          if (key === Symbol.toStringTag) return self.typeName
          if (key === Symbol.toPrimitive) return () => self.describe()
          return undefined
        }
        switch (key) {
          case "__qml":
            return self
          case "parent":
            return self.trackParent()?.proxy ?? null
          case "children":
            return self.trackChildren().map((c) => c.proxy)
        }
        if (self.hasMember(key)) return self.getMember(key)
        switch (key) {
          case "destroy":
            return () => self.destroy()
          case "toString":
            return () => self.describe()
        }
        return undefined
      },
      set(_t, key, value) {
        if (typeof key === "symbol") return false
        if (key === "parent") {
          const p = toQmlObject(value)
          if (p) p.appendChild(self)
          else self._parent?.removeChild(self)
          return true
        }
        self.setMember(key, value)
        return true
      },
      has(_t, key) {
        return typeof key === "string" && (key === "parent" || key === "children" || self.hasMember(key))
      },
      ownKeys() {
        return self.memberKeysUnder("").filter((k) => self.props.has(k) || self.groups.has(k))
      },
      getOwnPropertyDescriptor(_t, key) {
        if (typeof key !== "string" || !(self.props.has(key) || self.groups.has(key))) return undefined
        return { enumerable: true, configurable: true, writable: true, value: self.getMember(key) }
      },
    })
  }
}

/** `sig.connect(fn)` or `sig.connect(obj, method)` / `sig.connect(obj, "methodName")`. */
function resolveSlot(target: unknown, method: unknown): (...args: unknown[]) => unknown {
  if (typeof target === "function" && method === undefined) return target as (...a: unknown[]) => unknown
  if (typeof method === "function") return (...args) => (method as Function).apply(target, args)
  if (typeof method === "string" && target && typeof target === "object") {
    return (...args) => ((target as Record<string, Function>)[method] as Function).apply(target, args)
  }
  throw new TypeError("connect: expected a function")
}
