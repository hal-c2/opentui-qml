/**
 * Keyboard shortcuts declared in QML, on top of `@opentui/keymap` (one keymap per engine, see
 * `keymap-host.ts`).
 *
 * ```qml
 * Shortcut { sequence: "ctrl+s"; onActivated: save() }          // or sequences: ["ctrl+s", "f2"]
 * Keymap {
 *     name: "main"
 *     leader: "space"
 *     bindings: ({ "ctrl+s": "save", "gg": "top", "<leader>q": { action: "quit", description: "Quit" } })
 *     KeyBinding { keys: "ctrl+x ctrl+r"; action: "reload"; description: "Reload the file" }
 *     Action { name: "save"; shortcut: "mod+s"; text: "Save"; onTriggered: save() }
 *     handlers: ({ save: () => save(), quit: () => Qt.quit() })
 *     onActivated: (action, event) => console.log(action)
 * }
 * ```
 *
 * Every `Shortcut`, `Keymap` and standalone `Action` registers one keymap layer. Layers are
 * checked by `priority` (higher first, default 0), then document order (earlier first), before
 * the focused renderable and before `Keys.*` handlers. The first binding whose handler accepts
 * the key consumes it (`preventDefault()` + `stopPropagation()`); a handler that sets
 * `event.accepted = false` rejects it and dispatch falls through to the next matching binding
 * or layer, and then to the focused renderable and `Keys.onPressed`.
 *
 * `context` ("window" default, "item", "application"): "item" layers are active only while
 * focus is inside the enclosing visual item; "window" and "item" layers yield plain printable
 * and editing keys (no ctrl / alt / super) to a focused TextInput / TextArea, so a `"q"`
 * shortcut doesn't swallow typing. "application" layers always win.
 *
 * Key strings: `"ctrl+s"`, `"shift+tab"`, `"alt+enter"` (alt = meta = option), `"mod+s"` (ctrl,
 * cmd on macOS), `"escape"` / `"esc"`, `"return"` / `"enter"`, `"space"`, `"up"`, `"f5"`, single
 * characters `"q"`, `"?"`, `"+"`; sequences `"gg"`, `"ctrl+x ctrl+s"`, `"<leader>s"`; and
 * comma-separated alternatives `"ctrl+s, f2"`. Modifiers are case-insensitive; a lone uppercase
 * letter means shift (`"Q"` == `"shift+q"`, but `"Ctrl+S"` == `"ctrl+s"`). Shift is ignored
 * when matching single symbols like `"?"`.
 */
import type { KeyEvent, Renderable } from "@opentui/core"
import type { CommandContext } from "@opentui/keymap"
import { QmlObject, toQmlObject } from "../runtime/object.ts"
import { createSignal, untrack } from "../runtime/reactive.ts"
import type { QmlEngine } from "../runtime/engine.ts"
import { makeQmlKeyEvent, type QmlKeyEvent } from "./key-dispatcher.ts"
import { isVisual } from "./visual.ts"
import {
  LayerSlot,
  keyboardHostFor,
  toKeymapKeys,
  type ActiveKeyInfo,
  type KeyboardHost,
  type QmlKeymapLayer,
} from "./keymap-host.ts"

// -----------------------------------------------------------------------------------------------
// Key sequences

export interface ParsedKeySequence {
  /** Normalised key name as OpenTUI reports it (`"s"`, `"return"`, `"up"`, `"?"`). */
  name: string
  ctrl: boolean
  shift: boolean
  /** alt / meta / option */
  meta: boolean
  super: boolean
  /** Match regardless of shift (single non-letter symbols like "?" or "+"). */
  anyShift: boolean
}

const MODIFIERS: Record<string, "ctrl" | "shift" | "meta" | "super"> = {
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  alt: "meta",
  meta: "meta",
  option: "meta",
  opt: "meta",
  super: "super",
  cmd: "super",
  command: "super",
  win: "super",
}

const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  enter: "return",
  ret: "return",
  kpenter: "return",
  del: "delete",
  ins: "insert",
  pgup: "pageup",
  pgdn: "pagedown",
  pgdown: "pagedown",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  bs: "backspace",
  spacebar: "space",
  " ": "space",
  kpdecimal: ".",
  kpdivide: "/",
  kpmultiply: "*",
  kpminus: "-",
  kpplus: "+",
  kpequal: "=",
  kpseparator: ",",
  kpleft: "left",
  kpright: "right",
  kpup: "up",
  kpdown: "down",
  kppageup: "pageup",
  kppagedown: "pagedown",
  kphome: "home",
  kpend: "end",
  kpinsert: "insert",
  kpdelete: "delete",
}

/** Normalise a key name (lowercase multi-char names, resolve aliases, keypad digits). */
export function normalizeKeyName(name: string): string {
  if (name.length === 1) return name === " " ? "space" : name
  const lower = name.toLowerCase()
  if (/^kp[0-9]$/.test(lower)) return lower.slice(2)
  return KEY_ALIASES[lower] ?? lower
}

/** Parse `"ctrl+shift+s"` & co. Throws on an empty string or an unknown modifier. */
export function parseKeySequence(input: string): ParsedKeySequence {
  const s = String(input).trim() === "" && String(input).length > 0 ? " " : String(input).trim()
  if (s === "") throw new Error("empty key sequence")
  const m = /^((?:[A-Za-z]+\+)*)(.+)$/.exec(s)!
  const mods = m[1] ? m[1].slice(0, -1).split("+") : []
  let key = m[2]!
  const parsed: ParsedKeySequence = { name: "", ctrl: false, shift: false, meta: false, super: false, anyShift: false }
  for (const mod of mods) {
    const which = MODIFIERS[mod.toLowerCase()]
    if (!which) throw new Error(`unknown modifier "${mod}" in key sequence "${input}"`)
    parsed[which] = true
  }
  if (key.length === 1) {
    if (/[A-Z]/.test(key)) {
      key = key.toLowerCase()
      // "Q" means shift+q; with modifiers the case is ignored ("Ctrl+S" == "ctrl+s").
      if (mods.length === 0) parsed.shift = true
    } else if (!/[a-z0-9]/.test(key) && key !== " " && !mods.some((x) => MODIFIERS[x.toLowerCase()] === "shift")) {
      parsed.anyShift = true
    }
  }
  parsed.name = normalizeKeyName(key)
  return parsed
}

/** Format a parsed sequence as `"ctrl+shift+s"`. */
export function formatKeySequence(seq: ParsedKeySequence | string): string {
  const p = typeof seq === "string" ? parseKeySequence(seq) : seq
  const parts: string[] = []
  if (p.ctrl) parts.push("ctrl")
  if (p.meta) parts.push("alt")
  if (p.super) parts.push("super")
  if (p.shift) parts.push("shift")
  parts.push(p.name)
  return parts.join("+")
}

type KeyLike = Pick<KeyEvent, "name"> & Partial<Pick<KeyEvent, "ctrl" | "shift" | "meta" | "option" | "super">>

/** Does an OpenTUI key event (or `{ name, ctrl, shift, meta }`) match a parsed sequence? */
export function keyEventMatches(event: KeyLike, parsed: ParsedKeySequence): boolean {
  let name = normalizeKeyName(event.name ?? "")
  let shift = !!event.shift
  if (name.length === 1 && /[A-Z]/.test(name)) {
    name = name.toLowerCase()
    shift = true
  }
  if (name !== parsed.name) return false
  if (!!event.ctrl !== parsed.ctrl) return false
  if (!!(event.meta || event.option) !== parsed.meta) return false
  if (!!event.super !== parsed.super) return false
  if (!parsed.anyShift && shift !== parsed.shift) return false
  return true
}

// -----------------------------------------------------------------------------------------------
// Shared plumbing

type KeyContext = "window" | "item" | "application"

function toContext(v: unknown): KeyContext {
  return v === "item" || v === "application" ? v : "window"
}

/** Nearest visual ancestor (for `context: "item"`). */
function enclosingVisual(obj: QmlObject): QmlObject | null {
  for (let p = obj.parent; p; p = p.parent) if (isVisual(p)) return p
  return null
}

/** A key string or an array of key strings → list. */
function keyList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x) => x !== null && x !== undefined && x !== "").map(String)
  return v === null || v === undefined || v === "" ? [] : [String(v)]
}

/** Keymap keys for a QML key string; warns and returns [] when it is invalid. */
function keysOrWarn(obj: QmlObject, key: string): string[] {
  try {
    return toKeymapKeys(key)
  } catch (err) {
    obj.engine.warn(`${obj.describe()}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

/** Only non-empty string fields (the metadata addon rejects empty `desc` / `title`). */
function textFields(fields: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === "string" && v.trim() !== "") out[k] = v
  }
  return out
}

/** The event handed to `onActivated` / `onTriggered`; `payload` is set for dispatched commands. */
export interface QmlCommandEvent extends QmlKeyEvent {
  payload?: unknown
}

function qmlEvent(host: KeyboardHost, event: KeyEvent | null | undefined, payload?: unknown): QmlCommandEvent {
  const e = makeQmlKeyEvent(event ?? host.commandEvent(), true) as QmlCommandEvent
  if (payload !== undefined) e.payload = payload
  return e
}

type LayerCtx = CommandContext<Renderable, KeyEvent>

/** Base of the types that own one keymap layer. */
abstract class KeymapLayerObject extends QmlObject {
  protected readonly host: KeyboardHost
  protected readonly slot: LayerSlot
  /** Document order among all layers of the engine (earlier wins ties). */
  private readonly layerIndex: number
  /** `qmlOwner` layer field: attributes graph layers / pending sequences to this object. */
  readonly ownerId: string
  private readonly completedSignal = createSignal(false)

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    this.host = keyboardHostFor(engine)
    this.slot = new LayerSlot(this.host, this)
    this.layerIndex = this.host.nextLayerIndex()
    this.ownerId = `${typeName}#${this.layerIndex}`
    this.onDestroy(() => this.slot.dispose())
  }

  protected override onCompleted(): void {
    super.onCompleted()
    this.completedSignal[1](true)
  }

  /** Reactive `isCompleted` (layers are registered once the object is complete). */
  protected completed(): boolean {
    return this.completedSignal[0]()
  }

  /** Priority (+ document order), enabled matcher, target and editor guard. */
  protected baseLayer(priority: unknown, context: KeyContext, target: QmlObject | null): QmlKeymapLayer {
    const layer: QmlKeymapLayer = {
      priority: (Number(priority) || 0) + 0.5 / (this.layerIndex + 1),
      enabled: () => !this.isDestroyed && !!this.peek("enabled"),
      qmlYieldToEditor: context !== "application",
      qmlOwner: this.ownerId,
    }
    const t = target ?? (context === "item" ? enclosingVisual(this) : null)
    if (t && isVisual(t)) {
      layer.target = t.renderable as Renderable
      layer.targetMode = "focus-within"
    }
    return layer
  }

  /** `enabled` is read at dispatch time; changing it only needs to refresh help data. */
  protected defineEnabled(): void {
    this.defineProperty("enabled", { type: "bool", value: true, onChange: () => this.host.touch() })
  }
}

// -----------------------------------------------------------------------------------------------
// Shortcut

/**
 * `Shortcut { sequence: "ctrl+s"; onActivated: (event) => save() }`: one or more key sequences
 * (`sequence`, `sequences`) that emit `activated(event)`. `event.accepted = false` falls through.
 */
export class Shortcut extends KeymapLayerObject {
  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    this.defineProperty("sequence", { type: "string" })
    this.defineProperty("sequences", { type: "var", value: [] })
    this.defineEnabled()
    this.defineProperty("context", { type: "string", value: "window" })
    this.defineProperty("autoRepeat", { type: "bool", value: true })
    this.defineProperty("priority", { type: "int", value: 0 })
    this.defineProperty("description", { type: "string" })
    this.defineSignal("activated", ["event"])
    this.defineSignal("activatedAmbiguously")
    this.watch(() => {
      if (!this.completed()) return
      const seqs = [...keyList(this.get("sequence")), ...keyList(this.get("sequences"))]
      const context = toContext(this.get("context"))
      const priority = this.get("priority")
      const description = String(this.get("description") ?? "")
      untrack(() => {
        const keys = seqs.flatMap((k) => keysOrWarn(this, k))
        if (keys.length === 0) return this.slot.set(null)
        const layer = this.baseLayer(priority, context, null)
        const cmd = (ctx: LayerCtx): boolean => this.activate(ctx.event)
        layer.bindings = keys.map((key) => ({ key, cmd, ...textFields({ desc: description }) }))
        this.slot.set(layer)
      })
    })
  }

  private activate(event: KeyEvent): boolean {
    if (this.isDestroyed || !this.peek("enabled")) return false
    if (!this.peek("autoRepeat") && (event.eventType === "repeat" || event.repeated)) return false
    const qevent = makeQmlKeyEvent(event, true)
    this.emit("activated", qevent)
    return qevent.accepted
  }
}

// -----------------------------------------------------------------------------------------------
// KeyBinding / Action

export class KeyBinding extends QmlObject {
  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    /** A key string or an array of key strings. */
    this.defineProperty("keys", { type: "var" })
    this.defineProperty("action", { type: "string" })
    this.defineProperty("description", { type: "string" })
    this.defineProperty("enabled", { type: "bool", value: true })
  }
}

/**
 * `Action { name: "save"; shortcut: "ctrl+s"; text: "Save"; onTriggered: save() }` — a named
 * command. Inside a Keymap it is one of the Keymap's actions: `triggered(event)` fires whenever
 * the Keymap activates `name`, and `shortcut` (a key string or an array) adds bindings for it.
 * Outside a Keymap it registers its own layer with the command and its shortcut bindings.
 * `trigger(payload?)` dispatches the command `name` (like `Keyboard.dispatch(name)`), falling
 * back to emitting `triggered` directly when no active command handles it.
 */
export class Action extends KeymapLayerObject {
  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    this.defineProperty("name", { type: "string" })
    this.defineProperty("text", { type: "string" })
    this.defineProperty("shortcut", { type: "var" })
    this.defineProperty("description", { type: "string" })
    this.defineProperty("category", { type: "string" })
    this.defineEnabled()
    this.defineProperty("context", { type: "string", value: "window" })
    this.defineProperty("priority", { type: "int", value: 0 })
    this.defineSignal("triggered", ["event"])
    this.defineMethod("trigger", (payload?: unknown) => this.trigger(payload))
    this.watch(() => {
      if (!this.completed() || this.parent instanceof Keymap) return
      const name = String(this.get("name") ?? "")
      const shortcut = keyList(this.get("shortcut"))
      const text = String(this.get("text") ?? "")
      const description = String(this.get("description") ?? "")
      const category = String(this.get("category") ?? "")
      const context = toContext(this.get("context"))
      const priority = this.get("priority")
      untrack(() => {
        const keys = shortcut.flatMap((k) => keysOrWarn(this, k))
        if (!name && keys.length === 0) return this.slot.set(null)
        const layer = this.baseLayer(priority, context, null)
        if (name) {
          layer.commands = [
            {
              name,
              run: (ctx: LayerCtx) => this.fire(ctx.event, ctx.payload),
              ...textFields({ title: text, desc: description || text, category }),
            },
          ]
        }
        const cmd = (ctx: LayerCtx): boolean => this.fire(ctx.event)
        layer.bindings = keys.map((key) => ({ key, cmd, ...textFields({ qmlCommand: name, desc: description || text }) }))
        this.slot.set(layer)
      })
    })
  }

  /** Emit `triggered` (if enabled); returns `event.accepted`. */
  fire(event: KeyEvent | null, payload?: unknown): boolean {
    if (this.isDestroyed || !this.peek("enabled")) return false
    const qevent = qmlEvent(this.host, event, payload)
    this.emit("triggered", qevent)
    return qevent.accepted
  }

  /** Dispatch the command `name`; without an active command, emit `triggered` directly. */
  trigger(payload?: unknown): boolean {
    const name = String(this.peek("name") ?? "")
    if (name && !this.host.isDestroyed) {
      const result = this.host.dispatchCommand(name, payload)
      if (result.ok) return true
      if (result.reason === "rejected" || result.reason === "error") return false
    }
    return this.fire(null, payload)
  }
}

// -----------------------------------------------------------------------------------------------
// Keymap

export interface KeymapEntry {
  keys: string
  action: string
  description: string
}

interface CompiledEntry extends KeymapEntry {
  normalized: string[]
}

type RawEntry = { keys: string; action: string | null; description: string }

const keymapRegistry = new WeakMap<QmlEngine, Set<Keymap>>()
const keymapOverrides = new WeakMap<QmlEngine, Record<string, unknown>>()

function keymapsOf(engine: QmlEngine): Set<Keymap> {
  let s = keymapRegistry.get(engine)
  if (!s) {
    s = new Set()
    keymapRegistry.set(engine, s)
  }
  return s
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) && !toQmlObject(v)
}

/** Entries of a bindings object: `{ keys: "action" | { action, description } | null }`. */
function bindingEntries(obj: unknown): RawEntry[] {
  if (!obj || typeof obj !== "object") return []
  const out: RawEntry[] = []
  for (const [keys, value] of Object.entries(obj as Record<string, unknown>)) {
    if (value === null || value === undefined || value === false) {
      out.push({ keys, action: null, description: "" })
    } else if (typeof value === "string") {
      out.push({ keys, action: value, description: "" })
    } else if (typeof value === "object") {
      const o = value as Record<string, unknown>
      if (typeof o.action === "string") {
        out.push({ keys, action: o.action, description: o.description === undefined ? "" : String(o.description) })
      }
    }
  }
  return out
}

interface ActionMeta {
  title: string
  description: string
  category: string
}

/**
 * A named set of key bindings → action names. Each activation emits `activated(action, event)`,
 * calls `handlers[action](event, action)` and emits `triggered(event)` on enabled `Action`
 * children with that name. Every action is also a keymap command (`Keyboard.dispatch(action)`).
 */
export class Keymap extends KeymapLayerObject {
  private entries: CompiledEntry[] = []
  private overrides: Record<string, unknown> = {}
  private readonly entriesRev = createSignal(0, { equals: false })
  private leaderKey = ""
  private releaseLeader: (() => void) | null = null

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    this.defineProperty("name", { type: "string" })
    this.defineProperty("bindings", { type: "var", value: {} })
    this.defineProperty("handlers", { type: "var", value: {} })
    this.defineEnabled()
    this.defineProperty("priority", { type: "int", value: 0 })
    this.defineProperty("context", { type: "string", value: "window" })
    /** A visual item: the keymap is active only while focus is inside it. */
    this.defineProperty("target", { type: "var", value: null })
    /** The key of the `<leader>` token (e.g. "space", "ctrl+x"). */
    this.defineProperty("leader", { type: "string" })
    this.defineProperty("pendingSequence", { type: "string", readonly: true, value: "" })
    this.defineProperty("overridesRevision", { type: "int", value: 0 })
    this.defineSignal("activated", ["action", "event"])
    this.defineMethod("describe", () => this.describeBindings())
    this.defineMethod("keysFor", (action: string) => {
      this.entriesRev[0]()
      return this.entries.filter((e) => e.action === action).map((e) => e.keys)
    })
    this.defineMethod("activeKeys", (): ActiveKeyInfo[] => this.host.activeKeys({ owner: this.ownerId }))
    this.defineMethod("dispatch", (action: unknown, payload?: unknown) => {
      if (this.isDestroyed || !this.peek("enabled")) return false
      return this.invoke(String(action ?? ""), null, payload)
    })

    this.watch(() => {
      if (!this.completed()) return
      const list: RawEntry[] = [...bindingEntries(this.get("bindings"))]
      const meta = new Map<string, ActionMeta>()
      for (const child of this.trackChildren()) {
        if (!(child instanceof KeyBinding) || !child.get("enabled")) continue
        const action = String(child.get("action") ?? "")
        const description = String(child.get("description") ?? "")
        for (const k of keyList(child.get("keys"))) list.push({ keys: k, action, description })
      }
      for (const child of this.trackChildren()) {
        if (!(child instanceof Action)) continue
        const action = String(child.get("name") ?? "")
        const text = String(child.get("text") ?? "")
        const description = String(child.get("description") || text)
        if (action && !meta.has(action)) {
          meta.set(action, { title: text, description, category: String(child.get("category") ?? "") })
        }
        for (const k of keyList(child.get("shortcut"))) list.push({ keys: k, action, description })
      }
      this.get("overridesRevision")
      list.push(...bindingEntries(this.overrides))
      const handlers = this.get("handlers")
      const context = toContext(this.get("context"))
      const target = toQmlObject(this.get("target"))
      const leader = String(this.get("leader") ?? "")
      const priority = this.get("priority")
      untrack(() => {
        this.setLeader(leader)
        this.compile(list)
        const names = new Set<string>(this.entries.map((e) => e.action))
        for (const name of meta.keys()) names.add(name)
        if (handlers && typeof handlers === "object") for (const name of Object.keys(handlers)) names.add(name)
        names.delete("")
        const layer = this.baseLayer(priority, context, target)
        layer.commands = [...names].map((name) => {
          const m = meta.get(name)
          const desc = m?.description || this.entries.find((e) => e.action === name && e.description)?.description || ""
          return {
            name,
            run: (ctx: LayerCtx) => this.invoke(name, ctx.event, ctx.payload),
            ...textFields({ title: m?.title, desc, category: m?.category }),
          }
        })
        // Bindings without a description share the first one given for the same action.
        const described = new Map<string, string>()
        for (const e of this.entries) if (e.description && !described.has(e.action)) described.set(e.action, e.description)
        layer.bindings = this.entries.flatMap((e) => {
          const cmd = (ctx: LayerCtx): boolean => this.invoke(e.action, ctx.event)
          const desc = e.description || meta.get(e.action)?.description || described.get(e.action)
          const fields = textFields({ qmlCommand: e.action, desc })
          return e.normalized.map((key) => ({ key, cmd, ...fields }))
        })
        this.slot.set(layer)
      })
    })

    keymapsOf(engine).add(this)
    const offPending = this.host.onPendingChange(() =>
      this.write("pendingSequence", this.host.ownsPending(this.ownerId) ? this.host.pendingSequence() : ""),
    )
    this.onDestroy(() => {
      offPending()
      keymapsOf(engine).delete(this)
      this.setLeader("")
    })
  }

  protected override onCompleted(): void {
    const pending = keymapOverrides.get(this.engine)
    if (pending) this.applyOverrides(pending)
    super.onCompleted()
  }

  /** Merge user overrides for this keymap (see `applyKeymapOverrides`). */
  applyOverrides(all: Record<string, unknown>): void {
    const name = this.peek("name") as string
    let mine: Record<string, unknown> = {}
    if (name) {
      const v = all[name]
      if (isPlainObject(v)) mine = v
    } else {
      for (const [k, v] of Object.entries(all)) if (!isPlainObject(v) || typeof v.action === "string") mine[k] = v
    }
    this.overrides = { ...this.overrides, ...mine }
    this.write("overridesRevision", (Number(this.peek("overridesRevision")) || 0) + 1)
  }

  private setLeader(leader: string): void {
    if (leader === this.leaderKey) return
    this.leaderKey = leader
    this.releaseLeader?.()
    this.releaseLeader = null
    if (!leader) return
    const key = keysOrWarn(this, leader)[0]
    if (!key) return
    this.host.mutate(() => {
      if (this.leaderKey !== leader || this.isDestroyed) return
      this.releaseLeader?.()
      this.releaseLeader = this.host.setToken(this, "leader", key)
    })
  }

  private compile(list: RawEntry[]): void {
    // Later entries override earlier ones for the same (normalised) key.
    const byKey = new Map<string, CompiledEntry | null>()
    for (const item of list) {
      const normalized = keysOrWarn(this, item.keys)
      if (normalized.length === 0) continue
      const id = normalized.join(",")
      byKey.delete(id)
      byKey.set(
        id,
        item.action === null ? null : { keys: item.keys, action: item.action, description: item.description, normalized },
      )
    }
    this.entries = [...byKey.values()].filter((e): e is CompiledEntry => e !== null)
    this.entriesRev[1](0)
  }

  /** `[{ keys, action, description }]` for help screens (reactive). */
  describeBindings(): KeymapEntry[] {
    this.entriesRev[0]()
    return this.entries.map(({ keys, action, description }) => ({ keys, action, description }))
  }

  /**
   * Run `action`: emit `activated(action, event)`, call the handler, trigger enabled `Action`
   * children named `action`. Returns `event.accepted` (false rejects the key / command).
   */
  invoke(action: string, event: KeyEvent | null, payload?: unknown): boolean {
    if (this.isDestroyed) return false
    const qevent = qmlEvent(this.host, event, payload)
    this.emit("activated", action, qevent)
    const handlers = this.peek("handlers") as Record<string, unknown> | null
    const fn = handlers && typeof handlers === "object" ? handlers[action] : undefined
    if (typeof fn === "function") {
      try {
        fn.call(this.proxy, qevent, action)
      } catch (err) {
        this.engine.reportError(err, `${this.describe()}: handler for "${action}"`)
      }
    }
    for (const child of this.children) {
      if (child instanceof Action && child.peek("name") === action && child.peek("enabled")) {
        child.emit("triggered", qevent)
      }
    }
    return qevent.accepted
  }
}

/**
 * Merge key binding overrides (e.g. loaded from JSON) into the engine's Keymaps:
 * `{ main: { "ctrl+s": "save" } }` goes to `Keymap { name: "main" }`; top-level
 * `"keys": "action"` entries go to unnamed keymaps. A `null` action removes a binding.
 * Keymaps created later receive the overrides on completion.
 */
export function applyKeymapOverrides(engine: QmlEngine, overrides: Record<string, unknown>): void {
  const merged: Record<string, unknown> = { ...(keymapOverrides.get(engine) ?? {}) }
  for (const [k, v] of Object.entries(overrides)) {
    const prev = merged[k]
    merged[k] = isPlainObject(v) && isPlainObject(prev) && typeof v.action !== "string" ? { ...prev, ...v } : v
  }
  keymapOverrides.set(engine, merged)
  for (const keymap of keymapsOf(engine)) {
    if (keymap.isCompleted) keymap.applyOverrides(overrides)
  }
}
