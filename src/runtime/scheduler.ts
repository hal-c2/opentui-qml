/**
 * Timer schedulers. The engine uses `engine.scheduler` for `Timer` and `Qt.callLater`;
 * the default forwards to globalThis. `ManualScheduler` lets tests advance time explicitly.
 */
import type { Scheduler } from "./types.ts"

/** Scheduler backed by globalThis.setTimeout / setInterval. */
export const globalScheduler: Scheduler = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof globalThis.setInterval>),
}

interface ManualTask {
  id: number
  due: number
  interval: number | null
  fn: () => void
}

/** Deterministic scheduler for tests: time only moves on `advance(ms)`. */
export class ManualScheduler implements Scheduler {
  /** Current virtual time in ms. */
  now = 0
  private nextId = 1
  private tasks = new Map<number, ManualTask>()

  setTimeout(fn: () => void, ms: number): number {
    return this.add(fn, ms, null)
  }
  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number)
  }
  setInterval(fn: () => void, ms: number): number {
    return this.add(fn, ms, Math.max(1, ms))
  }
  clearInterval(handle: unknown): void {
    this.tasks.delete(handle as number)
  }

  /** Number of pending timeouts/intervals. */
  get pending(): number {
    return this.tasks.size
  }

  /** Advance virtual time, running due tasks in order (tasks scheduled meanwhile included). */
  advance(ms: number): void {
    const end = this.now + ms
    for (;;) {
      let next: ManualTask | undefined
      for (const t of this.tasks.values()) if (t.due <= end && (!next || t.due < next.due)) next = t
      if (!next) break
      this.now = next.due
      if (next.interval === null) this.tasks.delete(next.id)
      else next.due += next.interval
      next.fn()
    }
    this.now = end
  }

  private add(fn: () => void, ms: number, interval: number | null): number {
    const id = this.nextId++
    this.tasks.set(id, { id, due: this.now + Math.max(0, ms || 0), interval, fn })
    return id
  }
}
