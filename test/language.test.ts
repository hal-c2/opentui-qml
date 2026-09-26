import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTestRenderer } from "@opentui/core/testing"
import {
  ManualScheduler,
  QmlObject,
  QmlRuntimeError,
  createPropertyMap,
  createQmlEngine,
  createStore,
  parseQml,
  parseQmldir,
  topLevelDeclarations,
  type QmlEngine,
  type QmlEngineOptions,
} from "../src/index.ts"
import { mount } from "../src/components/index.ts"

const FIXTURES = join(import.meta.dir, "fixtures", "modules")
const APP = join(FIXTURES, "app", "main.qml")

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

async function setup(opts: Partial<QmlEngineOptions> = {}) {
  const t = await createTestRenderer({ width: 60, height: 16 })
  const warnings: string[] = []
  const errors: string[] = []
  const scheduler = new ManualScheduler()
  const engine: QmlEngine = createQmlEngine({
    renderer: t.renderer,
    scheduler,
    importPaths: [FIXTURES],
    onWarning: (w) => warnings.push(w),
    onError: (e, c) => errors.push(`${c ?? ""}: ${e instanceof Error ? e.message : String(e)}`),
    ...opts,
  })
  cleanups.push(() => {
    engine.destroy()
    t.renderer.destroy()
  })
  const load = (src: string, file = APP) => engine.createObject(engine.loadSource(src, file))
  const render = async (root: QmlObject): Promise<string> => {
    if (!root.parent && !(root as { mounted?: boolean }).mounted) {
      mount(engine, root)
      ;(root as { mounted?: boolean }).mounted = true
    }
    await t.renderOnce()
    await Promise.resolve()
    await t.renderOnce()
    return t.captureCharFrame()
  }
  return { t, engine, warnings, errors, scheduler, load, render }
}

/** The object with `id` in the root's document. */
const byId = (root: QmlObject, id: string): QmlObject => {
  const obj = root.component.ids.get(id)
  if (!obj) throw new Error(`no id ${id}`)
  return obj
}

const names = (list: unknown): string[] => (list as Array<{ objectName?: string; __qml?: QmlObject }>).map((p) => p.__qml!.id ?? "?")

// ---------------------------------------------------------------------------------------------

describe("parser: sibling objects on one line", () => {
  test("Text {} Text {} and Item { id: a } Item {}", () => {
    const doc = parseQml(`Column { Text { text: "a" } Text { text: "b" }
      Item { id: a } Item { id: b }; Item {} }`)
    const children = doc.root.members.filter((m) => m.type === "Object")
    expect(children.map((c) => (c as { name: string }).name)).toEqual(["Text", "Text", "Item", "Item", "Item"])
    expect(children.map((c) => (c as { id?: string }).id)).toEqual([undefined, undefined, "a", "b", undefined])
  })

  test("still rejects two bindings on one line", () => {
    expect(() => parseQml(`Item { width: 1 height: 2 }`)).toThrow()
  })
})

// ---------------------------------------------------------------------------------------------

describe("data / children / resources", () => {
  test("children are visual, resources non-visual, data both (declaration order)", async () => {
    const { load } = await setup()
    const root = load(`import OpenTUI
      Item {
        id: root
        Item { id: a }
        QtObject { id: q }
        Text { id: b }
        Timer { id: t }
      }`)
    expect(names(root.get("children"))).toEqual(["a", "b"])
    expect(names(root.get("resources"))).toEqual(["q", "t"])
    expect(names(root.get("data"))).toEqual(["a", "q", "b", "t"])
    expect(root.proxy.children.length).toBe(2)
  })

  test("non-visual objects: children are all children", async () => {
    const { load } = await setup()
    const root = load(`import OpenTUI
      QtObject { QtObject { id: x } QtObject { id: y } }`)
    expect(names(root.get("children"))).toEqual(["x", "y"])
    expect(names(root.get("data"))).toEqual(["x", "y"])
  })

  test("`data: [a, b]` appends; lists are reactive; children is read-only", async () => {
    const { load, errors } = await setup()
    const root = load(`import OpenTUI
      Item {
        id: root
        property int count: children.length
        Item { id: first }
        data: [ Item { id: second }, QtObject { id: third } ]
      }`)
    expect(names(root.get("data"))).toEqual(["first", "second", "third"])
    expect(root.get("count")).toBe(2)
    expect(() => root.set("children", [])).toThrow(TypeError)
    expect(errors).toEqual([])
  })

  test("children list updates when children are added and destroyed", async () => {
    const { load } = await setup()
    const root = load(`import OpenTUI
      Item {
        id: root
        property int count: children.length
        property Component maker: Component { Item { } }
        function add() { maker.createObject(root) }
        Item { id: gone }
      }`)
    expect(root.get("count")).toBe(1)
    root.proxy.add()
    expect(root.get("count")).toBe(2)
    byId(root, "gone").destroy()
    expect(root.get("count")).toBe(1)
  })
})

// ---------------------------------------------------------------------------------------------

describe("default property routing", () => {
  test("Card brick: heading alias, body alias, default alias into inner.data", async () => {
    const { engine, render, warnings, errors } = await setup()
    const card = engine.createObject(
      engine.loadSource(
        `import OpenTUI
        import "components"
        Column {
          id: outer
          property string who: "outer"
          Card {
            id: card
            heading: "Hello"
            Text { id: one; text: "first " + outer.who }
            Text { id: two; text: "second" }
            QtObject { id: res }
          }
        }`,
        join(import.meta.dir, "..", "examples", "app.qml"),
      ),
    )
    const cardObj = byId(card, "card")
    const inner = (cardObj.get("body") as { __qml: QmlObject }).__qml
    expect(names(inner.get("data"))).toEqual(["one", "two", "res"])
    expect(names(inner.get("children"))).toEqual(["one", "two"])
    const frame = await render(card)
    expect(frame).toContain("Hello")
    expect(frame.indexOf("first outer")).toBeGreaterThan(-1)
    expect(frame.indexOf("first outer")).toBeLessThan(frame.indexOf("second"))
    expect(warnings).toEqual([])
    expect(errors).toEqual([])
  })

  test("aliases to inner.children and to an object; own children stay put", async () => {
    const { load } = await setup()
    const root = load(`import OpenTUI
      Item {
        Item {
          id: a
          default property alias content: box.children
          Item { id: box }
          Item { id: other }
        }
        Item {
          id: b
          default property alias content: slot
          Column { id: slot }
        }
      }`)
    // children declared in the same object as the default property keep the type's default
    expect(names(byId(root, "a").get("children"))).toEqual(["box", "other"])
    expect(names(byId(root, "b").get("children"))).toEqual(["slot"])
  })

  test("children given to a document with an object alias default land in the target", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qml-default-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    writeFileSync(
      join(dir, "Frame.qml"),
      `import OpenTUI
      Item { default property alias content: slot; Item { id: header } Column { id: slot } }`,
    )
    writeFileSync(
      join(dir, "Bag.qml"),
      `import OpenTUI
      QtObject { default property list<QtObject> items; property int n: items.length }`,
    )
    writeFileSync(
      join(dir, "Holder.qml"),
      `import OpenTUI
      QtObject { default property Component delegate; property var made: delegate ? delegate.createObject(null) : null }`,
    )
    writeFileSync(join(dir, "One.qml"), `import OpenTUI\nQtObject { default property var thing }`)
    const { load } = await setup()
    const root = load(
      `import OpenTUI
      Item {
        Frame { id: f; Text { id: t1 } Text { id: t2 } }
        Bag { id: bag; QtObject { id: i1 } QtObject { id: i2 } }
        Holder { id: holder; Text { id: made; text: "made" } }
        One { id: one; QtObject { id: single } }
      }`,
      join(dir, "main.qml"),
    )
    const f = byId(root, "f")
    const slot = f.children[1]!
    expect(names(slot.get("children"))).toEqual(["t1", "t2"])
    expect(f.children.length).toBe(2)

    const bag = byId(root, "bag")
    expect(bag.get("n")).toBe(2)
    expect(names(bag.get("items"))).toEqual(["i1", "i2"])
    // list<> defaults collect but don't reparent
    expect(bag.children.includes(byId(root, "i1"))).toBe(false)

    const holder = byId(root, "holder")
    expect(holder.get("delegate")).toBeTruthy()
    expect((holder.get("made") as { text: string }).text).toBe("made")

    const one = byId(root, "one")
    expect((one.get("thing") as { __qml: QmlObject }).__qml.id).toBe("single")
  })
})

// ---------------------------------------------------------------------------------------------

describe("model data and required properties", () => {
  test("modelData / index for number, array and ListModel models", async () => {
    const { load } = await setup()
    const root = load(`import OpenTUI
      QtObject {
        id: root
        property var log: []
        property ListModel lm: ListModel { ListElement { name: "x" } ListElement { name: "y" } }
        property Instantiator a: Instantiator { model: 2; QtObject { Component.onCompleted: root.log.push("n" + index + ":" + modelData) } }
        property Instantiator b: Instantiator { model: ["p", "q"]; QtObject { Component.onCompleted: root.log.push("a" + index + ":" + modelData) } }
        property Instantiator c: Instantiator { model: root.lm; QtObject { Component.onCompleted: root.log.push("m" + index + ":" + name + "/" + model.name + "/" + modelData.name) } }
      }`)
    expect(root.get("log")).toEqual(["n0:0", "n1:1", "a0:p", "a1:q", "m0:x/x/x", "m1:y/y/y"])
  })

  test("required modelData/index are bound from the context, updates flow", async () => {
    const { load, warnings } = await setup()
    const root = load(`import OpenTUI
      QtObject {
        id: root
        property ListModel lm: ListModel { ListElement { name: "x" } ListElement { name: "y" } }
        property Instantiator inst: Instantiator {
          model: root.lm
          QtObject {
            required property var modelData
            required property int index
            required property string name
            property string label: index + ":" + name
          }
        }
      }`)
    const inst = (root.get("inst") as { __qml: QmlObject }).__qml
    const second = inst.proxy.objectAt(1) as { label: string; index: number }
    expect(second.label).toBe("1:y")
    ;(root.proxy.lm as { setProperty: Function }).setProperty(1, "name", "z")
    expect(second.label).toBe("1:z")
    expect(warnings.filter((w) => w.includes("required"))).toEqual([])
  })

  test("bindings on a delegate never see a required property unset", async () => {
    const { load, errors, warnings } = await setup()
    const root = load(`import OpenTUI
      QtObject {
        property Instantiator inst: Instantiator {
          model: ["alpha", "beta"]
          QtObject {
            required property var modelData
            required property int index
            property string upper: index + ":" + modelData.toUpperCase()
          }
        }
      }`)
    const inst = (root.get("inst") as { __qml: QmlObject }).__qml
    expect((inst.proxy.objectAt(1) as { upper: string }).upper).toBe("1:BETA")
    expect(errors).toEqual([])
    expect(warnings.filter((w) => w.includes("required"))).toEqual([])
  })

  test("unsatisfied required properties still warn", async () => {
    const { load, warnings } = await setup()
    load(`import OpenTUI
      QtObject { property Instantiator i: Instantiator { model: 1; QtObject { required property string missing } } }`)
    expect(warnings.some((w) => w.includes('required property "missing"'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------

describe("Instantiator", () => {
  test("creates delegates as children, count/object/objectAt, signals, reacts to model", async () => {
    const { load } = await setup()
    const root = load(`import OpenTUI
      QtObject {
        id: root
        property var log: []
        property var items: ["a", "b", "c"]
        property bool on: true
        property Instantiator inst: Instantiator {
          id: inst
          model: root.items
          active: root.on
          asynchronous: true
          delegate: QtObject { property string name: modelData }
          onObjectAdded: (index, object) => root.log.push("+" + index + object.name)
          onObjectRemoved: (index, object) => root.log.push("-" + index + object.name)
        }
        property int count: inst.count
        property string first: inst.object ? inst.object.name : "none"
      }`)
    const inst = byId(root, "inst")
    expect(root.get("count")).toBe(3)
    expect(root.get("first")).toBe("a")
    expect((inst.proxy.objectAt(2) as { name: string }).name).toBe("c")
    expect(inst.children.length).toBe(3)
    expect(inst.children[0]!.parent).toBe(inst)
    expect(root.get("log")).toEqual(["+0a", "+1b", "+2c"])
    root.set("log", [])
    root.set("items", ["z"])
    expect(root.get("count")).toBe(1)
    expect(root.get("log")).toEqual(["-0a", "-1b", "-2c", "+0z"])
    root.set("on", false)
    expect(root.get("count")).toBe(0)
    expect(root.get("first")).toBe("none")
    expect(inst.proxy.objectAt(0)).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------

describe("modules (qmldir)", () => {
  test("parseQmldir subset", () => {
    const q = parseQmldir(`module A.B
# comment
typeinfo x.qmltypes
plugin foo
optional plugin bar
prefer :/A/B/
depends QtQuick 2.0
designersupported
Card 1.0 Card.qml
singleton Theme 1.0 Theme.qml
internal Helper Helper.qml
Util 1.0 util.js # trailing comment
`)
    expect(q.module).toBe("A.B")
    expect(q.entries).toEqual([
      { name: "Card", version: "1.0", file: "Card.qml", singleton: false, internal: false, kind: "qml" },
      { name: "Theme", version: "1.0", file: "Theme.qml", singleton: true, internal: false, kind: "qml" },
      { name: "Helper", version: undefined, file: "Helper.qml", singleton: false, internal: true, kind: "qml" },
      { name: "Util", version: "1.0", file: "util.js", singleton: false, internal: false, kind: "js" },
    ])
  })

  test("import A.B, versions, qualifiers, singletons and JS resources", async () => {
    const { load, render, engine, errors, warnings } = await setup({ globals: { themeLog: [] } })
    const root = load(`import OpenTUI
      import Demo.Bricks
      import Demo.Bricks 1.0 as B1
      Column {
        Card { id: latest; heading: "latest " + Theme.accent }
        B1.Card { id: v1 }
        property string accent: B1.Theme.accent
        property int spacing: Theme.spacing
        property string greet: B1.Util.greeting + " " + Util.shout("hey")
      }`)
    const latest = byId(root, "latest")
    const v1 = byId(root, "v1")
    expect(latest.get("version")).toBe(2)
    expect(v1.get("version")).toBe(1)
    expect(latest.get("accent")).toBe("#ff0000")
    expect(latest.get("doubled")).toBe(42)
    expect((latest.get("helper") as { kind: string }).kind).toBe("helper")
    expect(root.get("accent")).toBe("#ff0000")
    expect(root.get("spacing")).toBe(2)
    expect(root.get("greet")).toBe("hello HEY!")
    expect(await render(root)).toContain("latest #ff0000")
    // one singleton instance per engine, no parent
    expect(engine.globals.themeLog).toEqual(["Theme created"])
    expect(errors).toEqual([])
    expect(warnings).toEqual([])
  })

  test("singletons are shared and reactive; using one as a type is an error", async () => {
    const { load, errors } = await setup({ globals: { themeLog: [] } })
    const a = load(`import Demo.Bricks\nimport OpenTUI\nQtObject { property string accent: Theme.accent }`)
    const b = load(`import Demo.Bricks\nimport OpenTUI\nQtObject { function paint() { Theme.accent = "#00ff00" } }`)
    b.proxy.paint()
    expect(a.get("accent")).toBe("#00ff00")
    expect(errors).toEqual([])
    expect(() => load(`import Demo.Bricks\nTheme { }`)).toThrow(/singleton/)
  })

  test("internal types are only visible inside the module", async () => {
    const { load } = await setup()
    expect(() => load(`import Demo.Bricks\nimport OpenTUI\nQtObject { property QtObject h: Helper {} }`)).toThrow(/unknown type "Helper"/)
  })

  test("a directory without qmldir is a module; import \"dir\" works (qualified too)", async () => {
    const { load, render } = await setup()
    const root = load(`import OpenTUI
      import Demo.Plain
      import "widgets"
      import "widgets" as W
      Column { Badge { label: "b" } Pill { } W.Pill { } }`)
    const frame = await render(root)
    expect(frame).toContain("[b]")
    expect(frame.split("pill").length - 1).toBe(2)
  })

  test("unknown modules / directories fail at load with the import paths", async () => {
    const { engine } = await setup()
    expect(() => engine.loadSource(`import No.Such.Module\nItem {}`, APP)).toThrow(QmlRuntimeError)
    expect(() => engine.loadSource(`import No.Such.Module\nItem {}`, APP)).toThrow(FIXTURES)
    expect(() => engine.loadSource(`import "missing"\nItem {}`, APP)).toThrow(/not found/)
    expect(() => engine.loadSource(`import QtQuick 2.15\nimport QtQuick.Controls as C\nimport OpenTUI\nItem {}`, APP)).not.toThrow()
  })

  test("addImportPath / importPaths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qml-mods-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    mkdirSync(join(dir, "Extra", "Things"), { recursive: true })
    writeFileSync(join(dir, "Extra", "Things", "Gizmo.qml"), `import OpenTUI\nQtObject { property int size: 7 }`)
    const { engine, load } = await setup({ importPaths: undefined, basePath: FIXTURES })
    expect(engine.importPaths).toEqual([FIXTURES])
    expect(() => engine.loadSource(`import Extra.Things\nQtObject {}`, APP)).toThrow(/not installed/)
    engine.addImportPath(dir)
    expect(engine.importPaths).toEqual([dir, FIXTURES])
    const root = load(`import Extra.Things\nimport OpenTUI\nQtObject { property QtObject g: Gizmo {} }`)
    expect((root.get("g") as { size: number }).size).toBe(7)
  })

  test('import "file.js" as Name: evaluated once, top-level names exposed', async () => {
    const { load } = await setup()
    const a = load(`import "lib.js" as Lib\nimport OpenTUI\nQtObject { property int n: Lib.next(); property string s: Lib.label("ada") }`)
    const b = load(`import "lib.js" as Lib\nimport OpenTUI\nQtObject { property int n: Lib.next(); property int c: Lib.counter }`)
    expect(a.get("n")).toBe(1)
    expect(b.get("n")).toBe(2)
    expect(b.get("c")).toBe(2)
    expect(a.get("s")).toBe("Hello ada")
  })

  test("topLevelDeclarations", () => {
    expect(
      topLevelDeclarations(`
        function a() { var inner = 1; function nested() {} }
        var b = { x: 1 }, c = [1, 2]
        let d = "var e = 1"
        const f = (x) => { let g = x }
        class H {}
        async function i() {}
        const { j } = obj
      `).sort(),
    ).toEqual(["H", "a", "b", "c", "d", "f", "i"])
  })
})

// ---------------------------------------------------------------------------------------------

describe("registered singletons and stores", () => {
  test("Shell.state property map: bindings re-evaluate on set(), including unset keys", async () => {
    const { engine, load } = await setup()
    const state = createPropertyMap()
    engine.registerSingleton("Shell", { state })
    const root = load(`import OpenTUI
      QtObject { property bool collapsed: Shell.state.layout ? Shell.state.layout.sidebarCollapsed : false }`)
    expect(root.get("collapsed")).toBe(false)
    state.set("layout", { sidebarCollapsed: true })
    expect(root.get("collapsed")).toBe(true)
    // deep mutation through the stored (wrapped) value
    ;(state.get("layout") as { sidebarCollapsed: boolean }).sidebarCollapsed = false
    expect(root.get("collapsed")).toBe(false)
    state.clear("layout")
    expect(root.get("collapsed")).toBe(false)
    expect(state.keys()).toEqual([])
    state.set("theme", { dark: true })
    expect(state.toJSON()).toEqual({ theme: { dark: true } })
    expect(state.contains("theme")).toBe(true)
  })

  test("createStore: deep proxy; store mutations re-evaluate bindings", async () => {
    const { engine, load } = await setup()
    const store = createStore<{ layout?: { sidebarCollapsed: boolean }; items: string[] }>({ items: [] })
    engine.registerSingleton("Shell", () => ({ state: store }))
    const root = load(`import OpenTUI
      QtObject {
        property bool collapsed: Shell.state.layout ? Shell.state.layout.sidebarCollapsed : false
        property string joined: Shell.state.items.join(",")
        property int keyCount: Object.keys(Shell.state).length
      }`)
    expect(root.get("collapsed")).toBe(false)
    expect(root.get("keyCount")).toBe(1)
    store.layout = { sidebarCollapsed: true }
    expect(root.get("collapsed")).toBe(true)
    expect(root.get("keyCount")).toBe(2)
    store.layout.sidebarCollapsed = false
    expect(root.get("collapsed")).toBe(false)
    store.items.push("a", "b")
    expect(root.get("joined")).toBe("a,b")
    store.items[0] = "z"
    expect(root.get("joined")).toBe("z,b")
    delete store.layout
    expect(root.get("keyCount")).toBe(1)
  })

  test("registerSingleton with a QmlObject; assignment to the name is rejected; used as a type errors", async () => {
    const { engine, load, errors } = await setup()
    const settingsDoc = engine.loadSource(`import OpenTUI\nQtObject { property int fontSize: 12 }`)
    engine.registerSingleton("Settings", engine.createObject(settingsDoc))
    const root = load(`import OpenTUI\nQtObject { property int size: Settings.fontSize * 2; function bad() { Settings = 1 } }`)
    expect(root.get("size")).toBe(24)
    expect(() => root.proxy.bad()).toThrow()
    expect(() => load(`Settings {}`)).toThrow(/singleton/)
    expect(errors).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------

describe("lifecycle helpers", () => {
  test("Component.onCompleted: children before parents, siblings in declaration order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qml-order-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    writeFileSync(
      join(dir, "Widget.qml"),
      `import OpenTUI
      QtObject { id: w; property string tag; property QtObject inner: QtObject { Component.onCompleted: log.push("inner of " + w.tag) }
        Component.onCompleted: log.push("widget " + tag) }`,
    )
    const { load, engine } = await setup({ globals: { log: [] } })
    load(
      `import OpenTUI
      QtObject {
        Component.onCompleted: log.push("root")
        property QtObject a: QtObject { Component.onCompleted: log.push("a") }
        property QtObject b: Widget { tag: "b"; Component.onCompleted: log.push("b outer") }
        QtObject { Component.onCompleted: log.push("c"); QtObject { Component.onCompleted: log.push("c.1") } }
      }`,
      join(dir, "main.qml"),
    )
    expect(engine.globals.log).toEqual(["a", "inner of b", "widget b", "b outer", "c.1", "c", "root"])
  })

  test("Qt.callLater coalesces; qsTr / qsTranslate", async () => {
    const { load, scheduler } = await setup()
    const root = load(`import OpenTUI
      QtObject {
        property int calls: 0
        property string t: qsTr("Save") + "/" + qsTranslate("ctx", "Open")
        function bump() { calls++ }
        function many() { Qt.callLater(bump); Qt.callLater(bump); Qt.callLater(bump) }
      }`)
    expect(root.get("t")).toBe("Save/Open")
    root.proxy.many()
    expect(root.get("calls")).toBe(0)
    scheduler.advance(1)
    expect(root.get("calls")).toBe(1)
  })
})
