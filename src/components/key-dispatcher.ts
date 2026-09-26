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
import type { KeyEvent } from "@opentui/core"
import type { QmlEngine } from "../runtime/engine.ts"

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
