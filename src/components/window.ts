/**
 * `Window` / `ApplicationWindow` — the root item: a full-size Box (`width`/`height` default to
 * "100%") with a background `color`.
 *
 * Children are laid out by flexbox with OpenTUI's default `flexDirection: "column"` (a Window
 * stacks its children vertically unless `flexDirection: "row"` is set). `title` is accepted for
 * Qt compatibility and ignored (terminals have no window title bar we control).
 */
import { BoxRenderable, type Renderable } from "@opentui/core"
import type { QmlEngine } from "../runtime/engine.ts"
import { Item, nextRenderableId } from "./visual.ts"

export class Window extends Item {
  declare readonly renderable: BoxRenderable

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    this.write("width", "100%")
    this.write("height", "100%")
    this.passthrough("color", { color: true, target: "backgroundColor" })
    this.defineProperty("title", { type: "string" })
  }

  protected override createRenderable(engine: QmlEngine, typeName: string): Renderable {
    return new BoxRenderable(engine.renderer, {
      id: nextRenderableId(typeName),
      border: false,
      width: "100%",
      height: "100%",
    })
  }
}
