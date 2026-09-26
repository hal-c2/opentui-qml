/**
 * Pixel / cell-level renderables:
 *
 * - `FrameBuffer` / `Canvas` (FrameBufferRenderable): an offscreen cell buffer drawn at the item's
 *   position. Signal `paint(painter)` fires after completion and whenever the size changes (the
 *   buffer is cleared on resize); methods `requestPaint()` (clear + `paint` again),
 *   `draw(fn)` (call `fn(painter)` now), `clear(color?)`. The painter has `width`, `height`,
 *   `drawText(text, x, y, fg?, bg?, attributes?)`, `setCell(x, y, char, fg?, bg?, attributes?)`,
 *   `fillRect(x, y, w, h, color)`, `clear(color?)`, `drawBox({ x, y, width, height, border?,
 *   borderStyle?, borderColor?, backgroundColor?, title?, titleColor?, titleAlignment?,
 *   shouldFill? })` and the raw OpenTUI `buffer`. Colours are any QML colour value.
 *   `respectAlpha` toggles alpha blending of the buffer onto the screen.
 * - `Image` (ImageRenderable): `source` (a path — relative paths resolve against the QML file's
 *   directory — URL string, Uint8Array / ArrayBuffer / Blob, or a NativeImage), `fit` ("fit" |
 *   "cover" | "fill"), `protocol` ("auto" | "kitty" | "sixel" | "blocks"); read-only `loading`,
 *   `status` ("null" | "loading" | "ready" | "error"); signals `loaded()`, `error(message)`.
 * - `EmbeddedTerminal` / `Terminal` (EmbeddedTerminalRenderable): a VT screen. With `command`
 *   (a string or array) + `args`, `cwd`, `env` it spawns the program in a PTY (Bun.spawn with a
 *   `terminal`) on completion (unless `autoStart: false`); the PTY follows the item's size and
 *   focused keys/paste are forwarded to it. Read-only `running`, `pid`, `exitCode`; props
 *   `transparentBackground`, `selectable`; signals `exited(code)`, `screenChanged()`,
 *   `input(data)` (bytes the widget would send to the program, as a string); methods
 *   `write(text)` (to the screen), `send(text)` (to the program), `start()`, `kill(signal?)`,
 *   `screenText()`, `screen()` (`{ text, lines, columns, rows, cursor }`), `selectedText()`.
 */
import {
  EmbeddedTerminalRenderable,
  FrameBufferRenderable,
  ImageRenderable,
  parseColor,
  type FrameBufferOptions,
  type OptimizedBuffer,
  type RenderContext,
  type Renderable,
  type RGBA,
} from "@opentui/core"
import { dirname, isAbsolute, resolve } from "node:path"
import type { QmlEngine } from "../runtime/engine.ts"
import { Item, nextRenderableId, toColor } from "./visual.ts"

function rgba(v: unknown, fallback: string): RGBA {
  const c = toColor(v)
  try {
    return parseColor((c ?? fallback) as string)
  } catch {
    return parseColor(fallback)
  }
}

// -----------------------------------------------------------------------------------------------
// FrameBuffer

/** FrameBufferRenderable that ignores zero-size layouts (the core one throws) and reports resizes. */
class QmlFrameBufferRenderable extends FrameBufferRenderable {
  onFrameResize: (() => void) | undefined

  constructor(ctx: RenderContext, options: FrameBufferOptions) {
    super(ctx, options)
  }

  protected override onResize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return
    if (width === this.frameBuffer.width && height === this.frameBuffer.height) return
    super.onResize(width, height)
    this.onFrameResize?.()
  }
}

/** The object handed to `paint` handlers and `draw(fn)` callbacks. */
export interface QmlPainter {
  readonly width: number
  readonly height: number
  readonly buffer: OptimizedBuffer
  drawText(text: unknown, x: number, y: number, fg?: unknown, bg?: unknown, attributes?: number): void
  setCell(x: number, y: number, char: unknown, fg?: unknown, bg?: unknown, attributes?: number): void
  fillRect(x: number, y: number, width: number, height: number, color?: unknown): void
  clear(color?: unknown): void
  drawBox(options: Record<string, unknown>): void
}

function makePainter(fb: FrameBufferRenderable, onDraw: () => void): QmlPainter {
  const buf = (): OptimizedBuffer => fb.frameBuffer
  return {
    get width() {
      return buf().width
    },
    get height() {
      return buf().height
    },
    get buffer() {
      return buf()
    },
    drawText(text, x, y, fg, bg, attributes) {
      buf().drawText(String(text ?? ""), x | 0, y | 0, rgba(fg, "#ffffff"), bg === undefined ? undefined : rgba(bg, "transparent"), attributes ?? 0)
      onDraw()
    },
    setCell(x, y, char, fg, bg, attributes) {
      buf().setCell(x | 0, y | 0, String(char ?? " ") || " ", rgba(fg, "#ffffff"), rgba(bg, "transparent"), attributes ?? 0)
      onDraw()
    },
    fillRect(x, y, width, height, color) {
      buf().fillRect(x | 0, y | 0, width | 0, height | 0, rgba(color, "transparent"))
      onDraw()
    },
    clear(color) {
      buf().clear(rgba(color, "transparent"))
      onDraw()
    },
    drawBox(o) {
      const border = o.border === undefined ? true : o.border
      buf().drawBox({
        x: Number(o.x ?? 0) | 0,
        y: Number(o.y ?? 0) | 0,
        width: Number(o.width ?? buf().width) | 0,
        height: Number(o.height ?? buf().height) | 0,
        border: border as boolean,
        borderColor: rgba(o.borderColor, "#ffffff"),
        backgroundColor: rgba(o.backgroundColor, "transparent"),
        ...(o.borderStyle !== undefined ? { borderStyle: o.borderStyle as "single" } : {}),
        ...(o.shouldFill !== undefined ? { shouldFill: !!o.shouldFill } : {}),
        ...(o.title !== undefined ? { title: String(o.title) } : {}),
        ...(o.titleColor !== undefined ? { titleColor: rgba(o.titleColor, "#ffffff") } : {}),
        ...(o.titleAlignment !== undefined ? { titleAlignment: o.titleAlignment as "left" } : {}),
      })
      onDraw()
    },
  }
}

export class FrameBuffer extends Item {
  declare readonly renderable: QmlFrameBufferRenderable
  readonly painter: QmlPainter

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    const r = this.renderable
    this.painter = makePainter(r, () => {
      if (!r.isDestroyed) r.requestRender()
    })
    this.defineProperty("respectAlpha", {
      type: "bool",
      value: false,
      onChange: (v) => {
        if (r.isDestroyed) return
        r.frameBuffer.setRespectAlpha(!!v)
        r.requestRender()
      },
    })
    this.defineSignal("paint", ["painter"])
    this.defineMethod("requestPaint", () => this.repaint())
    this.defineMethod("draw", (fn: unknown) => {
      if (typeof fn !== "function" || r.isDestroyed) return
      try {
        fn(this.painter)
      } catch (err) {
        this.engine.reportError(err, `${this.describe()}: draw`)
      }
    })
    this.defineMethod("clear", (color?: unknown) => {
      if (!r.isDestroyed) this.painter.clear(color)
    })
    r.onFrameResize = () => {
      if (this.isCompleted) this.repaint()
    }
  }

  private repaint(): void {
    const r = this.renderable
    if (r.isDestroyed || this.isDestroyed) return
    r.frameBuffer.clear(parseColor("transparent"))
    this.emit("paint", this.painter)
    r.requestRender()
  }

  protected override onCompleted(): void {
    super.onCompleted()
    this.repaint()
  }

  protected override createRenderable(engine: QmlEngine, typeName: string): Renderable {
    return new QmlFrameBufferRenderable(engine.renderer, { id: nextRenderableId(typeName), width: 1, height: 1 })
  }

  protected override get acceptsVisualChildren(): boolean {
    return false
  }
}

// -----------------------------------------------------------------------------------------------
// Image

const URL_RE = /^[a-z][a-z0-9+.-]*:/i

export class Image extends Item {
  declare readonly renderable: ImageRenderable
  private loadToken = 0

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    const r = this.renderable
    this.defineProperty("source", { type: "var", onChange: (v) => this.applySource(v) })
    this.passthrough("fit", { type: "string", value: "fit" })
    this.passthrough("protocol", { type: "string", value: "auto" })
    this.defineProperty("loading", { type: "bool", readonly: true, value: false })
    this.defineProperty("status", { type: "string", readonly: true, value: "null" })
    this.defineSignal("loaded")
    this.defineSignal("error", ["message"])
    r.onLoad = () => {
      if (this.isDestroyed) return
      this.write("loading", false)
      this.write("status", "ready")
      this.emit("loaded")
    }
    r.onError = (err) => {
      if (this.isDestroyed) return
      this.write("loading", false)
      this.write("status", "error")
      this.emit("error", err instanceof Error ? err.message : String(err))
    }
  }

  private sourceDirectory(): string | undefined {
    const file = this.engine.sourceFileOf(this)
    return file ? dirname(file) : undefined
  }

  private applySource(v: unknown): void {
    const r = this.renderable
    if (r.isDestroyed) return
    let src = v
    if (typeof src === "string") {
      if (src.startsWith("file://")) src = new URL(src).pathname
      else if (!URL_RE.test(src) && !isAbsolute(src)) src = resolve(this.sourceDirectory() ?? this.engine.basePath ?? ".", src)
    }
    const empty = src === undefined || src === null || src === ""
    r.source = empty ? undefined : (src as ImageRenderable["source"])
    this.write("loading", !empty && r.loading)
    this.write("status", empty ? "null" : r.loading ? "loading" : r.loadError ? "error" : r.image ? "ready" : "loading")
    // Swallow the renderable's own promise rejection: errors are reported through `error`.
    const token = ++this.loadToken
    r.loadPromise?.catch(() => {}).finally(() => {
      if (token === this.loadToken && !this.isDestroyed && this.peek("loading") && !r.loading) this.write("loading", false)
    })
  }

  protected override createRenderable(engine: QmlEngine, typeName: string): Renderable {
    return new ImageRenderable(engine.renderer, { id: nextRenderableId(typeName) })
  }

  protected override get acceptsVisualChildren(): boolean {
    return false
  }
}

// -----------------------------------------------------------------------------------------------
// EmbeddedTerminal

type Proc = ReturnType<typeof Bun.spawn>

export class EmbeddedTerminal extends Item {
  declare readonly renderable: EmbeddedTerminalRenderable
  private proc: Proc | undefined
  private cols = 80
  private rows = 24
  private readonly decoder = new TextDecoder()

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    const r = this.renderable
    this.defineProperty("command", { type: "var" })
    this.defineProperty("args", { type: "var" })
    this.defineProperty("cwd", { type: "string" })
    this.defineProperty("env", { type: "var" })
    this.defineProperty("autoStart", { type: "bool", value: true })
    this.defineProperty("running", { type: "bool", readonly: true, value: false })
    this.defineProperty("pid", { type: "int", readonly: true, value: 0 })
    this.defineProperty("exitCode", { type: "var", readonly: true })
    this.passthrough("transparentBackground", { type: "bool" })
    this.passthrough("selectable", { type: "bool" })
    this.defineSignal("exited", ["code"])
    this.defineSignal("screenChanged")
    this.defineSignal("input", ["data"])
    this.defineMethod("write", (data: unknown) => {
      if (!r.isDestroyed) r.write(data instanceof Uint8Array ? data : String(data ?? ""))
    })
    this.defineMethod("send", (data: unknown) => this.send(data instanceof Uint8Array ? data : String(data ?? "")))
    this.defineMethod("start", () => this.start())
    this.defineMethod("kill", (signal?: number | string) => this.proc?.kill(signal as number))
    this.defineMethod("screen", () => (r.isDestroyed ? null : r.screen()))
    this.defineMethod("screenText", () => (r.isDestroyed ? "" : r.screen().text))
    this.defineMethod("selectedText", () => (r.isDestroyed ? "" : r.getSelectedText()))
    r.onData = (data) => {
      if (this.isDestroyed) return
      this.send(data)
      this.emit("input", this.decoder.decode(data))
    }
    r.onTerminalResize = (cols, rows) => {
      this.cols = cols
      this.rows = rows
      try {
        this.proc?.terminal?.resize(cols, rows)
      } catch {
        // PTY already closed
      }
    }
    r.onScreenChange = () => {
      if (!this.isDestroyed) this.emit("screenChanged")
    }
  }

  private send(data: string | Uint8Array): void {
    const t = this.proc?.terminal
    if (!t || t.closed) return
    try {
      t.write(data)
    } catch (err) {
      this.engine.reportError(err, `${this.describe()}: send`)
    }
  }

  /** Spawn `command` (+ `args`) in a PTY. No-op while running or without a command. */
  start(): boolean {
    if (this.proc || this.isDestroyed) return false
    const cmdV = this.peek("command")
    const argsV = this.peek("args")
    const cmd = [
      ...(Array.isArray(cmdV) ? cmdV.map(String) : cmdV ? [String(cmdV)] : []),
      ...(Array.isArray(argsV) ? argsV.map(String) : []),
    ]
    if (cmd.length === 0) return false
    const r = this.renderable
    const cwd = this.peek("cwd") as string | undefined
    const envV = this.peek("env")
    try {
      const proc = Bun.spawn(cmd, {
        ...(cwd ? { cwd } : {}),
        ...(envV && typeof envV === "object" ? { env: { ...process.env, ...(envV as Record<string, string>) } } : {}),
        terminal: {
          cols: this.cols,
          rows: this.rows,
          data: (_t, d) => {
            if (!r.isDestroyed) r.write(d)
          },
        },
      })
      this.proc = proc
      this.write("running", true)
      this.write("pid", proc.pid)
      this.write("exitCode", undefined)
      void proc.exited.then((code) => {
        if (this.proc === proc) this.proc = undefined
        if (this.isDestroyed) return
        this.write("running", false)
        this.write("exitCode", code)
        this.emit("exited", code)
      })
      return true
    } catch (err) {
      this.engine.reportError(err, `${this.describe()}: start`)
      return false
    }
  }

  protected override onCompleted(): void {
    super.onCompleted()
    if (this.peek("autoStart") && this.peek("command")) this.start()
  }

  override destroy(): void {
    if (this.isDestroyed || this.isDestroying) return
    const proc = this.proc
    this.proc = undefined
    if (proc) {
      try {
        proc.kill()
        proc.terminal?.close()
      } catch {
        // already gone
      }
    }
    super.destroy()
  }

  protected override createRenderable(engine: QmlEngine, typeName: string): Renderable {
    return new EmbeddedTerminalRenderable(engine.renderer, { id: nextRenderableId(typeName), cols: 80, rows: 24 })
  }

  protected override get acceptsVisualChildren(): boolean {
    return false
  }
}
