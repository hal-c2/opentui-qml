/**
 * One `@opentui/keymap` Keymap per QML engine, plus the `Keyboard` singleton.
 *
 * The keymap is created lazily (first `Shortcut` / `Keymap` / standalone `Action` / `Keyboard`
 * use) on the engine's renderer. It is the equivalent of `createDefaultOpenTuiKeymap(renderer)`
 * (default keys + `enabled` + metadata fields), built on a wrapped OpenTUI host so it is torn
 * down when either the engine or the renderer is destroyed, plus these addons:
 * `bindingOverrides`, `emacs` (`"ctrl+x ctrl+s"`), `mod` (`"mod+s"` = ctrl, or cmd on macOS),
 * escape-clears-pending-sequence, base-layout fallback, dead-binding and unresolved-command
 * warnings (routed to `engine.warn`). The comma addon is *not* installed: it rejects literal
 * `","` / `"ctrl+,"` keys, so comma-separated alternatives are split on the QML side instead
 * (see {@link toKeymapKeys}).
 *
 * The package listens with `keyInput.prependListener`, so every keymap binding runs before the
 * engine's `KeyDispatcher` (`Keys.onPressed` & co.) and before the focused renderable. A binding
 * that handles a key stops propagation, so `Keys.*` handlers never see it.
 *
 * Headless engines (no renderer) get no keymap: `keymapFor()` returns null and the QML types
 * do nothing (except `Action.trigger()`, which still emits `triggered`).
 */
import { EditBufferRenderable, KeyEvent, type CliRenderer, type Renderable } from "@opentui/core"
import {
  Keymap as OpenTuiKeymap,
  type KeySequencePart,
  type KeymapHost,
  type Layer,
  type RunCommandResult,
} from "@opentui/keymap"
import { createOpenTuiKeymapHost } from "@opentui/keymap/opentui"
import {
  registerBaseLayoutFallback,
  registerBindingOverrides,
  registerDeadBindingWarnings,
  registerDefaultKeys,
  registerEmacsBindings,
  registerEnabledFields,
  registerEscapeClearsPendingSequence,
  registerMetadataFields,
  registerModBindings,
  registerUnresolvedCommandWarnings,
} from "@opentui/keymap/addons/opentui"
import { getGraphSnapshot, type GraphLayer } from "@opentui/keymap/extras/graph"
import { QmlObject } from "../runtime/object.ts"
import { createSignal, type Accessor, type Setter } from "../runtime/reactive.ts"
import type { QmlEngine } from "../runtime/engine.ts"
import { isPrintableSequence } from "./key-dispatcher.ts"

export type QmlKeymap = OpenTuiKeymap<Renderable, KeyEvent>
export type QmlKeymapLayer = Layer<Renderable, KeyEvent>

/** One row of `Keyboard.activeKeys()` / `Keymap.activeKeys()`. */
export interface ActiveKeyInfo {
  /** The full key sequence, formatted (`"ctrl+x ctrl+s"`, `"gg"`, `"<leader>s"`). */
  key: string
  /** The command / Keymap action name ("" for an anonymous `Shortcut`). */
  command: string
  description: string
}

/** One row of `Keyboard.commands()`. */
export interface CommandInfo {
  name: string
  title: string
  description: string
  category: string
  /** Active key sequences bound to the command (formatted). */
  keys: string[]
}

// -----------------------------------------------------------------------------------------------
// Key strings → @opentui/keymap binding keys

const MODIFIER_NAMES: Record<string, string> = {
  mod: "mod",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  meta: "alt",
  option: "alt",
  opt: "alt",
  super: "super",
  cmd: "super",
  command: "super",
  win: "super",
  hyper: "hyper",
  shift: "shift",
}
const MODIFIER_ORDER = ["mod", "ctrl", "alt", "super", "hyper", "shift"]

/** Key-name aliases accepted in QML key strings (lowercase). */
export const KEY_ALIASES: Record<string, string> = {
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
  comma: ",",
  plus: "+",
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

const NAMED_KEYS = new Set([
  "escape",
  "return",
  "linefeed",
  "tab",
  "space",
  "backspace",
  "delete",
  "insert",
  "home",
  "end",
  "pageup",
  "pagedown",
  "up",
  "down",
  "left",
  "right",
  "clear",
  "menu",
  "pause",
  "capslock",
  "numlock",
  "scrolllock",
  "printscreen",
])

function namedKey(word: string): string | null {
  const lower = word.toLowerCase()
  if (KEY_ALIASES[lower] !== undefined) return KEY_ALIASES[lower]!
  if (/^kp[0-9]$/.test(lower)) return lower.slice(2)
  if (NAMED_KEYS.has(lower) || /^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower
  return null
}

/** Split `"ctrl+s, ctrl+w"` into alternatives; a comma is literal after `+` or on its own. */
function splitAlternatives(input: string): string[] {
  const out: string[] = []
  let buf = ""
  for (const ch of input) {
    if (ch === ",") {
      const t = buf.trim()
      if (t === "" || t.endsWith("+")) {
        buf += ch
        continue
      }
      out.push(buf)
      buf = ""
      continue
    }
    buf += ch
  }
  out.push(buf)
  return out.map((s) => (s.trim() === "" && s.length > 0 ? " " : s.trim())).filter((s) => s !== "")
}

/** A single stroke → canonical key string (`"ctrl+shift+s"`, `"shift+q"`, `"escape"`), or null for a run of plain keys. */
function normalizeStroke(stroke: string, input: string): string | null {
  if (stroke.includes("<")) return null
  const m = /^((?:[A-Za-z]+\+)+)(.+)$/.exec(stroke)
  if (m) {
    const mods = new Set<string>()
    for (const raw of m[1]!.slice(0, -1).split("+")) {
      const mod = MODIFIER_NAMES[raw.toLowerCase()]
      if (!mod) throw new Error(`unknown modifier "${raw}" in key sequence "${input}"`)
      mods.add(mod)
    }
    let key = m[2]!
    key = key.length === 1 ? key.toLowerCase() : (namedKey(key) ?? key.toLowerCase())
    if (key === " ") key = "space"
    return [...MODIFIER_ORDER.filter((x) => mods.has(x)), key].join("+")
  }
  if (stroke.length === 1) {
    if (/[A-Z]/.test(stroke)) return `shift+${stroke.toLowerCase()}`
    return stroke === " " ? "space" : stroke
  }
  return namedKey(stroke)
}

/**
 * Convert a QML key string into `@opentui/keymap` binding keys, one per comma-separated
 * alternative. Throws on an empty string or an unknown modifier.
 *
 * - modifiers: ctrl/control, shift, alt/meta/option/opt, super/cmd/command/win, hyper, mod;
 * - a lone uppercase letter means shift (`"Q"` = `"shift+q"`); `"Ctrl+S"` = `"ctrl+s"`;
 * - aliases: esc, enter/ret, del, ins, pgup, pgdn, bs, spacebar, comma, plus, kp*;
 * - sequences: `"gg"`, `"g g"`, `"ctrl+x ctrl+s"`, `"<leader>s"`, `"gG"` (= g, shift+g).
 */
export function toKeymapKeys(input: unknown): string[] {
  const raw = String(input ?? "")
  const alternatives = raw.length > 0 && raw.trim() === "" ? [" "] : splitAlternatives(raw)
  if (alternatives.length === 0) throw new Error("empty key sequence")
  return alternatives.map((alt) => toKeymapKey(alt, raw))
}

function toKeymapKey(alt: string, input: string): string {
  if (alt === " ") return "space"
  if (alt === "+") return "+"
  const strokes: string[] = []
  for (const piece of alt.split(/\s+/).filter(Boolean)) {
    const one = normalizeStroke(piece, input)
    if (one !== null) {
      strokes.push(one)
      continue
    }
    if (piece.includes("<")) {
      strokes.push(piece)
      continue
    }
    // A run of plain keys: "gg", "gG", "jk".
    for (const ch of piece) strokes.push(/[A-Z]/.test(ch) ? `shift+${ch.toLowerCase()}` : ch)
  }
  if (strokes.length === 1) return strokes[0]!
  const emacs = strokes.some((s) => s.length > 1 && s.includes("+") && !s.includes("<"))
  if (emacs && strokes.some((s) => s.includes("<"))) {
    throw new Error(`key sequence "${input}" mixes <tokens> with modifier strokes`)
  }
  return strokes.join(emacs ? " " : "")
}

// -----------------------------------------------------------------------------------------------
// Formatting

function hasModifiers(part: KeySequencePart): boolean {
  const s = part.stroke
  return !!(s.ctrl || s.shift || s.meta || s.super || s.hyper)
}

/** `"ctrl+alt+shift+s"`, `"<leader>"`, `"g"`. */
export function formatKeyPart(part: KeySequencePart): string {
  if (part.tokenName) return `<${part.tokenName}>`
  const s = part.stroke
  const out: string[] = []
  if (s.ctrl) out.push("ctrl")
  if (s.meta) out.push("alt")
  if (s.super) out.push("super")
  if (s.hyper) out.push("hyper")
  if (s.shift) out.push("shift")
  out.push(s.name)
  return out.join("+")
}

/** Plain single keys and tokens are joined (`"gg"`, `"<leader>s"`), anything else with spaces. */
export function formatKeyParts(parts: readonly KeySequencePart[]): string {
  const compact = parts.every((p) => p.tokenName || (!hasModifiers(p) && [...p.stroke.name].length === 1))
  return parts.map(formatKeyPart).join(compact ? "" : " ")
}

// -----------------------------------------------------------------------------------------------
// Editor guard helpers

/** Keys that a focused text editor should get even when a window-level binding matches. */
export function isEditingKey(event: KeyEvent): boolean {
  if (event.ctrl || event.meta || event.option || event.super) return false
  if (isPrintableSequence(event.sequence)) return true
  return EDITING_KEY_NAMES.includes(event.name)
}

/** Stroke form of {@link isEditingKey}, for bindings (shift + a character is still typing). */
function isEditingStroke(part: KeySequencePart): boolean {
  const s = part.stroke
  if (s.ctrl || s.meta || s.super || s.hyper) return false
  return [...s.name].length === 1 || EDITING_KEY_NAMES.includes(s.name)
}

const EDITING_KEY_NAMES = ["space", "backspace", "delete", "left", "right", "home", "end", "return", "linefeed"]

function editorHasFocus(renderer: CliRenderer | undefined): boolean {
  return renderer?.currentFocusedRenderable instanceof EditBufferRenderable
}

// -----------------------------------------------------------------------------------------------
// Host

let hostSeq = 0

/** Per-engine keymap service. */
export class KeyboardHost {
  readonly keymap: QmlKeymap | null
  private destroyed = false
  private readonly destroyListeners = new Set<() => void>()
  private dispatchDepth = 0
  private readonly queue: Array<() => void> = []
  private currentEvent: KeyEvent | null = null
  /** True while taking a graph snapshot: the editor rule is then applied by `activeKeys`. */
  private snapshotting = false
  private layerCount = 0
  private readonly tokens = new Map<string, { owner: object; off: () => void }>()
  private readonly revision: Accessor<number>
  private readonly setRevision: Setter<number>
  private readonly pending: Accessor<string>
  private readonly setPending: Setter<string>
  private pendingOwners = new Set<string>()
  private readonly pendingListeners = new Set<() => void>()
  readonly id = ++hostSeq

  constructor(readonly engine: QmlEngine) {
    ;[this.revision, this.setRevision] = createSignal(0, { equals: false })
    ;[this.pending, this.setPending] = createSignal("")
    const renderer = engine.renderer as CliRenderer | undefined
    this.keymap = renderer && !renderer.isDestroyed ? this.createKeymap(renderer) : null
  }

  private createKeymap(renderer: CliRenderer): QmlKeymap {
    const base = createOpenTuiKeymapHost(renderer)
    const self = this
    const host: KeymapHost<Renderable, KeyEvent> = {
      get metadata() {
        return base.metadata
      },
      rootTarget: base.rootTarget,
      get isDestroyed() {
        return self.destroyed || base.isDestroyed
      },
      getFocusedTarget: () => base.getFocusedTarget(),
      getParentTarget: (t) => base.getParentTarget(t),
      isTargetDestroyed: (t) => base.isTargetDestroyed(t),
      onKeyPress: (l) => base.onKeyPress(l),
      onKeyRelease: (l) => base.onKeyRelease(l),
      onFocusChange: (l) => base.onFocusChange(l),
      onDestroy: (listener) => {
        let fired = false
        const once = (): void => {
          if (fired) return
          fired = true
          this.destroyListeners.delete(once)
          offRenderer()
          listener()
        }
        const offRenderer = base.onDestroy!(once)
        this.destroyListeners.add(once)
        return () => {
          this.destroyListeners.delete(once)
          offRenderer()
        }
      },
      onTargetDestroy: (t, l) => base.onTargetDestroy(t, l),
      onRawInput: base.onRawInput ? (l) => base.onRawInput!(l) : undefined,
      createCommandEvent: () => base.createCommandEvent(),
    }
    const keymap: QmlKeymap = new OpenTuiKeymap(host)
    // == createDefaultOpenTuiKeymap(renderer), on the wrapped host:
    registerDefaultKeys(keymap)
    registerEnabledFields(keymap)
    registerMetadataFields(keymap)
    // Extra addons.
    registerBindingOverrides(keymap)
    registerEmacsBindings(keymap)
    registerModBindings(keymap)
    registerEscapeClearsPendingSequence(keymap)
    registerBaseLayoutFallback(keymap)
    registerDeadBindingWarnings(keymap)
    registerUnresolvedCommandWarnings(keymap)

    keymap.on("warning", (w) => {
      if (w.code === "unknown-token") {
        // Bindings may be registered before the Keymap that declares `leader`; the binding
        // starts working once the token exists, so only warn if it is still missing.
        const token = (w.warning as { token?: string } | null)?.token
        queueMicrotask(() => {
          if (!this.destroyed && token && !this.tokens.has(token)) this.engine.warn(`keymap: ${w.message}`)
        })
        return
      }
      this.engine.warn(`keymap: ${w.message}`)
    })
    keymap.on("error", (e) => this.engine.warn(`keymap: ${e.message}${e.error instanceof Error ? `: ${e.error.message}` : ""}`))
    keymap.on("state", () => this.touch())
    keymap.on("pendingSequence", (parts) => this.onPendingSequence(parts))

    // QML fields.
    keymap.registerLayerFields({
      /** Yield editing keys to a focused TextInput / TextArea (contexts "window" and "item"). */
      qmlYieldToEditor: (value, ctx) => {
        if (value) ctx.activeWhen(() => !this.yieldsToEditor())
      },
      /** Owner id, used to attribute graph layers / pending sequences to QML objects. */
      qmlOwner: () => {},
    })
    keymap.registerBindingFields({
      qmlCommand: (value, ctx) => {
        if (typeof value === "string" && value) ctx.attr("command", value)
      },
    })

    // "?" / "+" / "!" bind without shift but arrive with shift on some terminals; alt may be
    // reported as `option`.
    keymap.appendEventMatchResolver((event, ctx) => {
      const out: string[] = []
      const meta = !!(event.meta || event.option)
      const name = event.name ?? ""
      if (event.shift && [...name].length === 1 && !/[a-z0-9]/i.test(name)) {
        out.push(ctx.resolveKey({ name, ctrl: event.ctrl, shift: false, meta, super: event.super ?? false }))
      }
      if (event.option && !event.meta) {
        out.push(ctx.resolveKey({ name, ctrl: event.ctrl, shift: event.shift, meta: true, super: event.super ?? false }))
      }
      return out.length ? out : undefined
    })

    // Track key dispatch: structural changes (layer (un)registration) are deferred while the
    // keymap is dispatching, and the current event feeds the editor guard.
    keymap.intercept(
      "key",
      ({ event }) => {
        this.currentEvent = event
        this.dispatchDepth++
        const depth = this.dispatchDepth
        queueMicrotask(() => {
          // Safety net in case "key:after" was never delivered.
          if (this.dispatchDepth >= depth) {
            this.dispatchDepth = depth - 1
            this.currentEvent = null
            if (this.dispatchDepth === 0) this.flush()
          }
        })
      },
      { priority: 1_000_000 },
    )
    keymap.intercept("key:after", () => {
      this.currentEvent = null
      if (this.dispatchDepth > 0) this.dispatchDepth--
      if (this.dispatchDepth === 0) this.flush()
    })
    return keymap
  }

  get isDestroyed(): boolean {
    return this.destroyed || !this.keymap || (this.engine.renderer?.isDestroyed ?? true)
  }

  private yieldsToEditor(): boolean {
    const event = this.currentEvent
    if (this.snapshotting || !event || !editorHasFocus(this.engine.renderer)) return false
    if (!isEditingKey(event)) return false
    return !this.keymap?.hasPendingSequence()
  }

  /** Run a structural keymap change now, or after the current key dispatch. */
  mutate(fn: () => void): void {
    if (this.isDestroyed) return
    if (this.dispatchDepth > 0) {
      this.queue.push(fn)
      return
    }
    this.run(fn)
  }

  private run(fn: () => void): void {
    try {
      fn()
    } catch (err) {
      this.engine.reportError(err, "keymap")
    }
  }

  private flush(): void {
    while (this.queue.length > 0 && this.dispatchDepth === 0) {
      const fn = this.queue.shift()!
      if (!this.isDestroyed) this.run(fn)
    }
  }

  /** Document-order tie breaker: earlier declared layers win among equal priorities. */
  nextLayerIndex(): number {
    return this.layerCount++
  }

  /** Invalidate reactive readers (`activeKeys()`, `commands()`). */
  touch(): void {
    this.setRevision(0)
  }

  /** Reactive dependency on the keymap state. */
  track(): void {
    this.revision()
  }

  /** Reactive formatted pending sequence ("" when none). */
  pendingSequence(): string {
    return this.pending()
  }

  /** Is a pending sequence (partly) owned by a layer with this `qmlOwner`? */
  ownsPending(owner: string): boolean {
    this.pending()
    return this.pendingOwners.has(owner)
  }

  onPendingChange(fn: () => void): () => void {
    this.pendingListeners.add(fn)
    return () => this.pendingListeners.delete(fn)
  }

  private onPendingSequence(parts: readonly KeySequencePart[]): void {
    const owners = new Set<string>()
    if (parts.length > 0 && this.keymap && !this.isDestroyed) {
      try {
        const snap = getGraphSnapshot(this.keymap)
        const layerOwner = new Map(snap.layers.map((l) => [l.id, ownerOf(l)]))
        for (const node of snap.sequenceNodes) {
          if (!node.pending) continue
          const owner = layerOwner.get(node.layerId)
          if (owner) owners.add(owner)
        }
      } catch {
        // ignore: best effort attribution
      }
    }
    this.pendingOwners = owners
    this.setPending(parts.length > 0 ? formatKeyParts(parts) : "")
    for (const fn of [...this.pendingListeners]) fn()
  }

  /** Register (or replace) a key token such as `<leader>`; returns a releaser. */
  setToken(owner: object, name: string, key: string): () => void {
    const km = this.keymap
    if (!km || this.isDestroyed) return () => {}
    const prev = this.tokens.get(name)
    if (prev) {
      if (prev.owner !== owner) this.engine.warn(`keymap: token <${name}> is redefined`)
      prev.off()
    }
    const off = km.registerToken({ name, key })
    const entry = { owner, off }
    this.tokens.set(name, entry)
    return () => {
      if (this.tokens.get(name) !== entry) return
      this.tokens.delete(name)
      if (!this.isDestroyed) off()
    }
  }

  /** A synthetic "command" key event (like the one the keymap passes to dispatched commands). */
  commandEvent(): KeyEvent {
    return new KeyEvent({
      name: "command",
      ctrl: false,
      meta: false,
      shift: false,
      option: false,
      sequence: "",
      number: false,
      raw: "",
      eventType: "press",
      source: "raw",
    })
  }

  /** `keymap.dispatchCommand(name, { payload })` (active layers only). */
  dispatchCommand(name: string, payload?: unknown): RunCommandResult<Renderable, KeyEvent> {
    const km = this.keymap
    if (!km || this.isDestroyed) return { ok: false, reason: "not-found" }
    this.dispatchDepth++
    try {
      return km.dispatchCommand(name, payload === undefined ? undefined : { payload })
    } finally {
      this.dispatchDepth--
      if (this.dispatchDepth === 0) this.flush()
    }
  }

  /**
   * Full key sequences of the currently active bindings (highest precedence first, shadowed
   * bindings removed). While a sequence is pending, only its continuations are listed.
   */
  activeKeys(opts: { owner?: string; ignorePending?: boolean } = {}): ActiveKeyInfo[] {
    this.track()
    this.pending()
    const km = this.keymap
    if (!km || this.isDestroyed) return []
    // Snapshot independently of the key being dispatched (activeKeys() may be re-evaluated
    // mid-dispatch), then hide what a focused text editor would take as typing.
    this.snapshotting = true
    let snap: ReturnType<typeof getGraphSnapshot<Renderable, KeyEvent>>
    try {
      snap = getGraphSnapshot(km)
    } finally {
      this.snapshotting = false
    }
    const layers = new Map(snap.layers.map((l) => [l.id, l]))
    const pending = opts.ignorePending ? [] : snap.pendingSequence.map((p) => p.match)
    const editorYield = snap.pendingSequence.length === 0 && editorHasFocus(this.engine.renderer)
    const bindings = snap.bindings
      .filter((b) => b.event === "press" && b.active && b.reachable && !b.shadowed)
      .map((b) => ({ b, layer: layers.get(b.layerId) }))
      .filter((x): x is { b: (typeof snap.bindings)[number]; layer: GraphLayer<Renderable> } => !!x.layer)
      .sort(
        (x, y) =>
          y.layer.priority - x.layer.priority || y.layer.order - x.layer.order || x.b.bindingIndex - y.b.bindingIndex,
      )
    const out: ActiveKeyInfo[] = []
    const seen = new Set<string>()
    for (const { b, layer } of bindings) {
      if (opts.owner !== undefined && ownerOf(layer) !== opts.owner) continue
      if (editorYield && layer.fields.qmlYieldToEditor && isEditingStroke(b.sequence[0]!)) continue
      if (pending.length > 0) {
        if (b.sequence.length <= pending.length) continue
        if (pending.some((m, i) => b.sequence[i]!.match !== m)) continue
      }
      const id = b.sequence.map((p) => p.match).join(" ")
      if (seen.has(id)) continue
      seen.add(id)
      const attrs = (b.attrs ?? {}) as Record<string, unknown>
      const cattrs = (b.commandAttrs ?? {}) as Record<string, unknown>
      const command = typeof attrs.command === "string" ? attrs.command : typeof b.command === "string" ? b.command : ""
      const description = String(attrs.desc ?? cattrs.desc ?? cattrs.title ?? "")
      out.push({ key: formatKeyParts(b.sequence), command, description })
    }
    return out
  }

  /** Commands of the active layers (deduplicated by name) with their active keys. */
  commands(): CommandInfo[] {
    this.track()
    const km = this.keymap
    if (!km || this.isDestroyed) return []
    const keys = new Map<string, string[]>()
    for (const k of this.activeKeys({ ignorePending: true })) {
      if (!k.command) continue
      const list = keys.get(k.command) ?? []
      list.push(k.key)
      keys.set(k.command, list)
    }
    const out: CommandInfo[] = []
    const seen = new Set<string>()
    for (const cmd of km.getCommands({ visibility: "active" })) {
      if (seen.has(cmd.name)) continue
      seen.add(cmd.name)
      out.push({
        name: cmd.name,
        title: String(cmd.title ?? ""),
        description: String(cmd.desc ?? ""),
        category: String(cmd.category ?? ""),
        keys: keys.get(cmd.name) ?? [],
      })
    }
    return out
  }

  /** Format a QML key string the way `activeKeys()` does (`"Ctrl+X Ctrl+S"` → `"ctrl+x ctrl+s"`). */
  formatKey(key: unknown): string {
    const alts = toKeymapKeys(key)
    const km = this.keymap
    if (!km || this.isDestroyed) return alts.join(", ")
    const primary = km.getHostMetadata().primaryModifier
    const mod = primary === "super" ? "super" : "ctrl"
    return alts
      .map((k) => {
        try {
          return formatKeyParts(km.parseKeySequence(k.replace(/(^|[+\s])mod(?=\+)/g, `$1${mod}`)))
        } catch {
          return k
        }
      })
      .join(", ")
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.queue.length = 0
    this.tokens.clear()
    this.pendingListeners.clear()
    for (const fn of [...this.destroyListeners]) {
      try {
        fn()
      } catch (err) {
        this.engine.reportError(err, "keymap destroy")
      }
    }
    this.destroyListeners.clear()
  }
}

function ownerOf(layer: GraphLayer<Renderable>): string | undefined {
  const v = (layer.fields as Record<string, unknown>).qmlOwner
  return typeof v === "string" ? v : undefined
}

/**
 * Owns one registered layer. `set()` replaces it (deferred while a key is being dispatched);
 * `dispose()` removes it. Safe to use after the keymap was destroyed.
 */
export class LayerSlot {
  private off: (() => void) | null = null
  private disposed = false

  constructor(
    private readonly host: KeyboardHost,
    private readonly owner: QmlObject,
  ) {}

  set(layer: QmlKeymapLayer | null): void {
    if (this.disposed) return
    this.host.mutate(() => {
      this.release()
      const km = this.host.keymap
      if (!layer || this.disposed || !km || this.host.isDestroyed) return
      try {
        this.off = km.registerLayer(layer)
      } catch (err) {
        this.host.engine.warn(`${this.owner.describe()}: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.host.mutate(() => this.release())
  }

  private release(): void {
    const off = this.off
    this.off = null
    if (!off || this.host.isDestroyed) return
    try {
      off()
    } catch {
      // the keymap was torn down with its host
    }
  }
}

const hosts = new WeakMap<QmlEngine, KeyboardHost>()

/** The engine's keyboard host (created on first use). */
export function keyboardHostFor(engine: QmlEngine): KeyboardHost {
  let h = hosts.get(engine)
  if (!h) {
    h = new KeyboardHost(engine)
    hosts.set(engine, h)
  }
  return h
}

/** The engine's `@opentui/keymap` Keymap (created on first use); null without a live renderer. */
export function keymapFor(engine: QmlEngine): QmlKeymap | null {
  const h = keyboardHostFor(engine)
  return h.isDestroyed ? null : h.keymap
}

/** Tear down the engine's keymap and `Keyboard` singleton (called when the engine is destroyed). */
export function destroyKeyboardHost(engine: QmlEngine): void {
  keyboards.get(engine)?.destroy()
  keyboards.delete(engine)
  hosts.get(engine)?.destroy()
  hosts.delete(engine)
}

// -----------------------------------------------------------------------------------------------
// Keyboard singleton

/**
 * `Keyboard` — the engine's keymap, visible in every QML scope.
 *
 * - `pendingSequence` (reactive string): the keys typed so far of an unfinished sequence
 *   (`"g"`, `"ctrl+x"`, `"<leader>"`), "" when none;
 * - `activeKeys()` (reactive): `[{ key, command, description }]` for every active binding,
 *   highest precedence first; while a sequence is pending, only its continuations;
 * - `commands()` (reactive): `[{ name, title, description, category, keys }]` of active commands;
 * - `dispatch(name, payload?)`: run the highest-priority active command `name` (true if handled);
 * - `setData(key, value)` / `getData(key)`: keymap data (visible to commands as `ctx.data`);
 * - `formatKey(key)`: normalise a key string for display (`"Ctrl+X Ctrl+S"` → `"ctrl+x ctrl+s"`);
 * - `clearPendingSequence()`.
 */
export class KeyboardObject extends QmlObject {
  private readonly off: () => void

  constructor(engine: QmlEngine) {
    super(engine, "Keyboard")
    const host = keyboardHostFor(engine)
    this.defineProperty("pendingSequence", { type: "string", readonly: true, value: host.pendingSequence() })
    this.defineMethod("activeKeys", () => host.activeKeys())
    this.defineMethod("commands", () => host.commands())
    this.defineMethod("dispatch", (name: unknown, payload?: unknown) => host.dispatchCommand(String(name ?? ""), payload).ok)
    this.defineMethod("setData", (key: unknown, value: unknown) => {
      if (!host.isDestroyed) host.keymap?.setData(String(key), value)
    })
    this.defineMethod("getData", (key: unknown) => (host.isDestroyed ? undefined : host.keymap?.getData(String(key))))
    this.defineMethod("formatKey", (key: unknown) => {
      try {
        return host.formatKey(key)
      } catch (err) {
        engine.warn(`Keyboard.formatKey: ${err instanceof Error ? err.message : String(err)}`)
        return String(key ?? "")
      }
    })
    this.defineMethod("clearPendingSequence", () => {
      if (!host.isDestroyed) host.keymap?.clearPendingSequence()
    })
    this.off = host.onPendingChange(() => this.write("pendingSequence", host.pendingSequence()))
    this.completeConstruction()
  }

  override destroy(): void {
    this.off()
    super.destroy()
  }
}

const keyboards = new WeakMap<QmlEngine, KeyboardObject>()

/** The engine's `Keyboard` singleton (created on first use). */
export function keyboardFor(engine: QmlEngine): KeyboardObject {
  let k = keyboards.get(engine)
  if (!k) {
    k = new KeyboardObject(engine)
    keyboards.set(engine, k)
  }
  return k
}
