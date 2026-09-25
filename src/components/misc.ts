/**
 * Leaf renderables:
 *
 * - `AsciiText` / `BigText` (ASCIIFontRenderable): `text`, `font` ("tiny" | "block" | "shade" |
 *   "slick" | ...), `color` (a colour or an array of colours for gradients), `backgroundColor`,
 *   `selectable`.
 * - `Markdown` (MarkdownRenderable): `text` (alias `content`), `color` (fg), `backgroundColor`
 *   (bg), `conceal`, `streaming`.
 * - `Code` (CodeRenderable): `text` (alias `content`), `filetype`, `conceal`, `wrapMode`,
 *   `color`, `backgroundColor`. Without a tree-sitter client the code is drawn unstyled.
 *
 * Markdown and Code get a default `SyntaxStyle`.
 */
import {
  ASCIIFontRenderable,
  CodeRenderable,
  MarkdownRenderable,
  SyntaxStyle,
  type Renderable,
} from "@opentui/core"
import type { QmlEngine } from "../runtime/engine.ts"
import { Item, nextRenderableId, toColor } from "./visual.ts"
import { TEXT_STATICS, toWrapMode } from "./text.ts"

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v)
}

export class AsciiText extends Item {
  declare readonly renderable: ASCIIFontRenderable

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    this.passthrough("text", { type: "string", value: "" })
    this.passthrough("font", { type: "string", value: "tiny" })
    this.passthrough("color", {
      type: "var",
      map: (v) => (Array.isArray(v) ? v.map(toColor) : toColor(v)),
    })
    this.passthrough("backgroundColor", { color: true })
    this.passthrough("selectable", { type: "bool" })
  }

  protected override createRenderable(engine: QmlEngine, typeName: string): Renderable {
    return new ASCIIFontRenderable(engine.renderer, { id: nextRenderableId(typeName), text: "", font: "tiny" })
  }

  protected override get acceptsVisualChildren(): boolean {
    return false
  }
}

/** `text` and `content` are two names for the same value. */
function defineContent(item: Item, apply: (v: string) => void): void {
  item.defineProperty("text", { type: "string", onChange: (v) => apply(str(v)) })
  item.defineAlias("content", item, "text")
}

export class Markdown extends Item {
  declare readonly renderable: MarkdownRenderable

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    defineContent(this, (v) => (this.renderable.content = v))
    this.passthrough("color", { color: true, target: "fg" })
    this.passthrough("backgroundColor", { color: true, target: "bg" })
    this.passthrough("conceal", { type: "bool" })
    this.passthrough("streaming", { type: "bool" })
  }

  protected override createRenderable(engine: QmlEngine, typeName: string): Renderable {
    return new MarkdownRenderable(engine.renderer, {
      id: nextRenderableId(typeName),
      content: "",
      syntaxStyle: SyntaxStyle.create(),
    })
  }

  protected override get acceptsVisualChildren(): boolean {
    return false
  }
}

export class Code extends Item {
  declare readonly renderable: CodeRenderable
  static qmlStatics = TEXT_STATICS

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    defineContent(this, (v) => (this.renderable.content = v))
    this.passthrough("filetype", { type: "string" })
    this.passthrough("conceal", { type: "bool" })
    this.passthrough("wrapMode", { type: "var", map: toWrapMode })
    this.passthrough("color", { color: true, target: "fg" })
    this.passthrough("backgroundColor", { color: true, target: "bg" })
    this.passthrough("selectable", { type: "bool" })
  }

  protected override createRenderable(engine: QmlEngine, typeName: string): Renderable {
    return new CodeRenderable(engine.renderer, {
      id: nextRenderableId(typeName),
      content: "",
      syntaxStyle: SyntaxStyle.create(),
      drawUnstyledText: true,
    })
  }

  protected override get acceptsVisualChildren(): boolean {
    return false
  }
}
