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

### Library

```ts
import { runQml } from "opentui-qml"

const app = await runQml("./ui/main.qml", {
  context: { api: myBackend },          // extra globals visible in QML
  plugins: [myPlugin, "./plugins/clock.qml"],
  pluginDirs: ["./plugins"],
  keymap: { "ctrl+s": "save" },         // user overrides merged into Keymap { ... }
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
`Keys.onPressed`, custom components from sibling `.qml` files and `import "dir"`, JS
expressions with full access to `Math`, `Date`, `JSON`, `console`, etc.

**Non-visual types**: `QtObject`, `Timer`, `Repeater`, `Connections`, `Component`, `Loader`,
`ListModel` / `ListElement`, `Shortcut`, `Keymap`, `KeyBinding`, `Action`, `Plugin`, `Contribution`.

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

Layout is OpenTUI's Yoga flexbox, not Qt's anchors. `anchors.fill: parent` and
`anchors.centerIn: parent` are translated; everything else uses flex properties.

See [`docs/DESIGN.md`](docs/DESIGN.md) for the full mapping and semantics, and
[`examples/`](examples/) for runnable apps.

## Keyboard

`Keys.onPressed` on the root sees every key; on any other item it fires while that item has or
contains focus. Set `event.accepted = true` to stop the key from reaching the focused widget.
`focus: true` and `forceActiveFocus()` move focus.

For shortcuts that end users can rebind, use `Shortcut` and `Keymap`:

```qml
Shortcut { sequence: "ctrl+s"; onActivated: save() }
Shortcut { sequences: ["q", "escape"]; onActivated: Qt.quit() }

Keymap {
    name: "main"
    bindings: ({ "j": "next", "k": "previous", "ctrl+s": "save" })
    onActivated: (action, event) => { if (action === "next") list.incrementCurrentIndex() }
    Action { name: "save"; shortcut: "ctrl+s"; text: "Save"; onTriggered: save() }
}
```

Key strings are `"ctrl+shift+s"`, `"escape"`, `"f5"`, `"up"`, and so on. Higher `priority`
wins; setting `event.accepted = false` in a handler lets the key fall through. `describe()`
lists the bindings for a help screen. `runQml(file, { keymap })` and the CLI's `--keymap`
merge `{ "ctrl+s": "save" }` into the unnamed keymap or `{ main: { ... } }` into a named one.
Plain printable keys are not intercepted while a text input has focus.

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

## Examples

```sh
bun run src/cli.ts examples/hello.qml
bun run src/cli.ts examples/counter.qml
bun run src/cli.ts examples/todo.qml
bun run src/cli.ts examples/dashboard.qml
bun run src/cli.ts examples/components.qml
bun run src/cli.ts examples/plugin-host.qml --plugins examples/plugins
```

## Development

```sh
bun install
bun test
bun run typecheck
```

## License

MIT
