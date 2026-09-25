/**
 * VisualObject — base class for every QML type that owns an OpenTUI renderable.
 *
 * CONTRACT (other modules depend on these names; keep them stable):
 *   - `VisualObject` (abstract) with `readonly renderable: Renderable`
 *   - `isVisual(obj)` type guard
 *   - `Item` — the plain flex container type (BoxRenderable without border)
 *   - `visualIndexFor(parent, index)` — maps a QmlObject child index (which counts
 *     non-visual children such as Timer/Repeater/ListModel) to the renderable child index.
 *
 * Child management: when a VisualObject child is appended/removed, its renderable is
 * added to / removed from this object's `contentRenderable` (defaults to `renderable`;
 * types like ScrollView can override to route children elsewhere).
 */
import { BoxRenderable, type Renderable } from "@opentui/core"
import { QmlObject } from "../runtime/object.ts"
import type { QmlEngine } from "../runtime/engine.ts"

let nextId = 0
export function nextRenderableId(typeName: string): string {
  return `qml-${typeName.toLowerCase()}-${++nextId}`
}

export function isVisual(obj: unknown): obj is VisualObject {
  return obj instanceof VisualObject
}

/** Number of visual siblings that precede `index` among `parent.children`. */
export function visualIndexFor(parent: QmlObject, index: number): number {
  let n = 0
  for (let i = 0; i < index && i < parent.children.length; i++) {
    if (isVisual(parent.children[i])) n++
  }
  return n
}

export abstract class VisualObject extends QmlObject {
  abstract readonly renderable: Renderable

  /** Where child renderables are mounted. Defaults to `renderable`. */
  get contentRenderable(): Renderable {
    return this.renderable
  }

  protected override onChildAdded(child: QmlObject, index: number): void {
    super.onChildAdded(child, index)
    if (isVisual(child)) {
      const target = this.contentRenderable
      const visualIndex = visualIndexFor(this, index)
      if (visualIndex >= target.getChildrenCount()) target.add(child.renderable)
      else target.add(child.renderable, visualIndex)
    }
  }

  protected override onChildRemoved(child: QmlObject, _index: number): void {
    super.onChildRemoved(child, _index)
    if (isVisual(child) && child.renderable.parent === this.contentRenderable) {
      this.contentRenderable.remove(child.renderable)
    }
  }

  override destroy(): void {
    if (this.isDestroyed) return
    super.destroy()
    const r = this.renderable
    if (r.parent) r.parent.remove(r)
    r.destroyRecursively()
  }
}

/**
 * Minimal `Item` placeholder so other modules can be developed against a visual type.
 * The components worker replaces the body of this class with the full property set
 * (layout passthrough, visible, focus, anchors, Layout.*, Keys.*), keeping the export name.
 */
export class Item extends VisualObject {
  readonly renderable: BoxRenderable

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    this.renderable = new BoxRenderable(engine.renderer, { id: nextRenderableId(typeName), border: false })
    for (const name of ["width", "height"] as const) {
      this.defineProperty(name, {
        type: "var",
        value: undefined,
        onChange: (v) => {
          if (v !== undefined) (this.renderable as any)[name] = v
        },
      })
    }
    this.defineProperty("visible", { type: "bool", value: true, onChange: (v) => (this.renderable.visible = !!v) })
  }
}
