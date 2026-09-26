/**
 * Per-engine keyboard dispatch for `Keys.*` attached handlers. (`Shortcut` / `Action` / `Keymap`
 * run on `@opentui/keymap`, see `keymap-host.ts`; its listener is prepended, so keymap bindings
 * see a key first and a consumed key never reaches this dispatcher.)
 *
 * One listener is installed (lazily) on `renderer.keyInput` for "keypress" (and one for
 * "keyrelease" when needed). Events whose propagation was stopped are skipped. Global keyInput
 * listeners run before OpenTUI's focused-renderable handlers, so an entry that consumes a key
 * (`stopPropagation()` + `preventDefault()`) keeps it away from the focused TextInput / ListView.
 *
 * Entries are ordered by `priority` (higher first), then by registration order. The first entry
 * whose `handle()` returns true consumes the event and dispatch stops.
 */
import type { CliRenderer, KeyEvent, Renderable } from "@opentui/core"
import type { QmlEngine } from "../runtime/engine.ts"

// -----------------------------------------------------------------------------------------------
// Focus key claims
//
// A focused renderable that consumes most of the keyboard (an EmbeddedTerminal) registers a
// claim. While it has focus, `Keys.*` handlers of its QML ancestors and "window" / "item"
// keymap layers yield every key it claims; "application" shortcuts and the item's own
// `Keys.*` handlers still run first.

export interface KeyStroke {
  name: string
  ctrl: boolean
  shift: boolean
  /** alt / option */
  meta: boolean
  super: boolean
}

export interface FocusKeyClaim {
  /** True when the focused renderable wants this key for itself. */
  claims(event: KeyEvent): boolean
  /** Stroke form, for `Keyboard.activeKeys()` style listings. */
  claimsStroke(stroke: KeyStroke): boolean
}

const focusKeyClaims = new WeakMap<Renderable, FocusKeyClaim>()

/** Register (or with `null` remove) the key claim of a renderable while it is focused. */
export function setFocusKeyClaim(renderable: Renderable, claim: FocusKeyClaim | null): void {
  if (claim) focusKeyClaims.set(renderable, claim)
  else focusKeyClaims.delete(renderable)
}

/** The claim of the currently focused renderable, if it registered one. */
export function focusKeyClaimFor(renderer: CliRenderer | null | undefined): FocusKeyClaim | null {
  const focused = renderer?.currentFocusedRenderable
  return (focused && focusKeyClaims.get(focused)) ?? null
}

/** Canonical `ctrl+alt+shift+super+name` form of a stroke (modifiers in that order, lower case). */
export function strokeId(s: KeyStroke): string {
  const name = s.name.toLowerCase()
  return `${s.ctrl ? "ctrl+" : ""}${s.meta ? "alt+" : ""}${s.shift ? "shift+" : ""}${s.super ? "super+" : ""}${name}`
}

/** Stroke of a key event (alt and option both count as alt). */
export function eventStroke(event: KeyEvent): KeyStroke {
  return {
    name: event.name ?? "",
    ctrl: !!event.ctrl,
    shift: !!event.shift,
    meta: !!(event.meta || event.option),
    super: !!event.super,
  }
}

/** Parse a user key string (`"ctrl+q"`, `"Escape"`, `"alt+x"`, `"Ctrl+Shift+C"`) into a stroke id. */
export function parseStrokeId(text: string): string {
  const parts = String(text).trim().split("+")
  const s: KeyStroke = { name: "", ctrl: false, shift: false, meta: false, super: false }
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i]!
    const p = raw.toLowerCase()
    const last = i === parts.length - 1
    if (!last && (p === "ctrl" || p === "control")) s.ctrl = true
    else if (!last && (p === "alt" || p === "option" || p === "meta")) s.meta = true
    else if (!last && p === "shift") s.shift = true
    else if (!last && (p === "super" || p === "cmd" || p === "win")) s.super = true
    else s.name = KEY_ALIASES[p] ?? p
  }
  return strokeId(s)
}

const KEY_ALIASES: Record<string, string> = { esc: "escape", enter: "return", " ": "space" }

export type KeyEventKind = "keypress" | "keyrelease"

export interface KeyDispatchEntry {
  /** Higher priority entries see the key first. */
  readonly priority: number
  /** Return true when the event was handled (it is then stopped and default-prevented). */
  handle(event: KeyEvent): boolean
}

interface Registered {
  entry: KeyDispatchEntry
  order: number
}

export class KeyDispatcher {
  private readonly lists: Record<KeyEventKind, Registered[]> = { keypress: [], keyrelease: [] }
  private readonly listeners: Partial<Record<KeyEventKind, (event: KeyEvent) => void>> = {}
  private order = 0

  constructor(private readonly engine: QmlEngine) {}

  /** Register an entry; returns an unregister function. */
  add(entry: KeyDispatchEntry, kind: KeyEventKind = "keypress"): () => void {
    const list = this.lists[kind]
    const reg: Registered = { entry, order: ++this.order }
    list.push(reg)
    this.sort(kind)
    this.install(kind)
    return () => {
      const i = list.indexOf(reg)
      if (i >= 0) list.splice(i, 1)
      if (list.length === 0) this.uninstall(kind)
    }
  }

  /** Re-sort after an entry's priority changed. */
  sort(kind: KeyEventKind = "keypress"): void {
    this.lists[kind].sort((a, b) => b.entry.priority - a.entry.priority || a.order - b.order)
  }

  /** Dispatch an event through the entries (also used directly by tests). */
  dispatch(event: KeyEvent, kind: KeyEventKind = "keypress"): boolean {
    for (const { entry } of this.lists[kind].slice()) {
      if (event.propagationStopped) return true
      let handled = false
      try {
        handled = entry.handle(event)
      } catch (err) {
        this.engine.reportError(err, "key handler")
        continue
      }
      if (handled) {
        event.stopPropagation()
        event.preventDefault()
        return true
      }
    }
    return event.propagationStopped
  }

  private install(kind: KeyEventKind): void {
    if (this.listeners[kind]) return
    const keyInput = this.engine.renderer?.keyInput
    if (!keyInput) return
    const listener = (event: KeyEvent): void => {
      this.dispatch(event, kind)
    }
    this.listeners[kind] = listener
    keyInput.on(kind, listener)
  }

  private uninstall(kind: KeyEventKind): void {
    const listener = this.listeners[kind]
    if (!listener) return
    delete this.listeners[kind]
    this.engine.renderer?.keyInput?.off(kind, listener)
  }
}

const dispatchers = new WeakMap<QmlEngine, KeyDispatcher>()

/** The engine's shared key dispatcher. */
export function keyDispatcherFor(engine: QmlEngine): KeyDispatcher {
  let d = dispatchers.get(engine)
  if (!d) {
    d = new KeyDispatcher(engine)
    dispatchers.set(engine, d)
  }
  return d
}

/** True for a single printable character sequence. */
export function isPrintableSequence(seq: string | undefined): boolean {
  if (!seq) return false
  const chars = [...seq]
  if (chars.length !== 1) return false
  const code = chars[0]!.codePointAt(0)!
  return code >= 32 && code !== 127
}

/** The JS event object handed to QML key handlers (`Keys.onPressed`, `Shortcut`, `Keymap`). */
export interface QmlKeyEvent {
  key: string
  name: string
  text: string
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
  super: boolean
  sequence: string
  eventType: string
  accepted: boolean
  isAutoRepeat: boolean
  original: KeyEvent
}

/**
 * Wrap an OpenTUI KeyEvent. `accepted` starts at `acceptedDefault`; setting it to true
 * stops propagation and prevents the default action (the focused renderable won't see it).
 */
export function makeQmlKeyEvent(event: KeyEvent, acceptedDefault: boolean): QmlKeyEvent {
  let accepted = acceptedDefault
  const alt = !!(event.meta || event.option)
  return {
    key: event.name,
    name: event.name,
    text: isPrintableSequence(event.sequence) ? event.sequence : "",
    ctrl: !!event.ctrl,
    shift: !!event.shift,
    alt,
    meta: alt,
    super: !!event.super,
    sequence: event.sequence ?? "",
    eventType: event.eventType ?? "press",
    isAutoRepeat: event.eventType === "repeat" || !!event.repeated,
    original: event,
    get accepted() {
      return accepted
    },
    set accepted(v: boolean) {
      accepted = !!v
      if (accepted) {
        event.stopPropagation()
        event.preventDefault()
      }
    },
  }
}
