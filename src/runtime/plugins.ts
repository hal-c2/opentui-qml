/**
 * Plugins: OpenTUI's slot registry exposed to QML.
 *
 * - One `CoreSlotRegistry` per engine (lazily created, shared per renderer — OpenTUI keys the
 *   core registry by renderer). Its context is `{ engine, renderer, root, ...engine.globals }`;
 *   `root` is filled in by `runQml` once the document is instantiated.
 * - TypeScript plugins (`registerPlugin`) are OpenTUI `CorePlugin`s whose slot renderers may
 *   also return a `VisualObject` (its renderable is mounted, the object is destroyed with it)
 *   or a QML source string (instantiated with the slot data as context properties).
 * - QML plugins are documents whose root is `Plugin { pluginId: "x"; Contribution { ... } }`
 *   (`loadQmlPlugin`, `loadPluginsFromDir`). A `Plugin` object registers itself with the
 *   registry when it completes and unregisters when destroyed.
 *
 * Plugin failures never throw into the host: the registry isolates setup/render/dispose
 * errors and reports them to `engine.reportError` (and to a `pluginError` signal on the
 * application root, if the root declares one).
 */
import { readdirSync, statSync } from "node:fs"
import { basename, extname, join, resolve } from "node:path"
import {
  BaseRenderable,
  createCoreSlotRegistry,
  registerCorePlugin,
  type CliRenderer,
  type CoreManagedSlot,
  type CorePlugin,
  type CoreSlotContribution,
  type CoreSlotRegistry,
  type PluginErrorEvent,
} from "@opentui/core"
import { ComponentObject } from "./builtins.ts"
import type { QmlComponent, QmlEngine } from "./engine.ts"
import { QmlObject, toQmlObject } from "./object.ts"
import { createSignal } from "./reactive.ts"
import type { QmlTypeFactory } from "./types.ts"

// ---------------------------------------------------------------------------------------------
// Types

/** The registry context every slot renderer / plugin `setup` receives. */
export interface QmlSlotContext {
  engine: QmlEngine
  renderer: CliRenderer
  /** The application root's proxy (set by `runQml`; null before the document exists). */
  root: unknown
  [key: string]: unknown
}

export type QmlSlotData = Record<string, unknown>

/**
 * What a slot renderer may return: an OpenTUI renderable, a visual `QmlObject` (or its proxy),
 * or QML source text (instantiated with `{ data, ...data }` as context properties).
 */
export type QmlSlotResult = BaseRenderable | QmlObject | string | object

/**
 * A slot renderer. Declared with method syntax (bivariant parameters) so OpenTUI `CorePlugin`s
 * typed with narrower context/data types are still accepted.
 */
export type QmlSlotRenderer = {
  render(ctx: Readonly<QmlSlotContext>, data: QmlSlotData): QmlSlotResult
}["render"]

export interface QmlManagedSlot {
  render: QmlSlotRenderer
  onActivate?(ctx: Readonly<QmlSlotContext>): void
  onDeactivate?(ctx: Readonly<QmlSlotContext>): void
  onDispose?(ctx: Readonly<QmlSlotContext>): void
}

/** A TypeScript plugin: an OpenTUI `CorePlugin` whose renderers may also return QML. */
export interface QmlPluginSpec {
  id: string
  order?: number
  setup?(ctx: Readonly<QmlSlotContext>, renderer: CliRenderer): void
  dispose?(): void
  slots: Record<string, QmlSlotRenderer | QmlManagedSlot | undefined>
}

/**
 * Any TypeScript plugin accepted by `registerPlugin`: a {@link QmlPluginSpec} or an OpenTUI
 * `CorePlugin` (which is structurally assignable to it). Kept as a single type, not a union,
 * so inline plugin literals get contextually typed `ctx`/`data` parameters.
 */
export type AnyPlugin = QmlPluginSpec

export type QmlSlotRegistry = CoreSlotRegistry<string, QmlSlotContext, QmlSlotData>

export interface PluginInfo {
  id: string
  order: number
  kind: "ts" | "qml"
  /** Source file for QML plugins. */
  file?: string
}

interface PluginEntry {
  id: string
  kind: "ts" | "qml"
  order: number
  file?: string
  object?: PluginObject
  unregister: () => void
}

// ---------------------------------------------------------------------------------------------
// Slot data identity

/**
 * Hidden key on the data object a `Slot` passes to its `SlotRenderable`: the owning Slot
 * object. QML contributions use it to keep one delegate instance per slot (updated in place
 * when the slot's data changes instead of being recreated).
 */
export const SLOT_OWNER: unique symbol = Symbol.for("opentui-qml.slotOwner") as never
const slotDataOwners = new WeakMap<object, object>()

/**
 * Prepare a Slot's `data` value for `SlotRenderable.data`: plain objects are shallow-copied
 * (so every assignment re-renders) and tagged with the owner; other objects are tagged via a
 * WeakMap; primitives become `{ value }`; null/undefined become `{}`.
 */
export function wrapSlotData(value: unknown, owner: object): QmlSlotData {
  if (value === null || value === undefined) value = {}
  if (typeof value !== "object" && typeof value !== "function") value = { value }
  const obj = value as Record<string | symbol, unknown>
  const proto = Object.getPrototypeOf(obj)
  if (proto === Object.prototype || proto === null) {
    const copy: Record<string | symbol, unknown> = { ...obj }
    Object.defineProperty(copy, SLOT_OWNER, { value: owner, enumerable: false })
    return copy as QmlSlotData
  }
  slotDataOwners.set(obj, owner)
  return obj as QmlSlotData
}

/** The identity used to key per-slot instances: the owning Slot, else the data object. */
function slotKeyOf(data: unknown): object {
  if (data && typeof data === "object") {
    const tagged = (data as Record<symbol, unknown>)[SLOT_OWNER]
    if (tagged && typeof tagged === "object") return tagged
    return slotDataOwners.get(data) ?? data
  }
  return slotKeyFallback
}
const slotKeyFallback = {}

function isDying(key: object): boolean {
  const obj = toQmlObject(key)
  return !!obj && (obj.isDestroyed || obj.isDestroying)
}

// ---------------------------------------------------------------------------------------------
// Plugin host (one per engine)

const hosts = new WeakMap<QmlEngine, PluginHost>()
const registriesByRenderer = new WeakMap<CliRenderer, { registry: QmlSlotRegistry; context: QmlSlotContext }>()
const lifetimeBound = new WeakSet<QmlObject>()
const sourceCache = new WeakMap<QmlEngine, Map<string, QmlComponent>>()

class PluginHost {
  readonly registry: QmlSlotRegistry
  readonly context: QmlSlotContext
  readonly entries = new Map<string, PluginEntry>()
  root: QmlObject | null = null
  private readonly offError: () => void

  constructor(readonly engine: QmlEngine) {
    const renderer = engine.renderer
    if (!renderer) throw new Error("QML: plugins and Slots need an engine with a renderer")
    const shared = registriesByRenderer.get(renderer)
    if (shared) {
      this.registry = shared.registry
      this.context = shared.context
    } else {
      this.context = { ...engine.globals, engine, renderer, root: null }
      this.registry = createCoreSlotRegistry<string, QmlSlotContext, QmlSlotData>(renderer, this.context)
      registriesByRenderer.set(renderer, { registry: this.registry, context: this.context })
      renderer.once("destroy", () => registriesByRenderer.delete(renderer))
    }
    this.offError = this.registry.onPluginError((event) => this.onPluginError(event))
  }

  private onPluginError(event: PluginErrorEvent): void {
    const where = `${event.phase}${event.slot ? `, slot "${event.slot}"` : ""}`
    this.engine.reportError(event.error, `plugin "${event.pluginId}" (${where})`)
    const root = this.root
    if (root && !root.isDestroyed && root.hasSignal("pluginError")) {
      root.emit("pluginError", {
        pluginId: event.pluginId,
        slot: event.slot,
        phase: event.phase,
        message: event.error.message,
        error: event.error,
      })
    }
  }

  /** Register `plugin`; returns false (after reporting) on a duplicate id or failing setup. */
  add(entry: PluginEntry, plugin: CorePlugin<string, QmlSlotContext, QmlSlotData>): boolean {
    if (this.entries.has(entry.id)) {
      this.engine.reportError(new Error(`plugin "${entry.id}" is already registered`), "registerPlugin")
      return false
    }
    let setupOk = true
    const setup = plugin.setup
    if (setup) {
      setupOk = false
      plugin = {
        ...plugin,
        setup: (ctx, renderer) => {
          setup(ctx, renderer)
          setupOk = true
        },
      }
    }
    let off: () => void
    try {
      off = registerCorePlugin(this.registry, plugin)
    } catch (err) {
      this.engine.reportError(err, `plugin "${entry.id}"`)
      return false
    }
    // A failing `setup` leaves the plugin unregistered (the registry reported the error).
    if (!setupOk) return false
    entry.unregister = () => {
      if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id)
      off()
    }
    this.entries.set(entry.id, entry)
    return true
  }

  dispose(): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.object) entry.object.destroy()
      else entry.unregister()
    }
    this.entries.clear()
    this.offError()
    hosts.delete(this.engine)
  }
}

function host(engine: QmlEngine): PluginHost {
  let h = hosts.get(engine)
  if (!h) {
    h = new PluginHost(engine)
    hosts.set(engine, h)
  }
  return h
}

/** The engine's slot registry (created on first use). Throws for engines without a renderer. */
export function getSlotRegistry(engine: QmlEngine): QmlSlotRegistry {
  return host(engine).registry
}

/** The registry context (`{ engine, renderer, root, ...globals }`), mutable by the host app. */
export function getSlotContext(engine: QmlEngine): QmlSlotContext {
  return host(engine).context
}

/** Set the application root (visible as `ctx.root`; receives `pluginError` signals). */
export function setPluginRoot(engine: QmlEngine, root: QmlObject | null): void {
  const h = host(engine)
  h.root = root
  h.context.root = root?.proxy ?? null
}

// ---------------------------------------------------------------------------------------------
// Slot results → renderables

/** Destroy `obj` when OpenTUI destroys its renderable (host-owned slot nodes). */
function bindLifetime(obj: QmlObject & { renderable: BaseRenderable }): void {
  if (lifetimeBound.has(obj)) return
  lifetimeBound.add(obj)
  obj.renderable.once("destroyed", () => {
    if (!obj.isDestroyed && !obj.isDestroying) obj.destroy()
  })
}

function visualOf(obj: QmlObject): (QmlObject & { renderable: BaseRenderable }) | null {
  const r = (obj as { renderable?: unknown }).renderable
  return r instanceof BaseRenderable ? (obj as QmlObject & { renderable: BaseRenderable }) : null
}

/**
 * Instantiate QML source text (components are cached per source). `contextProps` become
 * context names in the new document.
 */
export function createFromSource(
  engine: QmlEngine,
  source: string,
  parent?: QmlObject | null,
  contextProps?: Record<string, unknown> | null,
): QmlObject {
  let cache = sourceCache.get(engine)
  if (!cache) {
    cache = new Map()
    sourceCache.set(engine, cache)
  }
  let component = cache.get(source)
  if (!component) {
    component = engine.loadSource(source)
    cache.set(source, component)
  }
  return engine.createObject(component, parent ?? null, contextProps ?? null)
}

function sourceContext(data: QmlSlotData): Record<string, unknown> {
  const ctx: Record<string, unknown> = { ...data }
  ctx.data = data
  ctx.slotData = data
  return ctx
}

/** Convert a renderer's result into a renderable (the registry validates the rest). */
function toNode(engine: QmlEngine, result: QmlSlotResult, data: QmlSlotData, created?: Set<QmlObject>): BaseRenderable {
  if (typeof result === "string") {
    const obj = createFromSource(engine, result, null, sourceContext(data))
    const visual = visualOf(obj)
    if (!visual) {
      obj.destroy()
      throw new Error(`slot QML source must have a visual root object (got ${obj.typeName})`)
    }
    bindLifetime(visual)
    created?.add(visual)
    return visual.renderable
  }
  const obj = toQmlObject(result)
  if (obj) {
    const visual = visualOf(obj)
    if (!visual) throw new Error(`slot renderer returned a non-visual object (${obj.typeName})`)
    bindLifetime(visual)
    return visual.renderable
  }
  return result as BaseRenderable
}

/** Destroy objects we created for a managed slot that are no longer mounted anywhere. */
function sweep(created: Set<QmlObject>): void {
  for (const obj of [...created]) {
    const r = (obj as { renderable?: BaseRenderable }).renderable
    if (obj.isDestroyed || !r || !r.parent) {
      created.delete(obj)
      if (!obj.isDestroyed) obj.destroy()
    }
  }
}

function wrapContribution(
  engine: QmlEngine,
  contribution: QmlSlotRenderer | QmlManagedSlot,
): CoreSlotContribution<QmlSlotContext, QmlSlotData> {
  if (typeof contribution === "function") {
    return (ctx, data) => toNode(engine, contribution(ctx, data), data)
  }
  const created = new Set<QmlObject>()
  const managed: CoreManagedSlot<QmlSlotContext, QmlSlotData> = {
    render: (ctx, data) => {
      sweep(created)
      return toNode(engine, contribution.render(ctx, data), data, created)
    },
    onActivate: contribution.onActivate,
    onDeactivate: contribution.onDeactivate,
    onDispose: (ctx) => {
      try {
        contribution.onDispose?.(ctx)
      } finally {
        sweep(created)
      }
    },
  }
  return managed
}

// ---------------------------------------------------------------------------------------------
// Registration API

/**
 * Register a TypeScript plugin (an OpenTUI `CorePlugin` or a {@link QmlPluginSpec}).
 * Returns an unregister function. Errors (duplicate id, failing `setup`) are reported through
 * `engine.reportError`; they never throw.
 */
export function registerPlugin(engine: QmlEngine, plugin: AnyPlugin): () => void {
  const h = host(engine)
  const spec = plugin as QmlPluginSpec
  if (!spec || typeof spec.id !== "string" || !spec.id) {
    engine.reportError(new Error("plugin must have a non-empty string `id`"), "registerPlugin")
    return () => {}
  }
  const slots: Record<string, CoreSlotContribution<QmlSlotContext, QmlSlotData>> = {}
  for (const [name, contribution] of Object.entries(spec.slots ?? {})) {
    if (contribution) slots[name] = wrapContribution(engine, contribution)
  }
  const core: CorePlugin<string, QmlSlotContext, QmlSlotData> = {
    id: spec.id,
    order: spec.order,
    setup: spec.setup,
    dispose: spec.dispose,
    slots,
  }
  const entry: PluginEntry = { id: spec.id, kind: "ts", order: spec.order ?? 0, unregister: () => {} }
  return h.add(entry, core) ? () => entry.unregister() : () => {}
}

/** Unregister a plugin by id (a QML plugin's object is destroyed). Returns false if unknown. */
export function unregisterPlugin(engine: QmlEngine, id: string): boolean {
  const h = hosts.get(engine)
  const entry = h?.entries.get(id)
  if (!entry) return false
  if (entry.object) entry.object.destroy()
  else entry.unregister()
  return true
}

/** Plugins registered through this engine, in registration order. */
export function listPlugins(engine: QmlEngine): PluginInfo[] {
  const h = hosts.get(engine)
  if (!h) return []
  return [...h.entries.values()].map((e) => ({
    id: e.id,
    order: e.object ? (e.object.peek("order") as number) : e.order,
    kind: e.kind,
    ...(e.file ? { file: e.file } : {}),
  }))
}

/** Unregister every plugin registered through this engine (called by `QmlApp.destroy`). */
export function disposePlugins(engine: QmlEngine): void {
  hosts.get(engine)?.dispose()
}

// ---------------------------------------------------------------------------------------------
// QML plugin types

/**
 * `Contribution { slot: "statusbar"; mode: "host" | "managed"; Text { text: data.words } }`.
 * The single child object is a delegate (like `Component`), instantiated per mounted Slot with
 * context `{ data, slotData, plugin, slot, context, engine }`. One instance is kept per Slot and
 * its `data` is updated in place when the Slot's data changes.
 *
 * - `"host"` (default; `"append"` is accepted as an alias): the slot owns the instance — it is
 *   destroyed when the slot stops showing it (plugin unregistered, slot destroyed, lost a
 *   `single_winner` slot).
 * - `"managed"`: the plugin owns it — the instance survives deactivation and is reused when the
 *   slot shows the plugin again; destroyed when its Slot or the plugin goes away.
 */
export class Contribution extends ComponentObject {
  private readonly instances = new Map<object, { obj: QmlObject; setData: (d: QmlSlotData) => void }>()

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    this.defineProperty("slot", { type: "string" })
    this.defineProperty("mode", { type: "string", value: "host" })
  }

  get isManaged(): boolean {
    return this.peek("mode") === "managed"
  }

  /** Build the OpenTUI contribution for this delegate. */
  toCoreContribution(plugin: PluginObject): CoreSlotContribution<QmlSlotContext, QmlSlotData> {
    const render = (ctx: Readonly<QmlSlotContext>, data: QmlSlotData): BaseRenderable => this.render(plugin, ctx, data)
    if (!this.isManaged) return render
    return { render, onDispose: () => this.sweep(plugin) }
  }

  private render(plugin: PluginObject, ctx: Readonly<QmlSlotContext>, data: QmlSlotData): BaseRenderable {
    const key = slotKeyOf(data)
    const existing = this.instances.get(key)
    if (existing && !existing.obj.isDestroyed) {
      existing.setData(data)
      return (existing.obj as QmlObject & { renderable: BaseRenderable }).renderable
    }
    const [readData, writeData] = createSignal<QmlSlotData>(data, { equals: false })
    const context: Record<string, unknown> = {
      plugin: plugin.proxy,
      slot: this.peek("slot"),
      context: ctx,
      engine: this.engine,
    }
    Object.defineProperty(context, "data", { enumerable: true, get: readData })
    Object.defineProperty(context, "slotData", { enumerable: true, get: readData })
    const obj = this.createInstance({ contextProperties: context })
    if (!obj) throw new Error(`${this.describe()}: contribution has no delegate object`)
    const visual = visualOf(obj)
    if (!visual) {
      obj.destroy()
      throw new Error(`${this.describe()}: the contribution's delegate must be a visual type (got ${obj.typeName})`)
    }
    const entry = { obj, setData: (d: QmlSlotData) => writeData(() => d) }
    this.instances.set(key, entry)
    obj.onDestroy(() => {
      if (this.instances.get(key) === entry) this.instances.delete(key)
    })
    if (!this.isManaged) bindLifetime(visual)
    return visual.renderable
  }

  private sweep(plugin: PluginObject): void {
    const registered = plugin.isRegistered
    for (const [key, { obj }] of [...this.instances]) {
      const r = (obj as { renderable?: BaseRenderable }).renderable
      const detachedOrphan = key === slotKeyFallback || !toQmlObject(key) ? !r?.parent : false
      if (!registered || isDying(key) || detachedOrphan) {
        this.instances.delete(key)
        if (!obj.isDestroyed) obj.destroy()
      }
    }
  }

  override destroy(): void {
    for (const { obj } of [...this.instances.values()]) if (!obj.isDestroyed) obj.destroy()
    this.instances.clear()
    super.destroy()
  }
}

/**
 * Root type of a QML plugin file:
 *
 * ```qml
 * Plugin {
 *     pluginId: "wordcount"          // defaults to the QML id, then the file's base name
 *     order: 10
 *     types: ["./Widget.qml"]        // registered as engine-wide document types
 *     Contribution { slot: "statusbar"; Text { text: "words: " + data.words } }
 *     Keymap { ... }                 // ordinary children: keymaps / shortcuts work globally
 *     Component.onCompleted: ...     // setup
 *     Component.onDestruction: ...   // dispose
 * }
 * ```
 */
export class PluginObject extends QmlObject {
  private registeredId: string | null = null

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    this.defineProperty("pluginId", { type: "string" })
    this.defineProperty("order", {
      type: "int",
      value: 0,
      onChange: (v) => {
        if (this.registeredId !== null) host(this.engine).registry.updateOrder(this.registeredId, v as number)
      },
    })
    this.defineProperty("types", { type: "var", value: [] })
    this.defineProperty("description", { type: "string" })
    this.defineProperty("registered", { type: "bool", value: false, readonly: true })
  }

  /** The id this plugin registers under. */
  get pluginId(): string {
    const explicit = this.peek("pluginId") as string
    if (explicit) return explicit
    if (this.id) return this.id
    const file = this.component.component?.filename
    return file ? basename(file, extname(file)) : "qml-plugin"
  }

  get isRegistered(): boolean {
    return this.registeredId !== null
  }

  get contributions(): Contribution[] {
    return this.children.filter((c): c is Contribution => c instanceof Contribution)
  }

  protected override onCompleted(): void {
    this.registerTypes()
    this.register()
  }

  private registerTypes(): void {
    const types = this.peek("types")
    const list = Array.isArray(types) ? types : types ? [types] : []
    const dir = this.component.component?.directory ?? this.engine.basePath ?? "."
    for (const t of list) {
      if (typeof t !== "string" || !t) continue
      try {
        const abs = resolve(dir, t.replace(/^file:\/\//, ""))
        const comp = this.engine.componentForFile(abs)
        if (!comp) throw new Error(`type file not found: ${abs}`)
        this.engine.registerDocumentType(basename(abs, extname(abs)), comp)
      } catch (err) {
        this.engine.reportError(err, `plugin "${this.pluginId}" types`)
      }
    }
  }

  private register(): void {
    const h = host(this.engine)
    const id = this.pluginId
    const slots: Record<string, CoreSlotContribution<QmlSlotContext, QmlSlotData>> = {}
    for (const c of this.contributions) {
      const slot = c.peek("slot") as string
      if (!slot) {
        this.engine.warn(`plugin "${id}": Contribution without a slot name ignored`)
        continue
      }
      if (!c.definition) {
        this.engine.warn(`plugin "${id}": Contribution for slot "${slot}" has no delegate object`)
        continue
      }
      if (slots[slot]) {
        this.engine.warn(`plugin "${id}": several Contributions for slot "${slot}"; only the first is used`)
        continue
      }
      slots[slot] = c.toCoreContribution(this)
    }
    const entry: PluginEntry = {
      id,
      kind: "qml",
      order: this.peek("order") as number,
      file: this.component.component?.filename,
      object: this,
      unregister: () => {},
    }
    const core: CorePlugin<string, QmlSlotContext, QmlSlotData> = {
      id,
      order: this.peek("order") as number,
      dispose: () => {
        // Unregistered from the registry directly (e.g. registry.clear() on renderer destroy).
        if (this.registeredId !== null) {
          this.registeredId = null
          if (h.entries.get(id) === entry) h.entries.delete(id)
          if (!this.isDestroyed && !this.isDestroying) this.write("registered", false)
        }
      },
      slots,
    }
    this.registeredId = id
    if (!h.add(entry, core)) {
      this.registeredId = null
      return
    }
    this.write("registered", true)
  }

  /** Remove this plugin from the registry (idempotent). */
  unregister(): void {
    if (this.registeredId === null) return
    const h = hosts.get(this.engine)
    const entry = h?.entries.get(this.registeredId)
    if (entry && entry.object === this) entry.unregister()
    else h?.registry.unregister(this.registeredId)
    this.registeredId = null
  }

  override destroy(): void {
    if (this.isDestroyed || this.isDestroying) return
    this.unregister()
    super.destroy()
  }
}

/** Register the non-visual `Plugin` and `Contribution` types. */
export function registerPluginTypes(engine: QmlEngine): void {
  engine.registerType("Plugin", PluginObject)
  engine.registerType("Contribution", Contribution)
}

// ---------------------------------------------------------------------------------------------
// Loading QML plugins

function factoryIsPlugin(factory: QmlTypeFactory): boolean {
  return factory === (PluginObject as unknown) || factory.prototype instanceof PluginObject
}

/** Does this document's root resolve to `Plugin` (directly or via a document type)? */
export function isPluginDocument(component: QmlComponent, seen = new Set<QmlComponent>()): boolean {
  if (seen.has(component)) return false
  seen.add(component)
  const resolved = component.tryResolveType(component.document.root.name)
  if (!resolved) return false
  if (resolved.kind === "native") return factoryIsPlugin(resolved.factory)
  return isPluginDocument(resolved.component, seen)
}

/**
 * Load and instantiate a QML plugin file (root type `Plugin`). The plugin registers itself on
 * completion. Throws on I/O / syntax errors or if the root is not a `Plugin`.
 */
export async function loadQmlPlugin(engine: QmlEngine, path: string): Promise<PluginObject> {
  const abs = resolve(engine.basePath ?? ".", path)
  const component = await engine.loadFile(abs)
  if (!isPluginDocument(component)) {
    throw new Error(`${abs}: root object is not a Plugin (found "${component.document.root.name}")`)
  }
  const obj = engine.createObject(component)
  if (!(obj instanceof PluginObject)) {
    obj.destroy()
    throw new Error(`${abs}: root object is not a Plugin`)
  }
  return obj
}

/**
 * Load every `*.qml` file in `dir` whose root is `Plugin` (other files — e.g. helper types —
 * are skipped). Failures are reported through `engine.reportError`; returns the loaded plugins.
 */
export async function loadPluginsFromDir(engine: QmlEngine, dir: string): Promise<PluginObject[]> {
  const absDir = resolve(engine.basePath ?? ".", dir)
  let files: string[]
  try {
    files = readdirSync(absDir)
      .filter((f) => f.endsWith(".qml"))
      .sort()
      .map((f) => join(absDir, f))
      .filter((f) => statSync(f).isFile())
  } catch (err) {
    engine.reportError(err, `plugin directory "${absDir}"`)
    return []
  }
  const loaded: PluginObject[] = []
  for (const file of files) {
    try {
      const component = await engine.loadFile(file)
      if (!isPluginDocument(component)) continue
      loaded.push(await loadQmlPlugin(engine, file))
    } catch (err) {
      engine.reportError(err, `plugin "${file}"`)
    }
  }
  return loaded
}

/**
 * Register a plugin given as a `CorePlugin`/spec object or a path to a QML plugin file.
 * Never throws: failures are reported through `engine.reportError`.
 */
export async function addPlugin(engine: QmlEngine, plugin: AnyPlugin | string): Promise<void> {
  if (typeof plugin === "string") {
    try {
      await loadQmlPlugin(engine, plugin)
    } catch (err) {
      engine.reportError(err, `plugin "${plugin}"`)
    }
    return
  }
  registerPlugin(engine, plugin)
}
