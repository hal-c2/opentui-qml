# opentui-qml — Design

A QML runtime for [OpenTUI](https://opentui.com). Users write `.qml` files (QML syntax with
JavaScript expressions); the runtime parses them, builds a reactive object tree, and drives
OpenTUI core renderables (`@opentui/core`) directly — no React/Solid reconciler.

Goal: QML is easy for non-programmers to customise, so a TUI app can ship `.qml` files that
users edit to restyle/relayout the frontend without touching TypeScript.

Runtimes: Bun >= 1.3 (primary) and Node >= 26.4 (`node --experimental-ffi`, ESM only).
The code must be plain ESM TypeScript with no Bun-only APIs outside of `src/cli.ts` / tests
(use `node:fs`, `node:path`, `node:url`).

## Package layout

```
src/
  parser/
    ast.ts          # AST contract (already written — do not change shapes without updating this doc)
    lexer.ts        # QML/JS tokenizer
    parser.ts       # parseQml(source, filename?) -> QmlDocument
    index.ts
  runtime/
    reactive.ts     # thin wrapper over solid-js reactive core (see "Reactivity")
    expression.ts   # compile JS source -> callable; scope Proxy for `with`
    object.ts       # QmlObject: properties, bindings, signals, methods, children
    scope.ts        # name resolution chain (ids, scope object, component root, context, globals)
    engine.ts       # QmlEngine: type registry, file loading, imports, instantiation
    builtins.ts     # QtObject, Timer, Repeater, Connections, Component(+Loader), ListModel
    types.ts        # QmlType / QmlTypeDefinition / PropertySpec interfaces
    index.ts
  components/       # OpenTUI-backed visual types (Item, Rectangle, Text, TextInput, ...)
    keymap.ts       # Shortcut / Action / KeyBinding / Keymap (QML surface)
    keymap-host.ts  # one @opentui/keymap Keymap per engine + the Keyboard singleton
    index.ts        # registerOpenTuiTypes(engine)
  index.ts          # public API: runQml, createQmlApp, QmlEngine, parseQml, ...
  cli.ts            # `opentui-qml <file.qml>`
examples/           # runnable .qml apps
test/               # bun test
docs/
```

## Reactivity

Use the **solid-js reactive core** (`createSignal`, `createMemo`, `createComputed`,
`createRoot`, `batch`, `untrack`, `onCleanup`, `getOwner`, `runWithOwner`).

IMPORTANT: In Bun/Node, `import "solid-js"` resolves to the *server* build, which is
non-reactive. Import the browser build explicitly, exactly like `@opentui/solid` does:

```ts
import { createSignal, createComputed, createRoot, batch, untrack, onCleanup } from "solid-js/dist/solid.js"
```

`src/runtime/reactive.ts` re-exports what we use so this quirk lives in one place.

Semantics to reproduce from QML:

| QML | Implementation |
|---|---|
| `prop: expr` (binding) | `createComputed` inside the object's owner root that evaluates `expr` (tracked) and writes the property signal. |
| `prop = value` in JS | Disposes the binding (if any) then writes the signal. Bindings are broken by assignment, like Qt. |
| `onPropChanged: ...` | Emitted whenever the stored value changes (`!Object.is(old, new)`), whether by binding or assignment. Signal name is `${prop}Changed`. |
| `Qt.binding(() => expr)` assigned in JS | Re-establishes a binding. |
| binding loop | Solid throws on infinite loops; catch, log `QML: binding loop detected for property "x"`, and stop. Don't crash. |
| destroy | `dispose()` the object's root; destroys children recursively; removes renderable from its parent. |

Binding evaluation errors (ReferenceError, TypeError) must NOT crash the app: catch, log once
(`console.error` — OpenTUI captures console into its overlay), and leave the property at its
previous value. Errors thrown inside signal handlers are logged the same way.

## Binding expressions across lines (`src/parser/parser.ts`)

The parser does not parse JavaScript; it finds where a `name: expression` binding ends. At bracket
depth 0 the expression ends before `;`, before the `}` closing the object, or at a line break —
unless the expression continues, with JavaScript ASI semantics (as in Qt's grammar):

- brackets, parens, braces are unbalanced (template literals are single tokens);
- the previous line ends with an operator (`a +`, `cond ?`, `x ? a :`, `f(`, `=>`, `,`, `.`,
  `new`, `typeof`, ...);
- the next line starts with a binary / ternary / member operator: `+ - * / % ** == != === < > <= >=
  && || ?? ? : . ?. , = += ... ) ]`, `(` (call), `[` (index), a template literal (tagged), or
  `instanceof`/`in`/`as`/`else`/`catch`/`finally`. So `x: 1` followed by a line `-1` is `1 - 1`.
  Lines starting with `!`, `~`, `++`, `--` do not continue (JS would insert a semicolon).

A next line that starts a QML member always ends the expression: `property`/`signal`/`enum`/
`readonly`/`required`/`default`/`component`/`id:`, `Type {` / `group {`, and `name:` /
`a.b.c:` — except that `name: value` continues while a depth-0 `?` on an earlier line is still
waiting for its `:` (a ternary branch written as `cond ?\n  foo : bar`). Blocks (`{ ... }`) and
function bodies are captured by bracket balancing.

## Expressions and scope

Scripts are compiled once per binding/handler with `new Function`:

```ts
// expression:  return (SOURCE)
// block:       SOURCE            (the braces are already in the source; add `return` semantics: none)
// function expression handler: evaluates to a function; called with signal args
new Function("__scope", "__args", `with (__scope) { return (${source}) }`)
```

Sloppy mode is required for `with`; don't add "use strict".

`__scope` is a **Proxy** implementing `has`/`get`/`set`:
- `has(name)`: true iff the name resolves anywhere in the QML scope chain (below). Otherwise
  false so real JS globals (`Math`, `JSON`, `console`, `setTimeout`, `Date`, ...) fall through.
- `get(name)`: resolves through the chain, reading signals so Solid tracks the dependency.
  Methods are returned bound to their object. Signals are returned as callable emitters
  (`clicked()` emits `clicked`).
- `set(name, v)`: resolves the *owner* of the name through the same chain and assigns via
  `QmlObject.set` (breaks bindings). Assigning to an unknown name is an error (log, ignore).

Scope chain (first match wins), matching Qt's rules closely enough:
1. Properties, methods and signals of the **scope object** (the object the binding is written on).
2. `parent` (visual parent; also literally the name `parent`).
3. Context properties injected by delegates: `index`, `modelData`, `model`, and role names.
4. `id`s declared anywhere in the same component (document). Ids are per-document; a delegate
   instance shares the ids of the document it is written in.
5. Properties/methods/signals of the **component root object** (the document's root).
6. Engine globals: `Qt` (see below), `console`, plus anything passed via `runQml(..., { context })`.

Property access on objects (`foo.bar`) goes through `QmlObject`'s **public value proxy**:
every `QmlObject` exposes a Proxy (`obj.proxy`) whose `get` reads the signal for `bar`, whose
`set` calls `obj.set("bar", v)`, and which exposes methods, signals, `parent`, `children`, and
the raw object under `__qml`. Bindings always see and pass around the proxy, never the raw
`QmlObject`, so `parent.width` and `label.text = "x"` work naturally.

`this` inside a handler/function is the scope object's proxy.

`Qt` global (minimum): `Qt.binding(fn)`, `Qt.quit()` (calls `renderer.destroy()`),
`Qt.callLater(fn)`, `Qt.rgba(r,g,b,a)` -> "#rrggbbaa" string, `Qt.hsla(...)`, `Qt.darker(color, factor=2)`,
`Qt.lighter(color, factor=1.5)`, `Qt.formatDateTime(date, fmt?)` (basic), `Qt.platform.os = "tui"`.

## Runtime object model (`src/runtime/object.ts`)

```ts
export type PropertyType = "int" | "real" | "double" | "string" | "bool" | "var" | "color" | "list" | "alias" | string

export interface PropertyOptions {
  type?: PropertyType
  value?: unknown            // initial value
  readonly?: boolean
  required?: boolean
  /** Called (untracked) after the stored value changes. Components use this to push into renderables. */
  onChange?: (value: unknown, old: unknown) => void
  /** Optional coercion, e.g. "int" -> Math.trunc(Number(v)) */
  coerce?: (value: unknown) => unknown
}

export class QmlObject {
  readonly typeName: string
  readonly engine: QmlEngine
  id?: string
  parent: QmlObject | null
  readonly children: QmlObject[]          // all child objects in declaration order (visual + non-visual)
  readonly proxy: any                      // public value proxy (see above)
  readonly component: ComponentContext     // ids map, root object, document
  contextProperties: Record<string, unknown> | null   // e.g. { index, modelData } for delegates

  hasProperty(name): boolean
  defineProperty(name, opts?: PropertyOptions): void
  get(name): unknown                        // tracked read
  peek(name): unknown                       // untracked read
  set(name, value): void                    // breaks binding, coerces, writes, emits `${name}Changed`
  bind(name, compiled: CompiledScript, scopeObject?: QmlObject): void   // reactive binding
  unbind(name): void

  defineSignal(name, params?: string[]): void
  hasSignal(name): boolean
  emit(name, ...args): void                 // calls handlers in connection order; errors are logged
  connect(name, handler: (...args) => void): () => void   // returns disconnect
  defineMethod(name, fn: Function): void
  hasMethod(name): boolean
  call(name, ...args): unknown

  appendChild(child: QmlObject): void       // sets child.parent, pushes to children, calls this.onChildAdded
  removeChild(child: QmlObject): void
  destroy(): void                           // emits Component.destruction, disposes reactive root, destroys children, notifies type
  // Extension points for types:
  protected onChildAdded(child: QmlObject, index: number): void
  protected onChildRemoved(child: QmlObject): void
  protected onCompleted(): void             // after all bindings of the whole component are set up
}
```

Properties are backed by solid signals created lazily on `defineProperty`. `set` on a property
that isn't defined yet on a `var`-friendly object should define it as `var` (QML is strict about
this; we are lenient: log a warning in development, still define it). Every object also has
`objectName: string`.

Handlers: a PropertyBinding whose last path segment is `on` + Capitalized name and whose
object has a signal `name` (lowercase first letter) → connect. `onXxxChanged` for a property
`xxx` connects to the implicit changed-signal. Attached handlers `Component.onCompleted`,
`Component.onDestruction`, `Keys.onPressed`, `Keys.onReleased` are dispatched by the engine to
the type (see below). Unknown handler names are a warning, not an error.

Handler script forms (all supported): block `{ ... }`, expression `foo()`, function expression
`function(a, b) { ... }` / `(a, b) => ...`. For signals with named params (`signal moved(int x)`),
block/expression handlers see the params by name in scope (inject into a per-call context layer).

## Engine (`src/runtime/engine.ts`)

```ts
export interface QmlEngineOptions {
  renderer: CliRenderer            // from @opentui/core (or the test renderer)
  globals?: Record<string, unknown> // extra names visible in every scope (level 6)
  basePath?: string                 // for relative imports/files
  importPaths?: string[]            // module search dirs for `import A.B.C` (default [basePath ?? cwd])
  scheduler?: Scheduler             // timers for `Timer` / `Qt.callLater` (default: globalThis timers)
}

export class QmlEngine {
  constructor(opts: QmlEngineOptions)
  readonly renderer: CliRenderer
  registerType(name: string, type: QmlTypeFactory): void
  hasType(name): boolean
  /** Parse + register directory-local types: sibling `Foo.qml` files become type `Foo` (lazy). */
  loadFile(path: string): Promise<QmlComponent>
  loadSource(source: string, filename?: string): QmlComponent
  /** Instantiate a component. parent may be undefined for the root. */
  createObject(component: QmlComponent, parent?: QmlObject, contextProps?: Record<string, unknown>): QmlObject
  destroy(): void                           // runs onDestroy hooks, then destroys the roots
  /** Run `cb` in destroy(), before the roots are destroyed, in registration order; errors are
   *  reported via reportError. Returns a disposer. (Screen, Keyboard and the timeline detach use it.) */
  onDestroy(cb: () => void): () => void
  /** The `.qml` file `obj` was declared in (component context, walking up enclosing contexts). */
  sourceFileOf(obj: QmlObject): string | undefined
  /** Like qmlRegisterTypeNotAvailable: hasType stays false, using it fails with `message`. */
  registerTypeNotAvailable(name: string, message: string): void
  // modules and singletons (see "Modules and singletons")
  readonly importPaths: string[]
  addImportPath(dir: string): void          // highest priority; clears the module cache
  registerNativeModule(uri: string): void   // uri resolved against the type registry
  registerModuleDirectory(uri: string, dir: string): void  // explicit uri -> dir, before importPaths
  invalidate(path?: string): QmlObject[]    // drop cached docs/modules/scripts; returns stale QML singletons
  resolveModule(uri: string, fromDir?: string): QmlModule | null
  registerSingleton(name: string, value: unknown): void  // value, QmlObject or (engine) => value
  singletonFor(component: QmlComponent): QmlObject       // lazy, one per engine, no parent
  scriptNamespace(absPath: string): Record<string, unknown>  // JS resource, evaluated once
}

export interface QmlComponent {
  document: QmlDocument
  filename?: string
  /** Types visible to this document: builtins + directory siblings + `import "dir"` + qualified imports */
  resolveType(name: string): QmlTypeFactory
  createObject(parent?: QmlObject, contextProps?): QmlObject
}
```

Instantiation of an `ObjectDefinition` (order matters for QML semantics):
1. Resolve type; construct the `QmlObject` subclass (types may create their renderable in the constructor).
2. Register `id` in the component's id table.
3. Declare declared properties (`PropertyDeclaration`), signals, methods, enums.
4. Recursively instantiate child `ObjectDefinition` members and property values that are objects
   (`ObjectBinding` / `ArrayBinding`), appending visual children via `appendChild`.
   Object-valued property bindings (`delegate: Item {}`) are NOT appended as children; the
   *value* is the child object (for `delegate` it stays uninstantiated — see Repeater).
5. Apply all `PropertyBinding`s: literals are set directly; scripts become bindings; handlers connect.
6. After the *entire* component tree is built and bound, call `onCompleted()` bottom-up
   (children before parents) and emit `Component.completed`.

If building throws (unknown type, singleton used as a type, ...), every object the instantiation
already created is destroyed before the error propagates, so a failed document (e.g. a broken
user `shell.qml`) leaves nothing attached to its parent. `QmlObject.onDestroy(fn)` returns an
unsubscribe function.

Type files: a document whose root is `Item { property int foo }` used as `Foo { foo: 3 }` from
another file: instantiate the `Foo` document's root as the object, then apply the user's
members onto it (user bindings override). Ids inside Foo.qml are private to Foo.qml.

Completion order: `Component.onCompleted` runs after every binding of the whole instantiation is
applied, children before parents, siblings (and object-valued properties) in declaration order.
For `Foo { }` the Foo.qml root's handlers run before the user's `Component.onCompleted`.

### `data`, `children`, `resources`

Every `QmlObject` has three read-only list properties (reactive, with `dataChanged` /
`childrenChanged` / `resourcesChanged`): `data` = all child objects in order, `children` = the
visual children (for a non-visual object: all children), `resources` = the non-visual children.
They cannot be assigned (`children = []` is a TypeError); `data: [a, b]` in QML *appends* `a`
and `b` as children. A real property with the same name (e.g. `Slot.data`) shadows the
intrinsic one, and so does a same-named context property (plugin contributions' `data`).

### Default property routing

Child objects written inside `Foo { ... }` go to Foo's default property:
- no `default property` in the document: the native type's `defaultPropertyName` if it is a
  real property (`Repeater.delegate`, `Loader.sourceComponent`), else `appendChild`;
- `default property alias content: inner.data` / `inner.children` / `inner` (an object alias):
  `inner.appendChild(child)` in declaration order (inner's own default routing is not applied).
  The children keep the scope of the document that wrote them (outer ids stay visible);
- `default property list<Item> items` / `list<QtObject>`: the objects are collected into the
  (reactive) array and are *not* reparented; `Column { data: root.items }` places them;
- a non-list default (`Component`, `var`, `QtObject`): receives the single object; for a
  `Component`-typed default the child stays uninstantiated (it becomes a Component value);
- children declared in the same object that declares the default property use the type's
  default (so `Item { default property alias content: box.children; Item { id: box } }` works,
  unlike Qt's self-parenting gotcha).
`Component.createObject(parent)`, delegates and `engine.createObject(c, parent)` append to
`parent` directly (no default routing).

### Delegates and required properties

Delegates (Repeater, ListView, Instantiator) get the context properties `index`, `modelData`,
`model` and, for `ListModel` rows, one live getter per role. This holds for number, array and
ListModel models. A `required property` that is still unassigned after the delegate's own
bindings and has a same-named context property is *bound* to it (so ListModel updates flow) and
does not warn. `Instantiator { model; delegate; active; asynchronous (ignored); count; object;
objectAt(i); objectAdded(index, object); objectRemoved(index, object) }` creates its objects as
its own (non-visual) children.

## Modules and singletons (`src/runtime/modules.ts`, `src/runtime/store.ts`)

Imports are resolved per document when it is loaded:
- `import OpenTUI`, `QtQuick*`, `QtQml*`, `Qt.*` (and `engine.registerNativeModule(uri)`) are
  native: names resolve against the type registry.
- `import A.B.C [version] [as Q]` searches `<importPath>/A/B/C` for each engine import path
  (option `importPaths`, default `[basePath ?? cwd]`; `addImportPath` prepends), then the
  importing document's directory. A directory with a `qmldir`, or with any `.qml` file, is a
  module. Unknown modules throw `QmlRuntimeError` at load, listing the import paths. Modules
  are cached per directory and per (uri, importing directory).
- `import "dir" [as Q]` is the same for a directory relative to the document (must exist).
- `import "file.js" as Name`: evaluated once per engine as a library (`.pragma` / `.import`
  lines ignored), with `Qt`, `qsTr`, `qsTranslate` and the engine globals in scope. Top-level
  `function` / `var` / `let` / `const` / `class` names become live members of `Name`.

`qmldir` subset: `module`, `Type [version] File.qml`, `singleton Type [version] File.qml`,
`internal Type File.qml` (only visible to documents inside the module directory),
`Name [version] file.js` (JS resource, available as `Name`), `#` comments. Ignored: `typeinfo`,
`plugin`, `optional plugin`, `classname`, `prefer`, `depends`, `import`, `designersupported`,
`linktarget`, `static`, `system`. With several versions of a type, the highest version not
above the imported one wins (unversioned import: the highest). Without a qmldir, every
`Name.qml` in the directory is exported.

Unqualified type lookup: the document's own directory (sibling `Name.qml`, then its qmldir
entries, internal ones included), unqualified imports in declaration order, then the registry.
`Q.Name` looks only in the imports qualified `Q`; `Q.Theme`, `Q.Util` also work in scripts.

Singletons: a qmldir `singleton` entry (or a `pragma Singleton` document) is not instantiable
(`Theme {}` throws); the name evaluates to one engine-wide instance created lazily on first
read, with no parent, destroyed with the engine. From TypeScript,
`engine.registerSingleton("Shell", value | qmlObject | (engine) => value)` exposes a name in
every document (after document imports, before `globals`). For TS-side reactive state:
- `createStore(initial)`: a deep proxy with one signal per key (reads of missing keys, `in`,
  and key enumeration are tracked; plain objects/arrays are wrapped lazily; array methods work);
- `createPropertyMap()`: `set/insert`, `get/value`, `contains`, `clear`, `keys`, `toJSON`,
  values also readable as properties; reading an unset key is tracked, so
  `Shell.state.layout ? Shell.state.layout.sidebarCollapsed : false` updates on
  `state.set("layout", {...})`.

## Type definitions (`src/runtime/types.ts`)

```ts
export type QmlTypeFactory = new (engine: QmlEngine, typeName: string) => QmlObject
```

Visual types live in `src/components/`. They subclass `QmlObject`:

```ts
export abstract class VisualObject extends QmlObject {
  abstract readonly renderable: Renderable    // @opentui/core
  // appendChild of a VisualObject child adds child.renderable to this.renderable (respecting index)
}
```

Non-visual builtins in `src/runtime/builtins.ts`: `QtObject`, `Timer`, `Repeater`,
`Connections`, `Component`, `ListModel`/`ListElement`, `Binding`? (skip for now).

`Repeater { model: N | [] | ListModel; delegate: Item {} }`:
- Instantiates `delegate` once per model entry with context `{ index, modelData }` (for ListModel rows,
  each role is also injected as a context name and `model.role`).
- Delegate instances are inserted into the Repeater's *parent* renderable at the Repeater's
  position (Repeater itself is non-visual, like Qt). Re-runs when `model` changes (recreate all; a
  keyed diff is a later optimisation). `count` property, `itemAt(i)` method.
- ListView (visual, in components) also uses delegate + model; see below.

`Timer { interval: 1000; running: true; repeat: true; triggeredOnStart: false; onTriggered: ... }`,
methods `start()`, `stop()`, `restart()`. Uses `engine.scheduler` (`QmlEngineOptions.scheduler`;
default globalThis timers, `ManualScheduler` for tests); cleared on destroy.

`Connections { target: someId; function onSomething(a) {} }` (Qt6 style) and legacy
`onSomething: ...` bindings — connects to the target's signals; re-connects when `target` changes.

`Component { Item {} }` — non-visual, holds an uninstantiated ObjectDefinition;
`createObject(parent, props?)` method. `Loader { sourceComponent: comp; active: true }` instantiates.

## Component mapping to OpenTUI (`src/components/`)

All visual types inherit `Item`. Property names follow QML where a QML equivalent exists,
otherwise OpenTUI's names (flexbox). Every visual type also accepts the full OpenTUI layout
prop set (`flexDirection`, `flexGrow`, `flexShrink`, `flexBasis`, `flexWrap`, `alignItems`,
`alignSelf`, `justifyContent`, `padding*`, `margin*`, `gap`, `minWidth`, `maxWidth`, `minHeight`,
`maxHeight`, `position`, `top/left/right/bottom`, `overflow`, `zIndex`) as plain passthrough
properties (value -> `renderable[name] = value`).

| QML type | OpenTUI renderable | Notable properties / signals |
|---|---|---|
| `Item` | `BoxRenderable` (no border, transparent) | `width`, `height` (number, `"50%"`, `"auto"`), `x`, `y` (read-only: layout results, updated after layout), `visible`, `opacity`, `z`→zIndex, `focus` (bool: focus()/blur()), `enabled`, `spacing`→gap, `anchors.fill: parent` → width/height 100%, `anchors.centerIn: parent` → sets parent's alignItems/justifyContent center (best effort), `Layout.fillWidth/fillHeight` → flexGrow 1 + alignSelf stretch, `Layout.preferredWidth/Height` → width/height, `Layout.alignment` (ignore), `children` (default property), signals: `Keys.onPressed(event)` via renderable `onKeyDown` when focused, mouse: `onClicked`? -> no; Items expose `MouseArea`-like handlers directly: `onMouseDown/onMouseUp/onMouseMove/onMouseScroll` (OpenTUI names). |
| `Rectangle` | `BoxRenderable` | `color`→backgroundColor, `border.width` (>0 → border true), `border.color`, `border.style` ("single"/"double"/"rounded"/"bold"), `radius` (>0 → rounded style), `title`, `titleAlignment`, `focusedBorderColor` |
| `Column` / `ColumnLayout` | `BoxRenderable` flexDirection column | `spacing`→gap |
| `Row` / `RowLayout` | `BoxRenderable` flexDirection row | `spacing`→gap |
| `Grid` | Box with flexWrap wrap | `columns` (best effort: child width %) |
| `Text` / `Label` | `TextRenderable` | `text`, `color`→fg, `backgroundColor`→bg, `font.bold/italic/underline/strikeout`, `wrapMode` ("NoWrap"/"WordWrap"→wrapMode), `horizontalAlignment` ("AlignLeft"/"AlignHCenter"/"AlignRight"→textAlign? if supported, else ignore), `selectable`. `text` may be a string or a StyledText. |
| `TextInput` / `TextField` | `InputRenderable` | `text` (two-way: INPUT event → set `text` without breaking? Qt: user edits break bindings — do the same), `placeholderText`, `maxLength`, `color`, `backgroundColor`, `focusedBackgroundColor`, `cursorColor`, signals `textEdited(text)`, `accepted()` (ENTER), `editingFinished()` (blur) |
| `TextArea` | `TextareaRenderable` | `text`, `placeholderText`, `wrapMode`; signals `textEdited` |
| `ListView` | `SelectRenderable` | `model` (array of strings, array of `{name, description, value}`, or ListModel; a delegate is NOT rendered — Select owns rendering), `currentIndex` (two-way), `currentItem` (selected option), signals `activated(index, option)` (ITEM_SELECTED), `currentIndexChanged`; colours `selectedBackgroundColor`, `selectedTextColor`, `textColor`, `backgroundColor`, `showDescription`, `wrapSelection`→`wrapSelection`, `keyNavigationWraps` alias |
| `TabBar` | `TabSelectRenderable` | `model` (array of strings/objects), `currentIndex`, `tabWidth`, signals `activated` |
| `ScrollView` / `Flickable` | `ScrollBoxRenderable` | `showScrollbar`, `stickyScroll`, `scrollX`/`scrollY`, methods `scrollTo(y)`, `scrollBy(dy)`; children go into `.content`? No — `ScrollBoxRenderable.add` already routes into content; just call `add`. |
| `AsciiText` / `BigText` | `ASCIIFontRenderable` | `text`, `font` ("tiny"/"block"/"slick"/"shade"), `color` |
| `Code` | `CodeRenderable` | `text`→content, `language`/`filetype`, `theme`? |
| `Markdown` | `MarkdownRenderable` | `text`→content |
| `Window` / `ApplicationWindow` | Box that fills the terminal | `title` (ignored), `width`/`height` default 100%; `color` → backgroundColor; only valid as root |
| `QRCode` (optional) | `QRCodeRenderable` from `@opentui/qrcode` (an `optionalDependencies` entry) | registered only if the package loads (`registerQrCode`); otherwise `registerTypeNotAvailable` makes a use fail with "install the optional package @opentui/qrcode". `text` (aliases `value`, `content`), `errorCorrection` (L/M/Q/H or low/medium/quartile/high), `color`, `backgroundColor`, `quietZone`, `scale`, `fit`, `fallbackText`, `fallbackColor`; methods `version()`, `moduleCount()` |

Colors: accept `"#rrggbb"`, `"#rgb"`, CSS names, `"transparent"`, and RGBA objects (pass through;
OpenTUI's `parseColor` handles strings).

Keyboard: global `Keys.onPressed` on the root object receives every key event (`renderer.keyInput.on("keypress")`);
on non-root Items it fires only when that item (or a descendant) is focused. The event object has
`key` (name), `text`, `ctrl`, `shift`, `alt`(meta), `accepted` (setting true stops propagation via `stopPropagation`).

Focus: `focus: true` on an Item calls `renderable.focus()` after completion. Type-level
`focusable` passthrough. `forceActiveFocus()` method.

Sizes: Item's `width`/`height` getters return the *declared* value (number/string). The layout
result is exposed as `x`, `y`, `layoutWidth`, `layoutHeight` read-only props updated from the
renderable's `onSizeChange`/lifecycle pass so `width: parent.layoutWidth - 4` style bindings work.

## Public API (`src/index.ts`)

```ts
export async function runQml(file: string, options?: RunQmlOptions): Promise<QmlApp>
export async function runQmlSource(source: string, options?: RunQmlOptions & { filename?: string }): Promise<QmlApp>

export interface RunQmlOptions {
  renderer?: CliRenderer                  // default: createCliRenderer(rendererConfig)
  rendererConfig?: CliRendererConfig
  context?: Record<string, unknown>       // globals visible in QML (and in the plugin context)
  types?: Record<string, QmlTypeFactory>  // extra types
  plugins?: (AnyPlugin | string)[]        // TS plugins, or paths of QML plugin files (relative to cwd)
  pluginDirs?: string[]                   // dirs whose *.qml files with a Plugin root are loaded (relative to cwd)
  keymap?: Record<string, unknown>        // overrides merged into the document's Keymaps
  basePath?: string                       // default: the file's directory (source: cwd)
  importPaths?: string[]                  // extra module dirs (relative to cwd), searched before basePath
  singletons?: Record<string, unknown>    // engine.registerSingleton for each entry
  scheduler?: Scheduler
  onWarning?: (message: string) => void
  onError?: (error: unknown, context?: string) => void
}

export interface QmlApp {
  engine: QmlEngine
  root: QmlObject          // the instantiated root object (root.proxy for property access)
  renderer: CliRenderer
  destroy(): void          // tree + plugins; also the renderer if runQml created it
}

export function createQmlEngine(opts: QmlEngineOptions & { types?: ... }): QmlEngine
  // builtins + OpenTUI types + Slot + Plugin/Contribution, then `types`
export { parseQml } from "./parser"
export { QmlObject, VisualObject, QmlEngine, Slot, registerPlugin, ... } ...
```

Startup order: parse the document (syntax errors throw `QmlSyntaxError` before any side effect),
load plugins (so a QML plugin's `types` are visible to the document), instantiate, check the root
is visual, mount into `renderer.root`, apply keymap overrides. On failure everything created so far
is torn down (the renderer only if `runQml` created it) and the error is rethrown.

Exiting: `Qt.quit()` or Escape handled by the user's QML → `renderer.destroy()`. Never call
`process.exit()` from the runtime. `runQml` wires `renderer.on("destroy")` to plugin disposal +
`engine.destroy()`.

CLI (`src/cli.ts`, bin `opentui-qml`): `opentui-qml <file.qml> [--plugins dir]... [--plugin file.qml]...
[--context key=value]... [--keymap file.json] [-I dir]...`. `-I`/`--import-path` adds module
search directories. `--context` values are JSON-parsed when possible.
Exit codes via `process.exitCode`: 0 ok, 1 load/runtime error or missing file, 2 usage error.

## Testing

`bun test`. Parser tests are pure. Runtime tests use hand-built ASTs or `parseQml` + a fake
engine with a non-visual type registry. Component/integration tests use
`createTestRenderer({ width, height })` from `@opentui/core/testing`, mount via `runQml`-style
helper with `renderer` supplied, then `await renderOnce()` and assert on `captureCharFrame()`.
Keyboard interaction via `mockInput.pressKey("ARROW_DOWN")` / `typeText`.

`testQml` (`src/testing.ts`) runs the renderer on a `ManualClock` and, unless a `scheduler` is
passed, gives the engine a `ManualScheduler` (`t.scheduler`): `advance(ms)` moves animations and
QML `Timer`s together, stepping to each due timer (so an animation a Timer starts only gets the
remaining time); zero-delay tasks (`Qt.callLater`) run on every render helper. A lone ESC is held
by OpenTUI's stdin parser for 20 ms on the renderer clock, so `pressEscape()` /
`pressKey("ESCAPE")` run that timeout and rewind the clock (no time passes for animations).

## Non-goals for v1

States/Transitions/Behaviors/animations, anchors beyond `fill`/`centerIn`, `Loader` async,
C++/native `qmldir` plugins, `.import` inside JS files, non-library (per-instance) JS files,
module version checks beyond picking qmldir entries,
`ListView` delegates rendering custom items (Select owns rendering), `MouseArea` (mouse handlers are on Item).

## Keymap (`src/components/keymap.ts`, `src/components/keymap-host.ts`)

Goal: declare keyboard shortcuts in QML so users can rebind them, and let the host app override
them from TypeScript. The implementation is built on `@opentui/keymap` (pinned to the same
version as `@opentui/core`).

### Host (`keymap-host.ts`)

Each engine gets one `KeyboardHost`, created lazily by the first keymap type or the first use of
`Keyboard`. It owns one `@opentui/keymap` `Keymap` over `createOpenTuiKeymapHost(renderer)`. The
host is destroyed with the engine (`registerOpenTuiTypes` registers an `engine.onDestroy` hook) or with the
renderer. A headless engine (no renderer) has no keymap: layers are no-ops, and `Action.trigger()`
emits locally.

Addons installed, in this order:
- The default set: `registerDefaultKeys`, `registerEnabledFields` and `registerMetadataFields`,
  the same as `createDefaultOpenTuiKeymap`.
- `registerBindingOverrides`, `registerEmacsBindings` (`"ctrl+x ctrl+s"`), `registerModBindings`
  (`mod` = ctrl, or super on macOS), `registerEscapeClearsPendingSequence` and
  `registerBaseLayoutFallback`.
- `registerDeadBindingWarnings` and `registerUnresolvedCommandWarnings`.

The package's `"warning"` and `"error"` events go to `engine.warn` with the prefix `keymap:`.
`registerCommaBindings` is **not** installed, because it rejects the literal `","` and
`"ctrl+,"`. Instead, alternatives (`"ctrl+s, f2"`) are split on the QML side (`toKeymapKeys`).

QML-specific pieces:
- **Layer fields**: `qmlYieldToEditor` (`activeWhen`: the layer is inactive while a focused
  `EditBufferRenderable` would take the key as text) and `qmlOwner` (the id of the QML object,
  used for `Keymap.activeKeys()` and `Keymap.pendingSequence`).
- **Binding field**: `qmlCommand`, the action name shown by `activeKeys()`.
- **Event-match resolver**: a shifted single symbol also matches without shift (`"?"`), and
  option also matches as meta.
- **`key` / `key:after` intercepts**: these bracket each dispatch. Layer changes made by handlers
  during a dispatch are queued (`host.mutate`) and applied after the key.

`toKeymapKeys` normalises QML key strings to the package's syntax, doing things the package
parser does not:
- a canonical modifier order
- a lone capital letter becomes shift (`"G"` → `"shift+g"`)
- aliases such as `esc`, `enter` → `return`, `comma`, `plus`, `pgup`
- plain runs become sequences (`"gg"` → `"g g"`)
- `"<leader>"` tokens
- an error for unknown modifiers

### Types

```qml
Shortcut {
    sequence: "ctrl+s"              // or sequences: ["ctrl+s", "f2"]; "gg", "ctrl+x ctrl+s", "<leader>s"
    enabled: true
    context: "window"               // "window" (default) | "item" | "application"
    priority: 0
    autoRepeat: true                // ignore "repeat" key events when false
    description: "Save"             // shown by Keyboard.activeKeys()
    onActivated: (event) => save()
}

Action {                            // standalone, or a child of a Keymap (then it is that keymap's action)
    name: "save"; text: "Save"; shortcut: "mod+s"; description: "Save the file"; category: "File"
    enabled: true
    onTriggered: (event) => save()  // event.payload is set by trigger(payload) / dispatch(name, payload)
}
// action.trigger(payload?) === Keyboard.dispatch(action.name, payload)

Keymap {
    name: "main"                    // override target: runQml(file, { keymap: { main: {...} } })
    bindings: ({ "ctrl+s": "save", "gg": "top", "?": { action: "help", description: "Help" } })
    KeyBinding { keys: "ctrl+r"; action: "reload"; description: "Reload the file" }
    Action { name: "save"; shortcut: "mod+s"; text: "Save" }
    handlers: ({ save: (event) => save(), quit: () => Qt.quit() })
    onActivated: (action, event) => { ... }     // fires for every matched action
    leader: "space"                             // defines the <leader> token
    enabled: true; priority: 0; context: "window"; target: null   // target: an Item for "item" context
    // describe(), keysFor(action), activeKeys(), pendingSequence, dispatch(action, payload?)
}

// Singleton
Keyboard.pendingSequence            // reactive: "g", "ctrl+x", ...
Keyboard.activeKeys()               // [{ key, command, description }] reachable now (reactive;
                                    // minus keys a focused TextInput would take as typing)
Keyboard.commands()                 // [{ name, title, description, category, keys }]
Keyboard.dispatch(name, payload?)   // run a command; false if none accepted it
Keyboard.setData(key, value) / getData(key)
Keyboard.formatKey("mod+s")         // "ctrl+s" (or "super+s" on macOS)
Keyboard.clearPendingSequence()
```

### Semantics

- **Layers and precedence**: each `Shortcut`, `Keymap` and standalone `Action` registers one
  layer. Layers are ordered by `priority` (higher first), then by document order (earlier
  first). This is done with a fractional priority bonus, because the package otherwise prefers
  newer layers. All keymap layers see a key before the focused renderable and before `Keys.*`:
  the package listens with `prependListener`, and `KeyDispatcher` skips stopped events. Root
  `Keys.onPressed` therefore does not see a key a binding consumed.
- **Fall-through**: a handler that sets `event.accepted = false` makes the binding's command
  return `false`. The package then does not `preventDefault()`, and it tries the next matching
  binding or layer, then the focused renderable, then `Keys.*`.
- **Context**:
  - `"window"` (the default; it was `"application"` before `@opentui/keymap`) and `"item"`
    layers set `qmlYieldToEditor`. While a `TextInput`/`TextArea` has focus and no sequence is
    pending, keys without ctrl/alt/super that edit text are left to the input: printable
    characters, space, backspace, delete, left, right, home, end and return. `"ctrl+s"` still fires.
    A window-level `Shortcut { sequence: "a" }` therefore does not steal typing.
  - `"item"` layers target the enclosing visual item, or `Keymap.target`, with `targetMode:
    "focus-within"`.
  - `"application"` layers are always active.
- **Commands**:
  - Command names are global, as in the package. `Keyboard.dispatch(name)` runs the
    highest-priority active layer's command of that name, and a rejection falls down the chain.
  - Bindings use inline command functions, so two `Keymap`s that both bind `"save"` stay
    independent. As a consequence, the package's `bindingOverrides` addon does not apply to QML
    bindings. QML overrides are key-based (below).
- **Overrides**: `applyKeymapOverrides(engine, overrides)` (used by `runQml({ keymap })` and the
  CLI's `--keymap`) merges `{ "ctrl+s": "save" }` into unnamed keymaps, and `{ main: {...} }`
  into `Keymap { name: "main" }`. A `null` action removes a binding. Keymaps created later
  receive the stored overrides on completion.
- **Reactivity**:
  - `bindings`, `enabled`, `priority`, `context`, `target`, `leader` and `sequence(s)` can
    change at runtime; the layer is re-registered.
  - `Keyboard.activeKeys()`, `Keyboard.commands()` and `Keymap.describe()` depend on the
    keymap's state, so bindings that use them update with focus, the pending sequence and layer
    changes.
- **Helpers kept for compatibility**: `parseKeySequence`, `formatKeySequence`, `keyEventMatches`
  and `normalizeKeyName`. These are single-stroke matchers that are not used for dispatch.
- **Component key bindings**: `ListView`/`TabBar`/`TextInput`/`TextArea` expose a `keyBindings`
  property that is passed through to the renderable (`[{ name: "j", action: "move-down" }]`),
  plus a `keyAliasMap` passthrough.

## Plugins (`src/runtime/plugins.ts`, `src/components/slot.ts`)

OpenTUI ships a slot-based plugin system (`createCoreSlotRegistry`, `registerCorePlugin`,
`SlotRenderable` in `@opentui/core`): a plugin is `{ id, order?, setup?, dispose?, slots: { [name]: (ctx, data) => Renderable } }`
and a `SlotRenderable({ registry, name, data?, mode: "append"|"replace"|"single_winner", fallback? })`
mounts every contribution for `name` at that point in the tree, re-resolving when the registry
changes. We expose exactly this to QML. The API is a set of free functions taking the engine
(not engine methods), so the engine stays independent of OpenTUI's plugin module:

```ts
getSlotRegistry(engine): QmlSlotRegistry          // lazily created; shared per renderer (OpenTUI keys it by renderer)
registerPlugin(engine, plugin: AnyPlugin): () => void   // returns the unregister function
unregisterPlugin(engine, id): boolean
listPlugins(engine): { id, order, kind: "ts" | "qml", file? }[]
loadQmlPlugin(engine, path): Promise<PluginObject>      // rejects if the root is not a Plugin
loadPluginsFromDir(engine, dir): Promise<PluginObject[]> // skips non-Plugin files; errors are reported
registerPluginTypes(engine)                              // registers Plugin + Contribution (createQmlEngine does this)
createFromSource(engine, source, parent?, contextProps?) // instantiate QML text (component cached per source)
```

- The registry context is `{ ...context, engine, renderer, root }` where `context` is the
  `runQml` `context` option (engine globals) and `root` is the application root's proxy (set once
  the document is instantiated; `null` during plugin `setup`).
- **`Slot`** visual type wraps `SlotRenderable`: `Slot { name: "sidebar"; mode: "replace"; data: ({...}) }`.
  Children declared inside the `Slot` are its fallback. Modes follow OpenTUI: **`replace`
  (default)** shows all contributions, or the fallback when there are none; `append` always shows
  the fallback followed by the contributions; `single_winner` shows only the first contribution.
  Contributions are ordered by plugin `order`, then registration order. `data` is reactive
  (assigning a new value re-renders the contributions; `refresh()` re-renders after an in-place
  mutation). Read-only `count` = number of contributing plugins. Layout props for the contents
  (`flexDirection`, `alignItems`, `justifyContent`, `padding*`, `gap`/`spacing`) apply to the
  contributions; size/position/margin props apply to the Slot itself. Changing `name` re-resolves.
- **TypeScript plugins**: `runQml(file, { plugins: [plugin, ...] })` or `registerPlugin(engine, plugin)`
  where `plugin` is an OpenTUI `CorePlugin` (any `CorePlugin` is assignable to `QmlPluginSpec`).
  Slot renderers receive `(ctx, data)` and return a Renderable; they may also return a visual
  **QmlObject** or its proxy (we mount `.renderable`; the object is destroyed with it) or a **QML
  source string** (instantiated with context properties `{ ...data, data, slotData }`).
  Function contributions are host-owned (destroyed when unmounted); `{ render, onActivate?,
  onDeactivate?, onDispose? }` contributions are plugin-owned (OpenTUI "managed": only detached).
- **QML plugins**: a `.qml` file whose root is `Plugin`:

  ```qml
  import OpenTUI
  Plugin {
      pluginId: "wordcount"    // optional; defaults to the QML `id`, then the file's base name
      order: 10
      types: ["./Widget.qml"]  // registered engine-wide under their base names (relative to this file)
      Contribution {
          slot: "statusbar"
          Text { text: "words: " + data.words }   // `data` (alias `slotData`) = the Slot's data
      }
      Contribution { slot: "sidebar"; mode: "managed"; Item { ... } }
      Component.onCompleted: console.log("plugin loaded")   // = setup
      Component.onDestruction: ...                          // = dispose
  }
  ```
  **Deviation from the first draft:** the plugin id is `pluginId`, not `id: "wordcount"` —
  `id` must be an identifier in QML (`id: "x"` is a syntax error). `Plugin { id: wordcount }`
  also works (the QML id is the fallback plugin id).

  Loaded with `runQml(file, { plugins: ["./plugins/wordcount.qml"] })`, `{ pluginDirs: ["./plugins"] }`
  (every `*.qml` in the dir whose root is `Plugin`; helper types in the same dir are skipped),
  `loadQmlPlugin(engine, path)`, or the CLI's `--plugin` / `--plugins`. QML plugins are loaded
  before the host document is instantiated. The `Plugin` registers itself when it completes and
  unregisters when destroyed (`unregisterPlugin(engine, id)` destroys it). Other `Plugin`
  properties: `description`, read-only `registered`; changing `order` re-sorts live.

  Each `Contribution`'s single child object is a delegate (uninstantiated, like `Component`)
  instantiated per mounted Slot with context properties `{ data, slotData, plugin, slot, context,
  engine }` (`plugin` = the Plugin object, `slot` = the slot name, `context` = the registry context).
  One instance is kept per Slot; when the Slot's data changes the same instance is reused and its
  `data` updates in place (bindings re-evaluate; nothing is recreated). The delegate must be
  visual. `mode: "host"` (default; `"append"` is an accepted alias) — the Slot owns the instance
  and destroys it when it stops showing it; `mode: "managed"` — the plugin owns it and it survives
  deactivation, destroyed when its Slot or the plugin goes away.

  Other children of `Plugin` (`Timer`, `Keymap`, `Shortcut`, ...) are ordinary objects that live
  as long as the plugin; `id`s declared in the plugin file are in scope inside delegates.
- Supporting this needed one engine addition: `engine.registerDocumentType(name, component)` /
  `getDocumentType(name)` — named types backed by a loaded QML document (used for `types`).
- Failures never crash the host: setup/render/dispose errors are isolated by OpenTUI's registry
  and reported via `engine.reportError` (context `plugin "id" (phase, slot "x")`); duplicate ids,
  unreadable/broken plugin files and non-visual delegates are reported the same way. If the root
  declares `signal pluginError(var error)` it also receives `{ pluginId, slot, phase, message, error }`.
