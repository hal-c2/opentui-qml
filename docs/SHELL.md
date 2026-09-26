# Shell host: a replaceable root

**Status:** implemented in `src/shell.ts` (`runShell`), with the overlay in
`src/shell/error-overlay.ts`; tests in `test/shell.test.ts`, example in `examples/shell/`.

The reason this runtime exists: an application ships its UI as a set of QML **bricks** (a
module of components) plus a **default shell** that composes them. A user can drop a
`shell.qml` into a config directory and it replaces the root wholesale, composing the same
bricks in a different arrangement, with different colours, or with extra pieces. The app keeps
control of behaviour and data; the user controls layout and look.

This document is the contract for `runShell` in `src/shell.ts`. The reference for the pattern
is a Qt desktop app whose `DefaultShell.qml`, `T3.Bricks` module and `~/.t3/shell/shell.qml`
work exactly this way; we reproduce the shape, not the code.

## What the app provides

```ts
import { runShell, createStore, createPropertyMap } from "opentui-qml"

const state = createPropertyMap()          // Shell.state.<key>, per-key reactive
const theme = createStore({ radius: 1, colors: { chrome: "#16161e", text: "#c0caf5" } })

const shell = await runShell({
  appId: "myapp",                          // → default configDir ~/.config/myapp/shell
  defaultShell: "./qml/DefaultShell.qml",  // the built-in root
  modules: { "MyApp.Bricks": "./qml/MyApp/Bricks" },   // module uri → dir (has a qmldir)
  importPaths: ["./qml"],                  // extra roots for `import X.Y`
  configDir?: string,                      // overrides the appId default
  userShell?: string,                      // overrides `${configDir}/shell.qml`
  singletons: {                            // TS objects visible as QML singletons
    Shell: { state, dispatch: (action, payload) => {...}, pageTitle: "..." },
    Theme: theme,
  },
  context?: {},                            // plain engine globals (as runQml)
  plugins?, pluginDirs?, keymap?, types?,  // as runQml
  watch?: boolean,                         // default true: hot reload on change
  errorOverlay?: boolean,                  // default true: ShellErrorOverlay on fallback
  basePath?: string,                       // default: the defaultShell's directory
  renderer?, rendererConfig?,
  onError?, onWarning?,
})
```

`shell` is a `QmlApp` plus:

- `shell.reload()` – re-resolve and re-instantiate the root (same engine, same renderer). A
  reload requested while one runs is queued (several requests coalesce into one); the promise
  never rejects: failures land in `lastError` and the `"error"` event.
- `shell.usingUserShell`, `shell.userShellPath`, `shell.configDir`, `shell.lastError` (`Error | null`),
  `shell.generation` (1 for the first root, +1 for every reload that swapped the root).
- `shell.on("generation", (n) => ...)` / `shell.on("error", (err) => ...)`, each returning a disposer.
- `shell.root` is the live root (it changes on reload); `shell.destroy()` stops the watchers
  and destroys the tree, plugins and engine (and the renderer if `runShell` created it).
  Destroying the renderer (`Qt.quit()`) does the same.

Shell load errors are passed to `onError(error, "shell")` when given, and always stored in
`lastError` and emitted as `"error"`; the host never writes to the console. (Binding and handler
errors inside QML still go through the engine's `onError` / `console.error`, as with `runQml`.)

## Resolution and fallback

1. If `userShell` (default `${configDir}/shell.qml`) exists, load it as the root.
2. If it fails to parse, load, or instantiate (a thrown error: syntax error, unknown type or
   module, missing file, or a root that is not visual), load `defaultShell` instead and show the
   **error overlay** (a built-in `ShellErrorOverlay` visual: a bordered box at the top of the
   window with the file, line:column and message and the hint "Esc to dismiss ·
   Runtime.reload() to retry", dismissable with Esc, re-shown on the next failed reload).
   A broken user shell never locks the app. Binding errors are not load failures.
3. If both fail, keep the previous generation alive and report the error ("both shells failed
   to load: ..."); on first start with both broken, throw (a broken default shell with no user
   shell throws its own error).

`lastError` is cleared by a reload that loads the preferred shell (the user shell if present,
else the default shell).

`ShellErrorOverlay` is a small QML document registered as a document type on the engine (so a
user shell can use it too). On fallback it is instantiated as the first child of the default
shell's root with `position: "absolute"`, `z: 10000`, `width: "100%"`, so it does not depend
on the shell's layout; Esc is an `escape` `Shortcut` with a very high priority, enabled only
while the overlay is visible. `errorOverlay: false` turns it off.

`${configDir}/qml` is added to the import paths (after the app's `importPaths`, before the
default shell's directory), so a user can ship their own bricks and `import My.Extras` from
their shell. It is always listed; a missing directory is skipped at resolve time, and the
module cache is cleared on each reload, so creating it later works.

`modules` entries are registered with `engine.registerModuleDirectory(uri, dir)`: an explicit
uri → directory map consulted before the import paths (the directory need not end in `A/B`).

## Hot reload

With `watch: true`, the host watches `configDir` recursively, the `defaultShell` file's
directory and every module directory in `modules` (debounced, 100 ms). On a change to any
`.qml`, `.js` or `qmldir`:

1. clear the engine's document and module caches (`engine.invalidate()`: every cached
   document, qmldir, module resolution and JS namespace);
2. instantiate the new root **before** destroying the old one (never an empty frame);
3. swap them in `renderer.root`, call `setPluginRoot(engine, newRoot)` and re-apply the
   `keymap` overrides, destroy the old tree, bump `generation`, emit `"generation"`;
4. singletons and `context` objects are reused: they are app state, not QML objects, so a
   reload keeps the app where it was. Plugins are re-resolved against the new root.
   QML `pragma Singleton` documents from modules (e.g. a `Palette.qml`) are *re-created*
   from the new files; the old instances are destroyed after the swap.

The debounce is 100 ms after the last change. If the user shell file lives outside
`configDir`, its directory is watched too (not recursively). Directories are (re)checked on
every reload, so a `configDir` created after start is picked up after the next reload.
`Runtime.reload()` / `shell.reload()` work with `watch: false`.

## The `Runtime` singleton (QML side)

Registered automatically as `Runtime`:

| Member | Meaning |
|---|---|
| `configDir`, `userShellPath` | resolved paths (all members are read-only properties) |
| `usingUserShell` (bool) | which root is live |
| `lastError` (string or "") | last load error, cleared on a successful reload |
| `generation` (int) | increments per reload |
| `reload()` | force a reload |
| `openConfigDir()` | no-op placeholder for now (returns `false`) |

`Runtime` is a `QtObject`, so bindings such as `Text { text: "gen " + Runtime.generation }`
update after a reload. An app singleton named `Runtime` overrides it.

`Screen` (terminal size and theme mode) comes from the component layer; `Shell`, `Theme` and
friends are whatever the app passed as `singletons`.

## Conventions for bricks

- Bricks live in a module directory with a `qmldir`; the user imports the module by name.
- A brick that wraps content declares `default property alias content: inner.data`.
- Bricks that expose sub-parts declare `property alias sidebar: sidebarView` so an extension
  can tweak one piece without copying the layout.
- Extension points are `Loader { sourceComponent: ... }` slots exposed as
  `property alias toolbar: toolbarLoader.sourceComponent`, or `Slot { name }` when third
  parties should be able to contribute without editing the shell.
- Behaviour lives in the app: bricks call `Shell.dispatch("action", payload)` and read
  `Shell.state.<key>`; they never own domain state.

## Example

`examples/shell/` is a small app that follows the pattern:

```
examples/shell/
  app.ts                       runShell(...) with Shell/Theme singletons, a ticking store
  qml/Demo/Bricks/qmldir       module Demo.Bricks
  qml/Demo/Bricks/*.qml        ShellWindow, Sidebar, StatusBar, Card, Composer, Palette (singleton)
  qml/DefaultShell.qml         the built-in arrangement
  rices/minimal/shell.qml      the same bricks, sidebar on the right, no status bar
  rices/broken/shell.qml       a syntax error, to show the overlay and fallback
```

Run it with `bun examples/shell/app.ts --config-dir examples/shell/rices/minimal` (or
`--no-watch`). `ShellWindow` exposes `main` (the sidebar/body row), `sidebar`, `body`,
`statusBar` and `toolbar` (a `Loader` slot); the minimal rice uses
`main.flexDirection: "row-reverse"` and `statusBar.visible: false`. Keys in the default shell:
`q` quit, `ctrl+r` `Runtime.reload()`, `ctrl+b` toggle the sidebar, `ctrl+n` next page, `/`
focus the composer (Enter sends `Shell.dispatch("compose", text)`, Esc leaves it).
`app.ts` exports `startDemo()` so the tests drive it with the test renderer.

The CLI can host a shell without writing TypeScript (no app singletons then, only `--context`):
`opentui-qml --shell qml/DefaultShell.qml --app-id myapp [--config-dir dir] [--module Uri=dir]... [--no-watch]`.
