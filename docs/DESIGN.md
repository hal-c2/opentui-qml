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
  destroy(): void
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

Type files: a document whose root is `Item { property int foo }` used as `Foo { foo: 3 }` from
another file: instantiate the `Foo` document's root as the object, then apply the user's
members onto it (user bindings override). Ids inside Foo.qml are private to Foo.qml.

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
methods `start()`, `stop()`, `restart()`. Uses `setInterval`/`setTimeout`; cleared on destroy.

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
export async function runQml(file: string, options?: {
  renderer?: CliRenderer                  // default: createCliRenderer(rendererConfig)
  rendererConfig?: CliRendererConfig
  context?: Record<string, unknown>       // globals visible in QML
  types?: Record<string, QmlTypeFactory>  // extra types
}): Promise<QmlApp>

export interface QmlApp {
  engine: QmlEngine
  root: QmlObject          // the instantiated root object (root.proxy for property access)
  renderer: CliRenderer
  destroy(): void
}

export function createQmlEngine(opts: QmlEngineOptions & { types?: ... }): QmlEngine  // registers builtins + OpenTUI types
export { parseQml } from "./parser"
export { QmlObject, VisualObject, QmlEngine } ...
```

Exiting: `Qt.quit()` or Escape handled by the user's QML → `renderer.destroy()`. Never call
`process.exit()` from the runtime. `runQml` wires `renderer.on("destroy")` to `engine.destroy()`.

## Testing

`bun test`. Parser tests are pure. Runtime tests use hand-built ASTs or `parseQml` + a fake
engine with a non-visual type registry. Component/integration tests use
`createTestRenderer({ width, height })` from `@opentui/core/testing`, mount via `runQml`-style
helper with `renderer` supplied, then `await renderOnce()` and assert on `captureCharFrame()`.
Keyboard interaction via `mockInput.pressKey("ARROW_DOWN")` / `typeText`.

## Non-goals for v1

States/Transitions/Behaviors/animations, anchors beyond `fill`/`centerIn`, `Loader` async, QML
modules with `qmldir`, JS `.import`/`.js` library files (nice-to-have: `import "foo.js" as Foo`),
`ListView` delegates rendering custom items (Select owns rendering), `MouseArea` (mouse handlers are on Item).

## Keymap (`src/components/keymap.ts`)

Goal: keyboard shortcuts are declared in QML (so users can re-bind them) and the host app can
override them from TypeScript. Built on OpenTUI's key helpers from `@opentui/core`
(`parseKeyBinding`-style string → `{ name, ctrl, shift, meta, super }`, `defaultKeyAliases`,
`matchesKeyBinding`, `keyBindingToString`).

Key strings: `"ctrl+s"`, `"shift+tab"`, `"alt+enter"` (alt = meta), `"escape"`/`"esc"`,
`"return"`/`"enter"`, `"space"`, `"up"`, `"pageup"`, `"f5"`, single chars `"q"`, `"?"`.
Case-insensitive modifiers; `"Ctrl+S"` == `"ctrl+s"`. Export `parseKeySequence(str)` and
`keyEventMatches(event, parsed)`.

Types:

```qml
// Qt-compatible: fires when the key is pressed anywhere in the app (context "application")
// or, with context "item", only while the enclosing Item has focus.
Shortcut {
    sequence: "ctrl+s"              // or sequences: ["ctrl+s", "f2"]
    enabled: true
    context: "application"          // "application" | "item"   (default application)
    autoRepeat: true                // ignore "repeat" key events when false
    onActivated: save()
}

// A named action table users can edit. Bindings are a JS object or KeyBinding children.
Keymap {
    id: keys
    bindings: ({ "ctrl+s": "save", "q": "quit", "escape": "quit", "?": "help" })
    KeyBinding { keys: "ctrl+r"; action: "reload"; description: "Reload the file" }
    onActivated: (action, event) => { ... }     // fires for every matched action
    onSave: ...                                 // NOT supported (actions are dynamic) — use onActivated or `handlers`
    handlers: ({ save: () => save(), quit: () => Qt.quit() })   // optional per-action functions
    enabled: true
    priority: 0                                 // higher priority keymaps see the key first
}
```

Semantics: on each `keypress`, active Keymaps/Shortcuts are checked in priority order (then
document order); the first match runs its handler and calls `event.stopPropagation()` +
`preventDefault()` unless the handler sets `event.accepted = false`. `Keymap.bindings` can be
replaced at runtime (`keys.bindings = {...}`) and can be loaded from JSON:
`runQml(file, { keymap: { "ctrl+s": "save" } })` merges into every `Keymap { id: ... }` whose
`name` matches (`Keymap { name: "main" }` ↔ `keymap: { main: {...} }`; unnamed keymap ↔ top-level
object). `Keymap.describe()` returns `[{ keys, action, description }]` for help screens.
Component keybindings: `ListView`/`TabBar`/`TextInput`/`TextArea` expose a `keyBindings`
property passed through to the renderable (`[{ name: "j", action: "move-down" }]`) and a
`keyAliasMap` passthrough.

## Plugins (`src/runtime/plugins.ts`, `src/components/slot.ts`)

OpenTUI ships a slot-based plugin system (`createCoreSlotRegistry`, `registerCorePlugin`,
`SlotRenderable` in `@opentui/core`): a plugin is `{ id, order?, setup?, dispose?, slots: { [name]: (ctx, data) => Renderable } }`
and a `SlotRenderable({ registry, name, data?, mode: "append"|"replace"|"single_winner", fallback? })`
mounts every contribution for `name` at that point in the tree, re-resolving when the registry
changes. We expose exactly this to QML:

- The engine owns one `CoreSlotRegistry` (`engine.slots`), created lazily with the renderer and a
  context `{ engine, root, ...userContext }`.
- **`Slot`** visual type wraps `SlotRenderable`: `Slot { name: "sidebar"; mode: "append"; data: ({...}) }`.
  Children declared inside the `Slot` are its fallback (shown when no plugin contributes).
  `data` is reactive: setting it updates `slotRenderable.data` (which triggers re-render of contributions).
- **TypeScript plugins**: `runQml(file, { plugins: [plugin, ...] })` or `engine.registerPlugin(plugin)`
  where `plugin` is an OpenTUI `CorePlugin`. Slot renderers receive `(ctx, data)` and return a
  Renderable; they may also return a **QmlObject** (we unwrap `.renderable`) or a **QML source string**
  (we instantiate it with the slot `data` as context properties) — helper `engine.createFromSource(src, parent?, ctx?)`.
- **QML plugins**: a `.qml` file whose root is `Plugin`:

  ```qml
  import OpenTUI
  Plugin {
      id: "wordcount"          // plugin id (string property, not a QML id)
      order: 10
      Contribution {
          slot: "statusbar"
          Text { text: "words: " + data.words }      // `data` = the Slot's data; `plugin`, `engine` also in scope
      }
      Contribution { slot: "sidebar"; mode: "managed"; Item { ... } }
      Component.onCompleted: console.log("plugin loaded")   // = setup
      Component.onDestruction: ...                          // = dispose
  }
  ```
  Loaded with `runQml(file, { plugins: ["./plugins/wordcount.qml"] })`, `{ pluginDirs: ["./plugins"] }`
  (every `*.qml` in the dir whose root is `Plugin`), or `engine.loadPlugin(path)`. Each
  `Contribution`'s single child object is a delegate (uninstantiated `Component`) instantiated per
  slot mount with context `{ data, plugin, slot }`; the instance is destroyed when the slot unmounts.
  Plugins can also contribute **keymaps** (`Keymap {}` / `Shortcut {}` children of `Plugin` are
  global) and **types** (`Plugin { types: ["./Widget.qml"] }` registers extra QML types).
- `engine.unregisterPlugin(id)`, `engine.plugins` (list), `pluginError` signal on the root for
  failures (also logged). Plugin failures never crash the host: `SlotRegistry` already isolates them.
