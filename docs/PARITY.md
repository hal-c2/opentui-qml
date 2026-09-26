# Parity with the OpenTUI React and Solid bindings

The target is the OpenTUI functionality that `@opentui/react` and `@opentui/solid` expose
(https://opentui.com/docs/bindings/react/, https://opentui.com/docs/bindings/solid/), not the
frameworks themselves. Each row names the binding feature, the QML equivalent, and the status.
Verified against `@opentui/core` 0.5.12 and `@opentui/keymap` 0.5.12.

Status: **done** works and is tested; **partial** works with the noted limits; **n/a** does not
apply to QML; **missing** not implemented.

## Entry points

| Binding | QML runtime | Status |
|---|---|---|
| `createRoot(renderer).render(<App/>)` / `render(() => <App/>, renderer)` | `runQml(file, { renderer })`, `runQmlSource` | done |
| `createRoot` options (`rendererConfig`) | `runQml(file, { rendererConfig })` | done |
| `extend({ name: RenderableClass })` / `@opentui/solid/components` catalogue | `runQml(file, { types })`, `engine.registerType`, `.qml` files as types | done |
| `getComponentCatalogue()` (Solid) | `engine.hasType(name)`; the list is `registerOpenTuiTypes` | partial (no list API) |
| `testRender()` from `@opentui/react/test-utils` / `@opentui/solid` | `testQml()` from `opentui-qml/testing` | done |
| `flushSync` (React) | not needed: bindings update synchronously inside `batch` | n/a |
| Runtime plugin support entrypoints (`runtime-plugin-support`) | not needed: QML files are loaded by the engine, TS plugins by `import()` | n/a |

## Components

| Binding element | QML type | Status |
|---|---|---|
| `<box>` | `Item`, `Rectangle`, `Column`, `Row`, `Grid` (+ `*Layout` aliases) | done |
| `<text>` with `<span> <b> <strong> <i> <em> <u> <br> <a href>` | `Text` with `Span Bold Strong Italic Em Underline Strikethrough Dim Link Br` | done |
| `<input>` | `TextInput` / `TextField` | done |
| `<textarea>` | `TextArea` | done |
| `<select>` | `ListView` | done |
| `<tab-select>` | `TabBar` | done |
| `<slider>` | `Slider` | done |
| `<scrollbox>` | `ScrollView` / `Flickable` | done |
| `<scrollbar>` | `ScrollBar` | done |
| `<code>` | `Code` | done |
| `<markdown>` | `Markdown` | done |
| `<line-number>` | `LineNumbers` / `LineNumber` | done |
| `<diff>` | `Diff` | done |
| `<text-table>` | `TextTable` | partial: constructor-only options (`selectionBg`, `borderBackgroundColor`) are fixed |
| `<ascii-font>` | `AsciiText` / `BigText` | done |
| `<framebuffer>` | `FrameBuffer` / `Canvas` with `paint(painter)` | done |
| `<image>` | `Image` | done |
| `<embedded-terminal>` | `EmbeddedTerminal` / `Terminal` | done (tests do not spawn) |
| `<qr-code>` (`@opentui/qrcode`) | `QRCode` (`text`, `errorCorrection`, `color`, `quietZone`, `scale`, `fit`), registered only when the optional package is installed | done |
| Slot components (`<slot>` via core slot registry) | `Slot`, `Plugin`, `Contribution` | done |
| `<Portal>` (Solid) | `Portal { target }` | done |
| `<Dynamic component>` (Solid) | `Loader { sourceComponent }` | done |
| `style={{...}}` prop | QML property groups (`border.width`, `font.bold`) and all layout props on every visual | done |
| Layout props (`position`, `display`, `overflow`, min/max, `paddingX/Y`, `zIndex`) | same names on every visual, plus `anchors.fill` / `anchors.centerIn` shorthands | done |
| Mouse events (`onMouseDown/Up/Move/Drag/DragEnd/Drop/Over/Out/Scroll`) | same-named signals on every visual | done |
| `onSizeChange` | `sizeChanged(width, height)` | done |
| `focused` / `onFocus` / `onBlur` per renderable | `focus`, read-only `focused` / `activeFocus`, `forceActiveFocus()` | done |

## Hooks and services

| Binding hook | QML runtime | Status |
|---|---|---|
| `useRenderer()` | `Screen` singleton; `app.renderer` from TypeScript | done |
| `useKeyboard(handler, { release })` / `onKeyDown` | `Keys.onPressed`, `Keys.onReleased` on any item | done |
| `usePaste` | `Keys.onPaste`, `Window.onPaste` | done |
| `useOnResize` / `onResize` | `Screen.onResized`, `Connections { target: Screen }` | done |
| `useTerminalDimensions()` | `Screen.width`, `Screen.height` (reactive) | done |
| `useFocus` / `useBlur` / `onFocus` / `onBlur` (terminal focus) | `Screen.focused` (reactive) | done |
| `useSelectionHandler` | `Screen.selectionChanged(text)`, `Screen.selectedText`, `Text.selectable` | done |
| `useTimeline` / `createTimeline` | `NumberAnimation`, `PauseAnimation`, `SequentialAnimation`, `ParallelAnimation` | partial: no `X on prop` syntax, no `Behavior`, no `ColorAnimation` |
| `renderer.console` | `Screen.showConsole/hideConsole/toggleConsole/clearConsole/focusConsole/setConsoleDebug`, `consoleMode` | done |
| `renderer.triggerNotification` | `Screen.notify(message, title)` | done |
| Clipboard (`createClipboard`, OSC 52) | `Screen.copyToClipboard(text)` | done |
| `writeSolidToScrollback` / `createScrollbackWriter` | `Screen.writeToScrollback(text)` | partial: needs `screenMode: "split-footer"` as in core |
| `renderer.setTerminalTitle` | `Window.title`, `Screen.title` | done |
| `renderer.themeMode` / `theme_mode` event | `Screen.themeMode` (reactive) | done |
| `renderer.capabilities` | `Screen.capabilities` | done |
| `renderer.toggleDebugOverlay` | `Screen.toggleDebugOverlay()` | done |

## Keymap (`@opentui/keymap`)

| Binding | QML runtime | Status |
|---|---|---|
| `createDefaultOpenTuiKeymap(renderer)` | one keymap per engine, created lazily | done |
| `registerLayer({ bindings, commands, priority, target })` | `Keymap`, `Shortcut`, `Action`, `KeyBinding` | done |
| Sequences, chords, `mod+`, `<leader>`, comma alternatives | key strings `"gg"`, `"ctrl+x ctrl+s"`, `"mod+s"`, `"<leader>q"`, `"a, b"` | done |
| `targetMode: "focus-within"` | `context: "item"` / `target` | done |
| `getActiveKeys`, `getCommands`, `dispatchCommand`, `setData`, pending sequence | `Keyboard` singleton and `Keymap.describe()/activeKeys()/dispatch()` | done |
| `registerEditBufferCommands` / textarea layers | not exposed; inputs keep their own editing keys | missing |
| Ex commands (`:w`) | not exposed | missing |
| `useKeymap` / `KeymapProvider` (React, Solid) | `Keyboard` singleton is global to the engine | n/a |

## Beyond the bindings

These exist for the shell-override use case and have no binding equivalent:

- `runShell`: user `shell.qml` replaces the root, fallback to the default shell with an error
  overlay, hot reload, `Runtime` singleton (`docs/SHELL.md`).
- qmldir modules, `pragma Singleton`, TypeScript singletons, `createStore` /
  `createPropertyMap` reactive app state.
- QML plugins (`Plugin` / `Contribution`) loaded from files or directories.

## Known gaps

- `QRCode` depends on the optional `@opentui/qrcode` package; without it the type reports a clear install message.
- Animations: no `NumberAnimation on x` syntax, `Behavior`, `ColorAnimation`, `ScriptAction`.
- Edit-buffer keymap addons and ex commands are not surfaced.
- Two live engines animating at once share OpenTUI's single global timeline engine.
- A user shell that loads but throws inside a binding does not fall back to the default shell.
