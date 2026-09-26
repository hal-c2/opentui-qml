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
 * - `selectable`, methods `selectedText()` / `hasSelection()`.
 *
 * Rich text: non-visual span children compose a StyledText, after the plain `text` segment:
 *
 * ```qml
 * Text {
 *     text: "Status: "
 *     Bold { text: "ok"; color: "lime" }
 *     Span { text: " — see "; Link { href: "https://opentui.com"; text: "docs" } }
 *     Br {}
 *     Italic { Dim { text: "nested styles inherit" } }
 * }
 * ```
 *
 * Span types: `Span`, `Bold`/`Strong`, `Italic`/`Em`, `Underline`, `Strikethrough`, `Dim`,
 * `Link { href }`, `Br`. Each has `text`, `color`, `backgroundColor`, `bold`, `italic`,
 * `underline`, `strikethrough`, `dim`, `inverse`, `blink`, `href` (unset style props inherit
 * from the enclosing span). Everything is reactive.
 *
 * Text cannot contain visual children.
 */
import {
  StyledText,
  TextAttributes,
  TextRenderable,
  parseColor,
  type RGBA,
  type Renderable,
  type TextChunk,
} from "@opentui/core"
import type { QmlEngine } from "../runtime/engine.ts"
import { QmlObject } from "../runtime/object.ts"
import { Item, nextRenderableId, toColor } from "./visual.ts"

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

// -----------------------------------------------------------------------------------------------
// Rich text spans

const SPAN_STYLE_ATTRS: Array<[string, number]> = [
  ["bold", TextAttributes.BOLD],
  ["italic", TextAttributes.ITALIC],
  ["underline", TextAttributes.UNDERLINE],
  ["strikethrough", TextAttributes.STRIKETHROUGH],
  ["dim", TextAttributes.DIM],
  ["inverse", TextAttributes.INVERSE],
  ["blink", TextAttributes.BLINK],
]

/** Style defaults implied by the span type name. */
const SPAN_DEFAULTS: Record<string, Record<string, boolean>> = {
  Bold: { bold: true },
  Strong: { bold: true },
  B: { bold: true },
  Italic: { italic: true },
  Em: { italic: true },
  I: { italic: true },
  Underline: { underline: true },
  U: { underline: true },
  Strikethrough: { strikethrough: true },
  Dim: { dim: true },
  Link: { underline: true },
  A: { underline: true },
}

function optionalBool(v: unknown): boolean | undefined {
  return v === undefined || v === null ? undefined : !!v
}

/**
 * A styled run inside a `Text` (non-visual). Nested spans inherit unset style properties.
 * `Br` inserts a line break.
 */
export class Span extends QmlObject {
  readonly isBreak: boolean

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    this.isBreak = typeName === "Br"
    const defaults = SPAN_DEFAULTS[typeName] ?? {}
    this.defineProperty("text", { type: "string", value: "" })
    this.defineProperty("color", { type: "var", coerce: toColor })
    this.defineProperty("backgroundColor", { type: "var", coerce: toColor })
    for (const [name] of SPAN_STYLE_ATTRS) {
      this.defineProperty(name, {
        type: "var",
        coerce: optionalBool,
        ...(defaults[name] !== undefined ? { value: defaults[name] } : {}),
      })
    }
    this.defineProperty("href", { type: "string", value: "" })
  }
}

export const SPAN_TYPES: Readonly<Record<string, typeof Span>> = {
  Span,
  Bold: Span,
  Strong: Span,
  Italic: Span,
  Em: Span,
  Underline: Span,
  Strikethrough: Span,
  Dim: Span,
  Link: Span,
  Br: Span,
}

interface SpanStyle {
  fg?: RGBA
  bg?: RGBA
  flags: Record<string, boolean | undefined>
  href?: string
}

function safeColor(v: unknown): RGBA | undefined {
  if (v === undefined || v === null || v === "") return undefined
  try {
    return parseColor(v as string)
  } catch {
    return undefined
  }
}

/** Tracked: append the chunks of `span` (and its nested spans) to `out`. */
function collectSpanChunks(span: Span, inherited: SpanStyle, out: TextChunk[]): void {
  const flags = { ...inherited.flags }
  for (const [name] of SPAN_STYLE_ATTRS) {
    const v = span.get(name)
    if (v !== undefined) flags[name] = v as boolean
  }
  const style: SpanStyle = {
    fg: safeColor(span.get("color")) ?? inherited.fg,
    bg: safeColor(span.get("backgroundColor")) ?? inherited.bg,
    flags,
    href: (span.get("href") as string) || inherited.href,
  }
  const chunk = (text: string): TextChunk => {
    let attributes = 0
    for (const [name, bit] of SPAN_STYLE_ATTRS) if (style.flags[name]) attributes |= bit
    const c: TextChunk = { __isChunk: true, text }
    if (style.fg) c.fg = style.fg
    if (style.bg) c.bg = style.bg
    if (attributes) c.attributes = attributes
    if (style.href) c.link = { url: style.href }
    return c
  }
  if (span.isBreak) out.push(chunk("\n"))
  const text = span.get("text") as string
  if (text) out.push(chunk(text))
  for (const child of span.trackChildren()) {
    if (child instanceof Span) collectSpanChunks(child, style, out)
  }
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
    this.defineProperty("text", { type: "var", value: "", coerce: toContent })
    // Content = `text`, followed by the span children (reactive).
    this.watch(() => {
      const text = this.get("text") as string | StyledText
      const spans = this.trackChildren().filter((c): c is Span => c instanceof Span)
      if (r.isDestroyed) return
      if (spans.length === 0) {
        r.content = text
        return
      }
      const chunks: TextChunk[] =
        typeof text === "string" ? (text ? [{ __isChunk: true, text }] : []) : [...text.chunks]
      for (const span of spans) collectSpanChunks(span, { flags: {} }, chunks)
      r.content = new StyledText(chunks)
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
    this.defineMethod("selectedText", () => (r.isDestroyed ? "" : r.getSelectedText()))
    this.defineMethod("hasSelection", () => !r.isDestroyed && r.hasSelection())
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
