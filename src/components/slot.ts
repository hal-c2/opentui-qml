/**
 * `Slot` — a mount point for plugin contributions (wraps OpenTUI's `SlotRenderable`).
 *
 * ```qml
 * Slot {
 *     name: "sidebar"                 // required
 *     mode: "replace"                 // "replace" (default) | "append" | "single_winner"
 *     data: ({ file: currentFile })   // passed to every contribution; reactive
 *     flexDirection: "row"            // layout of the contributions
 *     Text { text: "no plugins" }     // fallback children
 * }
 * ```
 *
 * Modes (OpenTUI semantics): `replace` shows every contribution, or the fallback children when
 * there are none; `append` always shows the fallback children followed by the contributions;
 * `single_winner` shows only the first contribution (by plugin order).
 *
 * Structure: `renderable` is a transparent wrapper Box (it carries the Slot's own size/position
 * props); the `SlotRenderable` is created inside it on completion, once `name` is known. The
 * fallback children live in a separate Box passed as the SlotRenderable's fallback.
 */
import { BoxRenderable, SlotRenderable, type Renderable } from "@opentui/core"
import type { QmlEngine } from "../runtime/engine.ts"
import type { QmlObject } from "../runtime/object.ts"
import { getSlotRegistry, wrapSlotData, type QmlSlotContext, type QmlSlotData } from "../runtime/plugins.ts"
import { isVisual, nextRenderableId, VisualObject } from "./visual.ts"

const MODES = new Set(["append", "replace", "single_winner"])

/** Props applied to the wrapper (the Slot's box in its parent's layout). */
const OUTER_PROPS = [
  "width",
  "height",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "flexGrow",
  "flexShrink",
  "flexBasis",
  "alignSelf",
  "position",
  "top",
  "left",
  "right",
  "bottom",
  "margin",
  "marginX",
  "marginY",
  "marginTop",
  "marginBottom",
  "marginLeft",
  "marginRight",
  "zIndex",
  "opacity",
] as const

/** Props applied to the SlotRenderable and the fallback box (layout of the contents). */
const INNER_PROPS = [
  "flexDirection",
  "flexWrap",
  "alignItems",
  "justifyContent",
  "padding",
  "paddingX",
  "paddingY",
  "paddingTop",
  "paddingBottom",
  "paddingLeft",
  "paddingRight",
] as const

const INNER_BOX_ONLY = ["gap", "rowGap", "columnGap"] as const

type AnyRenderable = Record<string, unknown>

export class Slot extends VisualObject {
  readonly renderable: BoxRenderable
  private slot: SlotRenderable<string, QmlSlotContext, QmlSlotData> | null = null
  private fallbackBox: BoxRenderable
  private unsubscribe: (() => void) | null = null

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    this.renderable = new BoxRenderable(engine.renderer, {
      id: nextRenderableId(typeName),
      flexDirection: "column",
      border: false,
    })
    this.fallbackBox = this.createFallbackBox()

    this.defineProperty("name", { type: "string", required: true, onChange: () => this.rebuild() })
    this.defineProperty("mode", {
      type: "string",
      value: "replace",
      onChange: (v) => {
        if (this.slot) this.slot.mode = this.checkedMode(v)
      },
    })
    this.defineProperty("data", {
      type: "var",
      value: {},
      onChange: (v) => {
        if (this.slot) this.slot.data = wrapSlotData(v, this)
      },
    })
    /** Number of plugins contributing to this slot (read-only). */
    this.defineProperty("count", { type: "int", readonly: true })
    this.defineProperty("visible", {
      type: "bool",
      value: true,
      onChange: (v) => (this.renderable.visible = !!v),
    })
    for (const name of OUTER_PROPS) {
      this.defineProperty(name, {
        type: "var",
        onChange: (v) => {
          if (v !== undefined) (this.renderable as unknown as AnyRenderable)[name] = v
        },
      })
    }
    for (const name of [...INNER_PROPS, ...INNER_BOX_ONLY]) {
      this.defineProperty(name, { type: "var", onChange: () => this.applyInner(name) })
    }
    this.defineProperty("spacing", { type: "real", onChange: () => this.applyInner("gap") })
    this.defineMethod("refresh", () => this.refresh())
  }

  /** Fallback children are mounted in the fallback box, not in the wrapper. */
  override get contentRenderable(): Renderable {
    return this.fallbackBox
  }

  /** The underlying SlotRenderable (null before completion). */
  get slotRenderable(): SlotRenderable<string, QmlSlotContext, QmlSlotData> | null {
    return this.slot
  }

  /** Re-resolve contributions (e.g. after mutating `data` in place). */
  refresh(): void {
    if (!this.slot) return
    this.slot.data = wrapSlotData(this.peek("data"), this)
  }

  protected override onCompleted(): void {
    this.rebuild()
  }

  protected override onChildAdded(child: QmlObject, index: number): void {
    const hadFallback = this.hasFallback()
    super.onChildAdded(child, index)
    if (this.isCompleted && !hadFallback && this.hasFallback()) this.rebuild()
  }

  private hasFallback(): boolean {
    return this.children.some(isVisual)
  }

  private checkedMode(v: unknown): "append" | "replace" | "single_winner" {
    const mode = String(v)
    if (MODES.has(mode)) return mode as "append" | "replace" | "single_winner"
    this.engine.warn(`${this.describe()}: unknown Slot mode "${mode}" (use append, replace or single_winner)`)
    return "replace"
  }

  private createFallbackBox(): BoxRenderable {
    return new BoxRenderable(this.engine.renderer, { id: nextRenderableId("slot-fallback"), border: false })
  }

  private innerValue(name: string): unknown {
    if (name === "gap") {
      const gap = this.peek("gap")
      return gap !== undefined ? gap : this.peek("spacing")
    }
    return this.peek(name)
  }

  private applyInner(name: string, targets?: Renderable[]): void {
    const value = this.innerValue(name)
    if (value === undefined) return
    const isBoxOnly = (INNER_BOX_ONLY as readonly string[]).includes(name)
    const list = targets ?? [this.fallbackBox, ...(this.slot && !isBoxOnly ? [this.slot] : [])]
    for (const r of list) {
      if (isBoxOnly && !(r instanceof BoxRenderable)) continue
      ;(r as unknown as AnyRenderable)[name] = value
    }
  }

  /** (Re)create the SlotRenderable for the current name. */
  private rebuild(): void {
    if (!this.isCompleted || this.isDestroyed || this.isDestroying) return
    this.teardown()
    const name = this.peek("name") as string
    this.write("count", 0)
    if (!name) {
      this.engine.warn(`${this.describe()}: Slot has no name`)
      return
    }
    let registry
    try {
      registry = getSlotRegistry(this.engine)
    } catch (err) {
      this.engine.reportError(err, this.describe())
      return
    }
    const fallback = this.hasFallback() ? this.fallbackBox : undefined
    try {
      this.slot = new SlotRenderable<string, QmlSlotContext, QmlSlotData>(this.engine.renderer, {
        id: nextRenderableId("slot-mount"),
        registry,
        name,
        data: wrapSlotData(this.peek("data"), this),
        mode: this.checkedMode(this.peek("mode")),
        fallback,
        flexGrow: 1,
        flexShrink: 1,
      })
    } catch (err) {
      this.engine.reportError(err, `${this.describe()}: slot "${name}"`)
      return
    }
    for (const prop of INNER_PROPS) this.applyInner(prop)
    this.applyInner("gap")
    this.renderable.add(this.slot)
    const updateCount = (): void => {
      if (!this.isDestroyed) this.write("count", registry.resolveEntries(name).length)
    }
    this.unsubscribe = registry.subscribe(updateCount)
    updateCount()
  }

  /** Destroy the SlotRenderable without destroying the fallback children's renderables. */
  private teardown(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    const old = this.slot
    if (!old) return
    this.slot = null
    // The SlotRenderable destroys its fallback nodes: move the children to a fresh box first.
    const oldBox = this.fallbackBox
    const next = this.createFallbackBox()
    for (const child of oldBox.getChildren()) {
      oldBox.remove(child)
      next.add(child)
    }
    this.fallbackBox = next
    for (const prop of [...INNER_PROPS, "gap"]) this.applyInner(prop, [next])
    // `destroy()` (not destroyRecursively) detaches plugin-owned nodes instead of destroying them.
    old.destroy()
    if (!oldBox.isDestroyed) oldBox.destroyRecursively()
  }

  override destroy(): void {
    if (this.isDestroyed || this.isDestroying) return
    this.unsubscribe?.()
    this.unsubscribe = null
    const old = this.slot
    this.slot = null
    // Unmount contributions first (host-owned ones are destroyed, managed ones detached).
    old?.destroy()
    super.destroy()
    if (!this.fallbackBox.isDestroyed) this.fallbackBox.destroyRecursively()
  }
}
