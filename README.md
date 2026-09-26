# opentui-qml

A [QML](https://doc.qt.io/qt-6/qmlreference.html) runtime for [OpenTUI](https://opentui.com).
Write your terminal UI in `.qml` files with reactive property bindings and JavaScript handlers,
and render it with OpenTUI's native core. No React or Solid, no JSX, no build step.

The point: QML is small, declarative and easy to read, so an app can ship its frontend as
`.qml` files that end users restyle or rearrange without touching TypeScript.

```qml
import OpenTUI

Window {
    id: root
    property int count: 0

    Keys.onPressed: (event) => {
        if (event.key === "up") count++
        if (event.key === "q") Qt.quit()
    }

    Rectangle {
        anchors.centerIn: parent
        border.width: 1
        border.color: count % 2 === 0 ? "#9ece6a" : "#f7768e"
        padding: 1

        Text { text: "Count: " + root.count; font.bold: true }
    }
}
```

```sh
bun run src/cli.ts examples/counter.qml
```

## Install

```sh
bun add opentui-qml @opentui/core
```

Runs on Bun 1.3+ and on Node 26.4+ (`node --experimental-ffi`, ESM only), the same as OpenTUI.

## Usage

### CLI

```sh
opentui-qml path/to/app.qml
opentui-qml app.qml --plugins ./plugins --context user=ada --keymap keys.json
```

| Option | Meaning |
|---|---|
| `--plugins <dir>` | load every QML plugin (root type `Plugin`) in the directory, repeatable |
| `--plugin <file.qml>` | load one QML plugin file, repeatable |
| `--context key=value` | expose `key` to QML (value parsed as JSON when possible), repeatable |
| `--keymap <file.json>` | merge key bindings into the app's `Keymap`s |
| `-I <dir>` / `--import-path <dir>` | add a directory to search for `import X.Y` modules, repeatable |
| `--shell <file.qml>` | run the file as the default shell of a [shell host](#shells-let-users-replace-the-root) |
| `--app-id <id>` / `--config-dir <dir>` | with `--shell`: where the user's `shell.qml` lives (default `~/.config/<id>/shell`) |
| `--module Uri=dir` | with `--shell`: register a bricks module directory, repeatable |
| `--no-watch` | with `--shell`: no hot reload |

### Library

```ts
import { runQml, createStore } from "opentui-qml"

const app = await runQml("./ui/main.qml", {
  context: { api: myBackend },          // extra globals visible in QML
  plugins: [myPlugin, "./plugins/clock.qml"],
  pluginDirs: ["./plugins"],
  keymap: { "ctrl+s": "save" },         // user overrides merged into Keymap { ... }
  importPaths: ["./qml"],               // roots for `import X.Y` modules
  singletons: { Theme: createStore({ accent: "#7aa2f7" }) }, // reactive TS objects as QML singletons
})

app.root.proxy.count = 5                 // read / write QML properties from TypeScript
app.root.connect("saved", (data) => {})  // listen to QML signals
```

`runQml` creates an OpenTUI renderer for you; pass `renderer` to reuse an existing one
(including the test renderer from `@opentui/core/testing`). `runQmlSource(text, options)` does
the same for inline QML, and `createQmlEngine(options)` gives you a bare engine with all types
registered. Destroying the renderer destroys the engine; `app.destroy()` does both.

## What's supported

**Language**: object trees, `id`s, property bindings (reactive, re-evaluated on dependency
change), `property`/`readonly property`/`required property`/`property alias`, `signal`
declarations, `function` members, `onXxx` and `onXxxChanged` handlers, grouped and dotted
bindings (`border.width`, `anchors.fill`, `Layout.fillWidth`), `Component.onCompleted`,
`Keys.onPressed`, `default property alias content: inner.data`, `data`/`children` lists,
custom components from sibling `.qml` files, `import "dir"`, modules with a `qmldir`
(`import My.Bricks 1.0 as B`, `singleton` and `internal` entries, `.js` resources),
`pragma Singleton`, `import "lib.js" as Lib`, JS expressions with full access to `Math`,
`Date`, `JSON`, `console`, etc.

**Non-visual types**: `QtObject`, `Timer`, `Repeater`, `Instantiator`, `Connections`,
`Component`, `Loader`, `ListModel` / `ListElement`, `Shortcut`, `Keymap`, `KeyBinding`,
`Action`, `Plugin`, `Contribution`.

**Visual types** (backed by OpenTUI renderables):

| QML | OpenTUI | Notes |
|---|---|---|
| `Window` / `ApplicationWindow` | full-screen box | root element |
| `Item` | `BoxRenderable` | plain flex container; all OpenTUI layout props (`flexDirection`, `gap`, `padding`, `alignItems`, ...) |
| `Rectangle` | `BoxRenderable` | `color`, `border.width`, `border.color`, `border.style`, `radius`, `title` |
| `Column`, `Row`, `ColumnLayout`, `RowLayout`, `Grid` | `BoxRenderable` | `spacing`; `Grid` is a wrapping row |
| `Text` / `Label` | `TextRenderable` | `text`, `color`, `font.bold/italic/underline/strikeout/dim`, `wrapMode`, `horizontalAlignment` |
| `TextInput` / `TextField` | `InputRenderable` | two-way `text`, `placeholderText`, `accepted()`, `textEdited()` |
| `TextArea` | `TextareaRenderable` | multi-line `text`, `wrapMode` |
| `ListView` | `SelectRenderable` | `model` (array or `ListModel`), `currentIndex`, `activated(index, item)`; needs a height |
| `TabBar` | `TabSelectRenderable` | `model`, `currentIndex`, `tabWidth` |
| `ScrollView` / `Flickable` | `ScrollBoxRenderable` | `contentY`, `scrollTo()`, `scrollToBottom()` |
| `AsciiText` / `BigText` | `ASCIIFontRenderable` | `text`, `font` |
| `Markdown`, `Code` | `MarkdownRenderable`, `CodeRenderable` | `text`, `language` |
| `Slot` | `SlotRenderable` | plugin mount point, see below |
| `Span`, `Bold`/`Strong`, `Italic`/`Em`, `Underline`, `Strikethrough`, `Dim`, `Link`, `Br` | `StyledText` chunks | children of `Text`: nested, reactive rich text (`text`, `color`, `backgroundColor`, style flags, `href`) |
| `Diff` | `DiffRenderable` | `diff` (unified diff text), `view: "unified"/"split"`, `filetype`, `showLineNumbers`, diff colours, `highlightLines()` |
| `LineNumbers` / `LineNumber` | `LineNumberRenderable` | gutter around a `Code`/`TextArea` child; `lineNumberOffset`, `setLineSign()`, `setLineColor()` |
| `TextTable` | `TextTableRenderable` | `rows`, `model` + `columns`, or `content`; `headers`, borders, cell padding, `selectedText()` |
| `Slider` | `SliderRenderable` | `orientation`, two-way `value`, `from`/`to`, `viewPortSize`, `moved(value)` |
| `ScrollBar` | `ScrollBarRenderable` | `orientation`, two-way `position`, `scrollSize`, `viewportSize`, `scrolled(position)`, `scrollBy()` |
| `FrameBuffer` / `Canvas` | `FrameBufferRenderable` | `paint(painter)` signal, `draw(fn)`; `drawText`, `setCell`, `fillRect`, `drawBox` |
| `Image` | `ImageRenderable` | `source` (path/URL/bytes), `fit`, `protocol`, `status`, `loaded()`, `error(message)` |
| `EmbeddedTerminal` / `Terminal` | `EmbeddedTerminalRenderable` | `command`/`args`/`cwd`/`env` run in a PTY, `exited(code)`, `write()`, `send()`, `screenText()` |
| `Portal` | (re-parenting) | its children are drawn inside `target` (default: the whole screen) |
| `NumberAnimation` / `PropertyAnimation`, `PauseAnimation`, `SequentialAnimation`, `ParallelAnimation` | `Timeline` | `target`/`property`, `from`/`to`, `duration`, `easing.type: Easing.*`, `loops`, `running`, `started()`/`finished()` |
| `Screen` (global) | `CliRenderer` | `width`, `height`, `themeMode`, `focused`, `selectedText`, `resized()`, `notify()`, `copyToClipboard()`, console, `writeToScrollback()` |

Layout is OpenTUI's Yoga flexbox, not Qt's anchors. `anchors.fill: parent` and
`anchors.centerIn: parent` are translated; everything else uses flex properties.

See [`docs/DESIGN.md`](docs/DESIGN.md) for the full mapping and semantics, and
[`examples/`](examples/) for runnable apps.

## Keyboard

`Keys.onPressed` on the root sees every key; on any other item it fires while that item has or
contains focus. Set `event.accepted = true` to stop the key from reaching the focused widget.
`focus: true` and `forceActiveFocus()` move focus.

For shortcuts that end users can rebind, use `Shortcut`, `Action`, `KeyBinding` and `Keymap`. They
run on [`@opentui/keymap`](https://www.npmjs.com/package/@opentui/keymap) (one keymap per engine),
so multi-key sequences, a leader key, `mod` and emacs-style chords work out of the box:

```qml
Shortcut { sequence: "ctrl+s"; onActivated: save() }
Shortcut { sequences: ["q", "escape"]; context: "application"; onActivated: Qt.quit() }

Keymap {
    name: "main"
    leader: "ctrl+a"
    bindings: ({
        "j": "next", "k": "previous",
        "gg": "top", "G": "bottom",                       // sequences
        "ctrl+x ctrl+s": "save",                          // emacs-style chord
        "<leader>q": { action: "quit", description: "Quit" },
    })
    handlers: ({ top: () => list.currentIndex = 0, quit: () => Qt.quit() })
    onActivated: (action, event) => { if (action === "next") list.incrementCurrentIndex() }
    KeyBinding { keys: "ctrl+r"; action: "reload"; description: "Reload the file" }
    Action { name: "save"; shortcut: "mod+s"; text: "Save"; onTriggered: save() }
}

Text { text: Keyboard.activeKeys().map(k => k.key + " " + k.description).join("  ") }
```

- **Key strings**: `"ctrl+shift+s"`, `"alt+x"` (alt = meta = option), `"mod+s"` (ctrl, or cmd on
  macOS), `"escape"`, `"return"`/`"enter"`, `"f5"`, `"up"`, `"?"`. Strokes separated by spaces are
  a sequence (`"ctrl+x ctrl+s"`), and runs of plain characters are too (`"gg"`). `"<leader>s"`
  uses the enclosing `Keymap`'s `leader`. Commas separate alternatives (`"ctrl+s, f2"`). A lone
  capital letter means shift (`"G"` is `"shift+g"`).
- **Precedence**: every `Shortcut`, `Keymap` and standalone `Action` is one layer. Higher
  `priority` wins, then document order. All layers run before the focused widget and before
  `Keys.onPressed`. A binding that fires consumes the key.
- **Fall-through**: set `event.accepted = false` in a handler to reject the key. It then goes to the
  next matching binding, then the focused widget, then `Keys.*`.
- **Context**: `"window"` (default) and `"item"` layers yield plain printable and editing keys to a
  focused `TextInput`/`TextArea`, so a `"q"` shortcut doesn't eat typing. Chords such as `ctrl+s`
  still fire. `"item"` layers are active only while focus is inside the enclosing item, or inside
  `Keymap.target`. `"application"` layers always win.
- **Actions**: `Action.trigger(payload)`, `Keymap.dispatch(action, payload)` and
  `Keyboard.dispatch(name, payload)` run a command without a key. Their `event.payload` is the
  payload.
- **`Keyboard` singleton**: `pendingSequence` (reactive, e.g. `"g"` after the first `g` of `gg`),
  `activeKeys()` → `[{ key, command, description }]` for what can be pressed now (continuations
  while a sequence is pending; keys a focused text input would take as typing are left out), `commands()`, `dispatch(name, payload?)`, `setData(key, value)`,
  `formatKey("mod+s")` and `clearPendingSequence()`. `Keymap` also has `describe()`, `keysFor(action)`,
  `activeKeys()` and `pendingSequence`, all scoped to that keymap.
- **Overrides**: `runQml(file, { keymap })` and the CLI's `--keymap file.json` merge
  `{ "ctrl+s": "save" }` into the unnamed keymap, or `{ main: { ... } }` into `Keymap { name: "main" }`.
  Map a key to `null` to unbind it.

See [`examples/keymap.qml`](examples/keymap.qml).

## Plugins

Apps expose mount points with `Slot`; plugins fill them. The children of a `Slot` are shown
when nothing contributes to it.

```qml
Slot {
    name: "statusbar"
    flexDirection: "row"
    data: ({ user: root.user })
    Text { text: "ready" }
}
```

A plugin is a QML file whose root is `Plugin`. Each `Contribution` holds one delegate that is
instantiated inside a matching `Slot` with the slot's `data` in scope:

```qml
import OpenTUI

Plugin {
    pluginId: "clock"
    order: 100
    Contribution { slot: "statusbar"; Text { text: "Hello, " + data.user } }
    Component.onCompleted: console.log("loaded")
}
```

Load plugins with `runQml(file, { plugins: ["./plugins/clock.qml"] })`, `pluginDirs`, or the
CLI's `--plugins`. TypeScript plugins use OpenTUI's own `CorePlugin` shape and may return a
renderable, a QML object, or a QML source string from a slot renderer. Plugin errors are
reported through the engine and never take the host down. See
[`examples/plugin-host.qml`](examples/plugin-host.qml) and [`examples/plugins/`](examples/plugins/).

## Shells: let users replace the root

An app can ship its UI as a module of QML **bricks** plus a **default shell** that arranges
them, and let users drop a `shell.qml` into a config directory that replaces the root: same
bricks, their own layout and colours. The app keeps the behaviour and the data (TS singletons);
the user owns the arrangement.

```ts
import { runShell, createStore, createPropertyMap } from "opentui-qml"

const state = createPropertyMap({ page: "inbox" })   // read as Shell.state.page
const shell = await runShell({
  appId: "myapp",                                    // user shell: ~/.config/myapp/shell/shell.qml
  defaultShell: "./qml/DefaultShell.qml",
  modules: { "MyApp.Bricks": "./qml/MyApp/Bricks" }, // `import MyApp.Bricks`
  singletons: { Shell: { state, dispatch: (action, payload) => {} }, Theme: createStore({}) },
})
shell.on("generation", (n) => {})                    // hot reload swapped the root
```

A user shell that fails to parse or load falls back to the default shell with an error overlay
(Esc dismisses it); files under the config directory, the default shell's directory and the
modules are watched and hot-reloaded without losing app state. QML sees a `Runtime` singleton
(`usingUserShell`, `generation`, `lastError`, `reload()`). The contract is in
[`docs/SHELL.md`](docs/SHELL.md); [`examples/shell/`](examples/shell/) is a complete app:

```sh
bun examples/shell/app.ts --config-dir examples/shell/rices/minimal
bun examples/shell/app.ts --config-dir examples/shell/rices/broken   # fallback + overlay
```

## Examples

```sh
bun run src/cli.ts examples/hello.qml
bun run src/cli.ts examples/counter.qml
bun run src/cli.ts examples/todo.qml
bun run src/cli.ts examples/dashboard.qml
bun run src/cli.ts examples/components.qml
bun run src/cli.ts examples/richtext.qml     # Text spans: Bold, Italic, Link, ...
bun run src/cli.ts examples/table.qml        # TextTable from a model + Slider
bun run src/cli.ts examples/animation.qml    # Sequential/Parallel NumberAnimations
bun run src/cli.ts examples/responsive.qml   # layout driven by Screen.width
bun run src/cli.ts examples/keymap.qml       # sequences, leader, Actions, Keyboard help footer
bun run src/cli.ts examples/plugin-host.qml --plugins examples/plugins
bun examples/shell/app.ts --config-dir examples/shell/rices/minimal   # shell host, see above
```

Apps can be tested headlessly with `opentui-qml/testing`:

```ts
import { testQml } from "opentui-qml/testing"

const t = await testQml({ file: "examples/counter.qml" }, { width: 80, height: 24 })
await t.pressKey("k")
expect(await t.snapshot()).toContain("Count: 1")
await t.advance(250) // animations advance only through advance(ms)
t.destroy()
```

## Development

```sh
bun install
bun test
bun run typecheck
```

## License

MIT
