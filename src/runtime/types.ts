/**
 * Shared runtime types: property specs, type factories, component contexts, schedulers.
 *
 * Kept free of runtime code (apart from type-only imports) so every runtime module and the
 * visual components can import it without creating import cycles.
 */
import type { QmlComponent, QmlEngine } from "./engine.ts"
import type { QmlObject } from "./object.ts"
import type { CompiledScript } from "./expression.ts"
import type { QmlScope } from "./scope.ts"

/**
 * Declared QML property type, as written in `property <type> name`.
 *
 * Known coercions: `int` (Math.trunc(Number(v))), `real` / `double` / `number` (Number),
 * `string` / `url` (String, null/undefined → ""), `bool` (Boolean). Everything else
 * (`var`, `color`, `list`, `list<Item>`, object type names, `Component`, ...) is passed through.
 * `Component` is special for the engine: an inline object bound to a `Component`-typed property
 * (`delegate: Item {}`) is kept uninstantiated and wrapped in a `Component` object.
 */
export type PropertyType =
  | "int"
  | "real"
  | "double"
  | "number"
  | "string"
  | "url"
  | "bool"
  | "var"
  | "variant"
  | "color"
  | "list"
  | "alias"
  | "Component"
  | (string & {})

/** Options for {@link QmlObject.defineProperty}. */
export interface PropertyOptions {
  /** Declared type; drives the default value and coercion. Defaults to `"var"`. */
  type?: PropertyType
  /** Initial value. When omitted the type's default is used (0, "", false, [], undefined). */
  value?: unknown
  /** Read-only properties reject `set()` (a TypeError); `write()` and `bind()` still work. */
  readonly?: boolean
  /** `required property`: a warning is logged if it has not been assigned by completion. */
  required?: boolean
  /**
   * Called (untracked) after the stored value changes, before `${name}Changed` is emitted.
   * Visual components use this to push values into their renderable.
   */
  onChange?: (value: unknown, old: unknown) => void
  /** Custom coercion. Overrides the built-in coercion derived from `type`. */
  coerce?: (value: unknown) => unknown
}

/** Any subclass constructor of `QmlObject` can be registered as a QML type. */
export type QmlTypeFactory = (new (engine: QmlEngine, typeName: string) => QmlObject) & {
  /**
   * Optional static members visible in QML under the type's name, e.g.
   * `static qmlStatics = { WordWrap: "WordWrap" }` makes `Text.WordWrap` resolve.
   */
  qmlStatics?: Record<string, unknown>
}

/** Result of resolving a type name inside a document. */
export type ResolvedType =
  | { kind: "native"; name: string; factory: QmlTypeFactory }
  | { kind: "document"; name: string; component: QmlComponent }

/**
 * One instantiation of a document (or of an inline `Component`/delegate).
 *
 * Holds the per-instance id table and the root object. Delegate / inline-component contexts
 * have `parent` set to the context they were declared in, so ids and root properties of the
 * enclosing document stay visible. Documents used as types (`Foo.qml`) get a fresh context
 * with no parent: their ids are private.
 */
export interface ComponentContext {
  /** The document being instantiated (null for the engine's root context). */
  readonly component: QmlComponent | null
  /** Enclosing context for delegates / inline components. */
  readonly parent: ComponentContext | null
  /** `id` → object, for ids declared in this instantiation. */
  readonly ids: Map<string, QmlObject>
  /** The root object of this instantiation. */
  root: QmlObject | null
  /** Context properties (e.g. `{ index, modelData, model }` for delegates). May use getters. */
  contextProperties: Record<string, unknown> | null
}

/** A connected handler spec, as produced by the engine for `onXxx:` bindings. */
export interface HandlerSpec {
  /** Handler name as written: `"onClicked"`, `"onWidthChanged"`, `"onPressed"`. */
  readonly name: string
  readonly compiled: CompiledScript
  /** Scope the handler body is evaluated in. */
  readonly scope: QmlScope
}

/** A reactive binding source: a compiled QML script or a plain JS function. */
export type BindingSource = CompiledScript | (() => unknown)

/** Timer backend. Defaults to the globalThis timer functions; tests inject a manual one. */
export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}
