/**
 * Property animations driven by OpenTUI's timeline engine (`engine` from
 * `@opentui/core`'s animation/Timeline): every running top-level animation owns a `Timeline`
 * registered with that engine, which is attached to the QML engine's renderer on first use (it
 * requests live rendering while something runs) and detached when the QML engine is destroyed.
 *
 * - `NumberAnimation` / `PropertyAnimation`: `target` or `targets`, `property` or `properties`
 *   (comma separated), `from` (default: the current value at start), `to`, `duration` (ms, default
 *   250), `easing.type` (an `Easing.*` value or a name: "InOutQuad", "outBounce", ...),
 *   `easing.overshoot` (Back curves).
 * - `PauseAnimation`: `duration`.
 * - `SequentialAnimation` / `ParallelAnimation`: run their child animations one after another /
 *   together.
 *
 * Common to all: `running` (writable), `paused` (writable), `loops` (`Animation.Infinite` = -1),
 * signals `started()`, `stopped()`, `finished()`, methods `start()`, `stop()`, `pause()`,
 * `resume()`, `restart()`, `complete()`. Animations inside a group are driven by the group.
 * Only the explicit `target`/`property` form is supported (the parser has no `X on prop`).
 */
import { engine as timelineEngine, Timeline, type CliRenderer } from "@opentui/core"
import type { QmlEngine } from "../runtime/engine.ts"
import { QmlObject, toQmlObject } from "../runtime/object.ts"

type EaseFn = (t: number, overshoot?: number) => number

const bounceOut = (t: number): number => {
  const n1 = 7.5625
  const d1 = 2.75
  if (t < 1 / d1) return n1 * t * t
  if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75
  if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375
  return n1 * (t -= 2.625 / d1) * t + 0.984375
}

/** QML easing names (the same curves as OpenTUI's timeline where they overlap). */
const EASINGS: Record<string, EaseFn> = {
  Linear: (t) => t,
  InQuad: (t) => t * t,
  OutQuad: (t) => t * (2 - t),
  InOutQuad: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  InCubic: (t) => t * t * t,
  OutCubic: (t) => 1 - Math.pow(1 - t, 3),
  InOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  InQuart: (t) => t * t * t * t,
  OutQuart: (t) => 1 - Math.pow(1 - t, 4),
  InOutQuart: (t) => (t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2),
  InSine: (t) => 1 - Math.cos((t * Math.PI) / 2),
  OutSine: (t) => Math.sin((t * Math.PI) / 2),
  InOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  InExpo: (t) => (t === 0 ? 0 : Math.pow(2, 10 * t - 10)),
  OutExpo: (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  InOutExpo: (t) =>
    t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2,
  InCirc: (t) => 1 - Math.sqrt(1 - t * t),
  OutCirc: (t) => Math.sqrt(1 - Math.pow(t - 1, 2)),
  InOutCirc: (t) =>
    t < 0.5 ? (1 - Math.sqrt(1 - Math.pow(2 * t, 2))) / 2 : (Math.sqrt(1 - Math.pow(-2 * t + 2, 2)) + 1) / 2,
  InBack: (t, s = 1.70158) => t * t * ((s + 1) * t - s),
  OutBack: (t, s = 1.70158) => --t * t * ((s + 1) * t + s) + 1,
  InOutBack: (t, s = 1.70158) => {
    const c = s * 1.525
    return t < 0.5 ? (Math.pow(2 * t, 2) * ((c + 1) * 2 * t - c)) / 2 : (Math.pow(2 * t - 2, 2) * ((c + 1) * (t * 2 - 2) + c) + 2) / 2
  },
  InElastic: (t) =>
    t === 0 || t === 1 ? t : -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * ((2 * Math.PI) / 3)),
  OutElastic: (t) =>
    t === 0 || t === 1 ? t : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1,
  InBounce: (t) => 1 - bounceOut(1 - t),
  OutBounce: bounceOut,
  InOutBounce: (t) => (t < 0.5 ? (1 - bounceOut(1 - 2 * t)) / 2 : (1 + bounceOut(2 * t - 1)) / 2),
}

const EASING_BY_LOWER = new Map(Object.entries(EASINGS).map(([k, f]) => [k.toLowerCase(), f]))

/** The `Easing` global: `Easing.InOutQuad === "InOutQuad"`, etc. */
export const EASING_GLOBAL: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.keys(EASINGS).map((k) => [k, k])),
)

/** Resolve an easing name (QML "InOutQuad" / "Easing.InOutQuad" or OpenTUI "inOutQuad"). */
export function easingFunction(name: unknown): EaseFn {
  if (typeof name === "function") return name as EaseFn
  const key = String(name ?? "Linear")
    .replace(/^Easing\./, "")
    .toLowerCase()
  return EASING_BY_LOWER.get(key) ?? EASINGS.Linear!
}

export const ANIMATION_STATICS = { Infinite: -1 }

// -----------------------------------------------------------------------------------------------
// Timeline engine attachment (one core engine; attached to the renderer that last started an
// animation, detached when that QML engine is destroyed)

const attachedRenderer = (): CliRenderer | null => (timelineEngine as unknown as { renderer: CliRenderer | null }).renderer

function ensureTimelineAttached(engine: QmlEngine): void {
  const r = engine.renderer
  if (r.isDestroyed) return
  if (attachedRenderer() !== r) timelineEngine.attach(r)
}

/** Detach the core timeline engine if it is attached to this QML engine's renderer. */
export function detachTimelineEngine(engine: QmlEngine): void {
  if (attachedRenderer() === engine.renderer) timelineEngine.detach()
}

// -----------------------------------------------------------------------------------------------
// Base

export abstract class Animation extends QmlObject {
  static qmlStatics = ANIMATION_STATICS
  private timeline: Timeline | null = null
  private syncing = false

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    this.defineProperty("running", {
      type: "bool",
      value: false,
      onChange: (v) => {
        if (this.syncing || !this.isCompleted) return
        if (v) this.start()
        else this.stop()
      },
    })
    this.defineProperty("paused", {
      type: "bool",
      value: false,
      onChange: (v) => {
        if (this.syncing || !this.isCompleted) return
        if (v) this.pause()
        else this.resume()
      },
    })
    this.defineProperty("loops", { type: "int", value: 1 })
    this.defineSignal("started")
    this.defineSignal("stopped")
    this.defineSignal("finished")
    this.defineMethod("start", () => this.start())
    this.defineMethod("stop", () => this.stop())
    this.defineMethod("pause", () => this.pause())
    this.defineMethod("resume", () => this.resume())
    this.defineMethod("restart", () => {
      this.stop()
      this.start()
    })
    this.defineMethod("complete", () => this.complete())
  }

  /** Total duration of one loop (ms). */
  abstract totalDuration(): number
  /** Capture start values (called when this animation starts, or when a group reaches it). */
  abstract begin(): void
  /** Apply the state at local time `t` (0..totalDuration()). */
  abstract seek(t: number): void

  /** Inside a Sequential/Parallel group: driven by it, not started on its own. */
  get inGroup(): boolean {
    return this.parent instanceof AnimationGroup
  }

  private setState(running: boolean, paused: boolean): void {
    this.syncing = true
    try {
      this.write("running", running)
      this.write("paused", paused)
    } finally {
      this.syncing = false
    }
  }

  start(): void {
    if (this.isDestroyed) return
    if (this.inGroup) {
      this.engine.warn(`${this.describe()}: animations inside a group are started by the group`)
      return
    }
    if (this.timeline) return
    const loopsV = Number(this.peek("loops"))
    const infinite = loopsV < 0
    const loops = infinite ? 1 : Math.max(1, Math.floor(loopsV) || 1)
    this.begin()
    this.setState(true, false)
    this.emit("started")
    const d = this.totalDuration()
    if (d <= 0) {
      this.seek(0)
      this.finish()
      return
    }
    const clock = { t: 0 }
    const tl = new Timeline({
      duration: infinite ? d : d * loops,
      loop: infinite,
      autoplay: false,
      onComplete: () => {
        if (this.timeline === tl) this.finish()
      },
    })
    tl.add(clock, {
      duration: d,
      t: d,
      ease: "linear",
      ...(loops > 1 ? { loop: loops } : {}),
      onUpdate: () => {
        if (this.timeline === tl && !this.isDestroyed) this.apply(clock.t)
      },
    })
    this.timeline = tl
    ensureTimelineAttached(this.engine)
    tl.play()
    timelineEngine.register(tl)
  }

  private apply(t: number): void {
    try {
      this.seek(t)
    } catch (err) {
      this.engine.reportError(err, `${this.describe()}: animation`)
    }
  }

  private release(): void {
    const tl = this.timeline
    this.timeline = null
    if (tl) {
      tl.pause()
      timelineEngine.unregister(tl)
    }
  }

  private finish(): void {
    this.release()
    this.apply(this.totalDuration())
    this.setState(false, false)
    this.emit("stopped")
    this.emit("finished")
  }

  stop(): void {
    if (!this.timeline) {
      if (this.peek("running")) this.setState(false, false)
      return
    }
    this.release()
    this.setState(false, false)
    this.emit("stopped")
  }

  pause(): void {
    if (!this.timeline || this.peek("paused")) return
    this.timeline.pause()
    this.setState(true, true)
  }

  resume(): void {
    if (!this.timeline || !this.peek("paused")) return
    this.timeline.play()
    this.setState(true, false)
  }

  /** Jump to the end (the final values) and stop. */
  complete(): void {
    if (this.timeline) this.finish()
  }

  protected override onCompleted(): void {
    super.onCompleted()
    if (this.peek("running") && !this.inGroup) this.start()
  }

  override destroy(): void {
    if (this.isDestroyed || this.isDestroying) return
    this.release()
    super.destroy()
  }
}

// -----------------------------------------------------------------------------------------------
// NumberAnimation / PropertyAnimation

interface Channel {
  target: QmlObject
  property: string
  from: number
  to: number
}

function listOf(v: unknown): unknown[] {
  if (v === undefined || v === null || v === "") return []
  if (Array.isArray(v)) return v
  return [v]
}

export class NumberAnimation extends Animation {
  private channels: Channel[] = []

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    this.defineProperty("target", { type: "var" })
    this.defineProperty("targets", { type: "var" })
    this.defineProperty("property", { type: "string" })
    this.defineProperty("properties", { type: "string" })
    this.defineProperty("from", { type: "var" })
    this.defineProperty("to", { type: "var" })
    this.defineProperty("duration", { type: "int", value: 250 })
    this.defineProperty("easing.type", { type: "var", value: "Linear" })
    this.defineProperty("easing.overshoot", { type: "real", value: 1.70158 })
  }

  totalDuration(): number {
    return Math.max(0, Number(this.peek("duration")) || 0)
  }

  begin(): void {
    const targets = [...listOf(this.peek("target")), ...listOf(this.peek("targets"))]
      .map(toQmlObject)
      .filter((t): t is QmlObject => t !== null && !t.isDestroyed)
    const props = [String(this.peek("property") ?? ""), ...String(this.peek("properties") ?? "").split(",")]
      .map((p) => p.trim())
      .filter(Boolean)
    const fromV = this.peek("from")
    const toV = this.peek("to")
    this.channels = []
    if (targets.length === 0 || props.length === 0) {
      this.engine.warn(`${this.describe()}: needs a target and a property`)
      return
    }
    for (const target of targets) {
      for (const property of props) {
        if (!target.hasProperty(property)) {
          this.engine.warn(`${this.describe()}: ${target.describe()} has no property "${property}"`)
          continue
        }
        const cur = Number(target.peek(property))
        const from = fromV === undefined || fromV === null ? cur : Number(fromV)
        const to = toV === undefined || toV === null ? cur : Number(toV)
        if (!Number.isFinite(from) || !Number.isFinite(to)) {
          this.engine.warn(`${this.describe()}: ${target.describe()}.${property} is not numeric`)
          continue
        }
        this.channels.push({ target, property, from, to })
      }
    }
  }

  seek(t: number): void {
    const d = this.totalDuration()
    const p = d <= 0 ? 1 : Math.max(0, Math.min(1, t / d))
    const ease = easingFunction(this.peek("easing.type"))
    const e = p >= 1 ? 1 : ease(p, Number(this.peek("easing.overshoot")))
    for (const c of this.channels) {
      if (c.target.isDestroyed) continue
      const v = p >= 1 ? c.to : c.from + (c.to - c.from) * e
      // Like Qt: animation writes do not remove the target property's binding.
      c.target.write(c.property, v)
    }
  }
}

export class PauseAnimation extends Animation {
  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    this.defineProperty("duration", { type: "int", value: 250 })
  }

  totalDuration(): number {
    return Math.max(0, Number(this.peek("duration")) || 0)
  }

  begin(): void {}
  seek(_t: number): void {}
}

// -----------------------------------------------------------------------------------------------
// Groups

export abstract class AnimationGroup extends Animation {
  protected animations(): Animation[] {
    return this.children.filter((c): c is Animation => c instanceof Animation && !c.isDestroyed)
  }
}

export class SequentialAnimation extends AnimationGroup {
  private current = -1

  totalDuration(): number {
    return this.animations().reduce((s, a) => s + a.totalDuration(), 0)
  }

  begin(): void {
    this.current = -1
  }

  seek(t: number): void {
    const anims = this.animations()
    let offset = 0
    for (let i = 0; i < anims.length; i++) {
      const a = anims[i]!
      const d = a.totalDuration()
      const last = i === anims.length - 1
      if (t < offset + d || last) {
        if (i < this.current) this.current = -1 // looped: run the children again
        this.advanceTo(anims, i)
        a.seek(Math.max(0, Math.min(d, t - offset)))
        return
      }
      offset += d
    }
  }

  /** Finish the animations before `index` (in order) and begin the one at `index`. */
  private advanceTo(anims: Animation[], index: number): void {
    while (this.current < index) {
      if (this.current >= 0) {
        const prev = anims[this.current]
        prev?.seek(prev.totalDuration())
      }
      this.current++
      anims[this.current]?.begin()
    }
  }
}

export class ParallelAnimation extends AnimationGroup {
  totalDuration(): number {
    return this.animations().reduce((m, a) => Math.max(m, a.totalDuration()), 0)
  }

  begin(): void {
    for (const a of this.animations()) a.begin()
  }

  seek(t: number): void {
    for (const a of this.animations()) a.seek(Math.min(t, a.totalDuration()))
  }
}
