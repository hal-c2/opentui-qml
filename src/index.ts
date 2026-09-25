/**
 * opentui-qml public API.
 *
 * ```ts
 * import { runQml } from "opentui-qml"
 * const app = await runQml("./main.qml", { context: { user: "ada" }, pluginDirs: ["./plugins"] })
 * ```
 */
import { resolve, dirname } from "node:path"
import { createCliRenderer, type CliRenderer, type CliRendererConfig } from "@opentui/core"
import { QmlEngine, type QmlComponent, type QmlEngineOptions } from "./runtime/engine.ts"
import type { QmlObject } from "./runtime/object.ts"
import type { QmlTypeFactory, Scheduler } from "./runtime/types.ts"
import {
  addPlugin,
  disposePlugins,
  getSlotRegistry,
  loadPluginsFromDir,
  registerPluginTypes,
  setPluginRoot,
  type AnyPlugin,
} from "./runtime/plugins.ts"
import { isVisual } from "./components/visual.ts"
import { Slot } from "./components/slot.ts"
import { registerOpenTuiTypes } from "./components/index.ts"
import { applyKeymapOverrides } from "./components/keymap.ts"

// ---------------------------------------------------------------------------------------------
// Re-exports

export { parseQml } from "./parser/index.ts"
export { QmlSyntaxError } from "./parser/ast.ts"
export type { QmlDocument } from "./parser/ast.ts"
export * from "./runtime/index.ts"
export { VisualObject, Item, isVisual } from "./components/visual.ts"
export { Slot } from "./components/slot.ts"
export { registerOpenTuiTypes } from "./components/index.ts"
export {
  Contribution,
  PluginObject,
  SLOT_OWNER,
  addPlugin,
  createFromSource,
  disposePlugins,
  getSlotContext,
  getSlotRegistry,
  isPluginDocument,
  listPlugins,
  loadPluginsFromDir,
  loadQmlPlugin,
  registerPlugin,
  registerPluginTypes,
  setPluginRoot,
  unregisterPlugin,
  wrapSlotData,
} from "./runtime/plugins.ts"
export type {
  AnyPlugin,
  PluginInfo,
  QmlManagedSlot,
  QmlPluginSpec,
  QmlSlotContext,
  QmlSlotData,
  QmlSlotRegistry,
  QmlSlotRenderer,
  QmlSlotResult,
} from "./runtime/plugins.ts"

// ---------------------------------------------------------------------------------------------
// Engine

export interface CreateQmlEngineOptions extends QmlEngineOptions {
  /** Extra native types, registered after the builtin and OpenTUI types (may override them). */
  types?: Record<string, QmlTypeFactory>
}

/** A QmlEngine with the builtins, the OpenTUI visual types, `Slot`, `Plugin` and `Contribution`. */
export function createQmlEngine(opts: CreateQmlEngineOptions = {}): QmlEngine {
  const { types, ...engineOpts } = opts
  const engine = new QmlEngine(engineOpts)
  registerOpenTuiTypes(engine)
  engine.registerType("Slot", Slot)
  registerPluginTypes(engine)
  for (const [name, factory] of Object.entries(types ?? {})) engine.registerType(name, factory)
  return engine
}

// ---------------------------------------------------------------------------------------------
// Running an app

export interface RunQmlOptions {
  /** Renderer to mount into (e.g. a test renderer). Default: `createCliRenderer(rendererConfig)`. */
  renderer?: CliRenderer
  rendererConfig?: CliRendererConfig
  /** Names visible in every QML scope (engine globals) and in the plugin context. */
  context?: Record<string, unknown>
  /** Extra native types. */
  types?: Record<string, QmlTypeFactory>
  /**
   * Plugins: OpenTUI `CorePlugin`s / `QmlPluginSpec`s, or paths to QML plugin files
   * (relative paths resolve against the current working directory).
   */
  plugins?: (AnyPlugin | string)[]
  /** Directories whose `*.qml` files with a `Plugin` root are loaded (relative to cwd). */
  pluginDirs?: string[]
  /**
   * Keymap overrides merged into the document's `Keymap`s: `{ "ctrl+s": "save" }` for the
   * unnamed keymap, `{ main: { ... } }` for `Keymap { name: "main" }`.
   */
  keymap?: Record<string, unknown>
  /** Base directory for relative paths in the document (default: the file's directory / cwd). */
  basePath?: string
  scheduler?: Scheduler
  onWarning?: (message: string) => void
  onError?: (error: unknown, context?: string) => void
}

export interface QmlApp {
  engine: QmlEngine
  /** The instantiated root object (`root.proxy` for property access). */
  root: QmlObject
  renderer: CliRenderer
  /** Destroy the QML tree and plugins; also destroys the renderer if `runQml` created it. */
  destroy(): void
}

/** Load `file`, instantiate it and mount it into the renderer. */
export async function runQml(file: string, options: RunQmlOptions = {}): Promise<QmlApp> {
  const abs = resolve(file)
  return start(options, options.basePath ?? dirname(abs), (engine) => engine.loadFile(abs))
}

/** Like {@link runQml}, for QML source text (`filename` is used for errors and relative types). */
export async function runQmlSource(
  source: string,
  options: RunQmlOptions & { filename?: string } = {},
): Promise<QmlApp> {
  const base = options.basePath ?? (options.filename ? dirname(resolve(options.filename)) : process.cwd())
  return start(options, base, (engine) => engine.loadSource(source, options.filename ? resolve(options.filename) : undefined))
}

async function start(
  options: RunQmlOptions,
  basePath: string,
  load: (engine: QmlEngine) => QmlComponent | Promise<QmlComponent>,
): Promise<QmlApp> {
  const ownsRenderer = !options.renderer
  const renderer = options.renderer ?? (await createCliRenderer(options.rendererConfig))
  let engine: QmlEngine | null = null
  let root: QmlObject | null = null
  try {
    engine = createQmlEngine({
      renderer,
      globals: options.context,
      basePath,
      types: options.types,
      scheduler: options.scheduler,
      onWarning: options.onWarning,
      onError: options.onError,
    })
    // Parse first so syntax errors surface before any plugin side effects.
    const component = await load(engine)

    getSlotRegistry(engine)
    for (const plugin of options.plugins ?? []) {
      await addPlugin(engine, typeof plugin === "string" ? resolve(plugin) : plugin)
    }
    for (const dir of options.pluginDirs ?? []) await loadPluginsFromDir(engine, resolve(dir))

    root = engine.createObject(component)
    if (!isVisual(root)) {
      throw new Error(
        `${component.filename ?? "<qml>"}: the root object must be a visual type (Window, Item, Rectangle, ...), got "${root.typeName}"`,
      )
    }
    renderer.root.add(root.renderable)
    setPluginRoot(engine, root)
    if (options.keymap) applyKeymapOverrides(engine, options.keymap)
  } catch (err) {
    if (engine) {
      disposePlugins(engine)
      engine.destroy()
    }
    if (ownsRenderer && !renderer.isDestroyed) renderer.destroy()
    throw err
  }

  const eng = engine
  const rootObj = root
  let destroyed = false
  const teardown = (): void => {
    if (destroyed) return
    destroyed = true
    renderer.off("destroy", teardown)
    disposePlugins(eng)
    eng.destroy()
  }
  renderer.on("destroy", teardown)
  renderer.requestRender()

  return {
    engine: eng,
    root: rootObj,
    renderer,
    destroy() {
      teardown()
      if (ownsRenderer && !renderer.isDestroyed) renderer.destroy()
    },
  }
}
