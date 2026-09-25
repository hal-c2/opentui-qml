import { afterEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { QmlEngine, type QmlObject } from "../src/runtime/index.ts"
import {
  applyKeymapOverrides,
  formatKeySequence,
  keyEventMatches,
  mount,
  normalizeKeyName,
  parseKeySequence,
  registerOpenTuiTypes,
} from "../src/components/index.ts"

let t: TestRendererSetup | null = null
let engine: QmlEngine | null = null

afterEach(() => {
  engine?.destroy()
  engine = null
  t?.renderer.destroy()
  t = null
})

async function setup(src: string, opts: { overrides?: Record<string, unknown> } = {}) {
  t = await createTestRenderer({ width: 40, height: 6 })
  const warnings: string[] = []
  const errors: string[] = []
  engine = new QmlEngine({
    renderer: t.renderer,
    onWarning: (w) => warnings.push(w),
    onError: (e) => errors.push(e instanceof Error ? e.message : String(e)),
  })
  registerOpenTuiTypes(engine)
  if (opts.overrides) applyKeymapOverrides(engine, opts.overrides)
  const root = engine.loadSource(`import OpenTUI\n${src}`, "test.qml").createObject()
  mount(engine, root)
  await t.renderOnce()
  return { t, engine, root: root as QmlObject, warnings, errors, input: t.mockInput }
}

describe("key sequences", () => {
  test("parseKeySequence", () => {
    expect(parseKeySequence("ctrl+s")).toEqual({
      name: "s",
      ctrl: true,
      shift: false,
      meta: false,
      super: false,
      anyShift: false,
    })
    expect(parseKeySequence("Ctrl+S")).toEqual(parseKeySequence("ctrl+s"))
    expect(parseKeySequence("Q")).toMatchObject({ name: "q", shift: true })
    expect(parseKeySequence("alt+Enter")).toMatchObject({ name: "return", meta: true })
    expect(parseKeySequence("option+x").meta).toBe(true)
    expect(parseKeySequence("cmd+k").super).toBe(true)
    expect(parseKeySequence("esc").name).toBe("escape")
    expect(parseKeySequence("PgDn").name).toBe("pagedown")
    expect(parseKeySequence("?")).toMatchObject({ name: "?", anyShift: true })
    expect(parseKeySequence("ctrl++")).toMatchObject({ name: "+", ctrl: true })
    expect(parseKeySequence(" ").name).toBe("space")
    expect(() => parseKeySequence("")).toThrow("empty key sequence")
    expect(() => parseKeySequence("hyper+x")).toThrow('unknown modifier "hyper"')
    expect(normalizeKeyName("Up")).toBe("up")
  })

  test("formatKeySequence and keyEventMatches", () => {
    expect(formatKeySequence("Shift+Ctrl+Alt+S")).toBe("ctrl+alt+shift+s")
    expect(formatKeySequence("Q")).toBe("shift+q")
    const ctrlS = parseKeySequence("ctrl+s")
    expect(keyEventMatches({ name: "s", ctrl: true }, ctrlS)).toBe(true)
    expect(keyEventMatches({ name: "s" }, ctrlS)).toBe(false)
    expect(keyEventMatches({ name: "s", ctrl: true, shift: true }, ctrlS)).toBe(false)
    expect(keyEventMatches({ name: "S" }, parseKeySequence("Q"))).toBe(false)
    expect(keyEventMatches({ name: "Q" }, parseKeySequence("Q"))).toBe(true)
    expect(keyEventMatches({ name: "?", shift: true }, parseKeySequence("?"))).toBe(true)
    expect(keyEventMatches({ name: "x", option: true }, parseKeySequence("alt+x"))).toBe(true)
  })
})

describe("Shortcut", () => {
  test("fires activated for its sequence(s)", async () => {
    const s = await setup(`Window {
      property int saves: 0
      property int quits: 0
      Shortcut { sequence: "ctrl+s"; onActivated: saves++ }
      Shortcut { sequences: ["q", "escape"]; onActivated: quits++ }
    }`)
    s.input.pressKey("s", { ctrl: true })
    s.input.pressKey("s")
    s.input.pressKey("q")
    expect(s.root.peek("saves")).toBe(1)
    expect(s.root.peek("quits")).toBe(1)
    s.input.pressEscape()
    await new Promise((r) => setTimeout(r, 30))
    expect(s.root.peek("quits")).toBe(2)
  })

  test("consumes the key unless accepted = false; priority orders handlers", async () => {
    const s = await setup(`Window {
      property string log: ""
      Keys.onPressed: log += "K"
      Shortcut { sequence: "x"; onActivated: log += "low" }
      Shortcut { sequence: "x"; priority: 10; onActivated: (event) => { log += "high,"; event.accepted = false } }
      Shortcut { sequence: "y"; onActivated: log += "y" }
    }`)
    s.input.pressKey("x")
    expect(s.root.peek("log")).toBe("high,low")
    s.root.set("log", "")
    s.input.pressKey("y")
    expect(s.root.peek("log")).toBe("y") // consumed: the root Keys handler never sees it
    s.root.set("log", "")
    s.input.pressKey("z")
    expect(s.root.peek("log")).toBe("K")
  })

  test("disabled shortcuts and destroyed shortcuts do nothing", async () => {
    const s = await setup(`Window {
      property int hits: 0
      property bool on: false
      Shortcut { sequence: "a"; enabled: on; onActivated: hits++ }
    }`)
    s.input.pressKey("a")
    expect(s.root.peek("hits")).toBe(0)
    s.root.set("on", true)
    s.input.pressKey("a")
    expect(s.root.peek("hits")).toBe(1)
    s.root.children[0]!.destroy()
    s.input.pressKey("a")
    expect(s.root.peek("hits")).toBe(1)
  })

  test('context: "item" requires focus inside the enclosing item', async () => {
    const s = await setup(`Window {
      property int hits: 0
      Item { id: panel; width: 4; height: 1
        Shortcut { sequence: "p"; context: "item"; onActivated: hits++ }
      }
      Item { id: other; width: 4; height: 1; focus: true }
    }`)
    s.input.pressKey("p")
    expect(s.root.peek("hits")).toBe(0)
    s.root.children[0]!.proxy.forceActiveFocus()
    s.input.pressKey("p")
    expect(s.root.peek("hits")).toBe(1)
  })

  test("printable keys go to a focused text input instead", async () => {
    const s = await setup(`Window {
      property int hits: 0
      property int saves: 0
      Shortcut { sequence: "q"; onActivated: hits++ }
      Shortcut { sequence: "ctrl+s"; onActivated: saves++ }
      TextInput { id: field; width: 10; focus: true }
    }`)
    s.input.pressKey("q")
    s.input.pressKey("s", { ctrl: true })
    expect(s.root.peek("hits")).toBe(0)
    expect(s.root.peek("saves")).toBe(1)
    expect(s.root.children[2]!.peek("text")).toBe("q")
  })

  test("invalid sequences warn", async () => {
    const s = await setup(`Window { Shortcut { sequence: "hyper+x" } }`)
    expect(s.warnings.some((w) => w.includes('unknown modifier "hyper"'))).toBe(true)
  })
})

describe("Keymap", () => {
  test("bindings, KeyBinding children, handlers and describe()", async () => {
    const s = await setup(`Window {
      property var log: []
      Keymap { id: km
        bindings: ({ "ctrl+s": "save", "q": { action: "quit", description: "Quit the app" } })
        handlers: ({ save: (event, action) => log = log.concat(["handler:" + action]) })
        onActivated: (action, event) => log = log.concat([action + ":" + event.key])
        KeyBinding { keys: ["j", "down"]; action: "next"; description: "Next item" }
      }
      property var help: km.describe()
    }`)
    s.input.pressKey("s", { ctrl: true })
    s.input.pressKey("q")
    s.input.pressKey("j")
    s.input.pressArrow("down")
    s.input.pressKey("k")
    expect(s.root.peek("log")).toEqual(["save:s", "handler:save", "quit:q", "next:j", "next:down"])
    const km = s.root.children[0]!
    expect(km.proxy.describe()).toEqual([
      { keys: "ctrl+s", action: "save", description: "" },
      { keys: "q", action: "quit", description: "Quit the app" },
      { keys: "j", action: "next", description: "Next item" },
      { keys: "down", action: "next", description: "Next item" },
    ])
    expect(km.proxy.keysFor("next")).toEqual(["j", "down"])
  })

  test("Action children get triggered; shortcut adds bindings", async () => {
    const s = await setup(`Window {
      property int saved: 0
      property int opened: 0
      Keymap {
        bindings: ({ "ctrl+s": "save" })
        Action { name: "save"; onTriggered: saved++ }
        Action { name: "open"; shortcut: "ctrl+o"; text: "Open file"; onTriggered: opened++ }
      }
    }`)
    s.input.pressKey("s", { ctrl: true })
    s.input.pressKey("o", { ctrl: true })
    expect(s.root.peek("saved")).toBe(1)
    expect(s.root.peek("opened")).toBe(1)
    expect(s.root.children[0]!.proxy.describe()).toContainEqual({ keys: "ctrl+o", action: "open", description: "Open file" })
  })

  test("reactive bindings, priority and pass-through", async () => {
    const s = await setup(`Window {
      property string log: ""
      property string saveKey: "ctrl+s"
      Keys.onPressed: log += "K"
      Keymap { bindings: ({ [saveKey]: "save" }); onActivated: log += "A" + action }
      Keymap { priority: 5; bindings: ({ "ctrl+s": "first" })
        onActivated: (action, event) => { log += "B" + action + ","; event.accepted = false } }
    }`)
    s.input.pressKey("s", { ctrl: true })
    expect(s.root.peek("log")).toBe("Bfirst,Asave")
    s.root.set("log", "")
    s.root.set("saveKey", "ctrl+w")
    s.input.pressKey("w", { ctrl: true })
    expect(s.root.peek("log")).toBe("Asave")
    s.root.set("log", "")
    s.input.pressKey("s", { ctrl: true })
    expect(s.root.peek("log")).toBe("Bfirst,K")
  })

  test("applyKeymapOverrides: unnamed and named keymaps, null removes", async () => {
    const s = await setup(
      `Window {
        property var log: []
        Keymap { bindings: ({ "q": "quit", "ctrl+s": "save" }); onActivated: log = log.concat(["u:" + action]) }
        Keymap { name: "list"; bindings: ({ "j": "next" }); onActivated: log = log.concat(["l:" + action]) }
      }`,
      { overrides: { q: null, "ctrl+x": "quit", list: { n: "next", j: null } } },
    )
    s.input.pressKey("q")
    s.input.pressKey("x", { ctrl: true })
    s.input.pressKey("s", { ctrl: true })
    s.input.pressKey("j")
    s.input.pressKey("n")
    expect(s.root.peek("log")).toEqual(["u:quit", "u:save", "l:next"])

    // Overrides applied after creation reach existing keymaps too.
    applyKeymapOverrides(s.engine, { "ctrl+q": { action: "quit", description: "Quit" } })
    s.input.pressKey("q", { ctrl: true })
    expect(s.root.peek("log")).toEqual(["u:quit", "u:save", "l:next", "u:quit"])
    expect(s.root.children[0]!.proxy.keysFor("quit")).toEqual(["ctrl+x", "ctrl+q"])
  })

  test("disabled keymaps pass keys through", async () => {
    const s = await setup(`Window {
      property string log: ""
      Keys.onPressed: log += event.key
      Keymap { enabled: false; bindings: ({ "a": "x" }); onActivated: log += "!" }
    }`)
    s.input.pressKey("a")
    expect(s.root.peek("log")).toBe("a")
  })
})
