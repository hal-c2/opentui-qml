import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ManualScheduler, QmlEngine, QmlObject } from "../src/runtime/index.ts"
import type { HandlerSpec } from "../src/runtime/index.ts"
import { bind, doc, fn, obj, prop, signal } from "./helpers/ast.ts"

/** Minimal visual-ish test type: width/height, records attached calls. */
class Item extends QmlObject {
  attachedHandlers: string[] = []
  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    this.defineProperty("width", { type: "real" })
    this.defineProperty("height", { type: "real" })
    this.defineProperty("border.width", { type: "int" })
    this.defineSignal("clicked", ["mouse"])
  }
  override attachHandler(type: string, name: string, spec: HandlerSpec): void {
    this.attachedHandlers.push(`${type}.${name}:${spec.compiled.source}`)
  }
}
;(Item as unknown as { qmlStatics: unknown }).qmlStatics = { Big: 100 }

function setup() {
  const warnings: string[] = []
  const errors: unknown[] = []
  const scheduler = new ManualScheduler()
  const engine = new QmlEngine({
    scheduler,
    onWarning: (w) => warnings.push(w),
    onError: (e) => errors.push(e),
    globals: { appName: "demo" },
  })
  engine.registerType("Item", Item)
  const load = (src: string, file?: string) => engine.createObject(engine.loadSource(src, file))
  return { engine, scheduler, warnings, errors, load }
}

describe("bindings and handlers", () => {
  test("binding re-evaluation fires onXChanged", () => {
    const { load } = setup()
    const root = load(`
      Item {
        property int a: 1
        property int b: a * 2
        property var log: []
        onBChanged: log.push(b)
      }`)
    root.set("a", 5)
    expect(root.get("b")).toBe(10)
    expect(root.get("log")).toEqual([10])
  })

  test("assignment in a handler breaks the binding; Qt.binding restores it", () => {
    const { load } = setup()
    const root = load(`
      Item {
        property int a: 1
        property int b: a + 1
        signal cut
        signal rebind
        onCut: b = 42
        onRebind: b = Qt.binding(function() { return a * 100 })
      }`)
    root.emit("cut")
    root.set("a", 3)
    expect(root.get("b")).toBe(42)
    root.emit("rebind")
    expect(root.get("b")).toBe(300)
    root.set("a", 4)
    expect(root.get("b")).toBe(400)
  })

  test("handler reads are untracked", () => {
    const { load } = setup()
    const root = load(`
      Item {
        property int a: 1
        property int copies: 0
        signal go
        onGo: { copies = copies + a }
      }`)
    root.emit("go")
    expect(root.get("copies")).toBe(1)
    root.set("a", 10)
    expect(root.get("copies")).toBe(1)
  })

  test("handlers run in a batch", () => {
    const { load } = setup()
    const root = load(`
      Item {
        property int a: 0
        property int b: 0
        property int sum: a + b
        property int sumChanges: 0
        onSumChanged: sumChanges++
        signal go
        onGo: { a = 1; b = 2 }
      }`)
    root.emit("go")
    expect(root.get("sum")).toBe(3)
    expect(root.get("sumChanges")).toBe(1)
  })

  test("binding errors are logged once and the old value is kept", () => {
    const { load, errors } = setup()
    const root = load(`
      Item {
        property var src: ({ v: 1 })
        property int tick: 0
        property int out: { tick; return src.v }
      }`)
    expect(root.get("out")).toBe(1)
    root.set("src", null)
    root.set("tick", 1)
    root.set("tick", 2)
    expect(root.get("out")).toBe(1)
    expect(errors.length).toBe(1)
    expect(String((errors[0] as Error).message)).toMatch(/:\d+: /)
  })

  test("signal parameters are visible by name in block handlers", () => {
    const { load } = setup()
    const root = load(`
      Item {
        signal moved(int x, int y)
        property string got
        onMoved: { got = x + "," + y }
      }`)
    root.emit("moved", 3, 4)
    expect(root.get("got")).toBe("3,4")
  })

  test("function-valued handler receives args", () => {
    const { load } = setup()
    const root = load(`
      Item {
        property var got
        onClicked: function(m) { got = m.button }
      }`)
    root.emit("clicked", { button: "left" })
    expect(root.get("got")).toBe("left")
  })

  test("Component.onCompleted runs bottom-up after bindings", () => {
    const { engine, load } = setup()
    const order: string[] = []
    engine.globals.order = order
    const root = load(`
        Item {
          id: root
          property int w: child.width
          Component.onCompleted: order.push("root:" + w)
          Item {
            id: child
            width: 7
            Component.onCompleted: order.push("child")
          }
        }`)
    expect(order).toEqual(["child", "root:7"])
    expect(root.isCompleted).toBe(true)
  })

  test("destroy disposes bindings and emits onDestruction", () => {
    const { engine, load } = setup()
    const log: string[] = []
    engine.globals.log = log
    const root = load(`
      Item {
        id: root
        property int a: 1
        Item {
          width: root.a * 2
          onWidthChanged: log.push("w" + width)
          Component.onDestruction: log.push("bye")
        }
      }`)
    const child = root.children[0]!
    root.set("a", 2)
    root.destroy()
    expect(child.isDestroyed).toBe(true)
    expect(log).toEqual(["w4", "bye"])
    expect(root.isDestroyed).toBe(true)
  })

  test("attached handlers and attached properties", () => {
    const { load } = setup()
    const root = load(`
      Item {
        property bool fill: true
        Keys.onPressed: console.log(event)
        Layout.fillWidth: fill
        Layout.margins: 2
      }`) as Item
    expect(root.attachedHandlers).toEqual(["Keys.onPressed:console.log(event)"])
    expect(root.get("Layout.fillWidth")).toBe(true)
    expect(root.get("Layout.margins")).toBe(2)
    root.set("fill", false)
    expect(root.get("Layout.fillWidth")).toBe(false)
  })

  test("grouped properties via dotted names", () => {
    const { load } = setup()
    const root = load(`
      Item {
        property int w: border.width + 1
        border.width: 3
        border { width: 4 }
      }`)
    expect(root.get("border.width")).toBe(4)
    expect(root.get("w")).toBe(5)
  })

  test("unknown handler warns", () => {
    const { load, warnings } = setup()
    load(`Item { onNothing: 1 }`)
    expect(warnings.some((w) => w.includes("onNothing"))).toBe(true)
  })
})

describe("scope resolution", () => {
  test("scope object → parent → ids → root → globals → JS globals", () => {
    const { load } = setup()
    const root = load(`
      Item {
        id: root
        width: 50
        property int shadow: 1
        property int rootOnly: 9
        Item {
          id: child
          property int shadow: 2
          property int fromSelf: shadow
          property real fromParent: parent.width
          property int fromRoot: rootOnly
          property int fromId: root.shadow
          property string fromGlobal: appName
          property int fromStatic: Item.Big
          property real fromJs: Math.max(1, 5)
          property bool thisIsProxy: this === child
        }
      }`)
    const child = root.children[0]!
    expect(child.get("fromSelf")).toBe(2)
    expect(child.get("fromParent")).toBe(50)
    expect(child.get("fromRoot")).toBe(9)
    expect(child.get("fromId")).toBe(1)
    expect(child.get("fromGlobal")).toBe("demo")
    expect(child.get("fromStatic")).toBe(100)
    expect(child.get("fromJs")).toBe(5)
    expect(child.get("thisIsProxy")).toBe(true)
    root.set("width", 80)
    expect(child.get("fromParent")).toBe(80)
  })

  test("methods are bound and see their own scope", () => {
    const { load } = setup()
    const root = load(`
      Item {
        id: root
        property int n: 2
        function times(k) { return n * k }
        property var f: times
        property int r: f(3)
        Item { property int viaId: root.times(4) }
      }`)
    expect(root.get("r")).toBe(6)
    expect(root.children[0]!.get("viaId")).toBe(8)
    expect(root.call("times", 5)).toBe(10)
  })

  test("context properties", () => {
    const { engine } = setup()
    engine.registerType("Item", Item)
    const c = engine.loadSource(`Item { property string t: greeting + "!" }`)
    const o = engine.createObject(c, null, { greeting: "hi" })
    expect(o.get("t")).toBe("hi!")
  })

  test("enums are readonly ints", () => {
    const { load } = setup()
    const root = load(`
      Item {
        enum Mode { Off, On = 5, Auto }
        property int m: Auto
      }`)
    expect(root.get("m")).toBe(6)
  })
})

describe("hand-built AST", () => {
  test("engine accepts documents from the AST builder", () => {
    const { engine } = setup()
    const d = doc(
      obj(
        "Item",
        [
          prop("a", "int", "2"),
          prop("b", "int", "a * a"),
          prop("inner", "alias", "kid.width"),
          signal("ping", ["v"]),
          prop("got", "var"),
          bind("onPing", "{ got = v }"),
          fn("add", ["x"], "{ return a + x }"),
          obj("Item", [bind("width", "b + 1")], "kid"),
        ],
        "root",
      ),
    )
    const root = engine.createObject(engine.loadDocument(d))
    expect(root.get("b")).toBe(4)
    expect(root.get("inner")).toBe(5)
    root.emit("ping", "x")
    expect(root.get("got")).toBe("x")
    expect(root.call("add", 1)).toBe(3)
    root.set("a", 3)
    expect(root.get("inner")).toBe(10)
  })
})

describe("documents as types", () => {
  const dir = mkdtempSync(join(tmpdir(), "qml-runtime-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  writeFileSync(
    join(dir, "Button.qml"),
    `import QtQuick 2.15
Item {
  id: button
  property string text: "default"
  property alias labelWidth: label.width
  property int clicks: 0
  signal activated(string how)
  width: 10
  onClicked: { clicks++; activated("click") }
  Item { id: label; width: button.text.length }
}
`,
  )
  writeFileSync(
    join(dir, "Panel.qml"),
    `Item {
  default property alias content: body.children
  Item { id: header }
  Item { id: body }
}
`,
  )
  mkdirSync(join(dir, "widgets"))
  writeFileSync(join(dir, "widgets", "Badge.qml"), `Item { property int n: 7 }`)

  test("sibling file becomes a type; user bindings win; ids are private", async () => {
    const { engine, errors } = setup()
    writeFileSync(
      join(dir, "Main.qml"),
      `Item {
  id: root
  property string how
  property bool labelVisible: typeof label === "undefined"
  Button {
    id: ok
    text: "OK!"
    width: 99
    onActivated: root.how = how
  }
  property int okLabel: ok.labelWidth
}
`,
    )
    const comp = await engine.loadFile(join(dir, "Main.qml"))
    const root = comp.createObject()
    const ok = root.children[0]!
    expect(ok.get("text")).toBe("OK!")
    expect(ok.get("width")).toBe(99)
    expect(root.get("okLabel")).toBe(3)
    expect(root.get("labelVisible")).toBe(true)
    ok.emit("clicked", {})
    expect(ok.get("clicks")).toBe(1)
    expect(root.get("how")).toBe("click")
    ok.set("text", "Cancel")
    expect(root.get("okLabel")).toBe(6)
    expect(errors).toEqual([])
  })

  test("default property alias redirects children", async () => {
    const { engine } = setup()
    writeFileSync(join(dir, "UsesPanel.qml"), `Panel {
  Item { id: a }
  Item { id: b }
}
`)
    const root = (await engine.loadFile(join(dir, "UsesPanel.qml"))).createObject()
    expect(root.children.length).toBe(2)
    expect(root.children[1]!.children.length).toBe(2)
  })

  test("import dir and qualified import", async () => {
    const { engine } = setup()
    writeFileSync(
      join(dir, "Imports.qml"),
      `import "widgets"
import "widgets" as W
Item {
  Badge { }
  W.Badge { n: 8 }
}
`,
    )
    const root = (await engine.loadFile(join(dir, "Imports.qml"))).createObject()
    expect(root.children.map((c) => c.get("n"))).toEqual([7, 8])
  })

  test("unknown type throws", () => {
    const { engine } = setup()
    expect(() => engine.createObject(engine.loadSource(`Nope {}`))).toThrow(/unknown type "Nope"/)
  })
})
