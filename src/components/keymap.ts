/**
 * Keyboard shortcuts declared in QML.
 *
 * ```qml
 * Shortcut { sequence: "ctrl+s"; onActivated: save() }          // or sequences: ["ctrl+s", "f2"]
 * Keymap {
 *     name: "main"
 *     bindings: ({ "ctrl+s": "save", "q": "quit", "?": { action: "help", description: "Help" } })
 *     KeyBinding { keys: "ctrl+r"; action: "reload"; description: "Reload the file" }
 *     Action { name: "save"; shortcut: "ctrl+s"; onTriggered: save() }
 *     handlers: ({ save: () => save(), quit: () => Qt.quit() })
 *     onActivated: (action, event) => console.log(action)
 * }
 * ```
 *
 * All enabled Keymaps and Shortcuts share the engine's key dispatcher: they are checked in
 * `priority` order (higher first, default 0), then creation (document) order, before the focused
 * renderable and before `Keys.*` handlers. The first match runs, and the key is consumed
 * (`stopPropagation()` + `preventDefault()`) unless the handler sets `event.accepted = false`.
 *
 * While a text editor (TextInput / TextArea) has focus, plain printable keys and editing keys
 * (no ctrl / meta / super) are left to the editor: a `"q"` binding doesn't swallow typing.
 *
 * Key strings: `"ctrl+s"`, `"shift+tab"`, `"alt+enter"` (alt = meta = option), `"escape"` /
 * `"esc"`, `"return"` / `"enter"`, `"space"`, `"up"`, `"pageup"`, `"f5"`, single characters
 * `"q"`, `"?"`, `"+"`. Modifiers are case-insensitive; a lone uppercase letter means shift
 * (`"Q"` == `"shift+q"`, but `"Ctrl+S"` == `"ctrl+s"`). Shift is ignored when matching single symbols like `"?"`.
 */
import { EditBufferRenderable, type KeyEvent } from "@opentui/core"
import { QmlObject, toQmlObject } from "../runtime/object.ts"
import { untrack } from "../runtime/reactive.ts"
import type { QmlEngine } from "../runtime/engine.ts"
import { isPrintableSequence, keyDispatcherFor, makeQmlKeyEvent, type QmlKeyEvent } from "./key-dispatcher.ts"
import { isVisual } from "./visual.ts"

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

function tryParse(engine: QmlEngine, where: string, keys: string): ParsedKeySequence | null {
  try {
    return parseKeySequence(keys)
  } catch (err) {
    engine.warn(`${where}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/** Keys that a focused text editor should get even when a shortcut matches. */
function isEditingKey(event: KeyEvent): boolean {
  if (event.ctrl || event.meta || event.option || event.super) return false
  if (isPrintableSequence(event.sequence)) return true
  return ["space", "backspace", "delete", "left", "right", "home", "end", "return", "linefeed"].includes(event.name)
}

function editorHasFocus(engine: QmlEngine): boolean {
  return engine.renderer?.currentFocusedRenderable instanceof EditBufferRenderable
}

/** Nearest visual ancestor (for `context: "item"`). */
function enclosingVisual(obj: QmlObject): QmlObject | null {
  for (let p = obj.parent; p; p = p.parent) if (isVisual(p)) return p
  return null
}

// -----------------------------------------------------------------------------------------------
// Shortcut

export class Shortcut extends QmlObject {
  private parsed: ParsedKeySequence[] = []

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    this.defineProperty("sequence", { type: "string" })
    this.defineProperty("sequences", { type: "var", value: [] })
    this.defineProperty("enabled", { type: "bool", value: true })
    this.defineProperty("context", { type: "string", value: "application" })
    this.defineProperty("autoRepeat", { type: "bool", value: true })
    this.defineProperty("priority", {
      type: "int",
      value: 0,
      onChange: () => keyDispatcherFor(engine).sort(),
    })
    this.defineSignal("activated", ["event"])
    this.defineSignal("activatedAmbiguously")
    this.watch(() => {
      const seqs: string[] = []
      const one = this.get("sequence") as string
      if (one) seqs.push(one)
      const many = this.get("sequences")
      if (Array.isArray(many)) seqs.push(...many.map(String))
      untrack(() => {
        this.parsed = seqs.map((k) => tryParse(engine, this.describe(), k)).filter((p) => p !== null)
      })
    })
    const self = this
    const unregister = keyDispatcherFor(engine).add({
      get priority() {
        return Number(self.peek("priority")) || 0
      },
      handle: (e) => this.handle(e),
    })
    this.onDestroy(unregister)
  }

  private handle(event: KeyEvent): boolean {
    if (!this.isCompleted || !this.peek("enabled")) return false
    if (!this.peek("autoRepeat") && (event.eventType === "repeat" || event.repeated)) return false
    if (!this.parsed.some((p) => keyEventMatches(event, p))) return false
    if (editorHasFocus(this.engine) && isEditingKey(event)) return false
    if (this.peek("context") === "item") {
      const item = enclosingVisual(this)
      if (item && isVisual(item)) {
        const r = item.renderable
        if (!r.focused && !r.hasFocusedDescendant) return false
      }
    }
    const qevent = makeQmlKeyEvent(event, true)
    this.emit("activated", qevent)
    return qevent.accepted
  }
}

// -----------------------------------------------------------------------------------------------
// Keymap / KeyBinding

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
 * `Action { name: "save"; shortcut: "ctrl+s"; onTriggered: save() }` — a named action inside a
 * Keymap. `triggered(event)` fires whenever the Keymap activates `name`; `shortcut` (a key
 * string or an array) adds bindings for it. `trigger()` fires it programmatically.
 */
export class Action extends QmlObject {
  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    this.defineProperty("name", { type: "string" })
    this.defineProperty("text", { type: "string" })
    this.defineProperty("shortcut", { type: "var" })
    this.defineProperty("description", { type: "string" })
    this.defineProperty("enabled", { type: "bool", value: true })
    this.defineSignal("triggered", ["event"])
    this.defineMethod("trigger", () => this.emit("triggered", null))
  }
}

export interface KeymapEntry {
  keys: string
  action: string
  description: string
}

interface CompiledEntry extends KeymapEntry {
  parsed: ParsedKeySequence
}

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
function bindingEntries(obj: unknown): Array<{ keys: string; action: string | null; description: string }> {
  if (!obj || typeof obj !== "object") return []
  const out: Array<{ keys: string; action: string | null; description: string }> = []
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

export class Keymap extends QmlObject {
  private entries: CompiledEntry[] = []
  private overrides: Record<string, unknown> = {}

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    this.defineProperty("name", { type: "string" })
    this.defineProperty("bindings", { type: "var", value: {} })
    this.defineProperty("handlers", { type: "var", value: {} })
    this.defineProperty("enabled", { type: "bool", value: true })
    this.defineProperty("priority", {
      type: "int",
      value: 0,
      onChange: () => keyDispatcherFor(engine).sort(),
    })
    this.defineProperty("overridesRevision", { type: "int", value: 0 })
    this.defineSignal("activated", ["action", "event"])
    this.defineMethod("describe", () => this.describeBindings())
    this.defineMethod("keysFor", (action: string) =>
      this.entries.filter((e) => e.action === action).map((e) => e.keys),
    )

    this.watch(() => {
      const list: Array<{ keys: string; action: string | null; description: string }> = []
      list.push(...bindingEntries(this.get("bindings")))
      for (const child of this.trackChildren()) {
        if (!(child instanceof KeyBinding) || !child.get("enabled")) continue
        const keys = child.get("keys")
        const action = String(child.get("action") ?? "")
        const description = String(child.get("description") ?? "")
        const keyList = Array.isArray(keys) ? keys.map(String) : keys ? [String(keys)] : []
        for (const k of keyList) list.push({ keys: k, action, description })
      }
      for (const child of this.trackChildren()) {
        if (!(child instanceof Action)) continue
        const keys = child.get("shortcut")
        const action = String(child.get("name") ?? "")
        const description = String(child.get("description") || child.get("text") || "")
        const keyList = Array.isArray(keys) ? keys.map(String) : keys ? [String(keys)] : []
        for (const k of keyList) list.push({ keys: k, action, description })
      }
      this.get("overridesRevision")
      list.push(...bindingEntries(this.overrides))
      untrack(() => this.compile(list))
    })

    keymapsOf(engine).add(this)
    const self = this
    const unregister = keyDispatcherFor(engine).add({
      get priority() {
        return Number(self.peek("priority")) || 0
      },
      handle: (e) => this.handle(e),
    })
    this.onDestroy(() => {
      unregister()
      keymapsOf(engine).delete(this)
    })
  }

  protected override onCompleted(): void {
    super.onCompleted()
    const pending = keymapOverrides.get(this.engine)
    if (pending) this.applyOverrides(pending)
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

  private compile(list: Array<{ keys: string; action: string | null; description: string }>): void {
    // Later entries override earlier ones for the same (normalised) key.
    const byKey = new Map<string, CompiledEntry | null>()
    for (const item of list) {
      const parsed = tryParse(this.engine, this.describe(), item.keys)
      if (!parsed) continue
      const id = formatKeySequence(parsed)
      byKey.delete(id)
      byKey.set(id, item.action === null ? null : { keys: item.keys, action: item.action, description: item.description, parsed })
    }
    this.entries = [...byKey.values()].filter((e): e is CompiledEntry => e !== null)
  }

  /** `[{ keys, action, description }]` for help screens. */
  describeBindings(): KeymapEntry[] {
    return this.entries.map(({ keys, action, description }) => ({ keys, action, description }))
  }

  private handle(event: KeyEvent): boolean {
    if (!this.isCompleted || !this.peek("enabled")) return false
    const entry = this.entries.find((e) => keyEventMatches(event, e.parsed))
    if (!entry) return false
    if (editorHasFocus(this.engine) && isEditingKey(event)) return false
    const qevent: QmlKeyEvent = makeQmlKeyEvent(event, true)
    this.emit("activated", entry.action, qevent)
    const handlers = this.peek("handlers") as Record<string, unknown> | null
    const fn = handlers && typeof handlers === "object" ? handlers[entry.action] : undefined
    if (typeof fn === "function") {
      try {
        fn.call(this.proxy, qevent, entry.action)
      } catch (err) {
        this.engine.reportError(err, `${this.describe()}: handler for "${entry.action}"`)
      }
    }
    for (const child of this.children) {
      if (child instanceof Action && child.peek("name") === entry.action && child.peek("enabled")) {
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
