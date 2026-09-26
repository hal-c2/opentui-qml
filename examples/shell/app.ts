#!/usr/bin/env bun
/**
 * A small app built on the shell host (docs/SHELL.md): the app owns the state and the actions,
 * the QML bricks in `qml/Demo/Bricks` render them, `qml/DefaultShell.qml` arranges the bricks,
 * and a user `shell.qml` in the config directory can re-arrange them.
 *
 *   bun examples/shell/app.ts                                          # ~/.config/opentui-qml-shell-demo/shell
 *   bun examples/shell/app.ts --config-dir examples/shell/rices/minimal
 *   bun examples/shell/app.ts --config-dir examples/shell/rices/broken  # overlay + fallback
 *
 * Options: --config-dir <dir>, --no-watch.
 */
import { join } from "node:path"
import { parseArgs } from "node:util"
import type { CliRenderer } from "@opentui/core"
import { createPropertyMap, createStore, runShell, type ShellApp } from "../../src/index.ts"

const HERE = import.meta.dir

export interface DemoOptions {
  configDir?: string
  watch?: boolean
  renderer?: CliRenderer
  onError?: (error: unknown, context?: string) => void
  onWarning?: (message: string) => void
}

export interface Demo {
  shell: ShellApp
  state: ReturnType<typeof createPropertyMap>
  theme: { radius: number; colors: Record<string, string> }
  /** Stop the clock and destroy the shell. */
  stop(): void
}

const clock = (): string => new Date().toLocaleTimeString("en-GB")

export async function startDemo(opts: DemoOptions = {}): Promise<Demo> {
  // App state: per-key reactive, read by the bricks as `Shell.state.<key>`.
  const state = createPropertyMap({
    pages: [
      { id: "inbox", title: "Inbox" },
      { id: "drafts", title: "Drafts" },
      { id: "archive", title: "Archive" },
    ],
    page: "inbox",
    messages: [] as string[],
    sidebarCollapsed: false,
    clock: clock(),
  })
  const theme = createStore({
    radius: 1,
    colors: {
      chrome: "#16161e",
      surface: "#1f2335",
      text: "#c0caf5",
      muted: "#565f89",
      accent: "#7aa2f7",
      border: "#3b4261",
    },
  })

  let shell: ShellApp | null = null
  // Behaviour lives in the app: bricks only call Shell.dispatch(action, payload).
  const Shell = {
    state,
    pageTitle: "Shell demo",
    dispatch(action: string, payload?: unknown): void {
      switch (action) {
        case "toggleSidebar":
          state.set("sidebarCollapsed", !state.get("sidebarCollapsed"))
          break
        case "navigate": {
          const pages = state.get("pages") as Array<{ id: string }>
          const i = pages.findIndex((p) => p.id === state.get("page"))
          if (payload === "next") state.set("page", pages[(i + 1) % pages.length]!.id)
          else if (payload === "previous") state.set("page", pages[(i - 1 + pages.length) % pages.length]!.id)
          else if (pages.some((p) => p.id === payload)) state.set("page", payload)
          break
        }
        case "compose": {
          const text = String(payload ?? "").trim()
          if (text) (state.get("messages") as string[]).push(text)
          break
        }
        case "quit":
          shell?.destroy()
          break
      }
    },
  }

  const timer = setInterval(() => state.set("clock", clock()), 1000)
  try {
    shell = await runShell({
      appId: "opentui-qml-shell-demo",
      defaultShell: join(HERE, "qml", "DefaultShell.qml"),
      modules: { "Demo.Bricks": join(HERE, "qml", "Demo", "Bricks") },
      importPaths: [join(HERE, "qml")],
      configDir: opts.configDir,
      watch: opts.watch,
      renderer: opts.renderer,
      rendererConfig: { exitOnCtrlC: true },
      singletons: { Shell, Theme: theme },
      onError: opts.onError,
      onWarning: opts.onWarning,
    })
  } catch (err) {
    clearInterval(timer)
    throw err
  }
  const live = shell
  const stop = (): void => {
    clearInterval(timer)
    live.destroy()
  }
  // Qt.quit() (the "q" shortcut) destroys the renderer: stop the clock with it.
  live.renderer.once("destroy", () => clearInterval(timer))
  return { shell: live, state, theme, stop }
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { "config-dir": { type: "string" }, "no-watch": { type: "boolean" } },
  })
  try {
    await startDemo({ configDir: values["config-dir"], watch: !values["no-watch"] })
  } catch (err) {
    process.stderr.write(`shell demo: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  }
}
