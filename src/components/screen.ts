/**
 * `Screen` — the per-engine terminal/app services singleton, visible in every QML scope.
 *
 * Properties (all reactive; read-only unless noted):
 *   - `width` / `height`: renderer size in cells (updated on the renderer's "resize");
 *   - `themeMode`: "dark" | "light" | null (renderer "theme_mode");
 *   - `focused`: terminal focus (renderer "focus" / "blur"; true until the first blur);
 *   - `selectedText` / `hasSelection`: the current mouse selection (renderer "selection");
 *   - `capabilities`: the terminal capabilities object or null (renderer "capabilities");
 *   - `debugOverlay`: true while the debug overlay is shown;
 *   - `consoleMode` (writable): "console-overlay" | "disabled";
 *   - `title` (writable): the terminal title (`setTerminalTitle`).
 *
 * Signals: `resized(width, height)`, `selectionChanged(text)`, plus the usual
 * `<prop>Changed` signals (`themeModeChanged`, `focusedChanged`, `capabilitiesChanged`, ...).
 * Handlers can be attached from any item as `Screen.onResized: ...` or via
 * `Connections { target: Screen }`.
 *
 * Methods: `copyToClipboard(text)` (Promise<boolean>; OpenTUI's clipboard service with
 * destination "best-available", falling back to OSC 52), `notify(message, title?)`,
 * `toggleConsole()`, `showConsole()`, `hideConsole()`, `clearConsole()`, `focusConsole()`,
 * `setConsoleDebug(enabled)`, `toggleDebugOverlay()`, `setTitle(title)`, `requestRender()`,
 * `writeToScrollback(textOrStyledText)` (split-footer mode only), `clearSelection()`.
 */
import {
  StyledText,
  TextRenderable,
  createClipboard,
  createHostClipboard,
  createRendererClipboardAdapter,
  type CliRenderer,
  type ClipboardService,
  type Selection,
} from "@opentui/core"
import { QmlObject, handlerToSignalName } from "../runtime/object.ts"
import { createHandler } from "../runtime/expression.ts"
import type { QmlEngine } from "../runtime/engine.ts"
import type { HandlerSpec } from "../runtime/types.ts"

export class ScreenObject extends QmlObject {
  private clipboard: ClipboardService | null = null
  private readonly warned = new Set<string>()
  private readonly unsubs: Array<() => void> = []

  constructor(engine: QmlEngine) {
    super(engine, "Screen")
    const r = engine.renderer as CliRenderer | undefined

    this.defineProperty("width", { type: "int", readonly: true, value: r?.width ?? 0 })
    this.defineProperty("height", { type: "int", readonly: true, value: r?.height ?? 0 })
    this.defineProperty("themeMode", { type: "var", readonly: true, value: r?.themeMode ?? null })
    this.defineProperty("focused", { type: "bool", readonly: true, value: true })
    this.defineProperty("selectedText", { type: "string", readonly: true, value: "" })
    this.defineProperty("hasSelection", { type: "bool", readonly: true, value: false })
    this.defineProperty("capabilities", { type: "var", readonly: true, value: r?.capabilities ?? null })
    this.defineProperty("debugOverlay", { type: "bool", readonly: true, value: false })
    this.defineProperty("consoleMode", {
      type: "var",
      value: r?.consoleMode ?? "disabled",
      onChange: (v) => {
        if (!r || r.isDestroyed || (v !== "console-overlay" && v !== "disabled")) return
        try {
          r.consoleMode = v
        } catch (err) {
          engine.reportError(err, "Screen.consoleMode")
        }
      },
    })
    this.defineProperty("title", {
      type: "string",
      onChange: (v) => this.setTitle(String(v ?? "")),
    })

    this.defineSignal("resized", ["width", "height"])
    this.defineSignal("selectionChanged", ["text"])

    this.defineMethod("copyToClipboard", (text: unknown) => this.copyToClipboard(String(text ?? "")))
    this.defineMethod("notify", (message: unknown, title?: unknown) =>
      this.notify(String(message ?? ""), title === undefined || title === null ? undefined : String(title)),
    )
    this.defineMethod("toggleConsole", () => r?.console.toggle())
    this.defineMethod("showConsole", () => r?.console.show())
    this.defineMethod("hideConsole", () => r?.console.hide())
    this.defineMethod("clearConsole", () => r?.console.clear())
    this.defineMethod("focusConsole", () => r?.console.focus())
    this.defineMethod("setConsoleDebug", (on: unknown) => r?.console.setDebugMode(!!on))
    this.defineMethod("toggleDebugOverlay", () => r?.toggleDebugOverlay())
    this.defineMethod("setTitle", (title: unknown) => this.setTitle(String(title ?? "")))
    this.defineMethod("requestRender", () => r?.requestRender())
    this.defineMethod("writeToScrollback", (content: unknown) => this.writeToScrollback(content))
    this.defineMethod("clearSelection", () => {
      if (!r || r.isDestroyed) return
      r.clearSelection()
      // The renderer does not emit "selection" when cleared programmatically.
      if (this.peek("selectedText") !== "" || this.peek("hasSelection")) {
        this.write("hasSelection", false)
        this.write("selectedText", "")
        this.emit("selectionChanged", "")
      }
    })

    if (r) this.listen(r)
    this.completeConstruction()
  }

  private listen(r: CliRenderer): void {
    const on = (event: string, fn: (...args: any[]) => void): void => {
      r.on(event, fn)
      this.unsubs.push(() => r.off(event, fn))
    }
    on("resize", (w: number, h: number) => {
      this.write("width", w)
      this.write("height", h)
      this.emit("resized", w, h)
    })
    on("theme_mode", (mode: unknown) => this.write("themeMode", mode ?? null))
    on("focus", () => this.write("focused", true))
    on("blur", () => this.write("focused", false))
    on("capabilities", (caps: unknown) => this.write("capabilities", caps ?? null))
    on("debugOverlay:toggle", (enabled: boolean) => this.write("debugOverlay", !!enabled))
    on("selection", (selection: Selection | null) => {
      const text = selection?.getSelectedText() ?? ""
      this.write("hasSelection", !!selection && selection.isActive !== false && text !== "")
      this.write("selectedText", text)
      this.emit("selectionChanged", text)
    })
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return
    this.warned.add(key)
    this.engine.warn(message)
  }

  setTitle(title: string): void {
    const r = this.engine.renderer
    if (!r || r.isDestroyed) return
    r.setTerminalTitle(title)
  }

  notify(message: string, title?: string): boolean {
    const r = this.engine.renderer as (CliRenderer & { triggerNotification?: unknown }) | undefined
    if (!r || r.isDestroyed) return false
    if (typeof r.triggerNotification !== "function") {
      this.warnOnce("notify", "Screen.notify: terminal notifications are not supported by this OpenTUI version")
      return false
    }
    return r.triggerNotification(message, title)
  }

  /** Replace the clipboard service (tests, custom hosts). */
  setClipboard(service: ClipboardService | null): void {
    this.clipboard = service
  }

  async copyToClipboard(text: string): Promise<boolean> {
    const r = this.engine.renderer
    if (!r || r.isDestroyed) return false
    try {
      this.clipboard ??= createClipboard({ host: createHostClipboard(), terminal: createRendererClipboardAdapter(r) })
      const result = await this.clipboard.writeText(text, { destination: "best-available" })
      if (result.host.status === "written" || result.terminal.status === "attempted") return true
    } catch (err) {
      this.warnOnce("clipboard", `Screen.copyToClipboard: clipboard service failed (${String(err)}), using OSC 52`)
    }
    return r.isDestroyed ? false : r.copyToClipboardOSC52(text)
  }

  /**
   * Write a line (string or StyledText) above the footer. Needs the renderer in
   * `screenMode: "split-footer"` with `externalOutputMode: "capture-stdout"`.
   */
  writeToScrollback(content: unknown): boolean {
    const r = this.engine.renderer as CliRenderer | undefined
    if (!r || r.isDestroyed) return false
    if (typeof r.writeToScrollback !== "function") {
      this.warnOnce("scrollback", "Screen.writeToScrollback: not supported by this OpenTUI version")
      return false
    }
    const styled = content instanceof StyledText || (typeof content === "object" && content !== null && Array.isArray((content as StyledText).chunks))
    const value: string | StyledText = styled ? (content as StyledText) : String(content ?? "")
    const plain = typeof value === "string" ? value : value.chunks.map((c) => c.text).join("")
    try {
      r.writeToScrollback((ctx) => ({
        root: new TextRenderable(ctx.renderContext, { content: value, width: ctx.width }),
        width: ctx.width,
        height: Math.max(1, plain.split("\n").length),
        startOnNewLine: true,
        trailingNewline: true,
      }))
      return true
    } catch (err) {
      this.warnOnce("scrollback", `Screen.writeToScrollback: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  override destroy(): void {
    if (this.isDestroyed) return
    for (const u of this.unsubs.splice(0)) u()
    const c = this.clipboard
    this.clipboard = null
    try {
      const done = c?.dispose() as unknown
      if (done instanceof Promise) done.catch(() => {})
    } catch {
      // ignore clipboard teardown errors
    }
    super.destroy()
  }
}

const screens = new WeakMap<QmlEngine, ScreenObject>()

/** The engine's `Screen` singleton (created on first use). */
export function screenFor(engine: QmlEngine): ScreenObject {
  let s = screens.get(engine)
  if (!s || s.isDestroyed) {
    s = new ScreenObject(engine)
    screens.set(engine, s)
  }
  return s
}

/**
 * `Screen.onResized: ...` written on any item: connect the handler to the singleton's signal
 * for the item's lifetime. Returns false for unknown signals.
 */
export function connectScreenHandler(obj: QmlObject, handlerName: string, spec: HandlerSpec): boolean {
  const screen = screenFor(obj.engine)
  const signal = handlerToSignalName(handlerName)
  if (!signal || !screen.hasSignal(signal)) return false
  const fn = createHandler(spec.compiled, spec.scope, screen.signalParams(signal))
  const off = screen.connect(signal, (...args) => {
    try {
      return fn(...args)
    } catch (err) {
      obj.engine.reportError(err, `${obj.describe()}: Screen.${handlerName}`)
    }
  })
  obj.onDestroy(off)
  return true
}
