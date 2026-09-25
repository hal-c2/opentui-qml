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
```

### Library

```ts
import { runQml } from "opentui-qml"

const app = await runQml("./ui/main.qml", {
  context: { api: myBackend },          // extra globals visible in QML
})

app.root.proxy.count = 5                 // read / write QML properties from TypeScript
app.root.connect("saved", (data) => {})  // listen to QML signals
```

`runQml` creates an OpenTUI renderer for you; pass `renderer` to reuse an existing one
(including the test renderer from `@opentui/core/testing`).

## What's supported

**Language**: object trees, `id`s, property bindings (reactive, re-evaluated on dependency
change), `property`/`readonly property`/`required property`/`property alias`, `signal`
declarations, `function` members, `onXxx` and `onXxxChanged` handlers, grouped and dotted
bindings (`border.width`, `anchors.fill`, `Layout.fillWidth`), `Component.onCompleted`,
`Keys.onPressed`, custom components from sibling `.qml` files and `import "dir"`, JS
expressions with full access to `Math`, `Date`, `JSON`, `console`, etc.

**Non-visual types**: `QtObject`, `Timer`, `Repeater`, `Connections`, `Component`, `Loader`,
`ListModel` / `ListElement`.

**Visual types** (backed by OpenTUI renderables):

| QML | OpenTUI | Notes |
|---|---|---|
| `Window` / `ApplicationWindow` | full-screen box | root element |
| `Item` | `BoxRenderable` | plain flex container; all OpenTUI layout props (`flexDirection`, `gap`, `padding`, `alignItems`, ...) |
| `Rectangle` | `BoxRenderable` | `color`, `border.width`, `border.color`, `border.style`, `radius`, `title` |
| `Column`, `Row`, `ColumnLayout`, `RowLayout` | `BoxRenderable` | `spacing` |
| `Text` / `Label` | `TextRenderable` | `text`, `color`, `font.bold/italic/underline`, `wrapMode`, `horizontalAlignment` |
| `TextInput` / `TextField` | `InputRenderable` | `text`, `placeholderText`, `accepted()`, `textEdited()` |
| `TextArea` | `TextareaRenderable` | multi-line |
| `ListView` | `SelectRenderable` | `model`, `currentIndex`, `activated()` |
| `TabBar` | `TabSelectRenderable` | `model`, `currentIndex` |
| `ScrollView` / `Flickable` | `ScrollBoxRenderable` | scrollable container |
| `AsciiText` / `BigText` | `ASCIIFontRenderable` | `text`, `font` |
| `Markdown`, `Code` | `MarkdownRenderable`, `CodeRenderable` | `text`, `language` |

Layout is OpenTUI's Yoga flexbox, not Qt's anchors. `anchors.fill: parent` and
`anchors.centerIn: parent` are translated; everything else uses flex properties.

See [`docs/DESIGN.md`](docs/DESIGN.md) for the full mapping and semantics, and
[`examples/`](examples/) for runnable apps.

## Examples

```sh
bun run src/cli.ts examples/hello.qml
bun run src/cli.ts examples/counter.qml
bun run src/cli.ts examples/todo.qml
bun run src/cli.ts examples/dashboard.qml
bun run src/cli.ts examples/components.qml
```

## Development

```sh
bun install
bun test
bun run typecheck
```

## License

MIT
