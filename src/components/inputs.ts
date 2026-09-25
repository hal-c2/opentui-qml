/**
 * Text entry types.
 *
 * `TextInput` / `TextField` (InputRenderable, single line):
 * - `text` is two-way: typing updates it (like any user edit, this breaks a binding on `text`,
 *   as in Qt); assigning it updates the field.
 * - `placeholderText`, `maxLength`, `color` (textColor), `focusedColor`, `backgroundColor`,
 *   `focusedBackgroundColor`, `placeholderColor`, `cursorColor`, `keyBindings`, `keyAliasMap`.
 * - signals `textEdited(text)` (user edits only), `accepted()` (Enter), `editingFinished()`
 *   (Enter or focus loss).
 *
 * `TextArea` (TextareaRenderable, multi line): `text` (two-way), `placeholderText`, `wrapMode`,
 * colours as above, `keyBindings`, `keyAliasMap`, signal `textEdited(text)`.
 */
import { InputRenderable, InputRenderableEvents, TextareaRenderable, type Renderable } from "@opentui/core"
import type { QmlEngine } from "../runtime/engine.ts"
import { Item, nextRenderableId } from "./visual.ts"
import { toWrapMode, TEXT_STATICS } from "./text.ts"

function defineEditColors(item: Item): void {
  item.passthrough("color", { color: true, target: "textColor" })
  item.passthrough("focusedColor", { color: true, target: "focusedTextColor" })
  item.passthrough("backgroundColor", { color: true })
  item.passthrough("focusedBackgroundColor", { color: true })
  item.passthrough("placeholderColor", { color: true })
  item.passthrough("cursorColor", { color: true })
  item.passthrough("keyBindings", { type: "var" })
  item.passthrough("keyAliasMap", { type: "var" })
}

export class TextInput extends Item {
  declare readonly renderable: InputRenderable
  private pushing = false

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    const r = this.renderable
    this.defineProperty("text", {
      type: "string",
      onChange: (v) => {
        if (r.value === v) return
        this.pushing = true
        try {
          r.value = v as string
        } finally {
          this.pushing = false
        }
      },
    })
    this.passthrough("placeholderText", { type: "string", target: "placeholder" })
    this.passthrough("maxLength", { type: "int" })
    defineEditColors(this)
    this.defineSignal("textEdited", ["text"])
    this.defineSignal("accepted")
    this.defineSignal("editingFinished")

    r.on(InputRenderableEvents.INPUT, (value: string) => {
      if (this.pushing || this.isDestroyed) return
      this.pushing = true
      try {
        this.set("text", value)
      } finally {
        this.pushing = false
      }
      this.emit("textEdited", value)
    })
    r.on(InputRenderableEvents.ENTER, () => {
      if (this.isDestroyed) return
      this.emit("accepted")
      this.emit("editingFinished")
    })
    r.on("blurred", () => {
      if (!this.isDestroyed && !this.isDestroying) this.emit("editingFinished")
    })
    this.defineMethod("clear", () => this.set("text", ""))
    this.defineMethod("selectAll", () => r.selectAll?.())
  }

  protected override createRenderable(engine: QmlEngine, typeName: string): Renderable {
    return new InputRenderable(engine.renderer, { id: nextRenderableId(typeName) })
  }

  protected override get acceptsVisualChildren(): boolean {
    return false
  }
}

export class TextArea extends Item {
  declare readonly renderable: TextareaRenderable
  static qmlStatics = TEXT_STATICS
  private pushing = false

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    const r = this.renderable
    this.defineProperty("text", {
      type: "string",
      onChange: (v) => {
        if (r.plainText === v) return
        this.pushing = true
        try {
          r.setText(v as string)
        } finally {
          this.pushing = false
        }
      },
    })
    this.passthrough("placeholderText", { type: "string", target: "placeholder" })
    this.passthrough("wrapMode", { type: "var", map: toWrapMode })
    defineEditColors(this)
    this.defineSignal("textEdited", ["text"])
    r.onContentChange = () => {
      if (this.pushing || this.isDestroyed) return
      const value = r.plainText
      if (value === this.peek("text")) return
      this.pushing = true
      try {
        this.set("text", value)
      } finally {
        this.pushing = false
      }
      this.emit("textEdited", value)
    }
    this.defineMethod("clear", () => this.set("text", ""))
  }

  protected override createRenderable(engine: QmlEngine, typeName: string): Renderable {
    return new TextareaRenderable(engine.renderer, { id: nextRenderableId(typeName) })
  }

  protected override get acceptsVisualChildren(): boolean {
    return false
  }
}
