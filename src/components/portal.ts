/**
 * `Portal { target: someItem; ... }` — its visual children are drawn inside `target` (any visual
 * item; default: the renderer's root, i.e. on top of the whole screen) instead of where the Portal
 * is declared, like Solid's `<Portal mount={...}>`. Ids, bindings and ownership stay where the
 * Portal is written. The Portal itself is a Box container (all Item props apply — e.g.
 * `position: "absolute"` + `left`/`top`/`zIndex` for an overlay) and takes no space in its QML
 * parent. When the target is destroyed the content moves to the root.
 */
import type { Renderable } from "@opentui/core"
import type { QmlEngine } from "../runtime/engine.ts"
import { toQmlObject } from "../runtime/object.ts"
import { Item, isVisual } from "./visual.ts"

export class Portal extends Item {
  private mountToken = 0

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    this.defineProperty("target", {
      type: "var",
      onChange: () => {
        if (this.isCompleted) this.remount()
      },
    })
  }

  override get mountsInParent(): boolean {
    return false
  }

  private targetRenderable(): Renderable {
    const t = toQmlObject(this.peek("target"))
    if (isVisual(t) && !t.isDestroyed && !t.renderable.isDestroyed) return t.contentRenderable
    return this.engine.renderer.root
  }

  private remount(): void {
    const r = this.renderable
    if (this.isDestroyed || r.isDestroyed) return
    const token = ++this.mountToken
    const dest = this.targetRenderable()
    if (r.parent !== dest) {
      if (r.parent) r.parent.remove(r)
      dest.add(r)
    }
    const t = toQmlObject(this.peek("target"))
    if (isVisual(t)) {
      t.onDestroy(() => {
        if (token !== this.mountToken || this.isDestroyed || r.isDestroyed) return
        if (r.parent) r.parent.remove(r)
        this.engine.renderer.root.add(r)
      })
    }
  }

  protected override onCompleted(): void {
    super.onCompleted()
    this.remount()
  }
}
