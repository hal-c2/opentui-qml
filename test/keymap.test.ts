import { afterEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { QmlEngine, type QmlObject } from "../src/runtime/index.ts"
import { toKeymapKeys } from "../src/components/keymap-host.ts"
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
    const s = await setup(`Window { Shortcut { sequence: "foo+x" } }`)
    expect(s.warnings.some((w) => w.includes('unknown modifier "foo"'))).toBe(true)
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

const primary = process.platform === "darwin" ? { super: true } : { ctrl: true }

describe("@opentui/keymap integration", () => {
  test("toKeymapKeys normalises QML key strings", () => {
    expect(toKeymapKeys("Ctrl+S")).toEqual(["ctrl+s"])
    expect(toKeymapKeys("Q")).toEqual(["shift+q"])
    expect(toKeymapKeys("esc")).toEqual(["escape"])
    expect(toKeymapKeys("Alt+Enter")).toEqual(["alt+return"])
    expect(toKeymapKeys("cmd+k")).toEqual(["super+k"])
    expect(toKeymapKeys("gg")).toEqual(["gg"])
    expect(toKeymapKeys("g g")).toEqual(["gg"])
    expect(toKeymapKeys("gG")).toEqual(["g shift+g"])
    expect(toKeymapKeys("Ctrl+X Ctrl+S")).toEqual(["ctrl+x ctrl+s"])
    expect(toKeymapKeys("<leader>s")).toEqual(["<leader>s"])
    expect(toKeymapKeys("ctrl+s, f2")).toEqual(["ctrl+s", "f2"])
    expect(toKeymapKeys(",")).toEqual([","])
    expect(toKeymapKeys("ctrl+,")).toEqual(["ctrl+,"])
    expect(toKeymapKeys("comma")).toEqual([","])
    expect(toKeymapKeys(" ")).toEqual(["space"])
    expect(() => toKeymapKeys("")).toThrow("empty key sequence")
    expect(() => toKeymapKeys("foo+x")).toThrow('unknown modifier "foo"')
  })

  test("multi-key sequences: gg, ctrl+x ctrl+s, mod+s; Keyboard.pendingSequence", async () => {
    const s = await setup(`Window {
      property var log: []
      property string pending: Keyboard.pendingSequence
      property string kmPending: km.pendingSequence
      Keymap { id: km
        bindings: ({ "gg": "top", "G": "bottom", "ctrl+x ctrl+s": "save", "mod+o": "open" })
        onActivated: log = log.concat([action])
      }
    }`)
    s.input.pressKey("g")
    expect(s.root.peek("pending")).toBe("g")
    expect(s.root.peek("kmPending")).toBe("g")
    s.input.pressKey("g")
    expect(s.root.peek("pending")).toBe("")
    s.input.pressKey("G")
    s.input.pressKey("x", { ctrl: true })
    expect(s.root.peek("pending")).toBe("ctrl+x")
    s.input.pressKey("s", { ctrl: true })
    s.input.pressKey("o", primary)
    expect(s.root.peek("log")).toEqual(["top", "bottom", "save", "open"])
    // A key that doesn't continue the sequence clears it.
    s.input.pressKey("g")
    s.input.pressKey("q")
    expect(s.root.peek("pending")).toBe("")
    expect(s.root.peek("log")).toEqual(["top", "bottom", "save", "open"])
    // Escape clears a pending sequence.
    s.input.pressKey("x", { ctrl: true })
    s.input.pressEscape()
    await new Promise((r) => setTimeout(r, 30))
    expect(s.root.peek("pending")).toBe("")
    s.input.pressKey("s", { ctrl: true })
    expect(s.root.peek("log")).toEqual(["top", "bottom", "save", "open"])
  })

  test("leader token (also for bindings declared before the Keymap)", async () => {
    const s = await setup(`Window {
      property var log: []
      Shortcut { sequence: "<leader>q"; onActivated: log = log.concat(["quit"]) }
      Keymap { leader: "ctrl+a"
        bindings: ({ "<leader>s": { action: "save", description: "Save" } })
        onActivated: log = log.concat([action])
      }
      property var help: []
    }`)
    s.input.pressKey("a", { ctrl: true })
    s.input.pressKey("s")
    s.input.pressKey("a", { ctrl: true })
    s.input.pressKey("q")
    expect(s.root.peek("log")).toEqual(["save", "quit"])
    await new Promise((r) => setTimeout(r, 0))
    expect(s.warnings.filter((w) => w.includes("token"))).toEqual([])
    expect(s.engine.singletonValue("Keyboard") as any).toBeDefined()
    const keys = (s.engine.singletonValue("Keyboard") as any).activeKeys()
    expect(keys).toContainEqual({ key: "<leader>s", command: "save", description: "Save" })
    expect(keys).toContainEqual({ key: "<leader>q", command: "", description: "" })
  })

  test("symbols match with or without shift; aliases", async () => {
    const s = await setup(`Window {
      property var log: []
      Shortcut { sequence: "?"; onActivated: log = log.concat(["help"]) }
      Shortcut { sequence: "comma"; onActivated: log = log.concat(["comma"]) }
      Shortcut { sequence: "Q"; onActivated: log = log.concat(["Q"]) }
      Shortcut { sequence: "alt+x"; onActivated: log = log.concat(["M-x"]) }
    }`)
    s.input.pressKey("?")
    s.input.pressKey("?", { shift: true })
    s.input.pressKey(",")
    s.input.pressKey("q")
    s.input.pressKey("Q")
    s.input.pressKey("x", { meta: true })
    expect(s.root.peek("log")).toEqual(["help", "help", "comma", "Q", "M-x"])
  })

  test('context: "item" scopes Keymaps via target, and priority orders layers', async () => {
    const s = await setup(`Window {
      property var log: []
      Item { id: panel; width: 4; height: 1 }
      Item { id: other; width: 4; height: 1; focus: true }
      Keymap { target: panel; bindings: ({ "p": "panel" }); onActivated: log = log.concat([action]) }
      Shortcut { sequence: "n"; onActivated: log = log.concat(["low"]) }
      Keymap { priority: 3; bindings: ({ "n": "high" }); onActivated: log = log.concat([action]) }
      Shortcut { sequence: "m"; onActivated: log = log.concat(["first"]) }
      Shortcut { sequence: "m"; onActivated: log = log.concat(["second"]) }
      property var help: Keyboard.activeKeys().map((k) => k.key)
    }`)
    s.input.pressKey("p")
    expect(s.root.peek("log")).toEqual([])
    expect(s.root.peek("help")).toEqual(["n", "m"])
    s.root.children[0]!.proxy.forceActiveFocus()
    expect(s.root.peek("help")).toEqual(["n", "p", "m"])
    s.input.pressKey("p")
    s.input.pressKey("n")
    s.input.pressKey("m")
    expect(s.root.peek("log")).toEqual(["panel", "high", "first"])
  })

  test("enabled: false on Keymap, Shortcut and Action; toggling at runtime", async () => {
    const s = await setup(`Window {
      property string log: ""
      property bool on: false
      Keys.onPressed: log += "K" + event.key
      Keymap { enabled: on; bindings: ({ "a": "x" }); onActivated: log += "A" }
      Shortcut { enabled: on; sequence: "b"; onActivated: log += "B" }
      Action { name: "c"; enabled: on; shortcut: "c"; onTriggered: log += "C" }
    }`)
    s.input.pressKey("a")
    s.input.pressKey("b")
    s.input.pressKey("c")
    expect(s.root.peek("log")).toBe("KaKbKc")
    s.root.set("log", "")
    s.root.set("on", true)
    s.input.pressKey("a")
    s.input.pressKey("b")
    s.input.pressKey("c")
    expect(s.root.peek("log")).toBe("ABC")
  })

  test("Action.trigger(), Keyboard.dispatch() and Keymap.dispatch()", async () => {
    const s = await setup(`Window {
      id: root
      property var log: []
      Action { id: save; name: "save"; shortcut: "ctrl+s"; text: "Save"; category: "File"
        onTriggered: (event) => root.log = root.log.concat(["save:" + (event.payload === undefined ? "-" : event.payload)]) }
      Action { id: off; name: "off"; enabled: false; onTriggered: root.log = root.log.concat(["off"]) }
      Keymap { id: km
        bindings: ({ "q": "quit" })
        handlers: ({ quit: () => root.log = root.log.concat(["handler:quit"]) })
        onActivated: root.log = root.log.concat(["km:" + action])
        Action { id: quit; name: "quit"; text: "Quit"; onTriggered: root.log = root.log.concat(["action:quit"]) }
      }
      function run() {
        return [save.trigger(), Keyboard.dispatch("save", 7), quit.trigger(), off.trigger(),
                Keyboard.dispatch("nope"), km.dispatch("quit")]
      }
    }`)
    const results = s.root.proxy.run()
    expect(results).toEqual([true, true, true, false, false, true])
    expect(s.root.peek("log")).toEqual([
      "save:-",
      "save:7",
      "km:quit",
      "handler:quit",
      "action:quit",
      "km:quit",
      "handler:quit",
      "action:quit",
    ])
    s.root.set("log", [])
    s.input.pressKey("s", { ctrl: true })
    expect(s.root.peek("log")).toEqual(["save:-"])
    const commands = (s.engine.singletonValue("Keyboard") as any).commands()
    expect(commands).toContainEqual({ name: "save", title: "Save", description: "Save", category: "File", keys: ["ctrl+s"] })
    expect(commands.find((c: any) => c.name === "quit")).toMatchObject({ title: "Quit", keys: ["q"] })
    expect(commands.find((c: any) => c.name === "off")).toBeUndefined()
  })

  test("Keyboard.activeKeys() is reactive and follows pending sequences; formatKey", async () => {
    const s = await setup(`Window {
      property bool extra: false
      property var help: Keyboard.activeKeys().map((k) => k.key + "=" + k.command)
      Keymap { bindings: ({ "ctrl+x ctrl+s": { action: "save", description: "Save" }, "ctrl+x ctrl+c": "quit", "j": "down" }) }
      Shortcut { sequence: "h"; enabled: extra; description: "Help" }
      Shortcut { sequence: "j"; description: "shadowed" }
    }`)
    expect(s.root.peek("help")).toEqual(["ctrl+x ctrl+s=save", "ctrl+x ctrl+c=quit", "j=down"])
    s.root.set("extra", true)
    expect(s.root.peek("help")).toEqual(["ctrl+x ctrl+s=save", "ctrl+x ctrl+c=quit", "j=down", "h="])
    s.input.pressKey("x", { ctrl: true })
    expect(s.root.peek("help")).toEqual(["ctrl+x ctrl+s=save", "ctrl+x ctrl+c=quit"])
    s.input.pressKey("s", { ctrl: true })
    expect(s.root.peek("help")).toHaveLength(4)
    const kb = s.engine.singletonValue("Keyboard") as any
    expect(kb.formatKey("Ctrl+X Ctrl+S")).toBe("ctrl+x ctrl+s")
    expect(kb.formatKey("G")).toBe("shift+g")
    expect(kb.formatKey("mod+s")).toBe(process.platform === "darwin" ? "super+s" : "ctrl+s")
    kb.setData("mode", "insert")
    expect(kb.getData("mode")).toBe("insert")
  })

  test("a focused TextInput gets printable keys unless the binding is application-wide", async () => {
    const s = await setup(`Window {
      property var log: []
      Keys.onPressed: log = log.concat(["K" + event.key])
      Shortcut { sequence: "a"; onActivated: log = log.concat(["window"]) }
      Keymap { bindings: ({ "c": "keymap" }); onActivated: log = log.concat([action]) }
      Shortcut { sequence: "b"; context: "application"; onActivated: log = log.concat(["app"]) }
      Shortcut { sequence: "ctrl+s"; onActivated: log = log.concat(["save"]) }
      TextInput { id: field; width: 10; focus: true }
      readonly property string help: Keyboard.activeKeys().map((k) => k.key).join(" ")
    }`)
    // While the editor has focus, activeKeys() hides what it would take as typing.
    expect(s.root.peek("help")).toBe("b ctrl+s")
    s.input.pressKey("a")
    expect(s.root.peek("help")).toBe("b ctrl+s")
    s.input.pressKey("c")
    s.input.pressKey("b")
    s.input.pressKey("s", { ctrl: true })
    const field = s.root.children.find((c) => c.typeName === "TextInput")!
    expect(field.peek("text")).toBe("ac")
    // Keys yielded to the editor are not consumed, so the root Keys handler still sees them.
    expect(s.root.peek("log")).toEqual(["Ka", "Kc", "app", "save"])
  })

  test("headless engines: no keymap, Action.trigger() still emits", async () => {
    const warnings: string[] = []
    engine = new QmlEngine({ onWarning: (w) => warnings.push(w) })
    registerOpenTuiTypes(engine)
    const root = engine
      .loadSource(
        `import OpenTUI
        QtObject {
          id: root
          property int n: 0
          property var s: Shortcut { sequence: "ctrl+s" }
          property var a: Action { name: "go"; onTriggered: root.n++ }
          function go() { return [a.trigger(), Keyboard.dispatch("go"), Keyboard.activeKeys().length] }
        }`,
        "headless.qml",
      )
      .createObject()
    expect(root.proxy.go()).toEqual([true, false, 0])
    expect(root.peek("n")).toBe(1)
    expect(warnings).toEqual([])
  })

  test("destroying the engine removes the layers; destroyed objects are inert", async () => {
    const s = await setup(`Window {
      property int hits: 0
      Shortcut { sequence: "a"; onActivated: hits++ }
    }`)
    s.input.pressKey("a")
    expect(s.root.peek("hits")).toBe(1)
    let seen = 0
    s.t.renderer.keyInput.on("keypress", () => seen++)
    s.engine.destroy()
    s.input.pressKey("a")
    expect(seen).toBe(1)
    expect(s.errors).toEqual([])
  })

  test("layers can change while a key is being dispatched", async () => {
    const s = await setup(`Window {
      property int step: 0
      Shortcut { sequence: "a"; enabled: step === 0; onActivated: step = 1 }
      Shortcut { sequence: step === 1 ? "b" : "z"; onActivated: step = 2 }
    }`)
    s.input.pressKey("a")
    expect(s.root.peek("step")).toBe(1)
    s.input.pressKey("b")
    expect(s.root.peek("step")).toBe(2)
    expect(s.errors).toEqual([])
  })
})
