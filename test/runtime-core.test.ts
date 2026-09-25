import { describe, expect, test } from "bun:test"
import {
  ManualScheduler,
  QmlEngine,
  QmlObject,
  QmlRuntimeError,
  compileScript,
  createHandler,
  createMemo,
  createRoot,
  createScope,
  createSignal,
  isQmlObject,
  toQmlObject,
} from "../src/runtime/index.ts"

function setup() {
  const warnings: string[] = []
  const errors: unknown[] = []
  const scheduler = new ManualScheduler()
  const engine = new QmlEngine({
    scheduler,
    onWarning: (w) => warnings.push(w),
    onError: (e) => errors.push(e),
  })
  return { engine, scheduler, warnings, errors }
}

describe("reactive", () => {
  test("solid browser build propagates", () => {
    createRoot((dispose) => {
      const [a, setA] = createSignal(1)
      const double = createMemo(() => a() * 2)
      expect(double()).toBe(2)
      setA(5)
      expect(double()).toBe(10)
      dispose()
    })
  })
})

describe("QmlObject properties", () => {
  test("coercion by type", () => {
    const { engine } = setup()
    const o = new QmlObject(engine, "T")
    o.defineProperty("i", { type: "int" })
    o.defineProperty("r", { type: "real" })
    o.defineProperty("s", { type: "string" })
    o.defineProperty("b", { type: "bool" })
    o.defineProperty("v", { type: "var" })
    expect([o.get("i"), o.get("r"), o.get("s"), o.get("b"), o.get("v")]).toEqual([0, 0, "", false, undefined])
    o.set("i", "3.9")
    o.set("r", "2.5")
    o.set("s", 12)
    o.set("b", 1)
    o.set("v", { a: 1 })
    expect(o.get("i")).toBe(3)
    expect(o.get("r")).toBe(2.5)
    expect(o.get("s")).toBe("12")
    expect(o.get("b")).toBe(true)
    expect(o.get("v")).toEqual({ a: 1 })
    o.set("s", null)
    expect(o.get("s")).toBe("")
  })

  test("binding re-evaluates and fires changed signal", () => {
    const { engine } = setup()
    const o = new QmlObject(engine, "T")
    o.defineProperty("a", { type: "int", value: 1 })
    o.defineProperty("b", { type: "int" })
    const seen: unknown[] = []
    o.connect("bChanged", () => seen.push(o.peek("b")))
    o.bind("b", () => (o.get("a") as number) * 10)
    expect(o.get("b")).toBe(10)
    o.set("a", 2)
    expect(o.get("b")).toBe(20)
    expect(seen).toEqual([10, 20])
  })

  test("set breaks a binding; Qt.binding rebinds", () => {
    const { engine } = setup()
    const o = new QmlObject(engine, "T")
    o.defineProperty("a", { type: "int", value: 1 })
    o.defineProperty("b", { type: "int" })
    o.bind("b", () => o.get("a"))
    o.set("b", 7)
    expect(o.hasBinding("b")).toBe(false)
    o.set("a", 3)
    expect(o.get("b")).toBe(7)
    o.set("b", engine.Qt.binding(() => (o.get("a") as number) + 100))
    expect(o.get("b")).toBe(103)
    o.set("a", 4)
    expect(o.get("b")).toBe(104)
  })

  test("binding errors are logged once and keep the old value", () => {
    const { engine, errors } = setup()
    const o = new QmlObject(engine, "T")
    o.defineProperty("a", { type: "var", value: { x: 1 } })
    o.defineProperty("b", { type: "int" })
    o.defineProperty("tick", { type: "int" })
    o.bind("b", () => {
      o.get("tick")
      return (o.get("a") as { x: number }).x
    })
    expect(o.get("b")).toBe(1)
    o.set("a", null)
    expect(o.get("b")).toBe(1)
    o.set("tick", 1)
    o.set("tick", 2)
    expect(errors.length).toBe(1)
    o.set("a", { x: 5 })
    expect(o.get("b")).toBe(5)
  })

  test("readonly properties reject set but accept write", () => {
    const { engine } = setup()
    const o = new QmlObject(engine, "T")
    o.defineProperty("r", { type: "int", readonly: true, value: 1 })
    expect(() => o.set("r", 2)).toThrow()
    o.write("r", 3)
    expect(o.get("r")).toBe(3)
  })

  test("alias forwards reads, writes and changed signals", () => {
    const { engine } = setup()
    const target = new QmlObject(engine, "T")
    target.defineProperty("text", { type: "string", value: "a" })
    const o = new QmlObject(engine, "T")
    o.defineAlias("label", target, "text")
    let changes = 0
    o.connect("labelChanged", () => changes++)
    expect(o.get("label")).toBe("a")
    o.set("label", "b")
    expect(target.get("text")).toBe("b")
    target.set("text", "c")
    expect(o.get("label")).toBe("c")
    expect(changes).toBe(2)
  })

  test("undeclared set warns and defines a var", () => {
    const { engine, warnings } = setup()
    const o = new QmlObject(engine, "T")
    o.set("dyn", 5)
    expect(o.get("dyn")).toBe(5)
    expect(warnings.length).toBe(1)
  })
})

describe("QmlObject signals, methods, tree", () => {
  test("emit isolates handler errors", () => {
    const { engine, errors } = setup()
    const o = new QmlObject(engine, "T")
    o.defineSignal("ping", ["n"])
    const got: unknown[] = []
    o.connect("ping", () => {
      throw new Error("boom")
    })
    o.connect("ping", (n) => got.push(n))
    o.emit("ping", 42)
    expect(got).toEqual([42])
    expect(errors.length).toBe(1)
  })

  test("connect returns a disconnect function", () => {
    const { engine } = setup()
    const o = new QmlObject(engine, "T")
    o.defineSignal("ping")
    let n = 0
    const off = o.connect("ping", () => n++)
    o.emit("ping")
    off()
    o.emit("ping")
    expect(n).toBe(1)
  })

  test("methods have this = proxy", () => {
    const { engine } = setup()
    const o = new QmlObject(engine, "T")
    o.defineProperty("x", { type: "int", value: 2 })
    o.defineMethod("twice", function (this: { x: number }) {
      return this.x * 2
    })
    expect(o.call("twice")).toBe(4)
    expect(o.proxy.twice()).toBe(4)
  })

  test("children hooks and reparenting", () => {
    const { engine } = setup()
    const added: string[] = []
    class Box extends QmlObject {
      protected override onChildAdded(child: QmlObject, index: number) {
        added.push(`${child.typeName}@${index}`)
      }
    }
    const a = new Box(engine, "A")
    const b = new Box(engine, "B")
    const c = new QmlObject(engine, "C")
    a.appendChild(c)
    expect(c.parent).toBe(a)
    b.appendChild(c, 0)
    expect(a.children).toEqual([])
    expect(b.children).toEqual([c])
    expect(added).toEqual(["C@0", "C@0"])
  })

  test("value proxy", () => {
    const { engine } = setup()
    const o = new QmlObject(engine, "T")
    o.defineProperty("w", { type: "int", value: 3 })
    expect(isQmlObject(o)).toBe(true)
    expect(toQmlObject(o.proxy)).toBe(o)
    expect(o.proxy.w).toBe(3)
    o.proxy.w = 9
    expect(o.get("w")).toBe(9)
    expect("w" in o.proxy).toBe(true)
  })

  test("destroy disposes bindings and children", () => {
    const { engine } = setup()
    const src = new QmlObject(engine, "S")
    src.defineProperty("a", { type: "int", value: 1 })
    const o = new QmlObject(engine, "T")
    o.defineProperty("b", { type: "int" })
    let runs = 0
    o.bind("b", () => {
      runs++
      return src.get("a")
    })
    const child = new QmlObject(engine, "C")
    o.appendChild(child)
    let destructions = 0
    child.connect("Component.destruction", () => destructions++)
    o.destroy()
    src.set("a", 2)
    expect(runs).toBe(1)
    expect(child.isDestroyed).toBe(true)
    expect(destructions).toBe(1)
  })
})

describe("expressions", () => {
  test("expression vs block", () => {
    const scope = createScope([{ a: 2 }])
    expect(compileScript("a * 3").evaluate(scope)).toBe(6)
    expect(compileScript("{ a * 3 }", { isBlock: true }).evaluate(scope)).toBeUndefined()
    expect(compileScript("{ return a * 3 }", { isBlock: true }).evaluate(scope)).toBe(6)
  })

  test("statement lists fall back to block compilation", () => {
    const rec = { n: 0 }
    const scope = createScope([rec])
    const s = compileScript("n++; n++")
    expect(s.isBlock).toBe(true)
    s.evaluate(scope)
    compileScript("n++; n++").evaluate(scope)
    expect(rec.n).toBe(4)
  })

  test("errors carry file:line", () => {
    const scope = createScope([{}])
    const s = compileScript("missing.value", { filename: "Main.qml", line: 7 })
    expect(() => s.evaluate(scope)).toThrow(QmlRuntimeError)
    expect(() => s.evaluate(scope)).toThrow(/Main\.qml:7:/)
  })

  test("assigning an unknown name throws instead of leaking a global", () => {
    const scope = createScope([{}])
    expect(() => compileScript("{ leaked = 1 }", { isBlock: true }).evaluate(scope)).toThrow()
    expect((globalThis as Record<string, unknown>).leaked).toBeUndefined()
  })

  test("JS globals fall through the scope", () => {
    const scope = createScope([{ a: 4 }])
    expect(compileScript("Math.sqrt(a)").evaluate(scope)).toBe(2)
  })

  test("handler calls a function-valued expression with params", () => {
    const scope = createScope([{}])
    const h = createHandler(compileScript("function(x) { return x + 1 }"), scope, ["x"])
    expect(h(1)).toBe(2)
    const block = createHandler(compileScript("{ return x * 2 }", { isBlock: true }), scope, ["x"])
    expect(block(5)).toBe(10)
  })
})

describe("scope", () => {
  test("first layer wins; set goes to the owning layer", () => {
    const { engine } = setup()
    const o = new QmlObject(engine, "T")
    o.defineProperty("x", { type: "int", value: 1 })
    const rec: Record<string, unknown> = { x: 99, y: 2 }
    const scope = createScope([o, rec], o.proxy)
    expect(compileScript("x + y").evaluate(scope)).toBe(3)
    compileScript("{ x = 5; y = 6 }", { isBlock: true }).evaluate(scope)
    expect(o.get("x")).toBe(5)
    expect(rec.y).toBe(6)
    expect(compileScript("this.x").evaluate(scope)).toBe(5)
  })
})

describe("Qt global", () => {
  test("colors", () => {
    const { engine } = setup()
    expect(engine.Qt.rgba(1, 0, 0, 1)).toBe("#ff0000ff")
    expect(engine.Qt.hsla(0, 1, 0.5, 1)).toBe("#ff0000ff")
    expect(engine.Qt.darker("#808080", 2)).toBe("#404040ff")
    expect(engine.Qt.lighter("#404040", 2)).toBe("#808080ff")
  })

  test("callLater runs once on the scheduler", () => {
    const { engine, scheduler } = setup()
    let n = 0
    const f = () => n++
    engine.Qt.callLater(f)
    engine.Qt.callLater(f)
    expect(n).toBe(0)
    scheduler.advance(0)
    expect(n).toBe(1)
  })

  test("quit destroys the renderer", () => {
    let destroyed = false
    const engine = new QmlEngine({ renderer: { destroy: () => (destroyed = true) } as never })
    engine.Qt.quit()
    expect(destroyed).toBe(true)
  })

  test("formatDateTime", () => {
    const { engine } = setup()
    const d = new Date(2024, 0, 5, 9, 7, 3)
    expect(engine.Qt.formatDateTime(d, "yyyy-MM-dd hh:mm:ss")).toBe("2024-01-05 09:07:03")
  })
})
