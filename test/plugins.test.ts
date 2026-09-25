import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { BoxRenderable, TextRenderable } from "@opentui/core"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import {
  createFromSource,
  getSlotRegistry,
  listPlugins,
  loadPluginsFromDir,
  loadQmlPlugin,
  parseQml,
  registerPlugin,
  runQml,
  runQmlSource,
  Slot,
  unregisterPlugin,
  type QmlApp,
  type QmlObject,
  type RunQmlOptions,
} from "../src/index.ts"
import { TestText } from "./fixtures/test-text.ts"

const FIXTURES = join(import.meta.dir, "fixtures")

let t: TestRendererSetup | null = null
let app: QmlApp | null = null

afterEach(() => {
  app?.destroy()
  app = null
  t?.renderer.destroy()
  t = null
})

interface Harness {
  app: QmlApp
  errors: string[]
  log: string[]
  frame: () => Promise<string>
}

async function mount(source: string, options: RunQmlOptions = {}, size = { width: 40, height: 8 }): Promise<Harness> {
  t = await createTestRenderer(size)
  const errors: string[] = []
  const log: string[] = []
  app = await runQmlSource(source, {
    renderer: t.renderer,
    types: { TestText },
    context: { log },
    onError: (err, ctx) => errors.push(`${ctx ?? ""}: ${err instanceof Error ? err.message : String(err)}`),
    onWarning: () => {},
    ...options,
  })
  const setup = t
  return {
    app,
    errors,
    log,
    frame: async () => {
      await setup.renderOnce()
      return setup.captureCharFrame()
    },
  }
}

function findSlot(root: QmlObject, name: string): Slot {
  const stack = [root]
  while (stack.length) {
    const obj = stack.pop()!
    if (obj instanceof Slot && obj.peek("name") === name) return obj
    stack.push(...obj.children)
  }
  throw new Error(`no slot ${name}`)
}

const text = (renderer: unknown, content: string) =>
  new TextRenderable(renderer as ConstructorParameters<typeof TextRenderable>[0], { content })

describe("TypeScript plugins", () => {
  test("a CorePlugin renderer contributing a TextRenderable renders in the Slot", async () => {
    const h = await mount(`Item { width: 40; height: 4; Slot { name: "status" } }`, {
      plugins: [{ id: "hello", slots: { status: (ctx) => text(ctx.renderer, "hello from plugin") } }],
    })
    expect(await h.frame()).toContain("hello from plugin")
    expect(listPlugins(h.app.engine)).toEqual([{ id: "hello", order: 0, kind: "ts" }])
    expect(h.errors).toEqual([])
  })

  test("a renderer may return QML source; slot data is in scope (data.x and x)", async () => {
    const h = await mount(`Item { width: 40; height: 4; Slot { name: "status"; data: ({ n: 42 }) } }`, {
      plugins: [{ id: "src", slots: { status: () => `TestText { text: "n=" + data.n + " also " + n }` } }],
    })
    expect(await h.frame()).toContain("n=42 also 42")
    findSlot(h.app.root, "status").set("data", { n: 7 })
    expect(await h.frame()).toContain("n=7 also 7")
    expect(h.errors).toEqual([])
  })

  test("a returned VisualObject is mounted and destroyed when the slot drops it", async () => {
    const h = await mount(`Item { width: 40; height: 4; Slot { name: "status" } }`)
    const created: QmlObject[] = []
    registerPlugin(h.app.engine, {
      id: "obj",
      slots: {
        status: () => {
          const obj = createFromSource(h.app.engine, `TestText { text: "visual object" }`)
          created.push(obj)
          return obj
        },
      },
    })
    expect(await h.frame()).toContain("visual object")
    expect(created).toHaveLength(1)
    expect(created[0]!.isDestroyed).toBe(false)
    expect(unregisterPlugin(h.app.engine, "obj")).toBe(true)
    expect(created[0]!.isDestroyed).toBe(true)
    expect(await h.frame()).not.toContain("visual object")
  })

  test("setup errors are isolated and reported; other plugins still work", async () => {
    const h = await mount(`Item { width: 40; height: 4; Slot { name: "status"; flexDirection: "row"; gap: 1 } }`, {
      plugins: [
        {
          id: "bad",
          setup: () => {
            throw new Error("boom in setup")
          },
          slots: { status: (ctx) => text(ctx.renderer, "BAD") },
        },
        { id: "good", slots: { status: (ctx) => text(ctx.renderer, "GOOD") } },
      ],
    })
    const frame = await h.frame()
    expect(frame).toContain("GOOD")
    expect(frame).not.toContain("BAD")
    expect(h.errors.some((e) => e.includes('plugin "bad"') && e.includes("boom in setup"))).toBe(true)
    expect(listPlugins(h.app.engine).map((p) => p.id)).toEqual(["good"])
  })

  test("render errors are isolated; duplicate ids are rejected", async () => {
    const h = await mount(`Item { width: 40; height: 4; Slot { name: "status"; flexDirection: "row"; gap: 1 } }`, {
      plugins: [
        {
          id: "throws",
          slots: {
            status: () => {
              throw new Error("render boom")
            },
          },
        },
        { id: "fine", slots: { status: (ctx) => text(ctx.renderer, "FINE") } },
        { id: "fine", slots: { status: (ctx) => text(ctx.renderer, "DUP") } },
      ],
    })
    const frame = await h.frame()
    expect(frame).toContain("FINE")
    expect(frame).not.toContain("DUP")
    expect(h.errors.some((e) => e.includes("render boom"))).toBe(true)
    expect(h.errors.some((e) => e.includes('"fine" is already registered'))).toBe(true)
  })

  test("pluginError signal on the root receives failures", async () => {
    const h = await mount(
      `Item {
         width: 40; height: 4
         property string lastError: ""
         signal pluginError(var error)
         onPluginError: (e) => lastError = e.pluginId + ":" + e.phase
         Slot { name: "status" }
       }`,
    )
    registerPlugin(h.app.engine, {
      id: "x",
      slots: {
        status: () => {
          throw new Error("nope")
        },
      },
    })
    expect(h.app.root.peek("lastError")).toBe("x:render")
  })

  test("the plugin context carries engine, renderer, root and user context", async () => {
    let seen: Record<string, unknown> | null = null
    const h = await mount(`Item { width: 40; height: 4; Slot { name: "status" } }`, {
      context: { user: "ada", log: [] },
      plugins: [
        {
          id: "ctx",
          setup: (ctx) => {
            seen = { ...ctx }
          },
          slots: { status: (ctx) => text(ctx.renderer, `user=${ctx.user}`) },
        },
      ],
    })
    expect(await h.frame()).toContain("user=ada")
    expect(seen!.engine).toBe(h.app.engine)
    expect(seen!.renderer).toBe(h.app.renderer)
    expect(getSlotRegistry(h.app.engine).context.root).toBe(h.app.root.proxy)
  })
})

describe("Slot", () => {
  test("fallback shows without plugins, disappears when one registers, returns on unregister", async () => {
    const h = await mount(
      `Item { width: 40; height: 4; Slot { name: "side"; TestText { text: "fallback here" } } }`,
    )
    const slot = findSlot(h.app.root, "side")
    expect(await h.frame()).toContain("fallback here")
    expect(slot.peek("count")).toBe(0)

    registerPlugin(h.app.engine, { id: "p", slots: { side: (ctx) => text(ctx.renderer, "contributed") } })
    let frame = await h.frame()
    expect(frame).toContain("contributed")
    expect(frame).not.toContain("fallback here")
    expect(slot.peek("count")).toBe(1)

    unregisterPlugin(h.app.engine, "p")
    frame = await h.frame()
    expect(frame).toContain("fallback here")
    expect(frame).not.toContain("contributed")
    expect(slot.peek("count")).toBe(0)
  })

  test('mode "append" keeps the fallback and adds contributions after it', async () => {
    const h = await mount(
      `Item { width: 40; height: 4; Slot { name: "side"; mode: "append"; flexDirection: "row"; gap: 1; TestText { text: "BASE" } } }`,
      { plugins: [{ id: "p", slots: { side: (ctx) => text(ctx.renderer, "EXTRA") } }] },
    )
    const line = (await h.frame()).split("\n").find((l) => l.includes("BASE"))!
    expect(line).toContain("EXTRA")
    expect(line.indexOf("BASE")).toBeLessThan(line.indexOf("EXTRA"))
  })

  test('mode "replace" shows every contribution by order; "single_winner" only the first', async () => {
    const h = await mount(
      `Item { width: 40; height: 4; Slot { name: "side"; mode: "replace"; flexDirection: "row"; gap: 1; TestText { text: "BASE" } } }`,
      {
        plugins: [
          { id: "late", order: 20, slots: { side: (ctx) => text(ctx.renderer, "LATE") } },
          { id: "early", order: 10, slots: { side: (ctx) => text(ctx.renderer, "EARLY") } },
        ],
      },
    )
    let frame = await h.frame()
    expect(frame).not.toContain("BASE")
    expect(frame.indexOf("EARLY")).toBeGreaterThanOrEqual(0)
    expect(frame.indexOf("EARLY")).toBeLessThan(frame.indexOf("LATE"))

    findSlot(h.app.root, "side").set("mode", "single_winner")
    frame = await h.frame()
    expect(frame).toContain("EARLY")
    expect(frame).not.toContain("LATE")
  })

  test("changing the name re-resolves contributions and keeps the fallback children", async () => {
    const h = await mount(`Item { width: 40; height: 4; Slot { name: "a"; TestText { text: "fallback" } } }`, {
      plugins: [{ id: "p", slots: { b: (ctx) => text(ctx.renderer, "for b") } }],
    })
    const slot = findSlot(h.app.root, "a")
    expect(await h.frame()).toContain("fallback")
    slot.set("name", "b")
    expect(await h.frame()).toContain("for b")
    slot.set("name", "c")
    expect(await h.frame()).toContain("fallback")
  })

  test("refresh() re-renders after in-place data mutation", async () => {
    const h = await mount(`Item { width: 40; height: 4; Slot { name: "s" } }`)
    let calls = 0
    registerPlugin(h.app.engine, {
      id: "p",
      slots: {
        s: (ctx, data) => {
          calls++
          return text(ctx.renderer, `v=${String(data.v)}`)
        },
      },
    })
    const slot = findSlot(h.app.root, "s")
    const data: Record<string, unknown> = { v: 1 }
    slot.set("data", data)
    expect(await h.frame()).toContain("v=1")
    data.v = 2
    slot.call("refresh")
    expect(await h.frame()).toContain("v=2")
    expect(calls).toBeGreaterThanOrEqual(3)
  })

  test("destroying a Slot destroys host-owned contributions", async () => {
    const h = await mount(`Item { width: 40; height: 4; Slot { name: "s" } }`)
    let node: BoxRenderable | null = null
    registerPlugin(h.app.engine, {
      id: "p",
      slots: {
        s: (ctx) => {
          node = new BoxRenderable(ctx.renderer, { width: 3, height: 1 })
          return node
        },
      },
    })
    const slot = findSlot(h.app.root, "s")
    expect(node!.isDestroyed).toBe(false)
    slot.destroy()
    expect(node!.isDestroyed).toBe(true)
  })
})

describe("QML plugins", () => {
  const pluginFile = join(FIXTURES, "plugins", "wordcount.qml")

  test("a Plugin file contributes to a slot with reactive data", async () => {
    const h = await mount(
      `Item {
         id: root
         width: 40; height: 4
         property int words: 3
         Slot { name: "status"; data: ({ words: root.words }); TestText { text: "no plugins" } }
       }`,
      { plugins: [pluginFile] },
    )
    let frame = await h.frame()
    expect(frame).toContain("words: 3")
    expect(frame).not.toContain("no plugins")
    expect(h.log).toEqual(["wordcount setup"])
    expect(listPlugins(h.app.engine)).toEqual([{ id: "wordcount", order: 5, kind: "qml", file: pluginFile }])

    // The delegate instance is updated in place, not recreated.
    const slot = findSlot(h.app.root, "status")
    const before = slot.slotRenderable!.getChildren()[0]
    h.app.root.set("words", 10)
    frame = await h.frame()
    expect(frame).toContain("words: 10")
    expect(slot.slotRenderable!.getChildren()[0]).toBe(before)

    // Direct assignment of the Slot's data works too.
    slot.set("data", { words: 99 })
    expect(await h.frame()).toContain("words: 99")
    expect(h.errors).toEqual([])
  })

  test("unregistering a QML plugin destroys it (Component.onDestruction = dispose)", async () => {
    const h = await mount(`Item { width: 40; height: 4; Slot { name: "status"; data: ({ words: 1 }); TestText { text: "none" } } }`, {
      plugins: [pluginFile],
    })
    expect(await h.frame()).toContain("words: 1")
    expect(unregisterPlugin(h.app.engine, "wordcount")).toBe(true)
    expect(h.log).toEqual(["wordcount setup", "wordcount dispose"])
    expect(await h.frame()).toContain("none")
    expect(listPlugins(h.app.engine)).toEqual([])
  })

  test("plugin types are registered for the host document", async () => {
    const h = await mount(`Item { width: 40; height: 4; Badge {} }`, { plugins: [pluginFile] })
    expect(await h.frame()).toContain("badge!")
  })

  test("pluginDirs loads every Plugin file and skips helper types", async () => {
    const h = await mount(
      `Item {
         width: 40; height: 6
         Slot { name: "status"; data: ({ words: 2 }) }
         Slot { name: "side"; data: ({ n: 1 }) }
       }`,
      { pluginDirs: [join(FIXTURES, "plugins")] },
    )
    const frame = await h.frame()
    expect(frame).toContain("words: 2")
    expect(frame).toContain("managed side 1")
    expect(listPlugins(h.app.engine).map((p) => p.id).sort()).toEqual(["managedPlugin", "wordcount"])
    expect(h.errors).toEqual([])
  })

  test("managed contributions keep their instance while the slot's data changes", async () => {
    const h = await mount(`Item { width: 40; height: 4; Slot { name: "side"; data: ({ n: 1 }) } }`, {
      plugins: [join(FIXTURES, "plugins", "managed.qml")],
    })
    expect(await h.frame()).toContain("managed side 1")
    findSlot(h.app.root, "side").set("data", { n: 2 })
    expect(await h.frame()).toContain("managed side 2")
    expect(h.log).toEqual(["managed created"])
    unregisterPlugin(h.app.engine, "managedPlugin")
    expect(await h.frame()).not.toContain("managed")
  })

  test("broken plugin files and failing delegates are reported, good plugins still load", async () => {
    const h = await mount(`Item { width: 40; height: 4; Slot { name: "status"; flexDirection: "row" } }`, {
      pluginDirs: [join(FIXTURES, "plugins-broken")],
    })
    expect(await h.frame()).toContain("good plugin")
    expect(h.errors.some((e) => e.includes("broken.qml"))).toBe(true)
    expect(h.errors.some((e) => e.includes('plugin "renderfail"') && e.includes("visual"))).toBe(true)
    expect(listPlugins(h.app.engine).map((p) => p.id).sort()).toEqual(["good", "renderfail"])
  })

  test("loadQmlPlugin rejects documents whose root is not a Plugin", async () => {
    const h = await mount(`Item { width: 10; height: 2 }`)
    await expect(loadQmlPlugin(h.app.engine, join(FIXTURES, "plugins", "Badge.qml"))).rejects.toThrow(
      "root object is not a Plugin",
    )
    expect(await loadPluginsFromDir(h.app.engine, join(FIXTURES, "does-not-exist"))).toEqual([])
    expect(h.errors.some((e) => e.includes("does-not-exist"))).toBe(true)
  })

  test("runQml with a file and QML plugin fixture", async () => {
    t = await createTestRenderer({ width: 40, height: 8 })
    const log: string[] = []
    app = await runQml(join(FIXTURES, "plugin-app.qml"), {
      renderer: t.renderer,
      types: { TestText },
      context: { log },
      plugins: [pluginFile],
    })
    await t.renderOnce()
    expect(t.captureCharFrame()).toContain("words: 3")
    app.root.set("words", 4)
    await t.renderOnce()
    expect(t.captureCharFrame()).toContain("words: 4")
  })
})

describe("examples", () => {
  const EXAMPLES = join(import.meta.dir, "..", "examples")

  /** TestText plus the few Text properties the example plugins use (until the real Text lands). */
  class ExampleText extends TestText {
    constructor(engine: ConstructorParameters<typeof TestText>[0], typeName: string) {
      super(engine, typeName)
      this.defineProperty("color", { type: "var" })
    }
  }

  test("the plugin examples parse", async () => {
    for (const file of ["plugin-host.qml", "plugins/clock.qml", "plugins/hello.qml"]) {
      expect(() => parseQml(readFileSync(join(EXAMPLES, file), "utf8"), file)).not.toThrow()
    }
  })

  test("examples/plugins/clock.qml contributes a ticking clock to the status bar", async () => {
    let tick: (() => void) | null = null
    const h = await mount(
      `Item { width: 40; height: 2; Slot { name: "statusbar"; flexDirection: "row"; TestText { text: "ready" } } }`,
      {
        types: { TestText, Text: ExampleText },
        plugins: [join(EXAMPLES, "plugins", "clock.qml")],
        scheduler: {
          setTimeout: (fn: () => void) => ((tick = fn), 1),
          clearTimeout: () => {},
          setInterval: (fn: () => void) => ((tick = fn), 1),
          clearInterval: () => {},
        },
      },
    )
    const frame = await h.frame()
    expect(frame).toMatch(/⏱ \d/)
    expect(frame).not.toContain("ready")
    expect(listPlugins(h.app.engine).map((p) => p.id)).toEqual(["clock"])
    expect(h.errors).toEqual([])
    expect(tick).not.toBeNull()
  })
})
