/**
 * Test-only visual text type so plugin tests don't depend on the full component set.
 */
import { TextRenderable } from "@opentui/core"
import type { QmlEngine } from "../../src/runtime/engine.ts"
import { nextRenderableId, VisualObject } from "../../src/components/visual.ts"

export class TestText extends VisualObject {
  readonly renderable: TextRenderable

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    this.renderable = new TextRenderable(engine.renderer, { id: nextRenderableId(typeName), content: "" })
    this.defineProperty("text", {
      type: "string",
      onChange: (v) => {
        this.renderable.content = String(v)
      },
    })
  }
}
