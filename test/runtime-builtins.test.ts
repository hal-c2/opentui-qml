import { describe, expect, test } from "bun:test"
import { ListModel, ManualScheduler, QmlEngine, QmlObject, Repeater, toQmlObject } from "../src/runtime/index.ts"

class Item extends QmlObject {
  inserted: string[] = []
  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    this.defineProperty("width", { type: "real" })
    this.defineProperty("text", { type: "string" })
  }
  protected override onChildAdded(child: QmlObject, index: number): void {
    this.inserted.push(`${child.typeName}@${index}`)
  }
}

function setup() {
  const warnings: string[] = []
  const errors: unknown[] = []
  const scheduler = new ManualScheduler()
  const engine = new QmlEngine({ scheduler, onWarning: (w) => warnings.push(w), onError: (e) => errors.push(e) })
  engine.registerType("Item", Item)
  engine.registerType("Text", Item)
  const load = (src: string) => engine.createObject(engine.loadSource(src))
  return { engine, scheduler, warnings, errors, load }
}

const texts = (o: QmlObject) => o.children.filter((c) => c.typeName === "Text").map((c) => c.get("text"))

describe("Repeater", () => {
  test("number model, inserted after the repeater, reactive count", () => {
    const { load } = setup()
    const root = load(`
      Item {
        property int n: 3
        property int shown: rep.count
        Item { id: before }
        Repeater {
          id: rep
          model: n
          Text { text: "t" + index + ":" + modelData }
        }
        Item { id: after }
      }`)
    expect(root.children.map((c) => c.typeName)).toEqual(["Item", "Repeater", "Text", "Text", "Text", "Item"])
    expect(texts(root)).toEqual(["t0:0", "t1:1", "t2:2"])
    expect(root.get("shown")).toBe(3)
    root.set("n", 1)
    expect(texts(root)).toEqual(["t0:0"])
    expect(root.get("shown")).toBe(1)
    expect((root as Item).inserted).toContain("Text@2")
  })

  test("array model with delegate property, itemAt", () => {
    const { load } = setup()
    const root = load(`
      Item {
        property var names: ["a", "b"]
        Repeater {
          id: rep
          model: names
          delegate: Text { text: modelData.toUpperCase() + index }
        }
        property var second: rep.itemAt(1)
      }`)
    expect(texts(root)).toEqual(["A0", "B1"])
    expect(toQmlObject(root.get("second"))?.get("text")).toBe("B1")
    root.set("names", ["x", "y", "z"])
    expect(texts(root)).toEqual(["X0", "Y1", "Z2"])
  })

  test("ListModel roles, updates and structure changes", () => {
    const { load } = setup()
    const root = load(`
      Item {
        ListModel {
          id: fruits
          ListElement { name: "apple"; cost: 2 }
          ListElement { name: "pear"; cost: 3 }
        }
        Repeater {
          model: fruits
          Text { text: name + "=" + cost + "/" + model.name }
        }
        property int total: fruits.count
        function add() { fruits.append({ name: "kiwi", cost: 1 }) }
        function bump() { fruits.setProperty(0, "cost", 5) }
      }`)
    expect(texts(root)).toEqual(["apple=2/apple", "pear=3/pear"])
    root.call("bump")
    expect(texts(root)).toEqual(["apple=5/apple", "pear=3/pear"])
    root.call("add")
    expect(texts(root)).toEqual(["apple=5/apple", "pear=3/pear", "kiwi=1/kiwi"])
    expect(root.get("total")).toBe(3)
    const model = root.children.find((c) => c instanceof ListModel) as ListModel
    model.remove(0, 2)
    expect(texts(root)).toEqual(["kiwi=1/kiwi"])
    model.clear()
    expect(texts(root)).toEqual([])
    expect(root.get("total")).toBe(0)
  })

  test("delegates see ids of the enclosing document", () => {
    const { load } = setup()
    const root = load(`
      Item {
        id: root
        property string prefix: "p"
        Repeater { model: 2; Text { text: root.prefix + index } }
      }`)
    expect(texts(root)).toEqual(["p0", "p1"])
    root.set("prefix", "q")
    expect(texts(root)).toEqual(["q0", "q1"])
  })

  test("destroying the repeater destroys its items", () => {
    const { load } = setup()
    const root = load(`Item { Repeater { model: 2; Text {} } }`)
    const rep = root.children[0] as Repeater
    const items = [...rep.instances]
    rep.destroy()
    expect(items.every((i) => i.isDestroyed)).toBe(true)
    expect(root.children).toEqual([])
  })
})

describe("ListModel API", () => {
  test("get/insert/set/move and reactive row reads", () => {
    const { load } = setup()
    const root = load(`
      Item {
        ListModel { id: m }
        property string first: m.count > 0 ? m.get(0).label : "none"
      }`)
    const m = root.children[0] as ListModel
    expect(root.get("first")).toBe("none")
    m.append([{ label: "a" }, { label: "b" }])
    expect(root.get("first")).toBe("a")
    m.insert(0, { label: "z" })
    expect(root.get("first")).toBe("z")
    m.setProperty(0, "label", "zz")
    expect(root.get("first")).toBe("zz")
    m.setRow(0, { label: "set" })
    expect(root.get("first")).toBe("set")
    m.move(0, 2)
    expect(m.toArray().map((r) => r.label)).toEqual(["a", "b", "set"])
  })
})

describe("Timer", () => {
  test("repeat timer driven by the manual scheduler", () => {
    const { load, scheduler } = setup()
    const root = load(`
      Item {
        property int ticks: 0
        Timer { id: t; interval: 100; running: true; repeat: true; onTriggered: ticks++ }
        function halt() { t.stop() }
      }`)
    scheduler.advance(350)
    expect(root.get("ticks")).toBe(3)
    root.call("halt")
    scheduler.advance(500)
    expect(root.get("ticks")).toBe(3)
    expect(scheduler.pending).toBe(0)
  })

  test("single-shot timer stops itself; restart and triggeredOnStart", () => {
    const { load, scheduler } = setup()
    const root = load(`
      Item {
        property int ticks: 0
        property alias timerRunning: t.running
        Timer { id: t; interval: 50; onTriggered: ticks++ }
        function go() { t.start() }
      }`)
    scheduler.advance(100)
    expect(root.get("ticks")).toBe(0)
    root.call("go")
    expect(root.get("timerRunning")).toBe(true)
    scheduler.advance(50)
    expect(root.get("ticks")).toBe(1)
    expect(root.get("timerRunning")).toBe(false)
    scheduler.advance(100)
    expect(root.get("ticks")).toBe(1)
  })

  test("triggeredOnStart and destroy clears", () => {
    const { load, scheduler } = setup()
    const root = load(`
      Item {
        property int ticks: 0
        Timer { interval: 10; running: true; repeat: true; triggeredOnStart: true; onTriggered: ticks++ }
      }`)
    expect(root.get("ticks")).toBe(1)
    root.destroy()
    expect(scheduler.pending).toBe(0)
  })
})

describe("Connections", () => {
  test("Qt6 function syntax, legacy syntax, reactive target and enabled", () => {
    const { load } = setup()
    const root = load(`
      Item {
        id: root
        property var log: []
        property var tgt: a
        property bool on: true
        Item { id: a; objectName: "a"; signal ping(int n) }
        Item { id: b; objectName: "b"; signal ping(int n) }
        Connections {
          target: root.tgt
          enabled: root.on
          function onPing(n) { root.log.push(target.objectName + n) }
        }
        Connections {
          target: a
          onPing: root.log.push("legacy" + n)
        }
      }`)
    const [a, b] = root.children as [QmlObject, QmlObject]
    a.emit("ping", 1)
    expect(root.get("log")).toEqual(["a1", "legacy1"])
    root.set("tgt", b.proxy)
    a.emit("ping", 2)
    b.emit("ping", 3)
    expect(root.get("log")).toEqual(["a1", "legacy1", "legacy2", "b3"])
    root.set("on", false)
    b.emit("ping", 4)
    expect((root.get("log") as unknown[]).length).toBe(4)
  })

  test("defaults to the parent", () => {
    const { load } = setup()
    const root = load(`
      Item {
        property int hits: 0
        signal poke
        Connections { function onPoke() { hits++ } }
      }`)
    root.emit("poke")
    expect(root.get("hits")).toBe(1)
  })
})

describe("Component and Loader", () => {
  test("Component.createObject with parent and properties", () => {
    const { load } = setup()
    const root = load(`
      Item {
        id: root
        property string suffix: "!"
        Component { id: factory; Text { text: "made" + root.suffix } }
        function make(w) { return factory.createObject(root, { width: w }) }
      }`)
    const made = toQmlObject(root.call("make", 12))!
    expect(made.parent).toBe(root)
    expect(made.get("text")).toBe("made!")
    expect(made.get("width")).toBe(12)
  })

  test("Loader: sourceComponent, active and item", () => {
    const { load } = setup()
    const root = load(`
      Item {
        property bool show: true
        Component { id: c; Text { text: "loaded" } }
        Loader { id: loader; sourceComponent: c; active: show }
        property var loaded: loader.item
      }`)
    expect(texts(root)).toEqual(["loaded"])
    expect(toQmlObject(root.get("loaded"))?.get("text")).toBe("loaded")
    root.set("show", false)
    expect(texts(root)).toEqual([])
    expect(root.get("loaded")).toBeNull()
  })

  test("Loader with inline component", () => {
    const { load } = setup()
    const root = load(`Item { Loader { Text { text: "inline" } } }`)
    expect(texts(root)).toEqual(["inline"])
  })
})

describe("QtObject", () => {
  test("holds declared properties", () => {
    const { load } = setup()
    const root = load(`
      Item {
        QtObject { id: store; property int v: 3 }
        property int doubled: store.v * 2
      }`)
    expect(root.get("doubled")).toBe(6)
  })
})
