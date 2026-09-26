/**
 * Shell host: an app ships its UI as QML bricks plus a default shell; a user `shell.qml` in the
 * app's config directory replaces the root. See docs/SHELL.md for the contract.
 *
 * ```ts
 * const shell = await runShell({
 *   appId: "myapp",
 *   defaultShell: "./qml/DefaultShell.qml",
 *   modules: { "MyApp.Bricks": "./qml/MyApp/Bricks" },
 *   singletons: { Shell: { state, dispatch }, Theme: theme },
 * })
 * ```
 */
import { existsSync, statSync, watch, type FSWatcher } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, relative, isAbsolute, resolve } from "node:path"
import { createCliRenderer } from "@opentui/core"
import type { QmlApp, RunQmlOptions } from "./index.ts"
import { QmlEngine } from "./runtime/engine.ts"
import type { QmlObject } from "./runtime/object.ts"
import { QtObject } from "./runtime/builtins.ts"
import {
  addPlugin,
  disposePlugins,
  getSlotRegistry,
  loadPluginsFromDir,
  registerPluginTypes,
  setPluginRoot,
} from "./runtime/plugins.ts"
import { isVisual, type VisualObject } from "./components/visual.ts"
import { Slot } from "./components/slot.ts"
import { registerOpenTuiTypes } from "./components/index.ts"
import { applyKeymapOverrides } from "./components/keymap.ts"
import { registerShellErrorOverlay, showShellErrorOverlay } from "./shell/error-overlay.ts"

export {
  SHELL_ERROR_OVERLAY_HINT,
  SHELL_ERROR_OVERLAY_QML,
  SHELL_ERROR_OVERLAY_TYPE,
  describeShellError,
} from "./shell/error-overlay.ts"
export type { ShellErrorLocation } from "./shell/error-overlay.ts"

export interface RunShellOptions extends RunQmlOptions {
  /** Application id: the default config directory is `$XDG_CONFIG_HOME/<appId>/shell`. */
  appId: string
  /** The built-in root document (relative paths resolve against cwd). */
  defaultShell: string
  /** Module uri → directory (with a `qmldir`), e.g. `{ "MyApp.Bricks": "./qml/MyApp/Bricks" }`. */
  modules?: Record<string, string>
  /** Overrides the `appId` default (`$XDG_CONFIG_HOME/<appId>/shell` or `~/.config/<appId>/shell`). */
  configDir?: string
  /** Overrides `${configDir}/shell.qml`. */
  userShell?: string
  /** Hot reload on `.qml` / `.js` / `qmldir` changes. Default true. */
  watch?: boolean
  /** Show `ShellErrorOverlay` on top of the default shell when the user shell failed. Default true. */
  errorOverlay?: boolean
}

export type ShellEvent = "generation" | "error"

export interface ShellApp extends QmlApp {
  /** Re-resolve and re-instantiate the root (queued behind a reload in progress; never rejects). */
  reload(): Promise<void>
  /** True when the live root is the user shell. */
  readonly usingUserShell: boolean
  readonly userShellPath: string
  readonly configDir: string
  /** The last load error (cleared by a reload that loads the preferred shell). */
  readonly lastError: Error | null
  /** 1 for the first root, incremented by every reload that swapped the root. */
  readonly generation: number
  on(event: "generation", cb: (generation: number) => void): () => void
  on(event: "error", cb: (error: Error) => void): () => void
}

/** `$XDG_CONFIG_HOME/<appId>/shell`, or `~/.config/<appId>/shell`. */
export function defaultShellConfigDir(appId: string): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(base, appId, "shell")
}

const WATCHED_FILE = /(\.qml|\.m?js|(^|[\\/])qmldir)$/
const DEBOUNCE_MS = 100

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

interface Resolved {
  root: VisualObject
  user: boolean
  /** The user shell's error when it fell back to the default shell. */
  error: Error | null
}

/** Load the user shell (falling back to the default shell) and mount it into the renderer. */
export async function runShell(options: RunShellOptions): Promise<ShellApp> {
  const defaultShell = resolve(options.defaultShell)
  const configDir = resolve(options.configDir ?? defaultShellConfigDir(options.appId))
  const userShellPath = resolve(options.userShell ?? join(configDir, "shell.qml"))
  const userQmlDir = join(configDir, "qml")
  const basePath = options.basePath ? resolve(options.basePath) : dirname(defaultShell)
  const modules = Object.entries(options.modules ?? {}).map(([uri, dir]) => [uri, resolve(dir)] as const)
  const overlayEnabled = options.errorOverlay !== false

  const ownsRenderer = !options.renderer
  const renderer = options.renderer ?? (await createCliRenderer(options.rendererConfig))
  let engine: QmlEngine | null = null
  let runtime: QtObject | null = null

  const listeners: { [K in ShellEvent]: Set<(value: never) => void> } = { generation: new Set(), error: new Set() }
  const emit = (event: ShellEvent, value: unknown): void => {
    for (const cb of [...listeners[event]]) {
      try {
        ;(cb as (v: unknown) => void)(value)
      } catch (err) {
        engine?.reportError(err, `shell "${event}" listener`)
      }
    }
  }

  let root: VisualObject | null = null
  let usingUserShell = false
  let lastError: Error | null = null
  let generation = 0
  let destroyed = false
  // Set once the reload machinery exists (Runtime.reload() during the first load is a no-op).
  let requestReload: () => Promise<void> = async () => {}

  const report = (err: Error): void => {
    lastError = err
    runtime?.write("lastError", err.message)
    try {
      options.onError?.(err, "shell")
    } catch {
      // an app callback must not break the host
    }
    emit("error", err)
  }

  const instantiateFile = async (eng: QmlEngine, file: string): Promise<VisualObject> => {
    const component = await eng.loadFile(file)
    const obj = eng.createObject(component)
    if (!isVisual(obj)) {
      obj.destroy()
      throw new Error(`${file}: the root object must be a visual type (Window, Item, Rectangle, ...), got "${obj.typeName}"`)
    }
    return obj
  }

  /** User shell → default shell; throws when neither can be instantiated. */
  const resolveRoot = async (eng: QmlEngine): Promise<Resolved> => {
    let userError: Error | null = null
    if (existsSync(userShellPath)) {
      try {
        return { root: await instantiateFile(eng, userShellPath), user: true, error: null }
      } catch (err) {
        userError = toError(err)
      }
    }
    try {
      const obj = await instantiateFile(eng, defaultShell)
      if (userError && overlayEnabled) {
        try {
          showShellErrorOverlay(eng, obj, userError, userShellPath)
        } catch (err) {
          eng.reportError(err, "ShellErrorOverlay")
        }
      }
      return { root: obj, user: false, error: userError }
    } catch (err) {
      const defaultError = toError(err)
      if (!userError) throw defaultError
      throw new Error(`both shells failed to load:\n  user shell: ${userError.message}\n  default shell: ${defaultError.message}`, {
        cause: userError,
      })
    }
  }

  /** Mount `next` in place of the current root (the new root is added before the old one goes). */
  const swap = (eng: QmlEngine, next: Resolved): void => {
    const old = root
    renderer.root.add(next.root.renderable)
    if (old && old.renderable.parent === renderer.root) renderer.root.remove(old.renderable)
    root = next.root
    usingUserShell = next.user
    setPluginRoot(eng, next.root)
    if (options.keymap) applyKeymapOverrides(eng, options.keymap)
    if (old) {
      try {
        old.destroy()
      } catch (err) {
        eng.reportError(err, "shell: destroying the previous root")
      }
    }
    generation++
    runtime?.write("generation", generation)
    runtime?.write("usingUserShell", usingUserShell)
    renderer.requestRender()
  }

  // ---------------------------------------------------------------------------------------------
  // Start

  try {
    const eng = new QmlEngine({
      renderer,
      globals: options.context,
      basePath,
      // `${configDir}/qml` is always listed; a missing directory is skipped at resolve time.
      importPaths: [...(options.importPaths ?? []).map((p) => resolve(p)), userQmlDir, basePath],
      scheduler: options.scheduler,
      onWarning: options.onWarning,
      onError: options.onError,
    })
    engine = eng
    registerOpenTuiTypes(eng)
    eng.registerType("Slot", Slot)
    registerPluginTypes(eng)
    for (const [name, factory] of Object.entries(options.types ?? {})) eng.registerType(name, factory)
    for (const [uri, dir] of modules) eng.registerModuleDirectory(uri, dir)
    registerShellErrorOverlay(eng)

    const rt = new QtObject(eng, "Runtime")
    runtime = rt
    rt.defineProperty("configDir", { type: "string", value: configDir, readonly: true })
    rt.defineProperty("userShellPath", { type: "string", value: userShellPath, readonly: true })
    rt.defineProperty("usingUserShell", { type: "bool", value: false, readonly: true })
    rt.defineProperty("lastError", { type: "string", value: "", readonly: true })
    rt.defineProperty("generation", { type: "int", value: 0, readonly: true })
    rt.defineMethod("reload", () => {
      void requestReload()
    })
    rt.defineMethod("openConfigDir", () => false)
    eng.registerSingleton("Runtime", rt)
    for (const [name, value] of Object.entries(options.singletons ?? {})) eng.registerSingleton(name, value)

    getSlotRegistry(eng)
    for (const plugin of options.plugins ?? []) {
      await addPlugin(eng, typeof plugin === "string" ? resolve(plugin) : plugin)
    }
    for (const dir of options.pluginDirs ?? []) await loadPluginsFromDir(eng, resolve(dir))

    const first = await resolveRoot(eng)
    swap(eng, first)
    if (first.error) report(first.error)
  } catch (err) {
    if (engine) {
      disposePlugins(engine)
      engine.destroy()
    }
    runtime?.destroy()
    if (ownsRenderer && !renderer.isDestroyed) renderer.destroy()
    throw err
  }

  const eng = engine

  // ---------------------------------------------------------------------------------------------
  // Reload

  const reloadNow = async (): Promise<void> => {
    if (destroyed || eng.isDestroyed) return
    const stale = eng.invalidate()
    let next: Resolved
    try {
      next = await resolveRoot(eng)
    } catch (err) {
      // Both shells failed: keep the previous generation (and its singletons) alive.
      report(toError(err))
      return
    }
    if (destroyed || eng.isDestroyed) {
      next.root.destroy()
      return
    }
    swap(eng, next)
    for (const obj of stale) obj.destroy()
    if (next.error) report(next.error)
    else {
      lastError = null
      runtime?.write("lastError", "")
    }
    refreshWatchers()
    emit("generation", generation)
  }

  let running: Promise<void> | null = null
  let queued: Promise<void> | null = null
  const reload = (): Promise<void> => {
    if (destroyed) return Promise.resolve()
    if (!running) {
      running = reloadNow()
        .catch((err) => report(toError(err)))
        .finally(() => {
          running = null
        })
      return running
    }
    queued ??= running.then(() => {
      queued = null
      return reload()
    })
    return queued
  }
  requestReload = reload

  // ---------------------------------------------------------------------------------------------
  // Watching

  const watchers = new Map<string, FSWatcher>()
  let debounce: ReturnType<typeof setTimeout> | null = null
  const watchEnabled = options.watch !== false

  const onChange = (filename: string | Buffer | null): void => {
    try {
      if (destroyed) return
      const name = filename == null ? null : String(filename)
      if (name !== null && !WATCHED_FILE.test(name)) return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        debounce = null
        void reload()
      }, DEBOUNCE_MS)
    } catch (err) {
      report(toError(err))
    }
  }

  /** Directories to watch: [dir, recursive]. Nested ones are covered by a recursive parent. */
  const watchTargets = (): Array<[string, boolean]> => {
    const recursive = [configDir, dirname(defaultShell), ...modules.map(([, dir]) => dir)].filter(isDir)
    const out: Array<[string, boolean]> = []
    for (const dir of recursive) {
      if (out.some(([d]) => isInside(d, dir))) continue
      for (let i = out.length - 1; i >= 0; i--) if (isInside(dir, out[i]![0])) out.splice(i, 1)
      out.push([dir, true])
    }
    const userDir = dirname(userShellPath)
    if (isDir(userDir) && !out.some(([d]) => isInside(d, userDir))) out.push([userDir, false])
    return out
  }

  const refreshWatchers = (): void => {
    if (!watchEnabled || destroyed) return
    const wanted = new Map(watchTargets())
    for (const [dir, watcher] of watchers) {
      if (!wanted.has(dir)) {
        watcher.close()
        watchers.delete(dir)
      }
    }
    for (const [dir, recursive] of wanted) {
      if (watchers.has(dir)) continue
      try {
        const watcher = watch(dir, { recursive, persistent: true }, (_event, filename) => onChange(filename))
        watcher.on("error", (err) => {
          watcher.close()
          watchers.delete(dir)
          report(toError(err))
        })
        watchers.set(dir, watcher)
      } catch (err) {
        report(new Error(`cannot watch "${dir}": ${toError(err).message}`, { cause: err }))
      }
    }
  }

  const stopWatching = (): void => {
    if (debounce) clearTimeout(debounce)
    debounce = null
    for (const watcher of watchers.values()) watcher.close()
    watchers.clear()
  }

  refreshWatchers()

  // ---------------------------------------------------------------------------------------------
  // Teardown

  const teardown = (): void => {
    if (destroyed) return
    destroyed = true
    stopWatching()
    renderer.off("destroy", teardown)
    disposePlugins(eng)
    eng.destroy()
    runtime?.destroy()
    listeners.generation.clear()
    listeners.error.clear()
  }
  renderer.on("destroy", teardown)
  renderer.requestRender()

  const app: ShellApp = {
    engine: eng,
    get root(): QmlObject {
      return root!
    },
    renderer,
    reload,
    get usingUserShell() {
      return usingUserShell
    },
    userShellPath,
    configDir,
    get lastError() {
      return lastError
    },
    get generation() {
      return generation
    },
    on(event: ShellEvent, cb: (value: never) => void): () => void {
      listeners[event].add(cb)
      return () => listeners[event].delete(cb)
    },
    destroy() {
      teardown()
      if (ownsRenderer && !renderer.isDestroyed) renderer.destroy()
    },
  }
  return app
}
