/**
 * List-like types backed by OpenTUI's own list renderables (they draw their items; custom
 * delegates are a non-goal).
 *
 * `ListView` (SelectRenderable) and `TabBar` (TabSelectRenderable):
 * - `model`: `string[]`, `{ name, description, value }[]` or a `ListModel`. Role mapping:
 *   `name` | `text` | `title` | `label` → name, `description` | `subtitle` → description
 *   (override with `textRole` / `descriptionRole`). `value` defaults to the model element.
 * - `currentIndex` (two-way: keyboard navigation updates it), read-only `currentItem` (the
 *   model element) and `count`.
 * - signal `activated(index, option)` on Enter.
 * - colours, `showDescription`, `wrapSelection`, `keyBindings`, `keyAliasMap`, ...
 * - methods `incrementCurrentIndex()` / `decrementCurrentIndex()`.
 *
 * ListView needs a height: set `height`, or let flexbox stretch it.
 */
import {
  SelectRenderable,
  SelectRenderableEvents,
  TabSelectRenderable,
  TabSelectRenderableEvents,
  type Renderable,
} from "@opentui/core"
import type { QmlEngine } from "../runtime/engine.ts"
import { resolveModel, type ModelEntry } from "../runtime/builtins.ts"
import { untrack } from "../runtime/reactive.ts"
import { Item, nextRenderableId } from "./visual.ts"

export interface ListOption {
  name: string
  description: string
  value?: unknown
}

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v)
}

/** Map a model entry to a Select option (reads roles, so it is tracked). */
export function toListOption(entry: ModelEntry, textRole?: string, descriptionRole?: string): ListOption {
  const v = entry.modelData
  if (v === null || v === undefined || typeof v !== "object") {
    return { name: str(v), description: "", value: v }
  }
  const o = v as Record<string, unknown>
  const name = textRole ? o[textRole] : (o.name ?? o.text ?? o.title ?? o.label)
  const description = descriptionRole ? o[descriptionRole] : (o.description ?? o.subtitle)
  return { name: str(name), description: str(description), value: "value" in o ? o.value : v }
}

type ListRenderable = SelectRenderable | TabSelectRenderable

abstract class ListBase extends Item {
  declare readonly renderable: ListRenderable
  private syncing = false
  private entries: ModelEntry[] = []

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    const r = this.renderable
    this.defineProperty("model", { type: "var" })
    this.defineProperty("textRole", { type: "string" })
    this.defineProperty("descriptionRole", { type: "string" })
    this.defineProperty("count", { type: "int", readonly: true })
    this.defineProperty("currentItem", { type: "var", readonly: true })
    this.defineProperty("currentIndex", {
      type: "int",
      value: 0,
      onChange: (v) => {
        if (this.syncing) return
        const i = Number(v)
        if (i >= 0 && i < this.entries.length && i !== r.getSelectedIndex()) r.setSelectedIndex(i)
        this.syncCurrentItem()
      },
    })
    this.defineSignal("activated", ["index", "option"])

    for (const name of [
      "backgroundColor",
      "textColor",
      "focusedBackgroundColor",
      "focusedTextColor",
      "selectedBackgroundColor",
      "selectedTextColor",
      "selectedDescriptionColor",
    ]) {
      this.passthrough(name, { color: true })
    }
    this.passthrough("wrapSelection", { type: "bool", value: false })
    this.passthrough("keyBindings", { type: "var" })
    this.passthrough("keyAliasMap", { type: "var" })

    r.on(SelectRenderableEvents.SELECTION_CHANGED, (index: number) => {
      if (this.isDestroyed) return
      this.syncing = true
      try {
        this.write("currentIndex", index)
      } finally {
        this.syncing = false
      }
      this.syncCurrentItem()
    })
    r.on(SelectRenderableEvents.ITEM_SELECTED, (index: number, option: ListOption | null) => {
      if (this.isDestroyed) return
      this.emit("activated", index, option ? option.value : null)
    })

    this.defineMethod("incrementCurrentIndex", () => this.increment())
    this.defineMethod("decrementCurrentIndex", () => this.decrement())

    this.watch(() => {
      const entries = resolveModel(this.get("model"))
      const textRole = (this.get("textRole") as string) || undefined
      const descriptionRole = (this.get("descriptionRole") as string) || undefined
      const options = entries.map((e) => toListOption(e, textRole, descriptionRole))
      untrack(() => this.applyOptions(entries, options))
    })
  }

  protected abstract increment(): void
  protected abstract decrement(): void
  protected abstract setOptions(options: ListOption[]): void

  private applyOptions(entries: ModelEntry[], options: ListOption[]): void {
    this.entries = entries
    this.setOptions(options)
    this.write("count", options.length)
    const r = this.renderable
    const wanted = Number(this.peek("currentIndex")) || 0
    const clamped = options.length === 0 ? 0 : Math.min(Math.max(0, wanted), options.length - 1)
    if (options.length > 0 && r.getSelectedIndex() !== clamped) r.setSelectedIndex(clamped)
    if (clamped !== wanted) {
      this.syncing = true
      try {
        this.write("currentIndex", options.length === 0 ? -1 : clamped)
      } finally {
        this.syncing = false
      }
    }
    this.syncCurrentItem()
  }

  private syncCurrentItem(): void {
    const i = Number(this.peek("currentIndex"))
    const entry = this.entries[i]
    this.write("currentItem", entry ? entry.modelData : null)
  }

  protected override get acceptsVisualChildren(): boolean {
    return false
  }
}

export class ListView extends ListBase {
  declare readonly renderable: SelectRenderable

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    this.passthrough("descriptionColor", { color: true })
    this.passthrough("showDescription", { type: "bool", value: true })
    this.passthrough("showScrollIndicator", { type: "bool", value: false })
    this.passthrough("showSelectionIndicator", { type: "bool", value: true })
    this.passthrough("itemSpacing", { type: "int", value: 0 })
    this.passthrough("fastScrollStep", { type: "int", value: 5 })
    this.passthrough("font", { type: "var" })
  }

  protected override createRenderable(engine: QmlEngine, typeName: string): Renderable {
    return new SelectRenderable(engine.renderer, { id: nextRenderableId(typeName), options: [] })
  }

  protected increment(): void {
    this.renderable.moveDown()
  }

  protected decrement(): void {
    this.renderable.moveUp()
  }

  protected setOptions(options: ListOption[]): void {
    this.renderable.options = options as never
  }
}

export class TabBar extends ListBase {
  declare readonly renderable: TabSelectRenderable

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    this.passthrough("tabWidth", { type: "int", value: 20 })
    this.passthrough("showDescription", { type: "bool", value: true })
    this.passthrough("showUnderline", { type: "bool", value: true })
    this.passthrough("showScrollArrows", { type: "bool", value: true })
  }

  protected override createRenderable(engine: QmlEngine, typeName: string): Renderable {
    return new TabSelectRenderable(engine.renderer, { id: nextRenderableId(typeName), options: [] })
  }

  protected increment(): void {
    this.renderable.moveRight()
  }

  protected decrement(): void {
    this.renderable.moveLeft()
  }

  protected setOptions(options: ListOption[]): void {
    this.renderable.setOptions(options as never)
  }
}

// TabSelect uses the same event names as Select.
void TabSelectRenderableEvents
