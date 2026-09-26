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
import { existsSync, readFileSync, statSync } from "node:fs"
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
import { batch, runWithOwner, untrack } from "./reactive.ts"
import { compileFunction, compileScript, createHandler, QmlRuntimeError } from "./expression.ts"
import type { CompiledScript } from "./expression.ts"
import { isHandlerName, QmlObject, toQmlObject } from "./object.ts"
import { buildObjectScope, recordLayer } from "./scope.ts"
import type { QmlScope, ScopeLayer } from "./scope.ts"
import { createQtGlobal } from "./qt.ts"
import type { QtGlobal } from "./qt.ts"
import { globalScheduler } from "./scheduler.ts"
import { ComponentObject, registerBuiltins } from "./builtins.ts"
import { evaluateScript, isModuleDirectory, QmlModule, uriToPath } from "./modules.ts"
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
  /**
   * Directories searched for `import A.B.C` modules (as `<path>/A/B/C`), in order.
   * Default: `[basePath ?? cwd]`. Relative entries resolve against `basePath` / cwd.
   * See also {@link QmlEngine.addImportPath}.
   */
  importPaths?: string[]
}

/** A value (or lazy factory) registered with {@link QmlEngine.registerSingleton}. */
interface RegisteredSingleton {
  factory: ((engine: QmlEngine) => unknown) | null
  value: unknown
}

/** Module uris provided by the engine itself (resolved against the type registry). */
const NATIVE_MODULE = /^(OpenTUI|QtQuick|QtQml|Qt)(\.|$)/

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
  /** Every object created by this instantiation (destroyed again if building throws). */
  created: QmlObject[]
}

interface Placement {
  parent: QmlObject | null
  index?: number
  /** This object is the root of its component context. */
  contextRoot: boolean
  /** Don't queue completion (the caller will, e.g. for a document type's inner root). */
  deferCompletion: boolean
  /**
   * Append to `parent` directly instead of routing through its default property
   * (`Component.createObject(parent)`, delegates, `engine.createObject(component, parent)`).
   */
  direct?: boolean
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

function isListType(type: string | undefined): boolean {
  return type === "list" || (type?.startsWith("list<") ?? false)
}

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
  /** `registerTypeNotAvailable`: type name → why it cannot be used. */
  private readonly unavailableTypes = new Map<string, string>()
  /** Named document types (`registerDocumentType`), e.g. `types: [...]` of a QML plugin. */
  private readonly documentTypes = new Map<string, QmlComponent>()
  private readonly files = new Map<string, QmlComponent | null>()
  private readonly scopes = new WeakMap<QmlObject, Map<ComponentContext, QmlScope>>()
  private readonly defaultProps = new WeakMap<QmlObject, DefaultPropertyInfo>()
  private readonly roots = new Set<QmlObject>()
  private readonly globalLayers: ScopeLayer[]
  private readonly importPathList: string[]
  private readonly nativeModules = new Set<string>()
  /** Module directories (one QmlModule per directory). */
  private readonly modulesByDir = new Map<string, QmlModule>()
  /** `uri \0 fromDir` → resolved module (null: not found). Cleared by `addImportPath`. */
  private readonly moduleCache = new Map<string, QmlModule | null>()
  /** Explicit `uri` → directory registrations (`registerModuleDirectory`), consulted first. */
  private readonly moduleDirs = new Map<string, string>()
  private readonly singletonInstances = new Map<QmlComponent, QmlObject>()
  private readonly singletonsCreating = new Set<QmlComponent>()
  private readonly registeredSingletons = new Map<string, RegisteredSingleton>()
  private readonly scripts = new Map<string, Record<string, unknown>>()
  private readonly parse: (source: string, filename?: string) => QmlDocument
  private readonly onWarning?: (message: string) => void
  private readonly onError?: (error: unknown, context?: string) => void
  private readonly destroyHooks = new Set<() => void>()
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
    this.importPathList = (opts.importPaths ?? [opts.basePath ?? "."]).map((p) => resolve(opts.basePath ?? ".", p))
    const types = this.types
    this.globalLayers = [
      {
        kind: "layer",
        label: "registered singletons",
        has: (name) => this.registeredSingletons.has(name),
        get: (name) => this.singletonValue(name),
        set: (name) => {
          throw new TypeError(`Cannot assign to singleton "${name}"`)
        },
      },
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
    this.unavailableTypes.delete(name)
  }

  /**
   * Declare that `name` is a known type that cannot be used here (like Qt's
   * `qmlRegisterTypeNotAvailable`): `hasType(name)` stays false, and a document that uses it
   * fails with `message` (e.g. "install the optional package @opentui/qrcode") instead of a
   * bare "unknown type". Ignored once `name` is registered.
   */
  registerTypeNotAvailable(name: string, message: string): void {
    if (!this.types.has(name)) this.unavailableTypes.set(name, message)
  }

  /** The `registerTypeNotAvailable` message for `name`, if any. */
  typeNotAvailableReason(name: string): string | undefined {
    return this.types.has(name) ? undefined : this.unavailableTypes.get(name)
  }

  /**
   * Register (or replace) a document type: `name` resolves to `component` (a loaded `.qml`
   * document) in every document, like a sibling `Name.qml` file. Native types of the same name
   * take precedence. Used by QML plugins' `types: [...]`.
   */
  registerDocumentType(name: string, component: QmlComponent): void {
    this.documentTypes.set(name, component)
  }

  getDocumentType(name: string): QmlComponent | undefined {
    return this.documentTypes.get(name)
  }

  hasType(name: string): boolean {
    return this.types.has(name) || this.documentTypes.has(name)
  }

  getType(name: string): QmlTypeFactory | undefined {
    return this.types.get(name)
  }

  typeNames(): string[] {
    return [...this.types.keys()]
  }

  // ---------------------------------------------------------------------------------------------
  // Singletons

  /**
   * Register a singleton visible by name in every document (after ids, context properties and
   * document imports; before `globals`). `value` may be a QmlObject (its proxy is exposed), any
   * JS value (e.g. a `createStore()` / `createPropertyMap()` object), or a factory function
   * `(engine) => value` called once, on first use. Using the name as a type is an error.
   */
  registerSingleton(name: string, value: unknown): void {
    const entry: RegisteredSingleton =
      typeof value === "function" && !(value instanceof QmlObject)
        ? { factory: value as (engine: QmlEngine) => unknown, value: undefined }
        : { factory: null, value }
    this.registeredSingletons.set(name, entry)
  }

  /** The value of a singleton registered with {@link registerSingleton} (undefined if none). */
  singletonValue(name: string): unknown {
    const entry = this.registeredSingletons.get(name)
    if (!entry) return undefined
    if (entry.factory) {
      const factory = entry.factory
      entry.factory = null
      entry.value = untrack(() => runWithOwner(null, () => factory(this)))
    }
    return entry.value instanceof QmlObject ? entry.value.proxy : entry.value
  }

  hasSingleton(name: string): boolean {
    return this.registeredSingletons.has(name)
  }

  /**
   * The engine-wide instance of a singleton document (`pragma Singleton`, exported by a qmldir
   * `singleton` line): created lazily on first use, once per engine, without a parent.
   * Destroyed with the engine.
   */
  singletonFor(component: QmlComponent): QmlObject {
    const existing = this.singletonInstances.get(component)
    if (existing) return existing
    if (this.singletonsCreating.has(component)) {
      throw new QmlRuntimeError("singleton depends on itself during construction", component.filename)
    }
    this.singletonsCreating.add(component)
    try {
      const obj = runWithOwner(null, () => this.createObject(component, null)) as QmlObject
      this.singletonInstances.set(component, obj)
      return obj
    } finally {
      this.singletonsCreating.delete(component)
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Modules

  /** Directories searched for `import A.B.C` (highest priority first). */
  get importPaths(): string[] {
    return [...this.importPathList]
  }

  /**
   * Add a module search directory with the highest priority (like Qt's `addImportPath`).
   * Relative paths resolve against `basePath` / cwd. Clears the module resolution cache
   * (documents loaded before keep their resolved imports).
   */
  addImportPath(dir: string): void {
    const abs = resolve(this.basePath ?? ".", dir)
    const i = this.importPathList.indexOf(abs)
    if (i >= 0) this.importPathList.splice(i, 1)
    this.importPathList.unshift(abs)
    this.moduleCache.clear()
  }

  /**
   * Map a module uri to an explicit directory (which need not end in `A/B/C`). It takes
   * precedence over the import paths. Relative paths resolve against `basePath` / cwd.
   * Clears the module resolution cache.
   */
  registerModuleDirectory(uri: string, dir: string): void {
    this.moduleDirs.set(uri, resolve(this.basePath ?? ".", dir))
    this.moduleCache.clear()
  }

  /**
   * Drop cached documents so the next load re-reads them from disk (hot reload). With `path`,
   * only that file's document / JavaScript namespace (and, for a `qmldir`, its directory's
   * module) are dropped; documents that already resolved it as a type keep the old one, so
   * for a full reload call it without arguments: every cached document, module, qmldir and
   * JavaScript namespace is dropped. The module resolution cache is always cleared.
   *
   * Objects already instantiated are untouched. Returns the instances of `pragma Singleton`
   * documents that were dropped with their document; the caller destroys them once nothing
   * uses them any more (else they live until the engine is destroyed).
   */
  invalidate(path?: string): QmlObject[] {
    this.moduleCache.clear()
    const stale: QmlObject[] = []
    const dropSingleton = (component: QmlComponent): void => {
      const obj = this.singletonInstances.get(component)
      if (!obj) return
      this.singletonInstances.delete(component)
      stale.push(obj)
    }
    if (path === undefined) {
      this.files.clear()
      this.modulesByDir.clear()
      this.scripts.clear()
      for (const component of [...this.singletonInstances.keys()]) dropSingleton(component)
      return stale
    }
    const abs = resolve(this.basePath ?? ".", path)
    this.files.delete(abs)
    this.scripts.delete(abs)
    if (abs.endsWith("qmldir")) this.modulesByDir.delete(dirname(abs))
    for (const component of [...this.singletonInstances.keys()]) if (component.filename === abs) dropSingleton(component)
    return stale
  }

  /**
   * Treat `uri` as a module provided by the engine's type registry (like `OpenTUI`, `QtQuick*`,
   * `QtQml*`, `Qt.*`): importing it never touches the file system.
   */
  registerNativeModule(uri: string): void {
    this.nativeModules.add(uri)
  }

  isNativeModule(uri: string): boolean {
    return this.nativeModules.has(uri) || NATIVE_MODULE.test(uri)
  }

  /**
   * Find the module directory for `uri`: a `registerModuleDirectory` entry, else
   * `A.B.C` → `<importPath>/A/B/C` (first match wins), then `<fromDir>/A/B/C`. A directory is a module if it has a `qmldir` or `.qml` files.
   * Returns null if not found. Cached per (uri, fromDir).
   */
  resolveModule(uri: string, fromDir?: string): QmlModule | null {
    const key = `${uri}\0${fromDir ?? ""}`
    const cached = this.moduleCache.get(key)
    if (cached !== undefined) return cached
    const rel = uriToPath(uri)
    const candidates = this.importPathList.map((p) => join(p, rel))
    const explicit = this.moduleDirs.get(uri)
    if (explicit) candidates.unshift(explicit)
    if (fromDir) candidates.push(join(fromDir, rel))
    const dir = candidates.find(isModuleDirectory)
    const module = dir ? this.moduleForDirectory(dir, uri) : null
    this.moduleCache.set(key, module)
    return module
  }

  /** The (cached) module for a directory, e.g. for `import "dir"` or a document's own directory. */
  moduleForDirectory(dir: string, uri?: string): QmlModule {
    const abs = resolve(dir)
    let module = this.modulesByDir.get(abs)
    if (!module) {
      module = new QmlModule(abs, uri, (m) => this.warn(m))
      this.modulesByDir.set(abs, module)
    }
    return module
  }

  /**
   * The namespace object of a JavaScript resource (`import "lib.js" as Lib`, qmldir JS entries):
   * evaluated once per engine, with `Qt`, `qsTr`, `qsTranslate` and the engine globals in scope.
   */
  scriptNamespace(absPath: string): Record<string, unknown> {
    let ns = this.scripts.get(absPath)
    if (!ns) {
      ns = evaluateScript(absPath, this.globals)
      this.scripts.set(absPath, ns)
    }
    return ns
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
      const state: BuildState = { aliasJobs: [], jobs: [], completions: [], created: [] }
      let obj: QmlObject
      try {
        obj = this.build(def, ctx, state, {
          parent: opts.parent ?? null,
          index: opts.index,
          contextRoot: true,
          deferCompletion: false,
          direct: true,
        })
      } catch (err) {
        // Don't leak a half-built tree (renderables attached to `parent`, subscriptions, ...).
        this.destroyPartial(state)
        throw err
      }
      if (opts.contextProperties) obj.contextProperties = opts.contextProperties
      // `required property var modelData` / `required property int index` on a delegate root:
      // initialise (bind) from the same-named context property, so updates flow. This must run
      // before any binding job so that bindings never see the property unset.
      state.jobs.unshift(() => this.bindRequiredFromContext(obj, ctx))
      const initial = opts.initialProperties
      if (initial) {
        // Initial properties are assigned before bindings evaluate (as in Qt's createObject).
        state.jobs.unshift(() => {
          for (const [key, value] of Object.entries(initial)) obj.set(key, value)
        })
      }
      this.finish(state)
      if (!obj.parent) this.roots.add(obj)
      return obj
    })
  }

  /**
   * Bind every still-unassigned `required` property of `obj` that has a same-named context
   * property (object-level, then the component context chain) to that context property.
   * The binding reads through getters, so role/`data` updates re-evaluate it.
   */
  private bindRequiredFromContext(obj: QmlObject, ctx: ComponentContext): void {
    const names = obj.unassignedRequiredProperties()
    if (names.length === 0) return
    const records: Array<Record<string, unknown>> = []
    if (obj.contextProperties) records.push(obj.contextProperties)
    for (let c: ComponentContext | null = ctx; c; c = c.parent) if (c.contextProperties) records.push(c.contextProperties)
    for (const name of names) {
      const record = records.find((r) => name in r)
      if (record) obj.bind(name, () => record[name])
    }
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
      const imports = context.component?.importLayer
      scope = buildObjectScope(object, context, imports ? [imports, ...this.globalLayers] : this.globalLayers)
      byContext.set(context, scope)
    }
    return scope
  }

  /**
   * The `.qml` file `obj` was declared in: the filename of its component context, walking up to
   * enclosing contexts (delegates / inline components) when that one has none. Undefined for
   * objects created from unnamed sources or outside any document.
   */
  sourceFileOf(obj: QmlObject): string | undefined {
    for (let c: ComponentContext | null = obj.component; c; c = c.parent) {
      const f = c.component?.filename
      if (f) return f
    }
    return undefined
  }

  /** Destroy what a failed instantiation created, innermost first; teardown errors are reported. */
  private destroyPartial(state: BuildState): void {
    for (const obj of state.created.reverse()) {
      if (obj.isDestroyed) continue
      try {
        obj.destroy()
      } catch (err) {
        this.reportError(err, `${obj.describe()}: destroy after a failed instantiation`)
      }
    }
    state.created.length = 0
  }

  /** Called by `QmlObject.destroy()`. */
  objectDestroyed(object: QmlObject): void {
    this.roots.delete(object)
  }

  /**
   * Register a callback run by {@link destroy} (once, before the root objects are destroyed),
   * in registration order. Errors are reported through `reportError`. Returns a disposer that
   * unregisters the callback. Registering on a destroyed engine is a no-op.
   */
  onDestroy(cb: () => void): () => void {
    // Wrap so the same function may be registered twice and each disposer removes its own entry.
    const entry = (): void => cb()
    if (!this.destroyed) this.destroyHooks.add(entry)
    return () => {
      this.destroyHooks.delete(entry)
    }
  }

  /** Run the {@link onDestroy} hooks, then destroy all root objects created by this engine. */
  destroy(): void {
    if (this.destroyed) return
    const hooks = [...this.destroyHooks]
    this.destroyHooks.clear()
    for (const hook of hooks) {
      try {
        hook()
      } catch (err) {
        this.reportError(err, "engine destroy hook")
      }
    }
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
    if (resolved.kind === "singleton") {
      throw new QmlRuntimeError(`"${def.name}" is a singleton and cannot be used as a type`, component.filename, def.loc?.start.line)
    }
    if (resolved.kind === "document") {
      // A document used as a type: build its root in a fresh private context, then apply the
      // user's members on top (below).
      const inner = createComponentContext(resolved.component, null, null)
      obj = this.build(resolved.component.document.root, inner, state, { ...place, contextRoot: true, deferCompletion: true })
    } else {
      obj = new resolved.factory(this, resolved.name)
      state.created.push(obj)
      obj.component = ctx
      if (place.contextRoot) ctx.root = obj
      if (place.parent && place.direct) place.parent.appendChild(obj, place.index)
      else if (place.parent) this.placeChild(place.parent, obj, place.index)
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
    const componentDefault = this.componentDefault(obj)
    for (const m of def.members) {
      if (m.type === "Object") {
        if (isComponent) continue
        if (componentDefault) {
          // `Repeater { Text {} }` / `default property Component delegate`: the child is a
          // Component (the delegate), not an instance.
          const { target, prop } = componentDefault
          const value = this.isComponentType(ctx, m.name)
            ? this.build(m, ctx, state, { parent: null, contextRoot: false, deferCompletion: false })
            : this.makeComponentValue(obj, m, ctx)
          target.ownObject(value)
          state.jobs.push(() => {
            if (isListType(target.propertyType(prop))) this.addToProperty(target, prop, value)
            else this.assign(target, prop, value.proxy)
          })
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

  /**
   * Where inline child objects written inside `obj` go (its `default property`):
   * - no default property / a default alias to `x.data`, `x.children`, `x.resources` or to the
   *   object `x` itself → `appendChild` on the owner (`obj` or `x`), in declaration order;
   * - a default (alias to a) property of any other type → the property receives the object
   *   (a `list`/`list<T>` collects them into a new array, anything else holds the single object);
   *   the object is owned by the property's object and is NOT a child (like Qt).
   */
  private defaultRoute(obj: QmlObject): { kind: "children"; target: QmlObject } | { kind: "property"; target: QmlObject; prop: string } {
    const info = this.defaultProps.get(obj)
    if (!info) {
      const native = obj.defaultPropertyName
      if (native && !CHILD_LIST_PROPERTIES.has(native) && obj.hasProperty(native)) return { kind: "property", target: obj, prop: native }
      return { kind: "children", target: obj }
    }
    const decl = info.decl
    if (decl.propertyType !== "alias") return { kind: "property", target: obj, prop: decl.name }
    const [head, ...rest] = decl.aliasTarget ?? []
    const target = head ? this.lookupId(info.context, head) : null
    if (!target) {
      this.warn(`${obj.describe()}: default property alias "${decl.name}" has no valid target`)
      return { kind: "children", target: obj }
    }
    const prop = rest.join(".")
    if (prop === "" || CHILD_LIST_PROPERTIES.has(prop)) return { kind: "children", target }
    if (target.hasProperty(prop)) return { kind: "property", target, prop }
    this.warn(`${obj.describe()}: default property alias "${decl.name}" refers to unknown property "${prop}"`)
    return { kind: "children", target: obj }
  }

  /** Put a child built from a child ObjectDefinition into its parent (honours `default property`). */
  private placeChild(parent: QmlObject, child: QmlObject, index?: number): void {
    const route = this.defaultRoute(parent)
    if (route.kind === "children") route.target.appendChild(child, route.target === parent ? index : undefined)
    else this.addToProperty(route.target, route.prop, child)
  }

  private addToProperty(obj: QmlObject, prop: string, child: QmlObject): void {
    obj.ownObject(child)
    const type = obj.propertyType(prop) ?? "var"
    const current = obj.peek(prop)
    if (isListType(type) || Array.isArray(current)) {
      obj.write(prop, [...((current as unknown[] | undefined) ?? []), child.proxy])
    } else {
      obj.write(prop, child.proxy)
    }
  }

  /** The default property of `obj` when it is Component-typed (Repeater, Loader, `default property Component x`). */
  private componentDefault(obj: QmlObject): { target: QmlObject; prop: string } | null {
    const route = this.defaultRoute(obj)
    if (route.kind !== "property") return null
    const type = route.target.propertyType(route.prop)
    return type === "Component" || type === "list<Component>" ? { target: route.target, prop: route.prop } : null
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

/** One `import` of a document. */
type ImportEntry =
  | { kind: "native"; uri: string }
  | { kind: "module"; module: QmlModule; version?: string }
  | { kind: "script"; path: string }

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** A loaded document: resolves type names visible to it and instantiates it. */
export class QmlComponent {
  readonly engine: QmlEngine
  readonly document: QmlDocument
  /** Absolute path, if loaded from (or associated with) a file. */
  readonly filename: string | undefined
  /** Directory whose sibling `.qml` files are visible as types. */
  readonly directory: string | undefined
  /** The document has `pragma Singleton`. */
  readonly isSingleton: boolean
  /** The document's own directory as a module (qmldir entries incl. internal ones, plus files). */
  private readonly ownModule: QmlModule | undefined
  private readonly imports: ImportEntry[] = []
  private readonly qualifiers = new Map<string, ImportEntry[]>()
  private readonly typeCache = new Map<string, ResolvedType | null>()
  private readonly namespaces = new Map<string, object>()
  private layer: ScopeLayer | undefined

  constructor(engine: QmlEngine, document: QmlDocument, filename?: string) {
    this.engine = engine
    this.document = document
    this.filename = filename
    this.directory = filename ? dirname(filename) : engine.basePath ? resolve(engine.basePath) : undefined
    this.isSingleton = document.pragmas.some((p) => p.name === "Singleton")
    this.ownModule = this.directory && isDirectory(this.directory) ? engine.moduleForDirectory(this.directory) : undefined
    for (const imp of document.imports) {
      const line = imp.loc?.start.line
      let entry: ImportEntry
      if (imp.path !== undefined) {
        const abs = resolve(this.directory ?? ".", imp.path)
        if (/\.m?js$/.test(imp.path)) {
          if (!imp.qualifier) throw new QmlRuntimeError(`JavaScript import "${imp.path}" needs a qualifier ("as Name")`, filename, line)
          if (!existsSync(abs)) throw new QmlRuntimeError(`JavaScript file "${abs}" not found`, filename, line)
          engine.scriptNamespace(abs)
          entry = { kind: "script", path: abs }
        } else {
          if (!isDirectory(abs)) throw new QmlRuntimeError(`import "${imp.path}": directory "${abs}" not found`, filename, line)
          entry = { kind: "module", module: engine.moduleForDirectory(abs), version: imp.version }
        }
      } else if (imp.uri) {
        if (engine.isNativeModule(imp.uri)) {
          entry = { kind: "native", uri: imp.uri }
        } else {
          const module = engine.resolveModule(imp.uri, this.directory)
          if (!module) {
            const paths = engine.importPaths.join(", ")
            throw new QmlRuntimeError(`module "${imp.uri}" is not installed (import paths: ${paths || "none"})`, filename, line)
          }
          entry = { kind: "module", module, version: imp.version }
        }
      } else continue
      if (imp.qualifier) {
        const list = this.qualifiers.get(imp.qualifier) ?? []
        list.push(entry)
        this.qualifiers.set(imp.qualifier, list)
      } else this.imports.push(entry)
    }
  }

  /**
   * Resolve a type name as written (`"Item"`, `"QtQuick.Item"`, `"Q.Foo"`). Unqualified names
   * look in: the document's own directory (its qmldir, then sibling `Foo.qml`), unqualified
   * module / `import "dir"` imports in declaration order, then the engine registry.
   * Qualified names (`Q.Foo`) look only in the imports with that qualifier. Throws for unknown types.
   */
  resolveType(name: string): ResolvedType {
    const resolved = this.tryResolveType(name)
    if (!resolved) {
      const reason = this.engine.typeNotAvailableReason(name.slice(name.lastIndexOf(".") + 1))
      if (reason) throw new Error(`${this.filename ?? "<qml>"}: type "${name}" is not available: ${reason}`)
      throw new Error(`${this.filename ?? "<qml>"}: unknown type "${name}"`)
    }
    return resolved
  }

  tryResolveType(name: string): ResolvedType | undefined {
    if (this.typeCache.has(name)) return this.typeCache.get(name) ?? undefined
    let result: ResolvedType | undefined
    const dot = name.indexOf(".")
    if (dot > 0) {
      const qualifier = name.slice(0, dot)
      const rest = name.slice(dot + 1)
      const entries = this.qualifiers.get(qualifier)
      if (entries) for (const entry of entries) result ??= this.fromImport(entry, rest)
      else result = this.fromRegistry(rest.slice(rest.lastIndexOf(".") + 1))
    } else {
      if (this.ownModule) result = this.fromModule(this.ownModule, name, undefined, true)
      for (const entry of this.imports) result ??= this.fromImport(entry, name)
      result ??= this.fromRegistry(name)
    }
    this.typeCache.set(name, result ?? null)
    return result
  }

  /**
   * Scope layer for names provided by this document's imports: import qualifiers (`B.Theme`,
   * `Lib.fn()`), singletons (`Theme.accent`) and qmldir JavaScript resources.
   */
  get importLayer(): ScopeLayer {
    this.layer ??= {
      kind: "layer",
      label: "imports",
      has: (name) => this.importValue(name).found,
      get: (name) => this.importValue(name).value,
      set: (name) => {
        throw new TypeError(`Cannot assign to "${name}" (an import)`)
      },
    }
    return this.layer
  }

  /** Instantiate this document. */
  createObject(parent?: QmlObject | null, contextProps?: Record<string, unknown> | null): QmlObject {
    return this.engine.createObject(this, parent, contextProps)
  }

  private importValue(name: string): { found: boolean; value?: unknown } {
    if (this.qualifiers.has(name)) return { found: true, value: this.namespace(name) }
    if (!/^[A-Z]/.test(name)) return { found: false }
    const type = this.tryResolveType(name)
    if (type?.kind === "singleton") return { found: true, value: type.instance() }
    if (type) return { found: false }
    let script: string | undefined
    if (this.ownModule) script = this.scriptIn(this.ownModule, name)
    for (const entry of this.imports) if (entry.kind === "module") script ??= this.scriptIn(entry.module, name, entry.version)
    return script ? { found: true, value: this.engine.scriptNamespace(script) } : { found: false }
  }

  /** Namespace object for an import qualifier (`import T3.Bricks as B` → `B`). */
  private namespace(qualifier: string): object {
    let ns = this.namespaces.get(qualifier)
    if (ns) return ns
    const entries = this.qualifiers.get(qualifier)!
    const lookup = (key: string): { found: boolean; value?: unknown } => {
      for (const entry of entries) {
        if (entry.kind === "script") {
          const script = this.engine.scriptNamespace(entry.path)
          if (key in script) return { found: true, value: script[key] }
          continue
        }
        const type = this.tryResolveType(`${qualifier}.${key}`)
        if (type?.kind === "singleton") return { found: true, value: type.instance() }
        if (type?.kind === "native" && type.factory.qmlStatics) return { found: true, value: type.factory.qmlStatics }
        if (entry.kind === "module") {
          const path = this.scriptIn(entry.module, key, entry.version)
          if (path) return { found: true, value: this.engine.scriptNamespace(path) }
        }
      }
      return { found: false }
    }
    ns = new Proxy(Object.create(null) as object, {
      has: (_t, key) => typeof key === "string" && lookup(key).found,
      get: (_t, key) => (typeof key === "string" ? lookup(key).value : undefined),
      set: (_t, key) => {
        throw new TypeError(`Cannot assign to ${qualifier}.${String(key)}`)
      },
    })
    this.namespaces.set(qualifier, ns)
    return ns
  }

  private scriptIn(module: QmlModule, name: string, version?: string): string | undefined {
    const entry = module.entry(name, "js", version, this.filename)
    return entry ? module.pathOf(entry) : undefined
  }

  private fromImport(entry: ImportEntry, name: string): ResolvedType | undefined {
    switch (entry.kind) {
      case "native":
        return this.fromRegistry(name.slice(name.lastIndexOf(".") + 1))
      case "module":
        return this.fromModule(entry.module, name, entry.version, false)
      case "script":
        return undefined
    }
  }

  /**
   * A type exported by a module: its qmldir entry (highest version ≤ the imported one; internal
   * entries only for documents inside the module), else — for the own directory or modules
   * without qmldir — a plain `Name.qml` file.
   */
  private fromModule(module: QmlModule, name: string, version: string | undefined, own: boolean): ResolvedType | undefined {
    if (!/^[A-Z]/.test(name)) return undefined
    // The own directory: sibling `Name.qml` first (so `Card2.qml` can use `Card`), then qmldir.
    let path = own || !module.qmldir ? module.plainFile(name) : undefined
    if (path === this.filename) path = undefined
    const entry = path ? undefined : module.entry(name, "qml", version, this.filename)
    if (entry) path = module.pathOf(entry)
    if (!path || path === this.filename) return undefined
    const component = this.engine.componentForFile(path)
    if (!component) {
      if (entry) this.engine.warn(`${module.dir}/qmldir: file "${entry.file}" for type "${name}" not found`)
      return undefined
    }
    if (component.isSingleton || module.isSingletonFile(path)) {
      const engine = this.engine
      return { kind: "singleton", name, component, instance: () => engine.singletonFor(component).proxy }
    }
    return { kind: "document", name, component }
  }

  private fromRegistry(name: string): ResolvedType | undefined {
    const factory = this.engine.getType(name)
    if (factory) return { kind: "native", name, factory }
    const doc = this.engine.getDocumentType(name)
    if (doc) return { kind: "document", name, component: doc }
    if (this.engine.hasSingleton(name)) {
      const engine = this.engine
      return { kind: "singleton", name, instance: () => engine.singletonValue(name) }
    }
    return undefined
  }
}
