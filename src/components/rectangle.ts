/**
 * `Rectangle` — a Box with background `color` and an optional border.
 *
 * `border.width` > 0 turns the (always 1 cell wide) border on; `border.color`, `border.style`
 * ("single" | "double" | "rounded" | "heavy" ...) style it. `radius` > 0 selects the "rounded"
 * border style unless `border.style` is set. OpenTUI extras: `title`, `titleAlignment`,
 * `titleColor`, `bottomTitle`, `bottomTitleAlignment`, `focusedBorderColor`, `shouldFill`.
 */
import { BoxRenderable, type Renderable } from "@opentui/core"
import type { QmlEngine } from "../runtime/engine.ts"
import { Item, nextRenderableId, toColor } from "./visual.ts"

export class Rectangle extends Item {
  declare readonly renderable: BoxRenderable

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    this.passthrough("color", { color: true, target: "backgroundColor" })
    this.defineProperty("border.width", {
      type: "int",
      value: 0,
      onChange: (v) => (this.renderable.border = Number(v) > 0),
    })
    this.defineProperty("border.color", {
      type: "color",
      onChange: (v) => {
        const c = toColor(v)
        if (c !== undefined) this.renderable.borderColor = c as string
      },
    })
    this.defineProperty("border.style", { type: "string", onChange: () => this.applyBorderStyle() })
    this.defineProperty("radius", { type: "real", value: 0, onChange: () => this.applyBorderStyle() })
    this.passthrough("focusedBorderColor", { color: true })
    this.passthrough("title", { type: "string" })
    this.passthrough("titleAlignment", { type: "string", value: "left" })
    this.passthrough("titleColor", { color: true })
    this.passthrough("bottomTitle", { type: "string" })
    this.passthrough("bottomTitleAlignment", { type: "string", value: "left" })
    this.passthrough("shouldFill", { type: "bool", value: true })
  }

  protected override createRenderable(engine: QmlEngine, typeName: string): Renderable {
    return new BoxRenderable(engine.renderer, { id: nextRenderableId(typeName), border: false })
  }

  private applyBorderStyle(): void {
    const style = this.peek("border.style") as string
    const radius = Number(this.peek("radius")) || 0
    const next = style ? style : radius > 0 ? "rounded" : "single"
    ;(this.renderable as unknown as { borderStyle: string }).borderStyle = next
  }
}
