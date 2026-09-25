/**
 * QmlEngine: type registry, document loading/imports and object instantiation.
 *
 * Instantiation of an `ObjectDefinition` follows QML's order:
 *   1. resolve the type and construct the object (types may create renderables here);
 *      a document type (`Foo.qml`) instantiates Foo's root in a fresh, private context;
 *   2. register the `id` in the component context;
 *   3. declare properties, signals, methods and enums;
 *   4. instantiate child objects (appended to the parent, or to its `default property`) and
 *      object-valued properties;
 *   5. after the WHOLE tree is built: resolve aliases, then apply script bindings, literal
 *      values and handlers (in one solid batch);
 *   6. complete objects bottom-up (children before parents): `onCompleted()` and
 *      `Component.onCompleted`.
 *
 * For a document type used as `Foo { x: 1 }`, Foo.qml's members are applied first and the
 * user's members after them, so user bindings win. Ids in Foo.qml are private to Foo.qml;
 * the user's ids live in the outer component.
 */
import { existsSync, readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { CliRenderer } from "@opentui/core"
import { parseQml } from "../parser/index.ts"
import type {
  ArrayBinding,
  FunctionDeclaration,
  ObjectBinding,
  ObjectDefinition,
  PropertyBinding,
  PropertyDeclaration,
  QmlDocument,
  ScriptBinding,
} from "../parser/ast.ts"
import { batch, untrack } from "./reactive.ts"
import { compileFunction, compileScript, createHandler } from "./expression.ts"
import type { CompiledScript } from "./expression.ts"
import { isHandlerName, QmlObject, toQmlObject } from "./object.ts"
import { buildObjectScope, recordLayer } from "./scope.ts"
import type { QmlScope, ScopeLayer } from "./scope.ts"
import { createQtGlobal } from "./qt.ts"
import type { QtGlobal } from "./qt.ts"
import { globalScheduler } from "./scheduler.ts"
import { ComponentObject, registerBuiltins } from "./builtins.ts"
import type { ComponentContext, HandlerSpec, QmlTypeFactory, ResolvedType, Scheduler } from "./types.ts"

export interface QmlEngineOptions {
  /**
   * The OpenTUI renderer (or the test renderer). Optional for headless/non-visual use
   * (then `engine.renderer` is undefined at runtime; `Qt.quit()` becomes a no-op).
   */
  renderer?: CliRenderer
  /** Extra names visible in every scope (after ids / root properties). */
  globals?: Record<string, unknown>
  /** Directory for relative `loadFile` paths and for `loadSource` documents without a filename. */
  basePath?: string
  /** Timer backend for `Timer` and `Qt.callLater`. Defaults to globalThis timers. */
  scheduler?: Scheduler
  /** Parser override (defaults to `parseQml`). */
  parse?: (source: string, filename?: string) => QmlDocument
  /** Register the non-visual builtins (QtObject, Timer, Repeater, ...). Default true. */
  builtins?: boolean
  /** Warning sink. Default: `console.warn("QML: ...")`. */
  onWarning?: (message: string) => void
  /** Error sink for binding/handler errors. Default: `console.error("QML: ...")`. */
  onError?: (error: unknown, context?: string) => void
}

/** Options for {@link QmlEngine.instantiate}. */
export interface InstantiateOptions {
  /** The document the definition belongs to (for type resolution and filename). */
  component: QmlComponent
  /** Enclosing context (delegates / inline components); null for a document root. */
  parentContext?: ComponentContext | null
  /** Context properties for the new context (e.g. `{ index, modelData, model }`). */
  contextProperties?: Record<string, unknown> | null
  /** Parent to append the new root to (before its bindings are evaluated). */
  parent?: QmlObject | null
  /** Index in `parent.children` (default: append). */
  index?: number
  /** Property values applied after the object's own bindings (Component.createObject props). */
  initialProperties?: Record<string, unknown> | null
}

interface BuildState {
  aliasJobs: Array<() => void>
  jobs: Array<() => void>
  completions: QmlObject[]
}

interface Placement {
  parent: QmlObject | null
  index?: number
  /** This object is the root of its component context. */
  contextRoot: boolean
  /** Don't queue completion (the caller will, e.g. for a document type's inner root). */
  deferCompletion: boolean
}

interface DefaultPropertyInfo {
  decl: PropertyDeclaration
  context: ComponentContext
}

/** Create a component context (one instantiation of a document / inline component). */
export function createComponentContext(
  component: QmlComponent | null,
  parent: ComponentContext | null = null,
  contextProperties: Record<string, unknown> | null = null,
): ComponentContext {
  return { component, parent, ids: new Map(), root: null, contextProperties }
}

const CHILD_LIST_PROPERTIES = new Set(["children", "data", "contentData", "contentChildren", "resources"])

export class QmlEngine {
  /** The OpenTUI renderer (see {@link QmlEngineOptions.renderer}). */
  readonly renderer: CliRenderer
  /** Engine globals, visible in every scope (includes `Qt` and `qsTr`). Mutable. */
  readonly globals: Record<string, unknown>
  readonly scheduler: Scheduler
  readonly basePath: string | undefined
  /** The `Qt` global object. */
  readonly Qt: QtGlobal
  /** Context used by objects created outside any document. */
  readonly rootContext: ComponentContext = createComponentContext(null)

  private readonly types = new Map<string, QmlTypeFactory>()
  private readonly files = new Map<string, QmlComponent | null>()
  private readonly scopes = new WeakMap<QmlObject, Map<ComponentContext, QmlScope>>()
  private readonly defaultProps = new WeakMap<QmlObject, DefaultPropertyInfo>()
  private readonly roots = new Set<QmlObject>()
  private readonly globalLayers: ScopeLayer[]
  private readonly parse: (source: string, filename?: string) => QmlDocument
  private readonly onWarning?: (message: string) => void
  private readonly onError?: (error: unknown, context?: string) => void
  private destroyed = false

  constructor(opts: QmlEngineOptions = {}) {
    // Headless engines have no renderer; visual components always run with one.
    this.renderer = opts.renderer as CliRenderer
    this.scheduler = opts.scheduler ?? globalScheduler
    this.basePath = opts.basePath
    this.parse = opts.parse ?? parseQml
    this.onWarning = opts.onWarning
    this.onError = opts.onError
    this.Qt = createQtGlobal(this)
    this.globals = {
      Qt: this.Qt,
      qsTr: (s: unknown) => String(s),
      qsTranslate: (_ctx: unknown, s: unknown) => String(s),
      ...opts.globals,
    }
    const types = this.types
    this.globalLayers = [
      recordLayer(() => this.globals, "globals"),
      {
        kind: "layer",
        label: "type statics",
        has: (name) => /^[A-Z]/.test(name) && types.get(name)?.qmlStatics !== undefined,
        get: (name) => types.get(name)?.qmlStatics,
        set: (name) => {
          throw new TypeError(`Cannot assign to type "${name}"`)
        },
      },
    ]
    if (opts.builtins !== false) registerBuiltins(this)
  }

  // ---------------------------------------------------------------------------------------------
  // Diagnostics

  /** Log a warning (through `onWarning` or console.warn). */
  warn(message: string): void {
    if (this.onWarning) this.onWarning(message)
    else console.warn(`QML: ${message}`)
  }

  /** Log a binding/handler error (through `onError` or console.error). Never throws. */
  reportError(error: unknown, context?: string): void {
    if (this.onError) {
      this.onError(error, context)
      return
    }
    const msg = error instanceof Error ? error.message : String(error)
    console.error(`QML: ${context ? `${context}: ` : ""}${msg}`)
  }

  // ---------------------------------------------------------------------------------------------
  // Types

  /** Register (or replace) a native type. */
  registerType(name: string, type: QmlTypeFactory): void {
    this.types.set(name, type)
  }

  hasType(name: string): boolean {
    return this.types.has(name)
  }

  getType(name: string): QmlTypeFactory | undefined {
    return this.types.get(name)
  }

  typeNames(): string[] {
    return [...this.types.keys()]
  }

  // ---------------------------------------------------------------------------------------------
  // Loading

  /** Parse source into a component. Sibling `.qml` files of `filename` become types (lazily). */
  loadSource(source: string, filename?: string): QmlComponent {
    const abs = filename ? resolve(this.basePath ?? ".", filename) : undefined
    const document = this.parse(source, abs ?? filename)
    return new QmlComponent(this, document, abs)
  }

  /** Wrap an already-parsed document (e.g. a hand-built AST in tests). */
  loadDocument(document: QmlDocument, filename?: string): QmlComponent {
    const abs = filename ?? document.filename
    return new QmlComponent(this, document, abs ? resolve(this.basePath ?? ".", abs) : undefined)
  }

  /** Read + parse a `.qml` file (relative paths resolve against `basePath` / cwd). Cached. */
  async loadFile(path: string): Promise<QmlComponent> {
    const abs = resolve(this.basePath ?? ".", path)
    const cached = this.files.get(abs)
    if (cached) return cached
    const source = await readFile(abs, "utf8")
    const component = new QmlComponent(this, this.parse(source, abs), abs)
    this.files.set(abs, component)
    return component
  }

  /**
   * Synchronously load a `.qml` file used as a type (cached; null if it doesn't exist).
   * Parse errors are thrown.
   */
  componentForFile(absPath: string): QmlComponent | null {
    if (this.files.has(absPath)) return this.files.get(absPath) ?? null
    if (!existsSync(absPath)) {
      this.files.set(absPath, null)
      return null
    }
    const source = readFileSync(absPath, "utf8")
    const component = new QmlComponent(this, this.parse(source, absPath), absPath)
    this.files.set(absPath, component)
    return component
  }

  // ---------------------------------------------------------------------------------------------
  // Instantiation

  /** Instantiate a component. `parent` may be omitted for a root object. */
  createObject(component: QmlComponent, parent?: QmlObject | null, contextProps?: Record<string, unknown> | null): QmlObject {
    return this.instantiate(component.document.root, {
      component,
      parent: parent ?? null,
      contextProperties: contextProps ?? null,
    })
  }

  /**
   * Instantiate an object definition in a new component context (used for documents,
   * delegates and inline `Component`s). Runs all phases including completion.
   */
  instantiate(def: ObjectDefinition, opts: InstantiateOptions): QmlObject {
    if (this.destroyed) throw new Error("QML: engine has been destroyed")
    return untrack(() => {
      const ctx = createComponentContext(opts.component, opts.parentContext ?? null, opts.contextProperties ?? null)
      const state: BuildState = { aliasJobs: [], jobs: [], completions: [] }
      const obj = this.build(def, ctx, state, {
        parent: opts.parent ?? null,
        index: opts.index,
        contextRoot: true,
        deferCompletion: false,
      })
      if (opts.contextProperties) obj.contextProperties = opts.contextProperties
      const initial = opts.initialProperties
      if (initial) {
        state.jobs.push(() => {
          for (const [key, value] of Object.entries(initial)) obj.set(key, value)
        })
      }
      this.finish(state)
      if (!obj.parent) this.roots.add(obj)
      return obj
    })
  }

  /** Scope for scripts written on `object` in `context` (default: the object's own context). */
  scopeFor(object: QmlObject, context: ComponentContext = object.component): QmlScope {
    let byContext = this.scopes.get(object)
    if (!byContext) {
      byContext = new Map()
      this.scopes.set(object, byContext)
    }
    let scope = byContext.get(context)
    if (!scope) {
      scope = buildObjectScope(object, context, this.globalLayers)
      byContext.set(context, scope)
    }
    return scope
  }

  /** Called by `QmlObject.destroy()`. */
  objectDestroyed(object: QmlObject): void {
    this.roots.delete(object)
  }

  /** Destroy all root objects created by this engine. */
  destroy(): void {
    if (this.destroyed) return
    for (const root of [...this.roots]) root.destroy()
    this.roots.clear()
    this.destroyed = true
  }

  get isDestroyed(): boolean {
    return this.destroyed
  }

  // ---------------------------------------------------------------------------------------------
  // Build phases

  private finish(state: BuildState): void {
    batch(() => {
      // Aliases may refer to aliases declared deeper in the tree: retry until no progress.
      let pending = state.aliasJobs
      while (pending.length > 0) {
        const failed: Array<() => void> = []
        let lastError: unknown = null
        for (const job of pending) {
          try {
            job()
          } catch (err) {
            failed.push(job)
            lastError = err
          }
        }
        if (failed.length === pending.length) {
          this.reportError(lastError, "alias")
          break
        }
        pending = failed
      }
      for (const job of state.jobs) {
        try {
          job()
        } catch (err) {
          this.reportError(err)
        }
      }
    })
    for (const obj of state.completions) obj.completeConstruction()
  }

  private build(def: ObjectDefinition, ctx: ComponentContext, state: BuildState, place: Placement): QmlObject {
    const component = ctx.component
    if (!component) throw new Error("QML: cannot instantiate outside a component")
    const resolved = component.resolveType(def.name)
    let obj: QmlObject
    if (resolved.kind === "document") {
      // A document used as a type: build its root in a fresh private context, then apply the
      // user's members on top (below).
      const inner = createComponentContext(resolved.component, null, null)
      obj = this.build(resolved.component.document.root, inner, state, { ...place, contextRoot: true, deferCompletion: true })
    } else {
      obj = new resolved.factory(this, resolved.name)
      obj.component = ctx
      if (place.contextRoot) ctx.root = obj
      if (place.parent) this.placeChild(place.parent, obj, place.index)
    }
    if (place.contextRoot && !ctx.root) ctx.root = obj

    if (def.id) {
      if (ctx.ids.has(def.id)) this.reportError(new Error(`id "${def.id}" is not unique`), component.filename)
      ctx.ids.set(def.id, obj)
      obj.id = def.id
    }

    if (obj instanceof ComponentObject) {
      const inline = def.members.find((m): m is ObjectDefinition => m.type === "Object") ?? null
      obj.setDefinition(inline, ctx)
    }

    this.applyMembers(obj, def, ctx, state)
    if (!place.deferCompletion) state.completions.push(obj)
    return obj
  }

  private applyMembers(obj: QmlObject, def: ObjectDefinition, ctx: ComponentContext, state: BuildState): void {
    const filename = ctx.component?.filename
    let defaultInfo: DefaultPropertyInfo | null = null

    // 3. Declarations
    for (const m of def.members) {
      switch (m.type) {
        case "PropertyDeclaration":
          this.declareProperty(obj, m, ctx, state)
          if (m.isDefault) defaultInfo = { decl: m, context: ctx }
          break
        case "SignalDeclaration":
          obj.defineSignal(
            m.name,
            m.params.map((p) => p.name),
          )
          break
        case "FunctionDeclaration":
          this.declareFunction(obj, m, ctx)
          break
        case "EnumDeclaration": {
          let next = 0
          for (const v of m.values) {
            const value = v.value ?? next
            next = value + 1
            obj.defineProperty(v.name, { type: "int", value, readonly: true })
          }
          break
        }
      }
    }

    // 4. Child objects and object-valued properties
    const isComponent = obj instanceof ComponentObject
    const componentDefault = this.nativeComponentDefault(obj)
    for (const m of def.members) {
      if (m.type === "Object") {
        if (isComponent) continue
        if (componentDefault) {
          // `Repeater { Text {} }`: the child is the delegate, not an instance.
          const value = this.isComponentType(ctx, m.name)
            ? this.build(m, ctx, state, { parent: null, contextRoot: false, deferCompletion: false })
            : this.makeComponentValue(obj, m, ctx)
          obj.ownObject(value)
          state.jobs.push(() => this.assign(obj, componentDefault, value.proxy))
        } else {
          this.build(m, ctx, state, { parent: obj, contextRoot: false, deferCompletion: false })
        }
      } else if (m.type === "PropertyBinding" && m.value.type !== "Script") {
        this.applyObjectBinding(obj, m.name, m.value, ctx, state)
      }
    }

    // 5. Script bindings and handlers (deferred until the whole tree exists)
    for (const m of def.members) {
      if (m.type === "PropertyBinding" && m.value.type === "Script") {
        this.applyScriptBinding(obj, m, m.value, ctx, state, filename)
      }
    }

    // The document's own default property applies to *users* of the type only.
    if (defaultInfo) {
      this.defaultProps.set(obj, defaultInfo)
      obj.defaultPropertyName = defaultInfo.decl.name
    }
  }

  private declareProperty(obj: QmlObject, decl: PropertyDeclaration, ctx: ComponentContext, state: BuildState): void {
    const filename = ctx.component?.filename
    if (decl.propertyType === "alias") {
      const target = decl.aliasTarget
      if (!target || target.length === 0) {
        this.reportError(new Error(`alias "${decl.name}" has no target`), filename)
        return
      }
      state.aliasJobs.push(() => {
        const [head, ...rest] = target
        const targetObj = this.lookupId(ctx, head!)
        if (!targetObj) throw new Error(`${filename ?? "<qml>"}: alias "${decl.name}": unknown id "${head}"`)
        obj.defineAlias(decl.name, targetObj, rest.join("."))
      })
      return
    }

    const type = decl.propertyType === "variant" ? "var" : decl.propertyType
    obj.defineProperty(decl.name, { type, readonly: decl.readonly, required: decl.required })
    const value = decl.value
    if (!value) return
    if (value.type === "Script") {
      const compiled = this.compile(value, filename)
      if (!compiled) return
      if (compiled.literal) obj.write(decl.name, compiled.literal.value)
      else state.jobs.push(() => obj.bind(decl.name, compiled, this.scopeFor(obj, ctx)))
    } else {
      this.applyObjectBinding(obj, [decl.name], value, ctx, state, true)
    }
  }

  private declareFunction(obj: QmlObject, decl: FunctionDeclaration, ctx: ComponentContext): void {
    try {
      const compiled = compileFunction(decl, { filename: ctx.component?.filename })
      const fn = compiled.evaluate(this.scopeFor(obj, ctx))
      obj.defineMethod(decl.name, fn as Function)
    } catch (err) {
      this.reportError(err, `${obj.describe()}: function ${decl.name}`)
    }
  }

  private applyObjectBinding(
    obj: QmlObject,
    path: string[],
    value: ObjectBinding | ArrayBinding,
    ctx: ComponentContext,
    state: BuildState,
    isDeclaration = false,
  ): void {
    const name = path.join(".")
    const defs = value.type === "ObjectValue" ? [value.object] : value.objects

    // `children: [...]`, `data: Item {}` or the default property: real children.
    if (CHILD_LIST_PROPERTIES.has(name) && !isDeclaration) {
      for (const d of defs) this.build(d, ctx, state, { parent: obj, contextRoot: false, deferCompletion: false })
      return
    }

    const wantsComponent = obj.propertyType(name) === "Component" || obj.propertyType(name) === "list<Component>"
    const values = defs.map((d) => {
      if (wantsComponent && !this.isComponentType(ctx, d.name)) {
        return this.makeComponentValue(obj, d, ctx).proxy
      }
      const child = this.build(d, ctx, state, { parent: null, contextRoot: false, deferCompletion: false })
      obj.ownObject(child)
      return child.proxy
    })
    const result = value.type === "ObjectValue" ? values[0] : values
    if (isDeclaration) obj.write(name, result)
    else state.jobs.push(() => this.assign(obj, name, result))
  }

  private applyScriptBinding(
    obj: QmlObject,
    binding: PropertyBinding,
    script: ScriptBinding,
    ctx: ComponentContext,
    state: BuildState,
    filename: string | undefined,
  ): void {
    const path = binding.name
    const last = path[path.length - 1]!
    const first = path[0]!
    const scope = (): QmlScope => this.scopeFor(obj, ctx)

    // Attached: `Component.onCompleted`, `Keys.onPressed`, `Layout.fillWidth`
    if (path.length >= 2 && /^[A-Z]/.test(first)) {
      const rest = path.slice(1).join(".")
      state.jobs.push(() => {
        const compiled = this.compile(script, filename)
        if (!compiled) return
        if (path.length === 2 && isHandlerName(last)) {
          if (first === "Component" && (last === "onCompleted" || last === "onDestruction")) {
            const signal = last === "onCompleted" ? "Component.completed" : "Component.destruction"
            obj.connect(signal, createHandler(compiled, scope()))
          } else {
            obj.attachHandler(first, last, { name: last, compiled, scope: scope() })
          }
        } else {
          this.bindAttached(obj, first, rest, compiled, scope())
        }
      })
      return
    }

    // Handlers: `onClicked`, `onWidthChanged`, `border.onColorChanged`
    if (isHandlerName(last)) {
      const handlerName = path.join(".")
      state.jobs.push(() => {
        const compiled = this.compile(script, filename)
        if (!compiled) return
        const spec: HandlerSpec = { name: handlerName, compiled, scope: scope() }
        if (!obj.connectHandler(spec)) {
          this.warn(`${obj.describe()}: cannot assign handler "${handlerName}": no matching signal`)
        }
      })
      return
    }

    // Plain / grouped property
    state.jobs.push(() => {
      const compiled = this.compile(script, filename)
      if (!compiled) return
      const { target, name } = this.resolvePropertyTarget(obj, path)
      if (target.isReadonly(name)) throw new TypeError(`${target.describe()}: cannot assign to read-only property "${name}"`)
      if (compiled.literal) target.set(name, compiled.literal.value)
      else target.bind(name, compiled, scope())
    })
  }

  /** `foo.bar: v` where `foo` is an object-valued property (not a dotted grouped property). */
  private resolvePropertyTarget(obj: QmlObject, path: string[]): { target: QmlObject; name: string } {
    const name = path.join(".")
    if (path.length > 1 && !obj.hasProperty(name) && obj.hasProperty(path[0]!)) {
      const inner = toQmlObject(obj.peek(path[0]!))
      if (inner) return this.resolvePropertyTarget(inner, path.slice(1))
    }
    return { target: obj, name }
  }

  private bindAttached(obj: QmlObject, type: string, name: string, compiled: CompiledScript, scope: QmlScope): void {
    if (compiled.literal) {
      obj.setAttached(type, name, compiled.literal.value)
      return
    }
    let lastError: string | null = null
    obj.watch(() => {
      let value: unknown
      try {
        value = compiled.evaluate(scope)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg !== lastError) this.reportError(err, `${obj.describe()}: binding for "${type}.${name}"`)
        lastError = msg
        return
      }
      lastError = null
      untrack(() => obj.setAttached(type, name, value))
    })
  }

  private assign(obj: QmlObject, name: string, value: unknown): void {
    if (obj.isReadonly(name)) throw new TypeError(`${obj.describe()}: cannot assign to read-only property "${name}"`)
    obj.set(name, value)
  }

  /** Put a child built from a child ObjectDefinition into its parent (honours `default property`). */
  private placeChild(parent: QmlObject, child: QmlObject, index?: number): void {
    const info = this.defaultProps.get(parent)
    if (!info) {
      const native = parent.defaultPropertyName
      if (native && !CHILD_LIST_PROPERTIES.has(native) && parent.hasProperty(native)) {
        this.addToProperty(parent, native, child)
      } else {
        parent.appendChild(child, index)
      }
      return
    }
    const decl = info.decl
    if (decl.propertyType === "alias" && decl.aliasTarget && decl.aliasTarget.length > 0) {
      const [head, ...rest] = decl.aliasTarget
      const target = this.lookupId(info.context, head!)
      const prop = rest.join(".")
      if (target && target !== parent && (prop === "" || CHILD_LIST_PROPERTIES.has(prop))) {
        this.placeChild(target, child, index)
        return
      }
      if (target && target.hasProperty(prop)) {
        this.addToProperty(target, prop, child)
        return
      }
      parent.appendChild(child, index)
      return
    }
    this.addToProperty(parent, decl.name, child)
  }

  private addToProperty(obj: QmlObject, prop: string, child: QmlObject): void {
    obj.ownObject(child)
    const type = obj.propertyType(prop) ?? "var"
    const current = obj.peek(prop)
    if (type === "list" || type.startsWith("list<") || Array.isArray(current)) {
      obj.write(prop, [...((current as unknown[] | undefined) ?? []), child.proxy])
    } else {
      obj.write(prop, child.proxy)
    }
  }

  /** A native type's `defaultPropertyName` when it is Component-typed (Repeater, Loader). */
  private nativeComponentDefault(obj: QmlObject): string | null {
    if (this.defaultProps.has(obj)) return null
    const name = obj.defaultPropertyName
    return name && obj.propertyType(name) === "Component" ? name : null
  }

  private lookupId(ctx: ComponentContext, name: string): QmlObject | null {
    for (let c: ComponentContext | null = ctx; c; c = c.parent) {
      const obj = c.ids.get(name)
      if (obj) return obj
    }
    return null
  }

  private isComponentType(ctx: ComponentContext, name: string): boolean {
    const resolved = ctx.component?.tryResolveType(name)
    return resolved?.kind === "native" && (resolved.factory as unknown) === ComponentObject
  }

  private makeComponentValue(owner: QmlObject, def: ObjectDefinition, ctx: ComponentContext): ComponentObject {
    const comp = new ComponentObject(this, "Component")
    comp.component = ctx
    comp.setDefinition(def, ctx)
    owner.ownObject(comp)
    comp.completeConstruction()
    return comp
  }

  private compile(script: ScriptBinding, filename: string | undefined): CompiledScript | null {
    try {
      return compileScript(script, { filename })
    } catch (err) {
      this.reportError(err)
      return null
    }
  }
}

type ImportTarget = { kind: "dir"; dir: string } | { kind: "module"; uri: string }

/** A loaded document: resolves type names visible to it and instantiates it. */
export class QmlComponent {
  readonly engine: QmlEngine
  readonly document: QmlDocument
  /** Absolute path, if loaded from (or associated with) a file. */
  readonly filename: string | undefined
  /** Directory whose sibling `.qml` files are visible as types. */
  readonly directory: string | undefined
  private readonly importDirs: string[] = []
  private readonly qualifiers = new Map<string, ImportTarget>()
  private readonly typeCache = new Map<string, ResolvedType | null>()

  constructor(engine: QmlEngine, document: QmlDocument, filename?: string) {
    this.engine = engine
    this.document = document
    this.filename = filename
    this.directory = filename ? dirname(filename) : engine.basePath ? resolve(engine.basePath) : undefined
    for (const imp of document.imports) {
      if (imp.path !== undefined) {
        if (/\.m?js$/.test(imp.path)) {
          engine.warn(`${filename ?? "<qml>"}: JavaScript imports are not supported ("${imp.path}")`)
          continue
        }
        const dir = resolve(this.directory ?? ".", imp.path)
        if (imp.qualifier) this.qualifiers.set(imp.qualifier, { kind: "dir", dir })
        else this.importDirs.push(dir)
      } else if (imp.uri && imp.qualifier) {
        this.qualifiers.set(imp.qualifier, { kind: "module", uri: imp.uri })
      }
    }
  }

  /**
   * Resolve a type name as written (`"Item"`, `"QtQuick.Item"`, `"Q.Foo"`). Unqualified names
   * look in: the document's directory (sibling `Foo.qml`), `import "dir"` directories, then
   * the engine registry. Throws for unknown types.
   */
  resolveType(name: string): ResolvedType {
    const resolved = this.tryResolveType(name)
    if (!resolved) throw new Error(`${this.filename ?? "<qml>"}: unknown type "${name}"`)
    return resolved
  }

  tryResolveType(name: string): ResolvedType | undefined {
    if (this.typeCache.has(name)) return this.typeCache.get(name) ?? undefined
    let result: ResolvedType | undefined
    const dot = name.indexOf(".")
    if (dot > 0) {
      const qualifier = name.slice(0, dot)
      const rest = name.slice(dot + 1)
      const target = this.qualifiers.get(qualifier)
      if (target?.kind === "dir") result = this.fromDirectory(target.dir, rest)
      else result = this.fromRegistry(rest.slice(rest.lastIndexOf(".") + 1))
    } else {
      if (this.directory) result = this.fromDirectory(this.directory, name)
      for (const dir of this.importDirs) result ??= this.fromDirectory(dir, name)
      result ??= this.fromRegistry(name)
    }
    this.typeCache.set(name, result ?? null)
    return result
  }

  /** Instantiate this document. */
  createObject(parent?: QmlObject | null, contextProps?: Record<string, unknown> | null): QmlObject {
    return this.engine.createObject(this, parent, contextProps)
  }

  private fromDirectory(dir: string, name: string): ResolvedType | undefined {
    if (!/^[A-Z]/.test(name)) return undefined
    const path = join(dir, `${name}.qml`)
    if (path === this.filename) return undefined
    const component = this.engine.componentForFile(path)
    return component ? { kind: "document", name, component } : undefined
  }

  private fromRegistry(name: string): ResolvedType | undefined {
    const factory = this.engine.getType(name)
    return factory ? { kind: "native", name, factory } : undefined
  }
}
