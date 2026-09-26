import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { InputRenderable, SelectRenderable, TextRenderable } from "@opentui/core"
import { QmlEngine, type QmlObject } from "../src/runtime/index.ts"
import { mount, registerOpenTuiTypes, type VisualObject } from "../src/components/index.ts"

const EXAMPLES = join(import.meta.dir, "..", "examples")

let t: TestRendererSetup | null = null
let engine: QmlEngine | null = null

afterEach(() => {
  engine?.destroy()
  engine = null
  t?.renderer.destroy()
  t = null
})

interface Setup {
  t: TestRendererSetup
  engine: QmlEngine
  root: QmlObject & VisualObject
  warnings: string[]
  errors: string[]
  frame(): string
  render(): Promise<string>
}

async function setupEngine(width: number, height: number) {
  t = await createTestRenderer({ width, height })
  const warnings: string[] = []
  const errors: string[] = []
  engine = new QmlEngine({
    renderer: t.renderer,
    onWarning: (w) => warnings.push(w),
    onError: (e, c) => errors.push(`${c ?? ""}: ${e instanceof Error ? e.message : String(e)}`),
  })
  registerOpenTuiTypes(engine)
  return { t, engine, warnings, errors }
}

async function finish(s: Omit<Setup, "frame" | "render" | "root">, root: QmlObject): Promise<Setup> {
  mount(s.engine, root)
  const render = async (): Promise<string> => {
    await s.t.renderOnce()
    await Promise.resolve() // layout results are synced in a microtask
    await s.t.renderOnce()
    return s.t.captureCharFrame()
  }
  await render()
  return { ...s, root: root as QmlObject & VisualObject, frame: () => s.t.captureCharFrame(), render }
}

async function setup(src: string, width = 40, height = 10): Promise<Setup> {
  const s = await setupEngine(width, height)
  const root = s.engine.loadSource(`import OpenTUI\n${src}`, "test.qml").createObject()
  return finish(s, root)
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

describe("Text", () => {
  test("renders and updates reactively", async () => {
    const s = await setup(`Window { property int count: 1; Text { text: "count " + count } }`)
    expect(s.frame()).toContain("count 1")
    s.root.proxy.count = 2
    expect(await s.render()).toContain("count 2")
  })

  test("numbers, font attributes, wrap and alignment statics", async () => {
    const s = await setup(`Window {
      Text { id: a; objectName: "a"; text: 42; font.bold: true; font.underline: true }
      Text { id: b; objectName: "b"; width: 10; text: "hello"; wrapMode: Text.NoWrap; horizontalAlignment: Text.AlignRight }
    }`)
    expect(s.frame()).toContain("42")
    const [a, b] = s.root.children as VisualObject[]
    const ra = a!.renderable as TextRenderable
    expect(ra.attributes).toBe(1 | 8) // BOLD | UNDERLINE
    const rb = b!.renderable as TextRenderable
    expect(rb.wrapMode).toBe("none")
    expect(rb.textAlign).toBe("right")
    expect(s.frame().split("\n")[1]).toBe("     hello" + " ".repeat(30))
  })

  test("Text does not mount visual children", async () => {
    const s = await setup(`Window { Text { text: "x"; Text { text: "inner" } } }`)
    expect(s.frame()).not.toContain("inner")
    expect(s.warnings.some((w) => w.includes("cannot contain visual children"))).toBe(true)
  })
})

describe("Rectangle", () => {
  test("border and title", async () => {
    const s = await setup(`Window {
      Rectangle { width: 20; height: 4; border.width: 1; border.color: "red"; title: " Box "; Text { text: "inside" } }
    }`)
    const lines = s.frame().split("\n")
    expect(lines[0]).toContain("┌─ Box ")
    expect(lines[1]).toContain("│inside")
    expect(lines[3]).toContain("└")
  })

  test("radius selects rounded borders", async () => {
    const s = await setup(`Window { Rectangle { width: 10; height: 3; border.width: 1; radius: 1 } }`)
    expect(s.frame()).toContain("╭")
  })
})

describe("layouts", () => {
  test("Column stacks and Row lines up children", async () => {
    const s = await setup(`Window {
      Column {
        Text { text: "A" }
        Text { text: "B" }
      }
      Row { spacing: 1
        Text { text: "C" }
        Text { text: "D" }
      }
    }`)
    const lines = s.frame().split("\n")
    expect(lines[0]!.startsWith("A")).toBe(true)
    expect(lines[1]!.startsWith("B")).toBe(true)
    expect(lines[2]!.startsWith("C D")).toBe(true)
  })

  test("Repeater children land between their siblings", async () => {
    const s = await setup(`Window {
      Text { text: "first" }
      Repeater { model: ["r1", "r2"]; Text { text: modelData } }
      Text { text: "last" }
    }`)
    const lines = s.frame().split("\n").map((l) => l.trim())
    expect(lines.slice(0, 4)).toEqual(["first", "r1", "r2", "last"])
  })

  test("layout results, anchors.fill and percentages", async () => {
    const s = await setup(`Window {
      Item { id: box; objectName: "box"; width: "50%"; height: 4
        Item { id: filler; anchors.fill: parent }
      }
      Text { text: "w=" + box.layoutWidth + " f=" + filler.layoutWidth + "x" + filler.layoutHeight + " y=" + y }
    }`)
    expect(s.frame()).toContain("w=20 f=20x4 y=4")
  })

  test("Layout.fillWidth in a RowLayout grows the item", async () => {
    const s = await setup(`Window {
      RowLayout {
        Item { id: a; Layout.fillWidth: true; height: 1 }
        Text { id: b; text: "end" }
      }
      Text { text: "a=" + a.layoutWidth }
    }`)
    expect(s.frame()).toContain("a=37")
  })

  test("visible: false hides an item", async () => {
    const s = await setup(`Window { property bool shown: true; Text { visible: shown; text: "peekaboo" } }`)
    expect(s.frame()).toContain("peekaboo")
    s.root.proxy.shown = false
    expect(await s.render()).not.toContain("peekaboo")
  })

  test("destroying an object removes its renderable", async () => {
    const s = await setup(`Window {
      Text { id: gone; text: "doomed" }
      Text { text: "stays" }
    }`)
    expect(s.frame()).toContain("doomed")
    const victim = s.root.children[0] as VisualObject
    victim.destroy()
    expect(victim.renderable.isDestroyed).toBe(true)
    expect(s.root.renderable.getChildrenCount()).toBe(1)
    const frame = await s.render()
    expect(frame).not.toContain("doomed")
    expect(frame).toContain("stays")
  })
})

describe("focus and keys", () => {
  test("focus: true focuses; forceActiveFocus moves focus", async () => {
    const s = await setup(`Window {
      Item { id: a; objectName: "a"; focus: true; width: 2; height: 1 }
      Item { id: b; objectName: "b"; width: 2; height: 1 }
    }`)
    const [a, b] = s.root.children as VisualObject[]
    expect(a!.renderable.focused).toBe(true)
    expect(a!.peek("activeFocus")).toBe(true)
    b!.proxy.forceActiveFocus()
    expect(b!.renderable.focused).toBe(true)
    expect(a!.peek("focus")).toBe(false)
    expect(b!.peek("focus")).toBe(true)
  })

  test("root Keys.onPressed receives keys", async () => {
    const s = await setup(`Window {
      property var seen: []
      Keys.onPressed: (event) => { seen = seen.concat([event.key + (event.ctrl ? "+c" : "")]) }
    }`)
    s.t.mockInput.pressKey("a")
    s.t.mockInput.pressKey("s", { ctrl: true })
    s.t.mockInput.pressArrow("down")
    expect(s.root.peek("seen")).toEqual(["a", "s+c", "down"])
  })

  test("non-root Keys only while focused; accepted stops the root handler", async () => {
    const s = await setup(`Window {
      property string log: ""
      Keys.onPressed: log += "R" + event.key
      Item { id: inner; width: 1; height: 1
        Keys.onPressed: (event) => { log += "I" + event.key; event.accepted = event.key === "x" }
        Keys.onEscapePressed: log += "E"
      }
    }`)
    s.t.mockInput.pressKey("a")
    expect(s.root.peek("log")).toBe("Ra")
    ;(s.root.children[0] as VisualObject).proxy.forceActiveFocus()
    s.t.mockInput.pressKey("b")
    s.t.mockInput.pressKey("x")
    expect(s.root.peek("log")).toBe("RaIbRbIx")
    s.t.mockInput.pressEscape()
    await tick()
    expect(s.root.peek("log")).toBe("RaIbRbIxEIescapeRescape")
  })
})

describe("TextInput", () => {
  test("typing updates text and fires textEdited / accepted", async () => {
    const s = await setup(`Window {
      property string edited: ""
      property int acceptedCount: 0
      property string mirror: input.text
      TextInput { id: input; focus: true; width: 20; text: "hi"
        onTextEdited: edited = text
        onAccepted: { acceptedCount++; text = "" }
      }
    }`)
    const input = s.root.children[0] as VisualObject
    expect((input.renderable as InputRenderable).value).toBe("hi")
    expect(input.renderable.focused).toBe(true)
    await s.t.mockInput.typeText(" there")
    expect(input.peek("text")).toBe("hi there")
    expect(s.root.peek("edited")).toBe("hi there")
    expect(s.root.peek("mirror")).toBe("hi there")
    expect(await s.render()).toContain("hi there")
    s.t.mockInput.pressEnter()
    expect(s.root.peek("acceptedCount")).toBe(1)
    expect(input.peek("text")).toBe("")
    expect((input.renderable as InputRenderable).value).toBe("")
  })

  test("assigning text updates the field without textEdited", async () => {
    const s = await setup(`Window { property int edits: 0; TextInput { width: 10; onTextEdited: edits++ } }`)
    const input = s.root.children[0] as VisualObject
    input.proxy.text = "abc"
    expect((input.renderable as InputRenderable).value).toBe("abc")
    expect(s.root.peek("edits")).toBe(0)
  })
})

describe("ListView", () => {
  test("arrow keys change currentIndex, Enter fires activated", async () => {
    const s = await setup(`Window {
      property var activatedWith: null
      ListView { id: list; focus: true; height: 6; showDescription: false
        model: ["alpha", { name: "beta", description: "b" }, { title: "gamma", value: 3 }]
        onActivated: (index, option) => activatedWith = [index, option]
      }
      Text { text: "current=" + list.currentIndex + " count=" + list.count }
    }`)
    const list = s.root.children[0] as VisualObject
    expect(list.renderable).toBeInstanceOf(SelectRenderable)
    expect(s.frame()).toContain("alpha")
    expect(s.frame()).toContain("gamma")
    s.t.mockInput.pressArrow("down")
    s.t.mockInput.pressArrow("down")
    expect(list.peek("currentIndex")).toBe(2)
    expect(await s.render()).toContain("current=2 count=3")
    s.t.mockInput.pressEnter()
    expect(s.root.peek("activatedWith")).toEqual([2, 3])
    list.proxy.decrementCurrentIndex()
    expect(list.peek("currentIndex")).toBe(1)
    expect(list.peek("currentItem")).toEqual({ name: "beta", description: "b" })
    list.proxy.currentIndex = 0
    expect((list.renderable as SelectRenderable).getSelectedIndex()).toBe(0)
  })

  test("ListModel models update the options", async () => {
    const s = await setup(`Window {
      ListModel { id: m; ListElement { name: "one" } }
      ListView { id: list; height: 4; showDescription: false; model: m }
      Text { text: "count=" + list.count }
    }`)
    expect(s.frame()).toContain("one")
    const model = s.root.children[0]!
    model.proxy.append({ name: "two" })
    const frame = await s.render()
    expect(frame).toContain("two")
    expect(frame).toContain("count=2")
  })

  test("TabBar renders its tabs", async () => {
    const s = await setup(`Window { TabBar { height: 2; showDescription: false; model: ["Home", "Settings"]; tabWidth: 10 } }`)
    expect(s.frame()).toContain("Home")
    expect(s.frame()).toContain("Settings")
  })
})

describe("containers and misc", () => {
  test("ScrollView mounts children in its content", async () => {
    const s = await setup(`Window {
      ScrollView { id: sv; height: 3
        Repeater { model: 10; Text { text: "line " + index } }
      }
    }`)
    const frame = s.frame()
    expect(frame).toContain("line 0")
    expect(frame).toContain("line 2")
    expect(frame).not.toContain("line 5")
    const sv = s.root.children[0] as VisualObject
    sv.proxy.scrollTo(5)
    expect(sv.peek("contentY")).toBe(5)
    expect(await s.render()).toContain("line 5")
  })

  test("AsciiText, Markdown and Code render headlessly", async () => {
    const s = await setup(
      `Window {
        AsciiText { text: "HI"; font: "tiny" }
        Markdown { height: 3; text: "# Title\\n\\nsome text" }
        Code { height: 1; text: "const x = 1"; filetype: "javascript" }
      }`,
      60,
      12,
    )
    // Markdown/Code highlighting runs asynchronously (tree-sitter); give it a few frames.
    let frame = s.frame()
    for (let i = 0; i < 20 && !frame.includes("some text"); i++) {
      await tick(20)
      frame = await s.render()
    }
    expect(frame).toContain("some text")
    expect(frame).toContain("const x = 1")
    expect(s.errors).toEqual([])
  })

  test("mouse signals report local coordinates", async () => {
    const s = await setup(`Window {
      property var clickedAt: null
      Item { width: 10; height: 3; marginLeft: 2; onMouseDown: (mouse) => clickedAt = [mouse.x, mouse.y] }
    }`)
    await s.t.mockMouse.click(5, 1)
    expect(s.root.peek("clickedAt")).toEqual([3, 1])
  })
})

describe("examples", () => {
  const cases: Array<[string, string[]]> = [
    ["hello.qml", ["Hello from QML!", "Press q or Esc to quit"]],
    ["counter.qml", ["Counter", "Count: 0", "even"]],
    ["dashboard.qml", ["opentui-qml dashboard", "Overview", "Welcome to the dashboard."]],
    ["todo.qml", ["Todos (3)", "[x] 1. Write a QML file", "[ ] 2. Run it with opentui-qml", "Add:"]],
    ["components.qml", ["Left", "Content of the left card", "and reused with different properties."]],
    ["richtext.qml", ["Rich text", "Styles: bold italic underline strike dim", "Nested: green and bold and italic", "0 presses of space", "Links: opentui.com"]],
    ["table.qml", ["Services (3 of 5)", "Service", "Latency (ms)", "cache", "degraded", "Rows:"]],
    ["animation.qml", ["Animations", "] 0%", "running"]],
    ["responsive.qml", ["Terminal: 80x24 (wide layout)", "Sidebar", "Side by side", "Resized 0 times"]],
  ]
  for (const [file, expected] of cases) {
    test(`${file} renders`, async () => {
      const s0 = await setupEngine(80, 24)
      const component = await s0.engine.loadFile(join(EXAMPLES, file))
      const s = await finish(s0, component.createObject())
      const frame = s.frame()
      for (const text of expected) expect(frame).toContain(text)
      expect(s.errors).toEqual([])
      expect(s.warnings).toEqual([])
    })
  }

  test("counter.qml reacts to keys", async () => {
    const s0 = await setupEngine(80, 24)
    const s = await finish(s0, (await s0.engine.loadFile(join(EXAMPLES, "counter.qml"))).createObject())
    s.t.mockInput.pressArrow("up")
    s.t.mockInput.pressKey("k")
    expect(await s.render()).toContain("Count: 2")
    s.t.mockInput.pressKey("-")
    expect(await s.render()).toContain("odd")
  })

  test("dashboard.qml follows the list selection", async () => {
    const s0 = await setupEngine(80, 24)
    const s = await finish(s0, (await s0.engine.loadFile(join(EXAMPLES, "dashboard.qml"))).createObject())
    s.t.mockInput.pressArrow("down")
    const frame = await s.render()
    expect(frame).toContain("─ Metrics ─")
    expect(frame).toContain("CPU 12%")
  })

  test("todo.qml adds an entry from the input", async () => {
    const s0 = await setupEngine(80, 24)
    const s = await finish(s0, (await s0.engine.loadFile(join(EXAMPLES, "todo.qml"))).createObject())
    await s.t.mockInput.typeText("Buy milk")
    s.t.mockInput.pressEnter()
    const frame = await s.render()
    expect(frame).toContain("Todos (4)")
    expect(frame).toContain("[ ] 4. Buy milk")
  })
})

