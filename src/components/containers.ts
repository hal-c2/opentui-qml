/**
 * `ScrollView` / `Flickable` — a ScrollBoxRenderable. Children are mounted in its content box.
 *
 * - `showScrollbar` (true: automatic visibility, false: hidden), `scrollX` (default false),
 *   `scrollY` (default true), `stickyScroll`, `stickyStart` ("bottom" | "top" | "left" | "right").
 * - `contentY` / `contentX` ↔ `scrollTop` / `scrollLeft` (updated after layout / scrolling).
 * - read-only `contentHeight` / `contentWidth` (scrollHeight / scrollWidth).
 * - methods `scrollTo(y)` / `scrollTo({x, y})`, `scrollBy(dy)` / `scrollBy({x, y})`,
 *   `scrollToBottom()`, `scrollToTop()`.
 */
import { ScrollBoxRenderable, type Renderable } from "@opentui/core"
import type { QmlEngine } from "../runtime/engine.ts"
import { Item, nextRenderableId } from "./visual.ts"

type Pos = number | { x: number; y: number }

export class ScrollView extends Item {
  declare readonly renderable: ScrollBoxRenderable
  private syncingScroll = false

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    const r = this.renderable
    this.defineProperty("showScrollbar", {
      type: "bool",
      value: true,
      onChange: (v) => {
        for (const bar of [r.verticalScrollBar, r.horizontalScrollBar]) {
          if (v) bar.resetVisibilityControl()
          else bar.visible = false
        }
      },
    })
    this.passthrough("stickyScroll", { type: "bool" })
    this.passthrough("stickyStart", { type: "var" })
    // scrollX / scrollY are construction options in OpenTUI; emulate them at runtime via the
    // content box's max size (unbounded along a scrollable axis).
    this.defineProperty("scrollX", {
      type: "bool",
      value: false,
      onChange: (v) => (r.content.maxWidth = v ? (undefined as never) : "100%"),
    })
    this.defineProperty("scrollY", {
      type: "bool",
      value: true,
      onChange: (v) => (r.content.maxHeight = v ? (undefined as never) : "100%"),
    })
    this.defineProperty("contentY", {
      type: "real",
      value: 0,
      onChange: (v) => {
        if (!this.syncingScroll) r.scrollTop = Number(v) || 0
      },
    })
    this.defineProperty("contentX", {
      type: "real",
      value: 0,
      onChange: (v) => {
        if (!this.syncingScroll) r.scrollLeft = Number(v) || 0
      },
    })
    this.defineProperty("contentHeight", { type: "real", readonly: true })
    this.defineProperty("contentWidth", { type: "real", readonly: true })

    this.defineMethod("scrollTo", (pos: Pos) => {
      r.scrollTo(pos)
      this.syncScroll()
    })
    this.defineMethod("scrollBy", (delta: Pos) => {
      r.scrollBy(delta)
      this.syncScroll()
    })
    this.defineMethod("scrollToBottom", () => {
      r.scrollTo({ x: r.scrollLeft, y: r.scrollHeight })
      this.syncScroll()
    })
    this.defineMethod("scrollToTop", () => {
      r.scrollTo({ x: r.scrollLeft, y: 0 })
      this.syncScroll()
    })
    this.connect("mouseScroll", () => queueMicrotask(() => this.syncScroll()))
  }

  protected override createRenderable(engine: QmlEngine, typeName: string): Renderable {
    return new ScrollBoxRenderable(engine.renderer, { id: nextRenderableId(typeName) })
  }

  override get contentRenderable(): Renderable {
    return this.renderable.content
  }

  override syncLayout(): void {
    super.syncLayout()
    this.syncScroll()
  }

  private syncScroll(): void {
    const r = this.renderable
    if (this.isDestroyed || r.isDestroyed) return
    this.syncingScroll = true
    try {
      this.write("contentY", r.scrollTop)
      this.write("contentX", r.scrollLeft)
      this.write("contentHeight", r.scrollHeight)
      this.write("contentWidth", r.scrollWidth)
    } finally {
      this.syncingScroll = false
    }
  }
}
