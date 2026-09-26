/**
 * Data / control widgets backed by OpenTUI renderables:
 *
 * - `Diff` (DiffRenderable): `text` (aliases `content`, `diff`: a unified diff), `view`
 *   ("unified" | "split"), `filetype`, `syncScroll`, `wrapMode`, `conceal`, `showLineNumbers`,
 *   `color` (fg), `selectionBg`/`selectionFg`, `lineNumberFg`/`lineNumberBg`, `addedBg`,
 *   `removedBg`, `contextBg`, `addedContentBg`, `removedContentBg`, `contextContentBg`,
 *   `addedSignColor`, `removedSignColor`, `addedLineNumberBg`, `removedLineNumberBg`; methods
 *   `highlightLines(start, end, color)`, `clearHighlightLines(start, end)`,
 *   `setLineColor(line, color)`, `clearLineColor(line)`, `clearAllLineColors()`.
 * - `LineNumbers` / `LineNumber` (LineNumberRenderable): a gutter around its first `Code` or
 *   `TextArea` child. `color` (fg), `backgroundColor` (bg), `showLineNumbers`,
 *   `lineNumberOffset`; methods `highlightLines`, `clearHighlightLines`, `setLineColor`,
 *   `clearLineColor`, `clearAllLineColors`, `setLineSign(line, { before, beforeColor, after,
 *   afterColor })`, `clearLineSign(line)`, `clearAllLineSigns()`.
 * - `TextTable` (TextTableRenderable): `content` (rows → cells; a cell is a string, number,
 *   StyledText, TextChunk[] or null), or `rows: string[][]`, or `model` (array / ListModel of
 *   arrays, or of objects read through `columns: ["name", ...]`); optional `headers: [...]`
 *   (bold first row). `wrapMode`, `columnWidthMode` ("content" | "full"), `columnFitter`
 *   ("proportional" | "balanced"), `cellPadding`, `cellPaddingX`, `cellPaddingY`, `columnGap`,
 *   `showBorders`, `border`, `outerBorder`, `borderStyle`, `borderColor`, `color` (fg),
 *   `selectable`; read-only `rowCount`; methods `selectedText()`, `hasSelection()`.
 * - `Slider` (SliderRenderable): `orientation` ("horizontal" | "vertical", also
 *   `Qt.Horizontal`/`Qt.Vertical`), `value` (two-way), `from`/`min`, `to`/`max`,
 *   `viewPortSize`, `backgroundColor` (track), `foregroundColor` (thumb); signal `moved(value)`
 *   (user drags only) besides `valueChanged`.
 * - `ScrollBar` (ScrollBarRenderable): `orientation`, `position` (two-way; alias `value`),
 *   `scrollSize`, `viewportSize`, `showArrows`, `scrollStep`, `trackColor`, `thumbColor`,
 *   `arrowColor`; signal `scrolled(position)`; method `scrollBy(delta, unit?)` (unit:
 *   "absolute" | "viewport" | "content" | "step").
 */
import {
  DiffRenderable,
  LineNumberRenderable,
  ScrollBarRenderable,
  SliderRenderable,
  StyledText,
  SyntaxStyle,
  TextAttributes,
  TextTableRenderable,
  type Renderable,
  type TextChunk,
  type TextTableContent,
} from "@opentui/core"
import type { QmlEngine } from "../runtime/engine.ts"
import type { QmlObject } from "../runtime/object.ts"
import { resolveModel } from "../runtime/builtins.ts"
import { untrack } from "../runtime/reactive.ts"
import { Item, isVisual, nextRenderableId, toColor } from "./visual.ts"
import { TEXT_STATICS, toWrapMode } from "./text.ts"

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v)
}

/** `text` plus aliases, all naming the same string value. */
function defineTextContent(item: Item, aliases: string[], apply: (v: string) => void): void {
  item.defineProperty("text", { type: "string", onChange: (v) => apply(str(v)) })
  for (const a of aliases) item.defineAlias(a, item, "text")
}

/** `highlightLines` & co. shared by Diff and LineNumbers (same method names in OpenTUI). */
function defineLineColorMethods(item: Item, target: () => any): void {
  const color = (c: unknown): unknown =>
    c !== null && typeof c === "object" && !("buffer" in (c as object)) && ("gutter" in (c as object) || "content" in (c as object))
      ? { gutter: toColor((c as any).gutter), content: toColor((c as any).content) }
      : toColor(c)
  item.defineMethod("highlightLines", (start: number, end: number, c: unknown) => target().highlightLines(start, end, color(c)))
  item.defineMethod("clearHighlightLines", (start: number, end: number) => target().clearHighlightLines(start, end))
  item.defineMethod("setLineColor", (line: number, c: unknown) => target().setLineColor(line, color(c)))
  item.defineMethod("clearLineColor", (line: number) => target().clearLineColor(line))
  item.defineMethod("clearAllLineColors", () => target().clearAllLineColors())
}

// -----------------------------------------------------------------------------------------------
// Diff

const DIFF_COLORS = [
  "selectionBg",
  "selectionFg",
  "lineNumberFg",
  "lineNumberBg",
  "addedBg",
  "removedBg",
  "contextBg",
  "addedContentBg",
  "removedContentBg",
  "contextContentBg",
  "addedSignColor",
  "removedSignColor",
  "addedLineNumberBg",
  "removedLineNumberBg",
]

export class Diff extends Item {
  declare readonly renderable: DiffRenderable
  static qmlStatics = TEXT_STATICS

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    defineTextContent(this, ["content", "diff"], (v) => (this.renderable.diff = v))
    this.passthrough("view", { type: "string", value: "unified" })
    this.passthrough("syncScroll", { type: "bool" })
    this.passthrough("filetype", { type: "string" })
    this.passthrough("wrapMode", { type: "var", map: toWrapMode })
    this.passthrough("conceal", { type: "bool" })
    this.passthrough("showLineNumbers", { type: "bool" })
    this.passthrough("color", { color: true, target: "fg" })
    for (const name of DIFF_COLORS) this.passthrough(name, { color: true })
    defineLineColorMethods(this, () => this.renderable)
  }

  protected override createRenderable(engine: QmlEngine, typeName: string): Renderable {
    return new DiffRenderable(engine.renderer, {
      id: nextRenderableId(typeName),
      diff: "",
      syntaxStyle: SyntaxStyle.create(),
    })
  }

  protected override get acceptsVisualChildren(): boolean {
    return false
  }
}

// -----------------------------------------------------------------------------------------------
// LineNumbers

export class LineNumbers extends Item {
  declare readonly renderable: LineNumberRenderable

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    const r = this.renderable
    this.passthrough("color", { color: true, target: "fg" })
    this.passthrough("backgroundColor", { color: true, target: "bg" })
    this.passthrough("showLineNumbers", { type: "bool" })
    this.passthrough("lineNumberOffset", { type: "int" })
    defineLineColorMethods(this, () => r)
    this.defineMethod("setLineSign", (line: number, sign: Record<string, unknown>) =>
      r.setLineSign(line, {
        ...(sign?.before !== undefined ? { before: str(sign.before) } : {}),
        ...(sign?.after !== undefined ? { after: str(sign.after) } : {}),
        ...(sign?.beforeColor !== undefined ? { beforeColor: toColor(sign.beforeColor) as string } : {}),
        ...(sign?.afterColor !== undefined ? { afterColor: toColor(sign.afterColor) as string } : {}),
      }),
    )
    this.defineMethod("clearLineSign", (line: number) => r.clearLineSign(line))
    this.defineMethod("clearAllLineSigns", () => r.clearAllLineSigns())
  }

  protected override createRenderable(engine: QmlEngine, typeName: string): Renderable {
    return new LineNumberRenderable(engine.renderer, { id: nextRenderableId(typeName) })
  }

  protected override onChildAdded(child: QmlObject, index: number): void {
    super.onChildAdded(child, index)
    if (isVisual(child) && child.renderable.parent !== this.renderable) {
      this.engine.warn(`${this.describe()}: only a Code or TextArea child gets line numbers (${child.describe()} is not shown)`)
    }
  }

  override detachChildRenderable(child: Renderable): void {
    const r = this.renderable
    if ((r as unknown as { target?: Renderable | null }).target === child) r.clearTarget()
    else if (child.parent) child.parent.remove(child)
  }
}

// -----------------------------------------------------------------------------------------------
// TextTable

function toCell(v: unknown, attributes = 0): TextChunk[] | null {
  if (v === null || v === undefined) return null
  if (v instanceof StyledText) return attributes ? v.chunks.map((c) => ({ ...c, attributes: (c.attributes ?? 0) | attributes })) : v.chunks
  if (typeof v === "object" && Array.isArray((v as StyledText).chunks)) return toCell(new StyledText((v as StyledText).chunks), attributes)
  if (Array.isArray(v) && v.every((c) => c && typeof c === "object" && (c as TextChunk).__isChunk)) return v as TextChunk[]
  const chunk: TextChunk = { __isChunk: true, text: String(v) }
  if (attributes) chunk.attributes = attributes
  return [chunk]
}

function toRow(v: unknown, columns: string[] | null): unknown[] {
  if (Array.isArray(v)) return v
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>
    return (columns ?? Object.keys(o)).map((c) => o[c])
  }
  return [v]
}

export class TextTable extends Item {
  declare readonly renderable: TextTableRenderable
  static qmlStatics = TEXT_STATICS

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    const r = this.renderable
    this.defineProperty("content", { type: "var" })
    this.defineProperty("rows", { type: "var" })
    this.defineProperty("model", { type: "var" })
    this.defineProperty("columns", { type: "var" })
    this.defineProperty("headers", { type: "var" })
    this.defineProperty("rowCount", { type: "int", readonly: true, value: 0 })
    this.passthrough("wrapMode", { type: "var", map: toWrapMode })
    this.passthrough("columnWidthMode", { type: "string" })
    this.passthrough("columnFitter", { type: "string" })
    this.passthrough("cellPadding", { type: "int" })
    this.passthrough("cellPaddingX", { type: "int" })
    this.passthrough("cellPaddingY", { type: "int" })
    this.passthrough("showBorders", { type: "bool" })
    this.passthrough("border", { type: "bool" })
    this.passthrough("outerBorder", { type: "bool" })
    this.passthrough("borderStyle", { type: "string" })
    this.passthrough("borderColor", { color: true })
    this.passthrough("color", { color: true, target: "fg" })
    this.passthrough("selectable", { type: "bool" })
    this.defineMethod("selectedText", () => (r.isDestroyed ? "" : r.getSelectedText()))
    this.defineMethod("hasSelection", () => !r.isDestroyed && r.hasSelection())

    this.watch(() => {
      const content = this.buildContent()
      untrack(() => {
        if (r.isDestroyed) return
        r.content = content
        this.write("rowCount", content.length)
      })
    })
  }

  /** Tracked: rows from `content`, else `model` (+ `columns`), else `rows`; `headers` first. */
  private buildContent(): TextTableContent {
    const columnsV = this.get("columns")
    const columns = Array.isArray(columnsV) ? columnsV.map(String) : null
    let source: unknown[] = []
    const content = this.get("content")
    const model = this.get("model")
    const rows = this.get("rows")
    if (Array.isArray(content) && content.length > 0) source = content
    else if (model !== undefined && model !== null) source = resolveModel(model).map((e) => e.modelData)
    else if (Array.isArray(rows)) source = rows
    const out: TextTableContent = source.map((row) => toRow(row, columns).map((cell) => toCell(cell)))
    const headers = this.get("headers")
    if (Array.isArray(headers) && headers.length > 0) out.unshift(headers.map((h) => toCell(h, TextAttributes.BOLD)))
    return out
  }

  protected override createRenderable(engine: QmlEngine, typeName: string): Renderable {
    return new TextTableRenderable(engine.renderer, { id: nextRenderableId(typeName), content: [] })
  }

  protected override get acceptsVisualChildren(): boolean {
    return false
  }
}

// -----------------------------------------------------------------------------------------------
// Slider / ScrollBar

export const ORIENTATION_STATICS = { Horizontal: "horizontal", Vertical: "vertical" }

function toOrientation(v: unknown, fallback: "horizontal" | "vertical"): "horizontal" | "vertical" {
  const s = String(v ?? "").toLowerCase()
  if (s === "vertical" || s === "2") return "vertical"
  if (s === "horizontal" || s === "1") return "horizontal"
  return fallback
}

export class Slider extends Item {
  declare readonly renderable: SliderRenderable
  static qmlStatics = ORIENTATION_STATICS
  private pushing = false

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    const r = this.renderable
    this.defineProperty("orientation", {
      type: "string",
      value: "horizontal",
      onChange: (v) => {
        ;(r as { orientation: string }).orientation = toOrientation(v, "horizontal")
        r.requestRender()
      },
    })
    this.defineProperty("value", {
      type: "real",
      value: r.value,
      onChange: (v) => this.pushValue(Number(v)),
    })
    for (const [name, alias] of [
      ["min", "from"],
      ["max", "to"],
    ] as const) {
      this.defineProperty(name, {
        type: "real",
        value: r[name],
        onChange: (v) => {
          const was = this.pushing
          this.pushing = true
          try {
            r[name] = Number(v)
          } finally {
            this.pushing = was
          }
          // A value assigned before its range was clamped: reapply it.
          this.pushValue(Number(this.peek("value")))
        },
      })
      this.defineAlias(alias, this, name)
    }
    this.passthrough("viewPortSize", { type: "real" })
    this.passthrough("backgroundColor", { color: true })
    this.passthrough("foregroundColor", { color: true })
    this.defineSignal("moved", ["value"])
    r.on("change", (e: { value: number }) => {
      if (this.isDestroyed) return
      this.write("value", e.value)
      if (!this.pushing) this.emit("moved", e.value)
    })
  }

  private pushValue(v: number): void {
    const r = this.renderable
    if (r.isDestroyed || !Number.isFinite(v)) return
    const was = this.pushing
    this.pushing = true
    try {
      r.value = v
    } finally {
      this.pushing = was
    }
    if (r.value !== v && this.peek("value") !== r.value) this.write("value", r.value)
  }

  protected override createRenderable(engine: QmlEngine, typeName: string): Renderable {
    return new SliderRenderable(engine.renderer, { id: nextRenderableId(typeName), orientation: "horizontal" })
  }

  protected override get acceptsVisualChildren(): boolean {
    return false
  }
}

export class ScrollBar extends Item {
  declare readonly renderable: ScrollBarRenderable
  static qmlStatics = ORIENTATION_STATICS
  private pushing = false

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    const r = this.renderable
    this.defineProperty("orientation", {
      type: "string",
      value: "vertical",
      onChange: (v) => this.applyOrientation(toOrientation(v, "vertical")),
    })
    this.defineProperty("position", {
      type: "real",
      value: 0,
      onChange: (v) => {
        if (r.isDestroyed) return
        const was = this.pushing
        this.pushing = true
        try {
          r.scrollPosition = Number(v) || 0
        } finally {
          this.pushing = was
        }
        if (r.scrollPosition !== v) this.write("position", r.scrollPosition)
      },
    })
    this.defineAlias("value", this, "position")
    for (const name of ["scrollSize", "viewportSize"] as const) {
      this.defineProperty(name, {
        type: "real",
        value: 0,
        onChange: (v) => {
          if (r.isDestroyed) return
          r[name] = Number(v) || 0
          if (r.scrollPosition !== this.peek("position")) this.write("position", r.scrollPosition)
        },
      })
    }
    this.passthrough("showArrows", { type: "bool" })
    this.defineProperty("scrollStep", {
      type: "var",
      onChange: (v) => (r.scrollStep = v === undefined || v === null ? null : Number(v)),
    })
    this.passthrough("trackColor", { color: true, target: "backgroundColor", on: () => r.slider })
    this.passthrough("thumbColor", { color: true, target: "foregroundColor", on: () => r.slider })
    this.defineProperty("arrowColor", {
      type: "var",
      coerce: toColor,
      onChange: (v) => {
        if (v === undefined) return
        r.startArrow.foregroundColor = v as string
        r.endArrow.foregroundColor = v as string
      },
    })
    this.defineSignal("scrolled", ["position"])
    this.defineMethod("scrollBy", (delta: number, unit?: string) =>
      r.scrollBy(Number(delta) || 0, (unit as "absolute" | "viewport" | "content" | "step") ?? "absolute"),
    )
    r.on("change", (e: { position: number }) => {
      if (this.isDestroyed) return
      this.write("position", e.position)
      if (!this.pushing) this.emit("scrolled", e.position)
    })
  }

  private applyOrientation(o: "horizontal" | "vertical"): void {
    const r = this.renderable as ScrollBarRenderable & { orientation: string }
    if (r.isDestroyed || r.orientation === o) return
    const vertical = o === "vertical"
    r.orientation = o
    r.flexDirection = vertical ? "column" : "row"
    ;(r.slider as { orientation: string }).orientation = o
    const s = r.slider
    if (vertical) {
      s.width = 1
      s.height = "100%"
      s.marginTop = 0
      s.marginLeft = "auto"
    } else {
      s.width = "100%"
      s.height = 1
      s.marginLeft = 0
      s.marginTop = "auto"
    }
    r.startArrow.direction = vertical ? "up" : "left"
    r.endArrow.direction = vertical ? "down" : "right"
    r.requestRender()
  }

  protected override createRenderable(engine: QmlEngine, typeName: string): Renderable {
    return new ScrollBarRenderable(engine.renderer, { id: nextRenderableId(typeName), orientation: "vertical" })
  }

  protected override get acceptsVisualChildren(): boolean {
    return false
  }
}
