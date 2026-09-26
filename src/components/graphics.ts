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
 * - `EmbeddedTerminal` / `Terminal` (EmbeddedTerminalRenderable inside a box): a VT screen.
 *   Emulator options `cols`, `rows` (initial size; the emulator follows the layout size),
 *   `maxScrollback` (bytes), `transparentBackground`, `selectable`. With `command` (string or
 *   array) + `args`, `cwd`, `env`, `term` (TERM, default xterm-256color) it spawns the program
 *   in a PTY on completion (unless `autoStart: false`); `shell: true` or no command runs
 *   `$SHELL`. Read-only `running`, `pid`, `exitCode`, `exitSignal`, `attached`. `hostKeys`
 *   (default `["escape"]`) lists the keys that stay with QML while the terminal is focused;
 *   every other key goes to the program (`context: "application"` shortcuts still win).
 *   Signals `started(pid)`, `exited(code, signal)`, `screenChanged()`, `input(text, source)` /
 *   `rawInput(bytes, source)` (what the widget sends to the program; source "input" for keys,
 *   mouse and paste, "response" for terminal query replies), `terminalResized(cols, rows)`.
 *   Methods `write(data)` (to the screen), `send(data)` (to the program), `start()`,
 *   `restart()`, `kill(signal?)`, `attach(child)` / `detach()` (drive a process you own:
 *   `child.write(bytes)` gets the input, `child.resize(cols, rows)` the size, and you feed its
 *   output to `write()`; a Bun subprocess with a `terminal` can be attached directly),
 *   `clear()`, `invalidate()`, `screenText()`, `lines()`, `cursor()`, `screen()`,
 *   `selectedText()`, `hasSelection()`.
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
import { eventStroke, parseStrokeId, setFocusKeyClaim, strokeId } from "./key-dispatcher.ts"
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

/** What `attach()` accepts: something that consumes input bytes and (optionally) resizes. */
export interface TerminalChild {
  write(data: Uint8Array): unknown
  resize?(cols: number, rows: number): unknown
}

/** A Bun subprocess spawned with a `terminal` option (`proc.terminal` is the PTY). */
interface PtyProcess {
  terminal?: { write(data: string | Uint8Array): unknown; resize(cols: number, rows: number): unknown; closed?: boolean } | null
  exited?: Promise<number>
}

const DEFAULT_HOST_KEYS = ["escape"]

/**
 * `EmbeddedTerminal` / `Terminal`: an `EmbeddedTerminalRenderable` (a VT emulator, not a PTY)
 * hosted inside a plain box so the emulator options that are fixed at construction (`cols`,
 * `rows`, `maxScrollback`) can be QML properties. The emulator is created on completion and
 * follows the item's layout size from then on.
 */
export class EmbeddedTerminal extends Item {
  /** The emulator; created in `onCompleted` (writes before that are queued). */
  private vt: EmbeddedTerminalRenderable | undefined
  private proc: Proc | undefined
  private child: TerminalChild | undefined
  private cols = 80
  private rows = 24
  private pendingWrites: (string | Uint8Array)[] = []
  private pendingFocus = false
  private hostKeys = new Set<string>(DEFAULT_HOST_KEYS.map(parseStrokeId))
  private readonly decoder = new TextDecoder()
  private readonly encoder = new TextEncoder()

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    // Emulator (construction-time) options.
    this.defineProperty("cols", { type: "int", value: 80, onChange: (v) => (this.cols = Math.max(1, Number(v) || 80)) })
    this.defineProperty("rows", { type: "int", value: 24, onChange: (v) => (this.rows = Math.max(1, Number(v) || 24)) })
    this.defineProperty("maxScrollback", { type: "int", value: 10000 })
    this.defineProperty("transparentBackground", {
      type: "bool",
      value: false,
      onChange: (v) => {
        if (this.vt && !this.vt.isDestroyed) this.vt.transparentBackground = !!v
      },
    })
    this.defineProperty("selectable", {
      type: "bool",
      value: true,
      onChange: (v) => {
        if (this.vt && !this.vt.isDestroyed) this.vt.selectable = !!v
      },
    })
    // Process options.
    this.defineProperty("command", { type: "var" })
    this.defineProperty("args", { type: "var" })
    this.defineProperty("shell", { type: "bool", value: false })
    this.defineProperty("cwd", { type: "string" })
    this.defineProperty("env", { type: "var" })
    this.defineProperty("term", { type: "string", value: "xterm-256color" })
    this.defineProperty("autoStart", { type: "bool", value: true })
    this.defineProperty("running", { type: "bool", readonly: true, value: false })
    this.defineProperty("pid", { type: "int", readonly: true, value: 0 })
    this.defineProperty("exitCode", { type: "var", readonly: true })
    this.defineProperty("exitSignal", { type: "var", readonly: true })
    this.defineProperty("attached", { type: "bool", readonly: true, value: false })
    // Keys that stay with the QML host (Shortcut / Keys handlers) while the terminal is focused.
    this.defineProperty("hostKeys", {
      type: "var",
      value: [...DEFAULT_HOST_KEYS],
      onChange: (v) => {
        const list = Array.isArray(v) ? v : v == null || v === "" ? [] : [v]
        this.hostKeys = new Set(list.map((k) => parseStrokeId(String(k))))
      },
    })

    this.defineSignal("started", ["pid"])
    this.defineSignal("exited", ["code", "signal"])
    this.defineSignal("screenChanged")
    this.defineSignal("input", ["text", "source"])
    this.defineSignal("rawInput", ["data", "source"])
    this.defineSignal("terminalResized", ["cols", "rows"])

    this.defineMethod("write", (data: unknown) => this.writeScreen(data))
    this.defineMethod("send", (data: unknown) => this.send(toBytes(data, this.encoder), "input"))
    this.defineMethod("start", () => this.start())
    this.defineMethod("restart", () => this.restart())
    this.defineMethod("kill", (signal?: number | string) => this.kill(signal))
    this.defineMethod("attach", (child: unknown) => this.attach(child as TerminalChild | PtyProcess))
    this.defineMethod("detach", () => this.detach())
    this.defineMethod("clear", () => this.writeScreen("\x1b[H\x1b[2J\x1b[3J"))
    this.defineMethod("invalidate", () => this.vt?.invalidate())
    this.defineMethod("screen", () => this.screen())
    this.defineMethod("screenText", () => this.screen()?.text ?? "")
    this.defineMethod("lines", () => this.screen()?.lines ?? [])
    this.defineMethod("cursor", () => this.screen()?.cursor ?? { x: 0, y: 0, visible: false })
    this.defineMethod("selectedText", () => (this.vt && !this.vt.isDestroyed ? this.vt.getSelectedText() : ""))
    this.defineMethod("hasSelection", () => !!this.vt && !this.vt.isDestroyed && this.vt.hasSelection())

    // `enabled: false` blurs the emulator (the Item version only knows the box).
    this.watch(() => {
      if (!this.get("enabled") && this.vt?.focused) this.vt.blur()
    })
  }

  /** The emulator renderable (undefined before completion / after destroy). */
  get terminal(): EmbeddedTerminalRenderable | undefined {
    return this.vt
  }

  // --- emulator ---------------------------------------------------------------------------------

  private createTerminal(): void {
    if (this.vt || this.isDestroyed) return
    const r = this.renderable
    const term = new EmbeddedTerminalRenderable(this.engine.renderer, {
      id: `${r.id}.vt`,
      cols: this.cols,
      rows: this.rows,
      maxScrollback: Math.max(0, Number(this.peek("maxScrollback")) || 0),
      transparentBackground: !!this.peek("transparentBackground"),
      selectable: !!this.peek("selectable"),
      width: "100%",
      height: "100%",
      flexGrow: 1,
      flexShrink: 1,
      onData: (data, source) => {
        if (this.isDestroyed) return
        this.send(data, source)
        this.emit("rawInput", data, source)
        this.emit("input", this.decoder.decode(data), source)
      },
      onTerminalResize: (cols, rows) => {
        this.cols = cols
        this.rows = rows
        this.resizeChild(cols, rows)
        if (!this.isDestroyed) this.emit("terminalResized", cols, rows)
      },
      onScreenChange: () => {
        if (!this.isDestroyed) this.emit("screenChanged")
      },
    })
    this.vt = term
    term.on("focused", () => this.syncFocus(true))
    term.on("blurred", () => this.syncFocus(false))
    setFocusKeyClaim(term, {
      claims: (event) => !this.hostKeys.has(strokeId(eventStroke(event))),
      claimsStroke: (stroke) => !this.hostKeys.has(strokeId(stroke)),
    })
    r.add(term)
    for (const data of this.pendingWrites) term.write(data)
    this.pendingWrites = []
    if (this.pendingFocus) {
      this.pendingFocus = false
      term.focus()
    }
  }

  private writeScreen(data: unknown): void {
    if (this.isDestroyed) return
    const bytes = data instanceof Uint8Array ? data : String(data ?? "")
    if (this.vt && !this.vt.isDestroyed) this.vt.write(bytes)
    else this.pendingWrites.push(bytes)
  }

  private screen(): ReturnType<EmbeddedTerminalRenderable["screen"]> | null {
    return this.vt && !this.vt.isDestroyed ? this.vt.screen() : null
  }

  protected override applyFocus(v: boolean): void {
    if (this.isDestroyed) return
    const term = this.vt
    if (!term || term.isDestroyed) {
      this.pendingFocus = v
      return
    }
    if (v) {
      if (!this.peek("enabled") || term.focused) return
      term.focusable = true
      term.focus()
    } else if (term.focused) {
      term.blur()
    }
  }

  // --- input / output plumbing ------------------------------------------------------------------

  /** Bytes the emulator (or `send()`) produces go to the PTY and to the attached child. */
  private send(data: Uint8Array, _source: "input" | "response"): void {
    const t = this.proc?.terminal
    if (t && !t.closed) {
      try {
        t.write(data)
      } catch (err) {
        this.engine.reportError(err, `${this.describe()}: send`)
      }
    }
    if (this.child) {
      try {
        this.child.write(data)
      } catch (err) {
        this.engine.reportError(err, `${this.describe()}: attached child write`)
      }
    }
  }

  private resizeChild(cols: number, rows: number): void {
    try {
      this.proc?.terminal?.resize(cols, rows)
    } catch {
      // PTY already closed
    }
    try {
      this.child?.resize?.(cols, rows)
    } catch (err) {
      this.engine.reportError(err, `${this.describe()}: attached child resize`)
    }
  }

  /**
   * Route the emulator's input bytes to `child.write(bytes)` and resizes to
   * `child.resize(cols, rows)`; the caller feeds the child's output to `write()`. A Bun
   * subprocess spawned with a `terminal` can be passed directly (its PTY is used, and it is
   * detached when it exits). Returns a disposer; `detach()` does the same.
   */
  attach(child: TerminalChild | PtyProcess): () => void {
    this.detach()
    let target: TerminalChild
    const pty = (child as PtyProcess).terminal
    if (pty && typeof pty.write === "function") {
      target = { write: (d) => pty.write(d), resize: (c, r) => pty.resize(c, r) }
      const exited = (child as PtyProcess).exited
      if (exited && typeof exited.then === "function") {
        void exited.then(() => {
          if (this.child === target) this.detach()
        })
      }
    } else if (child && typeof (child as TerminalChild).write === "function") {
      target = child as TerminalChild
    } else {
      throw new TypeError(`${this.describe()}: attach() needs an object with write(bytes)`)
    }
    this.child = target
    this.write("attached", true)
    target.resize?.(this.cols, this.rows)
    return () => {
      if (this.child === target) this.detach()
    }
  }

  detach(): void {
    if (!this.child) return
    this.child = undefined
    if (!this.isDestroyed) this.write("attached", false)
  }

  // --- process ----------------------------------------------------------------------------------

  private commandLine(): string[] {
    const cmdV = this.peek("command")
    const argsV = this.peek("args")
    const cmd = [
      ...(Array.isArray(cmdV) ? cmdV.map(String) : cmdV ? [String(cmdV)] : []),
      ...(Array.isArray(argsV) ? argsV.map(String) : []),
    ]
    if (cmd.length === 0 || this.peek("shell")) {
      const sh = process.env.SHELL || "/bin/sh"
      // `shell: true` with a command runs it through the shell; without one, an interactive shell.
      return cmd.length === 0 ? [sh] : [sh, "-c", cmd.join(" ")]
    }
    return cmd
  }

  /**
   * Spawn `command` (+ `args`) in a PTY; with no command (or `shell: true`) `$SHELL` / `/bin/sh`
   * is used. No-op while running. Returns true when a process was started.
   */
  start(): boolean {
    if (this.proc || this.isDestroyed) return false
    const cmd = this.commandLine()
    const cwd = this.peek("cwd") as string | undefined
    const envV = this.peek("env")
    const termName = String(this.peek("term") || "xterm-256color")
    const env: Record<string, string | undefined> = {
      ...process.env,
      TERM: termName,
      COLORTERM: "truecolor",
      ...(envV && typeof envV === "object" ? (envV as Record<string, string>) : {}),
    }
    try {
      const proc = Bun.spawn(cmd, {
        ...(cwd ? { cwd } : {}),
        env,
        terminal: {
          cols: this.cols,
          rows: this.rows,
          name: termName,
          data: (_t, d) => this.writeScreen(d),
        },
      })
      this.proc = proc
      this.write("running", true)
      this.write("pid", proc.pid)
      this.write("exitCode", undefined)
      this.write("exitSignal", undefined)
      this.emit("started", proc.pid)
      void proc.exited.then(
        (code) => this.onExit(proc, code, proc.signalCode ?? null),
        (err) => {
          this.engine.reportError(err, `${this.describe()}: process`)
          this.onExit(proc, -1, null)
        },
      )
      return true
    } catch (err) {
      this.engine.reportError(err, `${this.describe()}: start`)
      return false
    }
  }

  private onExit(proc: Proc, code: number, signal: string | null): void {
    if (this.proc === proc) this.proc = undefined
    try {
      proc.terminal?.close()
    } catch {
      // already closed
    }
    if (this.isDestroyed) return
    this.write("running", false)
    this.write("exitCode", code)
    this.write("exitSignal", signal)
    this.emit("exited", code, signal)
  }

  /** Send `signal` (a number or name such as `"SIGTERM"`) to the process. False when not running. */
  kill(signal?: number | string): boolean {
    const proc = this.proc
    if (!proc) return false
    try {
      proc.kill(signal as number)
      return true
    } catch (err) {
      this.engine.reportError(err, `${this.describe()}: kill`)
      return false
    }
  }

  /** Kill the running process (if any), clear the screen and start again. Resolves when started. */
  async restart(): Promise<boolean> {
    const proc = this.proc
    if (proc) {
      this.kill()
      try {
        await proc.exited
      } catch {
        // reported by start()'s handler
      }
    }
    if (this.isDestroyed) return false
    this.writeScreen("\x1b[H\x1b[2J\x1b[3J")
    return this.start()
  }

  // --- lifecycle --------------------------------------------------------------------------------

  protected override onCompleted(): void {
    this.createTerminal()
    super.onCompleted()
    if (this.peek("autoStart") && (this.peek("command") || this.peek("shell"))) this.start()
  }

  override destroy(): void {
    if (this.isDestroyed || this.isDestroying) return
    const proc = this.proc
    this.proc = undefined
    this.child = undefined
    if (proc) {
      try {
        proc.kill()
        proc.terminal?.close()
      } catch {
        // already gone
      }
    }
    const term = this.vt
    if (term) {
      setFocusKeyClaim(term, null)
      if (term.focused) term.blur()
    }
    super.destroy()
  }

  protected override get acceptsVisualChildren(): boolean {
    return false
  }
}

function toBytes(data: unknown, encoder: TextEncoder): Uint8Array {
  return data instanceof Uint8Array ? data : encoder.encode(String(data ?? ""))
}
