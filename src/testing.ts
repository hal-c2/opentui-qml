/**
 * Test helpers: run a QML document in OpenTUI's headless test renderer.
 *
 * ```ts
 * import { testQml } from "opentui-qml/testing"
 *
 * const t = await testQml(`Text { text: "hi" }`, { width: 20, height: 3 })
 * expect(await t.snapshot()).toContain("hi")
 * t.destroy()
 * ```
 *
 * The renderer runs on a `ManualClock` (pass `clock: false` for the real clock), so animations
 * only advance through `advance(ms)` and frames are deterministic.
 */
import { engine as timelineEngine } from "@opentui/core"
import { createTestRenderer, ManualClock, type TestRendererOptions, type TestRendererSetup } from "@opentui/core/testing"
import type { KeyInput } from "@opentui/core/testing"
import { runQml, runQmlSource, type QmlApp, type RunQmlOptions } from "./index.ts"
import type { QmlEngine } from "./runtime/engine.ts"
import type { QmlObject } from "./runtime/object.ts"

export interface TestQmlOptions extends Omit<RunQmlOptions, "renderer" | "rendererConfig"> {
  /** Terminal size (default 80x24). */
  width?: number
  height?: number
  /** Filename for source text (errors, relative types and paths). */
  filename?: string
  /** Renderer clock: a `ManualClock` by default; `false` uses the real clock. */
  clock?: ManualClock | false
  /** Extra `createTestRenderer` options (e.g. `screenMode`, `externalOutputMode`). */
  renderer?: Partial<TestRendererOptions>
  /** Render a first frame before returning (default true). */
  render?: boolean
}

type KeyModifiers = Parameters<TestRendererSetup["mockInput"]["pressKey"]>[1]

export interface QmlTestApp {
  app: QmlApp
  engine: QmlEngine
  /** The root object (use `.get()`/`.set()` or `proxy`). */
  root: QmlObject
  /** `root.proxy`: QML-style property access (`t.proxy.count`). */
  proxy: any
  renderer: TestRendererSetup["renderer"]
  setup: TestRendererSetup
  mockInput: TestRendererSetup["mockInput"]
  mockMouse: TestRendererSetup["mockMouse"]
  /** The renderer's clock, when it is a `ManualClock`. */
  clock: ManualClock | null
  /** Warnings / errors reported by the engine (they are also passed to your callbacks). */
  warnings: string[]
  errors: unknown[]
  /** Render (twice, so layout-driven bindings settle). */
  renderOnce(): Promise<void>
  captureCharFrame(): string
  /** Render a frame and return it as text. */
  snapshot(): Promise<string>
  pressKey(key: KeyInput, modifiers?: KeyModifiers): Promise<void>
  typeText(text: string): Promise<void>
  pressEnter(modifiers?: KeyModifiers): Promise<void>
  pressEscape(modifiers?: KeyModifiers): Promise<void>
  pressTab(modifiers?: KeyModifiers): Promise<void>
  pressArrow(direction: "up" | "down" | "left" | "right", modifiers?: KeyModifiers): Promise<void>
  /** Bracketed paste. */
  paste(text: string): Promise<void>
  click(x: number, y: number): Promise<void>
  /** Resize the terminal and render. */
  resize(width: number, height: number): Promise<void>
  /** Advance animations (OpenTUI's timeline engine) by exactly `ms`, then render. */
  advance(ms: number): Promise<void>
  destroy(): void
}

/** Run QML source text (or `{ file }`) in a headless test renderer. */
export async function testQml(source: string | { file: string }, options: TestQmlOptions = {}): Promise<QmlTestApp> {
  const { width = 80, height = 24, clock: clockOpt, renderer: rendererOpts, render = true, filename, ...runOpts } = options
  const clock = clockOpt === false ? null : (clockOpt ?? new ManualClock())
  const setup = await createTestRenderer({
    width,
    height,
    ...(clock ? { clock } : {}),
    ...rendererOpts,
  })
  const warnings: string[] = []
  const errors: unknown[] = []
  const opts: RunQmlOptions & { filename?: string } = {
    ...runOpts,
    renderer: setup.renderer,
    onWarning: (m) => {
      warnings.push(m)
      runOpts.onWarning?.(m)
    },
    onError: (e, ctx) => {
      errors.push(e)
      runOpts.onError?.(e, ctx)
    },
    ...(filename ? { filename } : {}),
  }
  let app: QmlApp
  try {
    app = typeof source === "string" ? await runQmlSource(source, opts) : await runQml(source.file, opts)
  } catch (err) {
    setup.renderer.destroy()
    throw err
  }
  const { mockInput, mockMouse } = setup
  // Layout results are synced to QML in a microtask: render, let it run, render again.
  const renderTwice = async (): Promise<void> => {
    await setup.renderOnce()
    await Promise.resolve()
    await setup.renderOnce()
  }
  const after = async (p: Promise<void> | void): Promise<void> => {
    await p
    await renderTwice()
  }
  const t: QmlTestApp = {
    app,
    engine: app.engine,
    root: app.root,
    proxy: app.root.proxy,
    renderer: setup.renderer,
    setup,
    mockInput,
    mockMouse,
    clock,
    warnings,
    errors,
    renderOnce: renderTwice,
    captureCharFrame: () => setup.captureCharFrame(),
    async snapshot() {
      await renderTwice()
      return setup.captureCharFrame()
    },
    pressKey: (key, modifiers) => after(mockInput.pressKey(key, modifiers)),
    typeText: (text) => after(mockInput.typeText(text)),
    pressEnter: (modifiers) => after(mockInput.pressEnter(modifiers)),
    pressEscape: (modifiers) => after(mockInput.pressEscape(modifiers)),
    pressTab: (modifiers) => after(mockInput.pressTab(modifiers)),
    pressArrow: (direction, modifiers) => after(mockInput.pressArrow(direction, modifiers)),
    paste: (text) => after(mockInput.pasteBracketedText(text)),
    click: (x, y) => after(mockMouse.click(x, y)),
    async resize(w, h) {
      setup.resize(w, h)
      await renderTwice()
    },
    async advance(ms) {
      // The manual clock stays put, so the frame callbacks run by renderOnce see a zero delta
      // and `ms` is applied exactly once.
      timelineEngine.update(ms)
      await renderTwice()
    },
    destroy() {
      app.destroy()
      if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    },
  }
  if (render) await renderTwice()
  return t
}
