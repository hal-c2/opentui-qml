/**
 * VisualObject / Item — base classes for every QML type that owns an OpenTUI renderable.
 *
 * CONTRACT (other modules depend on these names; keep them stable):
 *   - `VisualObject` (abstract) with `readonly renderable: Renderable`
 *   - `isVisual(obj)` type guard
 *   - `Item` — the plain flex container type (BoxRenderable without border)
 *   - `visualIndexFor(parent, index)` — maps a QmlObject child index (which counts
 *     non-visual children such as Timer/Repeater/ListModel) to the renderable child index.
 *   - `nextRenderableId(typeName)`
 *
 * Child management: when a VisualObject child is appended/removed, its renderable is
 * added to / removed from this object's `contentRenderable` (defaults to `renderable`;
 * types like ScrollView can override to route children elsewhere).
 *
 * `Item` implements the common property set shared by all visual types:
 *   - size: `width` / `height` (number, `"50%"`, `"auto"`), read-only layout results
 *     `x`, `y` (relative to the parent renderable), `layoutWidth`, `layoutHeight`;
 *   - every OpenTUI layout prop as a passthrough (`flexGrow`, `padding`, `alignItems`, ...);
 *   - `implicitWidth` / `implicitHeight` (used when `width` / `height` are not set);
 *   - `visible`, `display` ("flex" / "none"), `opacity`, `z` (zIndex), `enabled`, `focus`
 *     (writable, Qt style), read-only `focused` / `activeFocus`, `focusable`, `spacing` (gap);
 *   - mouse signals `mouseDown/Up/Move/Drag/DragEnd/Drop/Over/Out/Scroll(mouse)` and
 *     `sizeChanged(width, height)`;
 *   - `anchors.fill` / `anchors.centerIn` / `anchors.margins` (best effort, flexbox based);
 *   - attached `Layout.*`, `Keys.*` (incl. `Keys.onPaste` / `Keys.onReleased`),
 *     `Window.onPaste` and `Screen.on<Signal>` handlers;
 *   - methods `forceActiveFocus()` (and the proxy's built-in `destroy()`).
 *
 * Subclasses override `createRenderable()` and redeclare the field with
 * `declare readonly renderable: XRenderable` (never a plain field: with ESNext class fields a
 * redeclared field would be reset to undefined after `super()` returns).
 */
import {
  BoxRenderable,
  decodePasteBytes,
  type KeyEvent,
  type MouseEvent,
  type PasteEvent,
  type Renderable,
} from "@opentui/core"
import { QmlObject, toQmlObject } from "../runtime/object.ts"
import { createHandler } from "../runtime/expression.ts"
import type { QmlEngine } from "../runtime/engine.ts"
import type { HandlerSpec, PropertyType } from "../runtime/types.ts"
import {
  focusKeyClaimFor,
  keyDispatcherFor,
  makeQmlKeyEvent,
  type KeyEventKind,
  type QmlKeyEvent,
} from "./key-dispatcher.ts"
import { connectScreenHandler } from "./screen.ts"

let nextId = 0
export function nextRenderableId(typeName: string): string {
  return `qml-${typeName.toLowerCase()}-${++nextId}`
}

export function isVisual(obj: unknown): obj is VisualObject {
  return obj instanceof VisualObject
}

/**
 * Number of visual siblings that precede `index` among `parent.children` (only those whose
 * renderable is mounted in the parent: a `Portal` mounts elsewhere).
 */
export function visualIndexFor(parent: QmlObject, index: number): number {
  let n = 0
  for (let i = 0; i < index && i < parent.children.length; i++) {
    const c = parent.children[i]
    if (isVisual(c) && c.mountsInParent) n++
  }
  return n
}

const renderableOwners = new WeakMap<Renderable, VisualObject>()

/** The visual object owning `renderable` (or the nearest owned renderable ancestor). */
export function visualForRenderable(renderable: Renderable | null | undefined): VisualObject | null {
  for (let r: Renderable | null | undefined = renderable; r; r = r.parent) {
    const obj = renderableOwners.get(r)
    if (obj && !obj.isDestroyed) return obj
  }
  return null
}

export abstract class VisualObject extends QmlObject {
  abstract readonly renderable: Renderable

  /** Where child renderables are mounted. Defaults to `renderable`. */
  get contentRenderable(): Renderable {
    return this.renderable
  }

  /**
   * False for leaf renderables that cannot host arbitrary children (Text, TextInput, ListView,
   * ...). Visual children of such types are not mounted (a warning is logged once).
   */
  protected get acceptsVisualChildren(): boolean {
    return true
  }

  /** False when the renderable is mounted somewhere else than the QML parent (`Portal`). */
  get mountsInParent(): boolean {
    return true
  }

  /**
   * Remove a child renderable from `contentRenderable`. Overridden by types whose renderable
   * refuses a plain `remove()` (LineNumbers' target).
   */
  detachChildRenderable(child: Renderable): void {
    if (child.parent) child.parent.remove(child)
  }

  private warnedChildren = false

  protected override onChildAdded(child: QmlObject, index: number): void {
    super.onChildAdded(child, index)
    if (isVisual(child) && child.mountsInParent) {
      if (!this.acceptsVisualChildren) {
        if (!this.warnedChildren) {
          this.warnedChildren = true
          this.engine.warn(`${this.describe()}: ${this.typeName} cannot contain visual children (${child.describe()} is not shown)`)
        }
        return
      }
      const target = this.contentRenderable
      const visualIndex = visualIndexFor(this, index)
      if (visualIndex >= target.getChildrenCount()) target.add(child.renderable)
      else target.add(child.renderable, visualIndex)
    }
  }

  protected override onChildRemoved(child: QmlObject, _index: number): void {
    super.onChildRemoved(child, _index)
    if (isVisual(child) && child.renderable.parent === this.contentRenderable) {
      this.detachChildRenderable(child.renderable)
    }
  }

  override destroy(): void {
    if (this.isDestroyed || this.isDestroying) return
    super.destroy()
    const r = this.renderable
    if (r.isDestroyed) return
    const p = this.parent
    try {
      if (isVisual(p) && r.parent && r.parent === p.contentRenderable) p.detachChildRenderable(r)
      else if (r.parent) r.parent.remove(r)
    } catch (err) {
      this.engine.reportError(err, `${this.describe()}: destroy`)
    }
    r.destroyRecursively()
  }
}

// -----------------------------------------------------------------------------------------------
// Value helpers shared by the components

/** Dimension-ish values: numbers, numeric strings → number, "50%"/"auto" kept, null → undefined. */
export function coerceDimension(v: unknown): unknown {
  if (v === null || v === undefined || v === "") return undefined
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined
  if (typeof v === "string") {
    const t = v.trim()
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
    return t
  }
  return v
}

/**
 * Colour values for OpenTUI: strings and RGBA pass through (OpenTUI parses them), `{r,g,b,a}`
 * objects (0..1) become `#rrggbbaa`, empty/null → undefined.
 */
export function toColor(v: unknown): unknown {
  if (v === null || v === undefined || v === "") return undefined
  if (typeof v === "string") return v
  if (typeof v === "object") {
    const o = v as { r?: unknown; g?: unknown; b?: unknown; a?: unknown; buffer?: unknown }
    if (o.buffer !== undefined) return v // RGBA instance
    if (typeof o.r === "number" && typeof o.g === "number" && typeof o.b === "number") {
      const h = (x: number): string =>
        Math.round(Math.min(1, Math.max(0, x)) * 255)
          .toString(16)
          .padStart(2, "0")
      return `#${h(o.r)}${h(o.g)}${h(o.b)}${h(typeof o.a === "number" ? o.a : 1)}`
    }
  }
  return String(v)
}

type AnyRenderable = Renderable & Record<string, any>

/** Layout props passed straight through to the renderable (setter of the same name). */
export const LAYOUT_PROPS = [
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "flexGrow",
  "flexShrink",
  "flexBasis",
  "flexDirection",
  "flexWrap",
  "alignItems",
  "alignSelf",
  "justifyContent",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "margin",
  "marginX",
  "marginY",
  "marginTop",
  "marginRight",
  "marginBottom",
  "marginLeft",
  "padding",
  "paddingX",
  "paddingY",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "overflow",
  "zIndex",
  "translateX",
  "translateY",
  // Box-only (pushed only when the renderable has the setter)
  "gap",
  "rowGap",
  "columnGap",
] as const

/** Value pushed when a layout prop goes from a value back to undefined. */
const LAYOUT_RESET: Record<string, unknown> = { width: "auto", height: "auto", zIndex: 0, translateX: 0, translateY: 0 }

// -----------------------------------------------------------------------------------------------
// Layout results tracker (x / y / layoutWidth / layoutHeight)

class LayoutTracker {
  readonly items = new Set<Item>()
  private scheduled = false

  constructor(engine: QmlEngine) {
    engine.renderer?.root?.on?.("layout-changed", () => this.schedule())
  }

  schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      for (const item of [...this.items]) item.syncLayout()
    })
  }
}

const layoutTrackers = new WeakMap<QmlEngine, LayoutTracker>()

function layoutTrackerFor(engine: QmlEngine): LayoutTracker {
  let t = layoutTrackers.get(engine)
  if (!t) {
    t = new LayoutTracker(engine)
    layoutTrackers.set(engine, t)
  }
  return t
}

// -----------------------------------------------------------------------------------------------
// Keys.* routing

/**
 * Per-engine registry of items with `Keys.*` handlers. One dispatcher entry at the lowest
 * priority (after every Keymap/Shortcut) delivers each key to the focused item and its QML
 * ancestors (innermost first) until accepted, then to every root item that was not on that
 * chain (root `Keys.onPressed` sees every key that nothing else consumed).
 */
class KeysRegistry {
  readonly items = new Set<Item>()
  private unsubs: Partial<Record<KeyEventKind, () => void>> = {}

  constructor(private readonly engine: QmlEngine) {}

  add(item: Item, kind: KeyEventKind): void {
    this.items.add(item)
    if (!this.unsubs[kind]) {
      this.unsubs[kind] = keyDispatcherFor(this.engine).add(
        { priority: Number.NEGATIVE_INFINITY, handle: (e) => this.handle(e, kind) },
        kind,
      )
    }
  }

  remove(item: Item): void {
    this.items.delete(item)
    if (this.items.size === 0) {
      for (const k of Object.keys(this.unsubs) as KeyEventKind[]) this.unsubs[k]?.()
      this.unsubs = {}
    }
  }

  private handle(event: KeyEvent, kind: KeyEventKind): boolean {
    const qevent = makeQmlKeyEvent(event, false)
    const visited = new Set<QmlObject>()
    const focused = this.engine.renderer?.currentFocusedRenderable ?? null
    const focusedItem = visualForRenderable(focused)
    // A focused renderable that claims the key (an EmbeddedTerminal) gets it before any QML
    // ancestor or root handler; only the item owning it may still intercept.
    const claimed = focusKeyClaimFor(this.engine.renderer)?.claims(event) ?? false
    for (let o: QmlObject | null = focusedItem; o; o = o.parent) {
      visited.add(o)
      if (claimed && o !== focusedItem) continue
      if (o instanceof Item && this.items.has(o) && o.deliverKey(qevent, kind)) return true
    }
    if (claimed) return false
    for (const item of [...this.items]) {
      if (item.parent || visited.has(item) || item.isDestroyed) continue
      if (item.deliverKey(qevent, kind)) return true
    }
    return false
  }
}

const keysRegistries = new WeakMap<QmlEngine, KeysRegistry>()

function keysRegistryFor(engine: QmlEngine): KeysRegistry {
  let r = keysRegistries.get(engine)
  if (!r) {
    r = new KeysRegistry(engine)
    keysRegistries.set(engine, r)
  }
  return r
}

// -----------------------------------------------------------------------------------------------
// Paste routing (`Keys.onPaste` / `Window.onPaste`)

/** Event passed to `Keys.onPaste` / `Window.onPaste`. Set `accepted = true` to consume it. */
export interface QmlPasteEvent {
  type: "paste"
  /** The pasted text (`decodePasteBytes`). */
  text: string
  bytes: Uint8Array
  metadata?: unknown
  accepted: boolean
  original: PasteEvent
}

function makePasteEvent(e: PasteEvent): QmlPasteEvent {
  let accepted = false
  return {
    type: "paste",
    text: decodePasteBytes(e.bytes),
    bytes: e.bytes,
    metadata: e.metadata,
    original: e,
    get accepted() {
      return accepted
    },
    set accepted(v: boolean) {
      accepted = !!v
      if (accepted) {
        e.preventDefault()
        e.stopPropagation()
      }
    },
  }
}

type PasteHandler = { fn: (...args: unknown[]) => unknown; global: boolean }

/**
 * Per-engine paste routing, a global `keyInput` "paste" listener (it runs before the focused
 * renderable's own paste handling). `Keys.onPaste` handlers see the paste like keys: focused item
 * and its ancestors first, then root items; `Window.onPaste` handlers always see it afterwards
 * (unless it was accepted). Accepting a paste stops the focused input from inserting it.
 */
class PasteRegistry {
  private readonly items = new Map<Item, PasteHandler[]>()
  private unsub: (() => void) | null = null

  constructor(private readonly engine: QmlEngine) {}

  add(item: Item, fn: PasteHandler["fn"], global: boolean): void {
    const list = this.items.get(item) ?? []
    list.push({ fn, global })
    this.items.set(item, list)
    const keyInput = this.engine.renderer?.keyInput
    if (!this.unsub && keyInput) {
      const h = (e: PasteEvent): void => this.handle(e)
      keyInput.on("paste", h)
      this.unsub = () => keyInput.off("paste", h)
    }
  }

  remove(item: Item): void {
    this.items.delete(item)
    if (this.items.size === 0 && this.unsub) {
      this.unsub()
      this.unsub = null
    }
  }

  private deliver(item: Item, event: QmlPasteEvent, global: boolean): boolean {
    if (item.isDestroyed || !item.peek("enabled")) return false
    for (const h of this.items.get(item) ?? []) {
      if (h.global !== global) continue
      try {
        h.fn(event)
      } catch (err) {
        this.engine.reportError(err, `${item.describe()}: onPaste`)
      }
      if (event.accepted) return true
    }
    return false
  }

  private handle(e: PasteEvent): void {
    if (e.defaultPrevented || e.propagationStopped) return
    const event = makePasteEvent(e)
    const visited = new Set<QmlObject>()
    const focused = this.engine.renderer?.currentFocusedRenderable ?? null
    for (let o: QmlObject | null = visualForRenderable(focused); o; o = o.parent) {
      visited.add(o)
      if (o instanceof Item && this.items.has(o) && this.deliver(o, event, false)) return
    }
    for (const item of [...this.items.keys()]) {
      if (item.parent || visited.has(item)) continue
      if (this.deliver(item, event, false)) return
    }
    for (const item of [...this.items.keys()]) if (this.deliver(item, event, true)) return
  }
}

const pasteRegistries = new WeakMap<QmlEngine, PasteRegistry>()

function pasteRegistryFor(engine: QmlEngine): PasteRegistry {
  let r = pasteRegistries.get(engine)
  if (!r) {
    r = new PasteRegistry(engine)
    pasteRegistries.set(engine, r)
  }
  return r
}

/** `Keys.onReturnPressed` & co: handler name → key test. */
function specificKeyTest(handlerName: string): ((e: QmlKeyEvent) => boolean) | null {
  const m = /^on([A-Z][A-Za-z0-9]*)Pressed$/.exec(handlerName)
  if (!m) return null
  const key = m[1]!.toLowerCase()
  switch (key) {
    case "return":
    case "enter":
      return (e) => e.key === "return" || e.key === "enter" || e.key === "kpenter"
    case "back":
    case "backspace":
      return (e) => e.key === "backspace"
    case "backtab":
      return (e) => e.key === "tab" && e.shift
    case "tab":
      return (e) => e.key === "tab" && !e.shift
    case "digit0":
    case "digit1":
    case "digit2":
    case "digit3":
    case "digit4":
    case "digit5":
    case "digit6":
    case "digit7":
    case "digit8":
    case "digit9":
      return (e) => e.key === key.slice(5)
    default:
      return (e) => e.key === key
  }
}

// -----------------------------------------------------------------------------------------------
// Mouse

export interface QmlMouseEvent {
  type: string
  button: number
  /** Position relative to the item. */
  x: number
  y: number
  screenX: number
  screenY: number
  modifiers: { shift: boolean; alt: boolean; ctrl: boolean }
  scroll?: unknown
  accepted: boolean
  original: MouseEvent
}

function makeMouseEvent(e: MouseEvent, r: Renderable): QmlMouseEvent {
  let accepted = false
  return {
    type: e.type,
    button: e.button,
    x: e.x - r.screenX,
    y: e.y - r.screenY,
    screenX: e.x,
    screenY: e.y,
    modifiers: { ...e.modifiers },
    scroll: e.scroll,
    original: e,
    get accepted() {
      return accepted
    },
    set accepted(v: boolean) {
      accepted = !!v
      if (accepted) {
        e.stopPropagation()
        e.preventDefault()
      }
    },
  }
}

/** OpenTUI mouse event type → QML signal name. */
const MOUSE_SIGNALS: Record<string, string> = {
  down: "mouseDown",
  up: "mouseUp",
  move: "mouseMove",
  drag: "mouseDrag",
  "drag-end": "mouseDragEnd",
  drop: "mouseDrop",
  over: "mouseOver",
  out: "mouseOut",
  scroll: "mouseScroll",
}

// -----------------------------------------------------------------------------------------------
// Item

const LAYOUT_ATTACHED = new Set([
  "fillWidth",
  "fillHeight",
  "preferredWidth",
  "preferredHeight",
  "minimumWidth",
  "minimumHeight",
  "maximumWidth",
  "maximumHeight",
  "alignment",
  "margins",
])

function alignSelfFor(alignment: unknown, axis: "row" | "column"): string | undefined {
  if (alignment === undefined || alignment === null || alignment === "") return undefined
  const s = String(alignment)
  const has = (flag: string): boolean => s.includes(flag)
  if (["auto", "flex-start", "flex-end", "center", "stretch", "baseline"].includes(s)) return s
  if (s === "start" || s === "left" || s === "top") return "flex-start"
  if (s === "end" || s === "right" || s === "bottom") return "flex-end"
  if (has("AlignCenter")) return "center"
  if (axis === "column") {
    if (has("AlignHCenter")) return "center"
    if (has("AlignRight")) return "flex-end"
    if (has("AlignLeft")) return "flex-start"
  } else {
    if (has("AlignVCenter")) return "center"
    if (has("AlignBottom")) return "flex-end"
    if (has("AlignTop")) return "flex-start"
  }
  return undefined
}

export class Item extends VisualObject {
  readonly renderable: Renderable

  private readonly keyHandlers = new Map<string, (...args: unknown[]) => unknown>()
  private keysEnabled = true
  private readonly layoutAttached = new Map<string, unknown>()
  private syncingFocus = false
  private anchorsApplied = false

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    this.renderable = this.createRenderable(engine, typeName)
    renderableOwners.set(this.renderable, this)
    const r = this.renderable as AnyRenderable

    // Size
    for (const name of ["width", "height"] as const) {
      const implicit = name === "width" ? "implicitWidth" : "implicitHeight"
      this.defineProperty(name, {
        type: "var",
        coerce: coerceDimension,
        onChange: (v, old) => {
          if (this.anchorFillTarget()) return
          const fallback = this.peek(implicit)
          this.pushLayout(name, v ?? fallback, old ?? fallback)
        },
      })
      // Qt's implicit size: the size used when no explicit width/height is set.
      this.defineProperty(implicit, {
        type: "var",
        coerce: coerceDimension,
        onChange: (v, old) => {
          if (this.anchorFillTarget() || this.peek(name) !== undefined) return
          this.pushLayout(name, v, old)
        },
      })
    }
    for (const name of ["x", "y", "layoutWidth", "layoutHeight"]) {
      this.defineProperty(name, { type: "real", readonly: true, value: 0 })
    }

    // Layout passthrough
    for (const name of LAYOUT_PROPS) {
      this.defineProperty(name, {
        type: "var",
        coerce: coerceDimension,
        onChange: (v, old) => this.pushLayout(name, v, old),
      })
    }
    this.defineProperty("spacing", {
      type: "var",
      coerce: coerceDimension,
      onChange: (v, old) => {
        if (this.peek("gap") === undefined) this.pushLayout("gap", v, old)
      },
    })

    // `visible: false` and `display: "none"` both map to yoga display none (Renderable.visible).
    const applyVisible = (): void => {
      if (!r.isDestroyed) r.visible = !!this.peek("visible") && this.peek("display") !== "none"
    }
    this.defineProperty("visible", { type: "bool", value: true, onChange: applyVisible })
    this.defineProperty("display", { type: "string", value: "flex", onChange: applyVisible })
    this.defineProperty("opacity", {
      type: "real",
      value: 1,
      onChange: (v) => (r.opacity = Math.min(1, Math.max(0, Number(v)))),
    })
    this.defineProperty("z", { type: "real", value: 0, onChange: (v) => (r.zIndex = Math.trunc(Number(v) || 0)) })
    this.defineProperty("enabled", {
      type: "bool",
      value: true,
      onChange: (v) => {
        if (!v && r.focused) r.blur()
      },
    })

    // Focus
    this.defineProperty("focusable", {
      type: "bool",
      value: r.focusable,
      onChange: (v) => (r.focusable = !!v),
    })
    this.defineProperty("focus", {
      type: "bool",
      value: false,
      onChange: (v) => {
        if (this.syncingFocus || !this.isCompleted) return
        this.applyFocus(!!v)
      },
    })
    // `focused` (OpenTUI name) and `activeFocus` (Qt name): read-only, true while focused.
    this.defineProperty("focused", { type: "bool", readonly: true, value: false })
    this.defineProperty("activeFocus", { type: "bool", readonly: true, value: false })
    r.on("focused", () => this.syncFocus(true))
    r.on("blurred", () => this.syncFocus(false))
    this.defineMethod("forceActiveFocus", () => this.forceActiveFocus())

    // Anchors (best effort, flexbox based)
    this.defineProperty("anchors.fill", { type: "var", value: null, onChange: () => this.applyAnchors() })
    this.defineProperty("anchors.centerIn", { type: "var", value: null, onChange: () => this.applyAnchors() })
    this.defineProperty("anchors.margins", {
      type: "var",
      coerce: coerceDimension,
      onChange: (v, old) => this.pushLayout("margin", v, old),
    })

    // Mouse: one catch-all listener (`onMouse`), so renderables that install their own per-type
    // handlers (Slider, ScrollBar, EmbeddedTerminal) keep working.
    for (const signal of Object.values(MOUSE_SIGNALS)) this.defineSignal(signal, ["mouse"])
    r.onMouse = (e: MouseEvent) => {
      const signal = MOUSE_SIGNALS[e.type]
      if (!signal || !this.peek("enabled") || this.isDestroyed) return
      this.emit(signal, makeMouseEvent(e, this.renderable))
    }
    this.defineSignal("sizeChanged", ["width", "height"])
    r.onSizeChange = () => {
      if (!this.isDestroyed) this.emit("sizeChanged", r.width, r.height)
    }

    const tracker = layoutTrackerFor(engine)
    tracker.items.add(this)
    this.onDestroy(() => tracker.items.delete(this))
  }

  /** Create the renderable. Called from the Item constructor: don't rely on subclass fields. */
  protected createRenderable(engine: QmlEngine, typeName: string): Renderable {
    return new BoxRenderable(engine.renderer, { id: nextRenderableId(typeName), border: false })
  }

  /**
   * Define a property whose value is pushed into a renderable setter (`target`, default: the
   * same name). Undefined values (and empty colours) are never pushed. For typed props without
   * an explicit `value`, the initial value is read from the renderable's getter when it has one.
   */
  passthrough(
    name: string,
    opts: {
      type?: PropertyType
      target?: string
      color?: boolean
      value?: unknown
      on?: () => Renderable
      map?: (v: unknown) => unknown
    } = {},
  ): void {
    const type = opts.type ?? (opts.color ? "color" : "var")
    const targetName = opts.target ?? name
    const target = (): AnyRenderable => (opts.on ? opts.on() : this.renderable) as AnyRenderable
    let value = opts.value
    if (value === undefined && type !== "var" && type !== "color") {
      const cur = target()[targetName]
      if (cur !== undefined && cur !== null && typeof cur !== "function" && typeof cur !== "object") value = cur
    }
    this.defineProperty(name, {
      type,
      ...(value !== undefined ? { value } : {}),
      onChange: (v) => {
        let out = opts.color ? toColor(v) : v
        if (opts.map) out = opts.map(out)
        if (out === undefined) return
        const r = target()
        if (r.isDestroyed) return
        try {
          r[targetName] = out
        } catch (err) {
          this.engine.reportError(err, `${this.describe()}: ${name}`)
        }
      },
    })
  }

  /** Push a layout value into the renderable (skipping undefined, resetting on removal). */
  protected pushLayout(name: string, v: unknown, old: unknown): void {
    if (v === undefined && old === undefined) return
    const r = this.renderable as AnyRenderable
    if (!(name in r)) return
    try {
      r[name] = v === undefined ? LAYOUT_RESET[name] : v
    } catch (err) {
      this.engine.reportError(err, `${this.describe()}: ${name}`)
    }
  }

  // --- layout results ---------------------------------------------------------------------------

  /** Copy the computed layout into `x`, `y`, `layoutWidth`, `layoutHeight`. */
  syncLayout(): void {
    const r = this.renderable
    if (this.isDestroyed || r.isDestroyed) return
    const p = r.parent
    this.write("x", r.x - (p ? p.x : 0))
    this.write("y", r.y - (p ? p.y : 0))
    this.write("layoutWidth", r.width)
    this.write("layoutHeight", r.height)
  }

  // --- focus --------------------------------------------------------------------------------------

  forceActiveFocus(): void {
    this.syncingFocus = true
    try {
      this.write("focus", true)
    } finally {
      this.syncingFocus = false
    }
    this.applyFocus(true)
  }

  protected applyFocus(v: boolean): void {
    const r = this.renderable
    if (r.isDestroyed) return
    if (v) {
      if (!this.peek("enabled") || r.focused) return
      if (!r.focusable) {
        r.focusable = true
        this.write("focusable", true)
      }
      r.focus()
    } else if (r.focused) {
      r.blur()
    }
  }

  protected syncFocus(focused: boolean): void {
    if (this.isDestroyed) return
    this.syncingFocus = true
    try {
      this.write("focus", focused)
      this.write("focused", focused)
      this.write("activeFocus", focused)
    } finally {
      this.syncingFocus = false
    }
  }

  // --- anchors ------------------------------------------------------------------------------------

  private anchorFillTarget(): VisualObject | null {
    const t = toQmlObject(this.peek("anchors.fill"))
    return isVisual(t) ? t : null
  }

  private applyAnchors(): void {
    const r = this.renderable
    if (r.isDestroyed) return
    const fill = this.anchorFillTarget()
    if (fill) {
      if (fill !== this.parent) this.engine.warn(`${this.describe()}: anchors.fill only supports the parent item`)
      r.width = "100%"
      r.height = "100%"
      this.anchorsApplied = true
    } else if (this.anchorsApplied) {
      this.anchorsApplied = false
      r.width = (this.peek("width") as never) ?? (this.peek("implicitWidth") as never) ?? "auto"
      r.height = (this.peek("height") as never) ?? (this.peek("implicitHeight") as never) ?? "auto"
    }
    const centerIn = toQmlObject(this.peek("anchors.centerIn"))
    if (isVisual(centerIn)) {
      if (centerIn !== this.parent) {
        this.engine.warn(`${this.describe()}: anchors.centerIn only supports the parent item`)
      }
      const target = centerIn.contentRenderable as AnyRenderable
      target.alignItems = "center"
      target.justifyContent = "center"
    }
  }

  // --- attached properties / handlers -------------------------------------------------------------

  override setAttached(attachedType: string, name: string, value: unknown): void {
    if (attachedType === "Keys" && name === "enabled") {
      this.keysEnabled = !!value
      super.setAttached(attachedType, name, value)
      return
    }
    if (attachedType === "Layout") {
      if (!LAYOUT_ATTACHED.has(name)) {
        this.engine.warn(`${this.describe()}: unsupported attached property "Layout.${name}"`)
      }
      this.layoutAttached.set(name, value)
      super.setAttached(attachedType, name, value)
      if (this.isCompleted) this.applyLayoutAttached()
      return
    }
    super.setAttached(attachedType, name, value)
  }

  /** Apply `Layout.*` (needs the parent's direction, so only after completion). */
  private applyLayoutAttached(): void {
    if (this.layoutAttached.size === 0) return
    const r = this.renderable as AnyRenderable
    if (r.isDestroyed) return
    const parentR = r.parent as (Renderable & { primaryAxis?: string; flexDirection?: string }) | null
    const dir = String(
      parentR?.primaryAxis ?? (isVisual(this.parent) ? (this.parent.peek("flexDirection") ?? "column") : "column"),
    )
    const axis: "row" | "column" = dir.startsWith("row") ? "row" : "column"
    const get = (k: string): unknown => this.layoutAttached.get(k)
    const fill = (along: boolean, on: unknown): void => {
      if (on === undefined) return
      if (along) {
        if (this.peek("flexGrow") === undefined) r.flexGrow = on ? 1 : 0
        if (on && this.peek("flexShrink") === undefined) r.flexShrink = 1
      } else if (this.peek("alignSelf") === undefined) {
        r.alignSelf = on ? "stretch" : "auto"
      }
    }
    fill(axis === "row", get("fillWidth"))
    fill(axis === "column", get("fillHeight"))
    const dim = (key: string, prop: string, own: string): void => {
      const v = coerceDimension(get(key))
      if (v !== undefined && this.peek(own) === undefined) r[prop] = v
    }
    dim("preferredWidth", "width", "width")
    dim("preferredHeight", "height", "height")
    dim("minimumWidth", "minWidth", "minWidth")
    dim("minimumHeight", "minHeight", "minHeight")
    dim("maximumWidth", "maxWidth", "maxWidth")
    dim("maximumHeight", "maxHeight", "maxHeight")
    dim("margins", "margin", "margin")
    const align = alignSelfFor(get("alignment"), axis)
    if (align && this.peek("alignSelf") === undefined) (r as Record<string, unknown>).alignSelf = align
  }

  override attachHandler(attachedType: string, handlerName: string, spec: HandlerSpec): void {
    if (attachedType === "Screen") {
      if (!connectScreenHandler(this, handlerName, spec)) super.attachHandler(attachedType, handlerName, spec)
      return
    }
    if (handlerName === "onPaste" && (attachedType === "Keys" || attachedType === "Window")) {
      const fn = createHandler(spec.compiled, spec.scope, ["event"])
      const registry = pasteRegistryFor(this.engine)
      registry.add(this, fn, attachedType === "Window")
      this.onDestroy(() => registry.remove(this))
      return
    }
    if (attachedType !== "Keys") return super.attachHandler(attachedType, handlerName, spec)
    const kind: KeyEventKind = handlerName === "onReleased" ? "keyrelease" : "keypress"
    if (handlerName !== "onPressed" && handlerName !== "onReleased" && !specificKeyTest(handlerName)) {
      return super.attachHandler(attachedType, handlerName, spec)
    }
    this.keyHandlers.set(handlerName, createHandler(spec.compiled, spec.scope, ["event"]))
    const registry = keysRegistryFor(this.engine)
    registry.add(this, kind)
    this.onDestroy(() => registry.remove(this))
  }

  /** Deliver a key to this item's `Keys.*` handlers. Returns true when accepted. */
  deliverKey(event: QmlKeyEvent, kind: KeyEventKind): boolean {
    if (!this.keysEnabled || !this.peek("enabled") || this.isDestroyed) return false
    const call = (fn: (...args: unknown[]) => unknown): boolean => {
      try {
        fn(event)
      } catch (err) {
        this.engine.reportError(err, `${this.describe()}: Keys handler`)
      }
      return event.accepted
    }
    if (kind === "keyrelease") {
      const fn = this.keyHandlers.get("onReleased")
      return fn ? call(fn) : false
    }
    for (const [name, fn] of this.keyHandlers) {
      if (name === "onPressed" || name === "onReleased") continue
      if (specificKeyTest(name)?.(event) && call(fn)) return true
    }
    const fn = this.keyHandlers.get("onPressed")
    return fn ? call(fn) : false
  }

  // --- lifecycle ----------------------------------------------------------------------------------

  protected override onCompleted(): void {
    super.onCompleted()
    this.applyAnchors()
    this.applyLayoutAttached()
    if (this.peek("focus")) this.applyFocus(true)
  }

  override destroy(): void {
    if (this.isDestroyed || this.isDestroying) return
    const r = this.renderable
    if (r.focused) r.blur()
    super.destroy()
  }
}
