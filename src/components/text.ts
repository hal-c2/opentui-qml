/**
 * `Text` / `Label` — a TextRenderable.
 *
 * - `text`: string, number (coerced) or a StyledText (from OpenTUI's `t\`...\`` helpers).
 * - `color` (fg), `backgroundColor` (bg).
 * - `font.bold` / `font.italic` / `font.underline` / `font.strikeout` / `font.dim` /
 *   `font.inverse` → TextAttributes bitmask.
 * - `wrapMode`: `Text.WordWrap` / `Text.NoWrap` / `Text.WrapAnywhere` or "word" / "none" / "char".
 * - `horizontalAlignment`: `Text.AlignLeft` / `AlignHCenter` / `AlignRight` (also `Qt.Align*`)
 *   or "left" / "center" / "right".
 * - `elide: Text.ElideRight` or `truncate: true` truncates instead of overflowing.
 * - `selectable`.
 *
 * Text cannot contain visual children.
 */
import { StyledText, TextAttributes, TextRenderable, type Renderable } from "@opentui/core"
import type { QmlEngine } from "../runtime/engine.ts"
import { Item, nextRenderableId } from "./visual.ts"

export const TEXT_STATICS = {
  WordWrap: "word",
  Wrap: "word",
  WrapAtWordBoundaryOrAnywhere: "char",
  WrapAnywhere: "char",
  NoWrap: "none",
  AlignLeft: "left",
  AlignHCenter: "center",
  AlignRight: "right",
  ElideNone: "none",
  ElideRight: "right",
  ElideLeft: "left",
  ElideMiddle: "middle",
}

/** "word" / "WordWrap" / ... → OpenTUI wrap mode. */
export function toWrapMode(v: unknown): "none" | "char" | "word" | undefined {
  if (v === undefined || v === null || v === "") return undefined
  switch (String(v)) {
    case "word":
    case "WordWrap":
    case "Wrap":
      return "word"
    case "char":
    case "WrapAnywhere":
    case "WrapAtWordBoundaryOrAnywhere":
      return "char"
    case "none":
    case "NoWrap":
      return "none"
  }
  return undefined
}

/** "left" / "AlignHCenter" / ... → OpenTUI textAlign. */
export function toTextAlign(v: unknown): "left" | "center" | "right" | undefined {
  if (v === undefined || v === null || v === "") return undefined
  const s = String(v)
  if (s === "center" || s === "AlignHCenter" || s === "AlignCenter") return "center"
  if (s === "right" || s === "AlignRight") return "right"
  if (s === "left" || s === "AlignLeft" || s === "AlignJustify") return "left"
  return undefined
}

function toContent(v: unknown): string | StyledText {
  if (v instanceof StyledText) return v
  if (v === null || v === undefined) return ""
  if (typeof v === "object" && Array.isArray((v as { chunks?: unknown }).chunks)) return v as StyledText
  return String(v)
}

const FONT_ATTRS: Array<[string, number]> = [
  ["font.bold", TextAttributes.BOLD],
  ["font.italic", TextAttributes.ITALIC],
  ["font.underline", TextAttributes.UNDERLINE],
  ["font.strikeout", TextAttributes.STRIKETHROUGH],
  ["font.dim", TextAttributes.DIM],
  ["font.inverse", TextAttributes.INVERSE],
]

export class Text extends Item {
  declare readonly renderable: TextRenderable
  static qmlStatics = TEXT_STATICS

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    const r = this.renderable
    this.defineProperty("text", {
      type: "var",
      value: "",
      coerce: toContent,
      onChange: (v) => (r.content = v as string | StyledText),
    })
    this.passthrough("color", { color: true, target: "fg" })
    this.passthrough("backgroundColor", { color: true, target: "bg" })
    for (const [name] of FONT_ATTRS) {
      this.defineProperty(name, { type: "bool", value: false, onChange: () => this.applyAttributes() })
    }
    this.defineProperty("font.pixelSize", { type: "int", value: 0 })
    this.defineProperty("font.family", { type: "string" })
    this.passthrough("wrapMode", { type: "var", target: "wrapMode", map: toWrapMode })
    this.passthrough("horizontalAlignment", { type: "var", target: "textAlign", map: toTextAlign })
    this.passthrough("selectable", { type: "bool" })
    this.passthrough("truncate", { type: "bool" })
    this.defineProperty("elide", {
      type: "var",
      onChange: (v) => {
        if (v !== undefined) r.truncate = !!v && v !== "none" && v !== "ElideNone"
      },
    })
    this.defineProperty("textFormat", { type: "var" })
  }

  protected override createRenderable(engine: QmlEngine, typeName: string): Renderable {
    return new TextRenderable(engine.renderer, { id: nextRenderableId(typeName), content: "" })
  }

  protected override get acceptsVisualChildren(): boolean {
    return false
  }

  private applyAttributes(): void {
    let attrs = 0
    for (const [name, bit] of FONT_ATTRS) if (this.peek(name)) attrs |= bit
    this.renderable.attributes = attrs
  }
}
