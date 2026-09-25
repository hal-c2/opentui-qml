/**
 * Non-visual builtin types: QtObject, Timer, Repeater, Connections, Component, Loader,
 * ListModel / ListElement.
 */
import type { ObjectDefinition } from "../parser/ast.ts"
import { createSignal, untrack } from "./reactive.ts"
import type { Accessor, Setter } from "./reactive.ts"
import { createHandler } from "./expression.ts"
import { handlerToSignalName, isHandlerName, QmlObject, toQmlObject } from "./object.ts"
import type { QmlComponent, QmlEngine } from "./engine.ts"
import type { ComponentContext, HandlerSpec } from "./types.ts"

// -------------------------------------------------------------------------------------------
// QtObject

/** `QtObject { property int x: 1 }` — a plain non-visual object. */
export class QtObject extends QmlObject {}

// -------------------------------------------------------------------------------------------
// Component

/** Options for {@link ComponentObject.createInstance}. */
export interface ComponentInstanceOptions {
  parent?: QmlObject | null
  /** Index in `parent.children` (default: append). */
  index?: number
  contextProperties?: Record<string, unknown> | null
  initialProperties?: Record<string, unknown> | null
}

/**
 * `Component { Item {} }` and component-typed property values (`delegate: Item {}`).
 * Holds an uninstantiated ObjectDefinition plus the context it was declared in (so instances
 * see the enclosing document's ids), or a whole document (`QmlComponent`).
 *
 * The engine captures the first inline child object of any `ComponentObject` (subclasses
 * included) instead of instantiating it — subclass this for types that treat their child as a
 * delegate.
 *
 * JS API: `comp.createObject(parent?, properties?)` returns the new object's proxy.
 */
export class ComponentObject extends QmlObject {
  /** The captured definition (null for an empty Component). */
  definition: ObjectDefinition | null = null
  /** Context the definition was declared in. */
  declarationContext: ComponentContext | null = null
  /** Set when this wraps a whole document instead of an inline definition. */
  documentComponent: QmlComponent | null = null

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    this.defineMethod("createObject", (parent?: unknown, properties?: Record<string, unknown>) => {
      const obj = this.createInstance({ parent: toQmlObject(parent), initialProperties: properties ?? null })
      return obj?.proxy ?? null
    })
  }

  /** Wrap a loaded document as a Component value. */
  static fromDocument(engine: QmlEngine, component: QmlComponent): ComponentObject {
    const c = new ComponentObject(engine, "Component")
    c.documentComponent = component
    return c
  }

  /** Engine hook: capture the inline definition. */
  setDefinition(def: ObjectDefinition | null, context: ComponentContext): void {
    this.definition = def
    this.declarationContext = context
  }

  /** Instantiate the component (all phases, including completion). Null if empty. */
  createInstance(opts: ComponentInstanceOptions = {}): QmlObject | null {
    if (this.documentComponent) {
      return this.engine.instantiate(this.documentComponent.document.root, {
        component: this.documentComponent,
        parentContext: null,
        ...opts,
      })
    }
    const ctx = this.declarationContext
    if (!this.definition || !ctx || !ctx.component) {
      this.engine.warn(`${this.describe()}: component has no definition`)
      return null
    }
    return this.engine.instantiate(this.definition, { component: ctx.component, parentContext: ctx, ...opts })
  }
}

/** Resolve a `Component`-typed property value (proxy / raw) to a ComponentObject. */
export function toComponentObject(value: unknown): ComponentObject | null {
  const obj = toQmlObject(value)
  return obj instanceof ComponentObject ? obj : null
}

// -------------------------------------------------------------------------------------------
// ListModel / ListElement

/** `ListElement { name: "a"; value: 1 }` — any property is accepted (roles). */
export class ListElement extends QmlObject {
  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    this.allowDynamicProperties = true
  }

  /** The role values (untracked). */
  roles(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const name of this.propertyNames()) if (name !== "objectName") out[name] = this.peek(name)
    return out
  }
}

class ListRow {
  readonly values: Record<string, unknown>
  private readonly readVersion: Accessor<number>
  private readonly storeVersion: Setter<number>
  /** JS view of the row: tracked reads, writes go through `setProperty`. */
  readonly proxy: Record<string, unknown>

  constructor(values: Record<string, unknown>, model: ListModel) {
    this.values = { ...values }
    ;[this.readVersion, this.storeVersion] = createSignal(0)
    const row = this
    this.proxy = new Proxy(Object.create(null) as Record<string, unknown>, {
      get(_t, key) {
        if (typeof key !== "string") return undefined
        row.track()
        return row.values[key]
      },
      set(_t, key, value) {
        if (typeof key !== "string") return false
        const index = model.indexOfRow(row)
        if (index >= 0) model.setProperty(index, key, value)
        else row.update({ [key]: value })
        return true
      },
      has(_t, key) {
        row.track()
        return typeof key === "string" && key in row.values
      },
      ownKeys() {
        row.track()
        return Object.keys(row.values)
      },
      getOwnPropertyDescriptor(_t, key) {
        if (typeof key !== "string" || !(key in row.values)) return undefined
        return { enumerable: true, configurable: true, writable: true, value: row.values[key] }
      },
    })
  }

  track(): void {
    this.readVersion()
  }

  update(values: Record<string, unknown>): void {
    Object.assign(this.values, values)
    this.storeVersion((v) => v + 1)
  }
}

/**
 * `ListModel { ListElement { name: "a" } }`. Rows are plain objects; all changes are reactive:
 * structural changes (append/insert/remove/move/clear/set) bump the structure version (consumers
 * like Repeater rebuild), `setProperty` only notifies readers of that row.
 */
export class ListModel extends QmlObject {
  private rows: ListRow[] = []
  private readonly readStructure: Accessor<number>
  private readonly storeStructure: Setter<number>

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    ;[this.readStructure, this.storeStructure] = createSignal(0)
    this.defineProperty("count", { type: "int", readonly: true })
    this.defineProperty("dynamicRoles", { type: "bool" })
    this.defineMethod("get", (i: number) => this.get(i))
    this.defineMethod("append", (value: unknown) => this.append(value))
    this.defineMethod("insert", (i: number, value: unknown) => this.insert(i, value))
    this.defineMethod("remove", (i: number, n?: number) => this.remove(i, n))
    this.defineMethod("set", (i: number, value: Record<string, unknown>) => this.setRow(i, value))
    this.defineMethod("setProperty", (i: number, name: string, value: unknown) => this.setProperty(i, name, value))
    this.defineMethod("move", (from: number, to: number, n?: number) => this.move(from, to, n))
    this.defineMethod("clear", () => this.clear())
  }

  /** Tracked row count. */
  get count(): number {
    this.readStructure()
    return this.rows.length
  }

  /** Tracked: re-runs the caller on any structural change. Returns the row count. */
  trackStructure(): number {
    return this.count
  }

  /**
   * `get(i)` returns row `i` (the QML `ListModel.get` API); `get("name")` is the usual
   * QmlObject property read.
   */
  override get<T = unknown>(nameOrIndex: string | number): T {
    if (typeof nameOrIndex === "number") return this.getRow(nameOrIndex) as T
    return super.get(nameOrIndex) as T
  }

  /** Row `i` as a reactive JS object (reads tracked per row). */
  getRow(i: number): Record<string, unknown> | undefined {
    this.readStructure()
    return this.rows[i]?.proxy
  }

  /** Tracked snapshot of all rows as plain objects (tracks every row's values). */
  toArray(): Record<string, unknown>[] {
    this.readStructure()
    return this.rows.map((r) => {
      r.track()
      return { ...r.values }
    })
  }

  append(value: unknown): void {
    this.insert(untrack(() => this.rows.length), value)
  }

  insert(index: number, value: unknown): void {
    const items = Array.isArray(value) ? value : [value]
    const at = clampIndex(index, this.rows.length)
    this.rows.splice(at, 0, ...items.map((v) => new ListRow(plainRow(v), this)))
    this.changed()
  }

  remove(index: number, count = 1): void {
    if (index < 0 || index >= this.rows.length) {
      this.engine.warn(`ListModel.remove: index ${index} out of range`)
      return
    }
    this.rows.splice(index, Math.max(0, count))
    this.changed()
  }

  /** Replace row `index` (appends if `index === count`). */
  setRow(index: number, value: Record<string, unknown>): void {
    if (index === this.rows.length) return this.append(value)
    if (index < 0 || index > this.rows.length) {
      this.engine.warn(`ListModel.set: index ${index} out of range`)
      return
    }
    this.rows[index] = new ListRow(plainRow(value), this)
    this.changed()
  }

  setProperty(index: number, name: string, value: unknown): void {
    const row = this.rows[index]
    if (!row) {
      this.engine.warn(`ListModel.setProperty: index ${index} out of range`)
      return
    }
    row.update({ [name]: value })
  }

  move(from: number, to: number, count = 1): void {
    const moved = this.rows.splice(from, count)
    this.rows.splice(clampIndex(to, this.rows.length), 0, ...moved)
    this.changed()
  }

  clear(): void {
    this.rows = []
    this.changed()
  }

  /** Index of a row object (for row proxies writing back). */
  indexOfRow(row: ListRow): number {
    return this.rows.indexOf(row)
  }

  protected override onCompleted(): void {
    const elements = this.children.filter((c): c is ListElement => c instanceof ListElement)
    if (elements.length > 0) {
      this.rows.push(...elements.map((e) => new ListRow(e.roles(), this)))
      this.changed()
    }
  }

  private changed(): void {
    this.storeStructure((v) => v + 1)
    this.write("count", this.rows.length)
  }
}

function clampIndex(index: number, length: number): number {
  return Math.min(Math.max(0, Math.trunc(Number(index) || 0)), length)
}

function plainRow(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") return { ...(value as Record<string, unknown>) }
  return { modelData: value }
}

/** A model entry for delegates: the context properties to inject. */
export interface ModelEntry {
  index: number
  modelData: unknown
  model: unknown
  /** Role names (ListModel rows) — also injected as context names. */
  roles: string[]
}

/**
 * Normalise a `model` value: a number (N entries, modelData = index), an array
 * (modelData = element), or a ListModel (roles). Tracked: reads the ListModel structure.
 * Also used by visual list types.
 */
export function resolveModel(model: unknown): ModelEntry[] {
  if (typeof model === "number") {
    const n = Math.max(0, Math.trunc(model) || 0)
    return Array.from({ length: n }, (_, i) => ({ index: i, modelData: i, model: { index: i, modelData: i }, roles: [] }))
  }
  if (Array.isArray(model)) {
    return model.map((v, i) => ({ index: i, modelData: v, model: { index: i, modelData: v }, roles: [] }))
  }
  const obj = toQmlObject(model)
  if (obj instanceof ListModel) {
    const n = obj.trackStructure()
    const out: ModelEntry[] = []
    for (let i = 0; i < n; i++) {
      const row = untrack(() => obj.getRow(i))!
      out.push({ index: i, modelData: row, model: row, roles: untrack(() => Object.keys(row)) })
    }
    return out
  }
  return []
}

/** Context properties for a delegate instance (roles are live getters on the row). */
export function delegateContext(entry: ModelEntry): Record<string, unknown> {
  const ctx: Record<string, unknown> = { index: entry.index, modelData: entry.modelData, model: entry.model }
  const row = entry.model as Record<string, unknown>
  for (const role of entry.roles) {
    if (role === "index" || role === "modelData" || role === "model") continue
    Object.defineProperty(ctx, role, {
      enumerable: true,
      get: () => row[role],
      set: (v) => (row[role] = v),
    })
  }
  return ctx
}

// -------------------------------------------------------------------------------------------
// Repeater

/**
 * `Repeater { model: 3 | [...] | listModel; delegate: Item {} }`. Non-visual: instances are
 * inserted into the Repeater's *parent* right after the Repeater (`parent.appendChild(item,
 * index)`). Any model/delegate change recreates all instances.
 */
export class Repeater extends QmlObject {
  private items: QmlObject[] = []

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    this.defineProperty("model", { type: "var" })
    this.defineProperty("delegate", { type: "Component", value: null })
    this.defineProperty("count", { type: "int", readonly: true })
    this.defineSignal("itemAdded", ["index", "item"])
    this.defineSignal("itemRemoved", ["index", "item"])
    // Tracks `count`, so bindings using itemAt() update when the items are recreated.
    this.defineMethod("itemAt", (i: number) => (this.get("count"), this.items[i]?.proxy ?? null))
    this.defaultPropertyName = "delegate"
  }

  /** Current delegate instances (untracked). */
  get instances(): readonly QmlObject[] {
    return this.items
  }

  protected override onCompleted(): void {
    this.watch(() => {
      const entries = resolveModel(this.get("model"))
      const delegate = toComponentObject(this.get("delegate"))
      const parent = this.trackParent()
      untrack(() => this.regenerate(entries, delegate, parent))
    })
  }

  private regenerate(entries: ModelEntry[], delegate: ComponentObject | null, parent: QmlObject | null): void {
    this.clearItems()
    if (!delegate || !parent || this.isDestroyed) return
    const base = parent.children.indexOf(this) + 1
    entries.forEach((entry, i) => {
      const item = delegate.createInstance({
        parent,
        index: base + i,
        contextProperties: delegateContext(entry),
      })
      if (item) this.items.push(item)
    })
    this.write("count", this.items.length)
    this.items.forEach((item, i) => this.emit("itemAdded", i, item.proxy))
  }

  private clearItems(): void {
    const old = this.items
    this.items = []
    old.forEach((item, i) => {
      this.emit("itemRemoved", i, item.proxy)
      item.destroy()
    })
    if (old.length > 0) this.write("count", 0)
  }

  override destroy(): void {
    this.clearItems()
    super.destroy()
  }
}

// -------------------------------------------------------------------------------------------
// Loader

/**
 * `Loader { sourceComponent: comp; active: true }` (or `source: "Foo.qml"`). Like Repeater,
 * the item is inserted into the Loader's parent right after the Loader. Synchronous only.
 */
export class Loader extends QmlObject {
  private current: QmlObject | null = null

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    this.defineProperty("sourceComponent", { type: "Component", value: null })
    this.defineProperty("source", { type: "url" })
    this.defineProperty("active", { type: "bool", value: true })
    this.defineProperty("item", { type: "var", value: null, readonly: true })
    this.defineProperty("status", { type: "string", value: "Null", readonly: true })
    this.defineSignal("loaded")
    this.defaultPropertyName = "sourceComponent"
  }

  protected override onCompleted(): void {
    this.watch(() => {
      const comp = toComponentObject(this.get("sourceComponent"))
      const source = this.get("source") as string
      const active = this.get("active") as boolean
      const parent = this.trackParent()
      untrack(() => this.reload(comp, source, active, parent))
    })
  }

  private reload(comp: ComponentObject | null, source: string, active: boolean, parent: QmlObject | null): void {
    this.unload()
    if (!active || this.isDestroyed) return
    let factory = comp
    if (!factory && source) {
      const base = this.component.component?.directory ?? this.engine.basePath ?? "."
      const path = source.replace(/^file:\/\//, "")
      const loaded = this.engine.componentForFile(path.startsWith("/") ? path : `${base}/${path}`)
      if (!loaded) {
        this.write("status", "Error")
        this.engine.warn(`${this.describe()}: cannot load "${source}"`)
        return
      }
      factory = ComponentObject.fromDocument(this.engine, loaded)
      this.ownObject(factory)
    }
    if (!factory) return
    const index = parent ? parent.children.indexOf(this) + 1 : undefined
    const item = factory.createInstance({ parent, index })
    this.current = item
    this.write("item", item?.proxy ?? null)
    this.write("status", item ? "Ready" : "Error")
    if (item) this.emit("loaded")
  }

  private unload(): void {
    const old = this.current
    this.current = null
    if (old) {
      this.write("item", null)
      this.write("status", "Null")
      old.destroy()
    }
  }

  override destroy(): void {
    this.unload()
    super.destroy()
  }
}

// -------------------------------------------------------------------------------------------
// Timer

/**
 * `Timer { interval: 1000; running: true; repeat: true; triggeredOnStart: false; onTriggered: ... }`.
 * Starts after completion. Uses `engine.scheduler`. `start()/stop()/restart()` do not break a
 * binding on `running` (like Qt's C++ setters).
 */
export class Timer extends QmlObject {
  private handle: unknown = null
  private handleIsInterval = false

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    const sync = (): void => this.sync()
    this.defineProperty("interval", { type: "int", value: 1000, onChange: sync })
    this.defineProperty("running", { type: "bool", value: false, onChange: sync })
    this.defineProperty("repeat", { type: "bool", value: false, onChange: sync })
    this.defineProperty("triggeredOnStart", { type: "bool", value: false })
    this.defineSignal("triggered")
    this.defineMethod("start", () => this.write("running", true))
    this.defineMethod("stop", () => this.write("running", false))
    this.defineMethod("restart", () => {
      this.write("running", false)
      this.write("running", true)
    })
  }

  protected override onCompleted(): void {
    this.sync()
  }

  private sync(): void {
    this.clear()
    if (!this.isCompleted || this.isDestroyed || !this.peek("running")) return
    const scheduler = this.engine.scheduler
    const interval = Math.max(0, this.peek("interval") as number)
    const repeat = this.peek("repeat") as boolean
    if (repeat) {
      this.handleIsInterval = true
      this.handle = scheduler.setInterval(() => this.emit("triggered"), interval)
    } else {
      this.handleIsInterval = false
      this.handle = scheduler.setTimeout(() => {
        this.handle = null
        // Stop first so a handler calling start()/restart() re-arms the timer.
        this.write("running", false)
        this.emit("triggered")
      }, interval)
    }
    if (this.peek("triggeredOnStart")) this.emit("triggered")
  }

  private clear(): void {
    if (this.handle === null) return
    const scheduler = this.engine.scheduler
    if (this.handleIsInterval) scheduler.clearInterval(this.handle)
    else scheduler.clearTimeout(this.handle)
    this.handle = null
  }

  override destroy(): void {
    this.clear()
    super.destroy()
  }
}

// -------------------------------------------------------------------------------------------
// Connections

/**
 * `Connections { target: foo; function onClicked(mouse) {} }` (Qt6) and legacy
 * `onClicked: ...` bindings. Default target is the parent. Re-connects when `target` or
 * `enabled` change.
 */
export class Connections extends QmlObject {
  private legacy: HandlerSpec[] = []
  private disconnects: Array<() => void> = []

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    this.defineProperty("target", { type: "var" })
    this.defineProperty("enabled", { type: "bool", value: true })
    this.defineProperty("ignoreUnknownSignals", { type: "bool", value: false })
  }

  /** All `onXxx:` handlers written on a Connections object target the *target*. */
  override connectHandler(spec: HandlerSpec): boolean {
    this.legacy.push(spec)
    if (this.isCompleted) this.reconnect(this.currentTarget(), this.peek("enabled") as boolean)
    return true
  }

  protected override onCompleted(): void {
    this.watch(() => {
      const explicit = this.get("target")
      const parent = this.trackParent()
      const target = explicit === undefined ? parent : toQmlObject(explicit)
      const enabled = this.get("enabled") as boolean
      untrack(() => this.reconnect(target, enabled))
    })
  }

  private currentTarget(): QmlObject | null {
    const explicit = this.peek("target")
    return explicit === undefined ? this.parent : toQmlObject(explicit)
  }

  private reconnect(target: QmlObject | null, enabled: boolean): void {
    for (const d of this.disconnects.splice(0)) d()
    if (!target || !enabled || this.isDestroyed) return
    const ignoreUnknown = this.peek("ignoreUnknownSignals") as boolean
    for (const spec of this.legacy) {
      const signal = target.resolveHandlerSignal(spec.name)
      if (signal === null) {
        if (!ignoreUnknown) this.engine.warn(`Connections: ${target.describe()} has no signal for "${spec.name}"`)
        continue
      }
      this.disconnects.push(target.connect(signal, createHandler(spec.compiled, spec.scope, target.signalParams(signal))))
    }
    for (const name of this.methodNames()) {
      if (!isHandlerName(name)) continue
      const signal = target.resolveHandlerSignal(name) ?? (ignoreUnknown ? null : handlerToSignalName(name))
      if (signal === null) continue
      if (!target.hasSignal(signal)) {
        this.engine.warn(`Connections: ${target.describe()} has no signal for "${name}"`)
        continue
      }
      this.disconnects.push(target.connect(signal, (...args) => this.call(name, ...args)))
    }
  }

  override destroy(): void {
    for (const d of this.disconnects.splice(0)) d()
    super.destroy()
  }
}

// -------------------------------------------------------------------------------------------

/** Register all non-visual builtins on an engine. */
export function registerBuiltins(engine: QmlEngine): void {
  engine.registerType("QtObject", QtObject)
  engine.registerType("Component", ComponentObject)
  engine.registerType("Timer", Timer)
  engine.registerType("Repeater", Repeater)
  engine.registerType("Connections", Connections)
  engine.registerType("ListModel", ListModel)
  engine.registerType("ListElement", ListElement)
  engine.registerType("Loader", Loader)
}
