import { existsSync } from "node:fs"
import { afterEach, describe, expect, test } from "bun:test"
import {
  DiffRenderable,
  EmbeddedTerminalRenderable,
  FrameBufferRenderable,
  ImageRenderable,
  LineNumberRenderable,
  ScrollBarRenderable,
  SliderRenderable,
  StyledText,
  TextRenderable,
  TextTableRenderable,
  engine as timelineEngine,
} from "@opentui/core"
import { CliRenderer } from "@opentui/core"
import { testQml, type QmlTestApp, type TestQmlOptions } from "../src/testing.ts"
import { isVisual, loadQrCodeModule, screenFor } from "../src/components/index.ts"
import { ManualScheduler, toQmlObject, type QmlObject } from "../src/runtime/index.ts"

let current: QmlTestApp | null = null

afterEach(() => {
  current?.destroy()
  current = null
})

async function run(src: string, opts: TestQmlOptions = {}): Promise<QmlTestApp> {
  current = await testQml(`import OpenTUI\n${src}`, { width: 40, height: 10, ...opts })
  return current
}

function byId(t: QmlTestApp, id: string): QmlObject {
  const o = t.root.component.ids.get(id)
  if (!o) throw new Error(`no id ${id}`)
  return o
}

function renderableOf<T>(t: QmlTestApp, id: string): T {
  const o = byId(t, id)
  if (!isVisual(o)) throw new Error(`${id} is not visual`)
  return o.renderable as T
}

describe("testQml", () => {
  test("renders, snapshots and destroys", async () => {
    const t = await run(`Text { text: "hello testing" }`)
    expect(await t.snapshot()).toContain("hello testing")
    expect(t.proxy.text).toBe("hello testing")
    expect(t.warnings).toEqual([])
  })

  test("typeText / pressEnter reach QML", async () => {
    const t = await run(`
      Item {
        property string got: ""
        TextInput { id: input; focus: true; onAccepted: parent.got = text }
      }`)
    await t.typeText("abc")
    await t.pressEnter()
    expect(t.proxy.got).toBe("abc")
  })
})

describe("rich text spans", () => {
  test("text + nested spans build a StyledText, reactively", async () => {
    const t = await run(`
      Text {
        id: txt
        property string who: "world"
        text: "Hello "
        Bold { text: who; Italic { text: "!" } }
        Br {}
        Link { href: "https://example.com"; text: "link" }
      }`)
    const r = renderableOf<TextRenderable>(t, "txt")
    let frame = await t.snapshot()
    expect(frame).toContain("Hello world!")
    expect(frame).toContain("link")
    const chunks = (r.content as StyledText).chunks
    const world = chunks.find((c) => c.text === "world")!
    expect(world.attributes! & 1).toBe(1) // bold
    const bang = chunks.find((c) => c.text === "!")!
    expect(bang.attributes! & 1).toBe(1) // inherits bold
    expect(bang.attributes! & 4).toBe(4) // italic
    expect(chunks.find((c) => c.text === "link")!.link).toEqual({ url: "https://example.com" })
    t.proxy.who = "QML"
    frame = await t.snapshot()
    expect(frame).toContain("Hello QML!")
  })

  test("plain text still works and StyledText is accepted", async () => {
    const t = await run(`Text { id: txt; text: "plain" }`)
    expect(await t.snapshot()).toContain("plain")
  })

  test("selectable and selectedText()", async () => {
    const t = await run(`Text { id: txt; text: "abc"; selectable: true }`)
    expect(t.proxy.selectedText()).toBe("")
    expect(t.proxy.selectable).toBe(true)
  })
})

describe("widgets", () => {
  test("Diff renders a unified diff", async () => {
    const t = await run(`
      Diff {
        id: d
        width: 40; height: 6
        diff: "--- a/f.txt\\n+++ b/f.txt\\n@@ -1,2 +1,2 @@\\n-old line\\n+new line\\n same\\n"
        showLineNumbers: false
        addedBg: "#003300"
      }`)
    expect(renderableOf<unknown>(t, "d")).toBeInstanceOf(DiffRenderable)
    const frame = await t.snapshot()
    expect(frame).toContain("new line")
    expect(frame).toContain("old line")
    expect(byId(t, "d").peek("text")).toContain("+new line")
  })

  test("LineNumbers wraps a Code child", async () => {
    const t = await run(`
      LineNumbers {
        id: ln
        width: 30; height: 4
        lineNumberOffset: 0
        Code { text: "one\\ntwo\\nthree" }
      }`)
    expect(renderableOf<unknown>(t, "ln")).toBeInstanceOf(LineNumberRenderable)
    const frame = await t.snapshot()
    expect(frame).toMatch(/1\\s*one|1 +one|1.*one/)
    expect(frame).toMatch(/3.*three/)
  })

  test("TextTable from rows, model + columns, and headers", async () => {
    const t = await run(`
      Column {
        TextTable { id: a; rows: [["a1", "b1"], ["a2", "b2"]] }
        TextTable {
          id: b
          property var people: [{ name: "Ann", age: 31 }, { name: "Bob", age: 42 }]
          model: people
          columns: ["name", "age"]
          headers: ["Name", "Age"]
        }
      }`, { height: 20 })
    expect(renderableOf<unknown>(t, "a")).toBeInstanceOf(TextTableRenderable)
    let frame = await t.snapshot()
    expect(frame).toContain("a1")
    expect(frame).toContain("b2")
    expect(frame).toContain("Name")
    expect(frame).toContain("Bob")
    expect(frame).toContain("42")
    expect(byId(t, "b").peek("rowCount")).toBe(3)
    byId(t, "b").set("people", [{ name: "Cy", age: 7 }])
    frame = await t.snapshot()
    expect(frame).toContain("Cy")
    expect(frame).not.toContain("Bob")
  })

  test("Slider: two-way value, clamping, moved only for user changes", async () => {
    const t = await run(`
      Item {
        property var moves: []
        property real v: 5
        Slider {
          id: s
          width: 20; height: 1
          from: 0; to: 10
          value: v
          onMoved: (value) => moves = moves.concat([value])
        }
      }`)
    const s = byId(t, "s")
    const r = renderableOf<SliderRenderable>(t, "s")
    expect(r).toBeInstanceOf(SliderRenderable)
    expect(r.max).toBe(10)
    expect(r.value).toBe(5)
    t.proxy.v = 8
    expect(r.value).toBe(8)
    s.set("value", 50)
    expect(s.peek("value")).toBe(10)
    expect(t.proxy.moves).toEqual([])
    r.value = 3 // like a drag
    expect(s.peek("value")).toBe(3)
    expect(t.proxy.moves).toEqual([3])
  })

  test("ScrollBar: position, scrolled signal, scrollBy", async () => {
    const t = await run(`
      Item {
        property var log: []
        ScrollBar {
          id: sb
          width: 1; height: 8
          scrollSize: 100; viewportSize: 10
          onScrolled: (p) => log = log.concat([p])
        }
      }`)
    const sb = byId(t, "sb")
    const r = renderableOf<ScrollBarRenderable>(t, "sb")
    expect(r).toBeInstanceOf(ScrollBarRenderable)
    sb.set("position", 20)
    expect(r.scrollPosition).toBe(20)
    expect(t.proxy.log).toEqual([])
    ;(sb.proxy as any).scrollBy(5)
    expect(sb.peek("position")).toBe(25)
    expect(t.proxy.log).toEqual([25])
    sb.set("orientation", "horizontal")
    expect(r.slider.orientation).toBe("horizontal")
  })
})

describe("graphics", () => {
  test("FrameBuffer paint(painter) draws cells", async () => {
    const t = await run(`
      FrameBuffer {
        id: fb
        width: 10; height: 3
        onPaint: (p) => {
          p.fillRect(0, 0, p.width, p.height, "#000000")
          p.drawText("paint!", 1, 1, "#ffffff")
          p.setCell(0, 0, "X", "red")
        }
      }`)
    expect(renderableOf<unknown>(t, "fb")).toBeInstanceOf(FrameBufferRenderable)
    const frame = await t.snapshot()
    expect(frame).toContain("paint!")
    expect(frame.split("\n")[0]!.startsWith("X")).toBe(true)
    ;(byId(t, "fb").proxy as any).draw((p: any) => p.drawText("more", 4, 2))
    expect(await t.snapshot()).toContain("more")
  })

  test("Image constructs and reports a missing file", async () => {
    const t = await run(`
      Item {
        property string err: ""
        Image { id: img; width: 4; height: 2; source: "does-not-exist.png"; fit: "cover"; onError: (m) => err = m }
      }`)
    const r = renderableOf<ImageRenderable>(t, "img")
    expect(r).toBeInstanceOf(ImageRenderable)
    expect(r.fit).toBe("cover")
    await r.loadPromise?.catch(() => {})
    await Promise.resolve()
    expect(byId(t, "img").peek("status")).toBe("error")
    expect(t.proxy.err).not.toBe("")
  })

  test("EmbeddedTerminal constructs and displays written data (no process)", async () => {
    const t = await run(`EmbeddedTerminal { id: term; width: 20; height: 3 }`)
    const item = byId(t, "term") as any
    const r = item.terminal as EmbeddedTerminalRenderable
    expect(r).toBeInstanceOf(EmbeddedTerminalRenderable)
    expect(r.parent).toBe(renderableOf(t, "term"))
    item.proxy.write("hi from vt")
    await t.renderOnce()
    expect(item.proxy.screenText()).toContain("hi from vt")
    expect(item.proxy.lines()[0]).toContain("hi from vt")
    expect(item.proxy.cursor().x).toBe(10)
    expect(item.peek("running")).toBe(false)
    // The emulator follows the layout size, and reports it.
    expect(r.width).toBe(20)
    expect(r.height).toBe(3)
    expect(item.proxy.screen().columns).toBe(20)
  })

  test("EmbeddedTerminal queues writes before completion and honours cols/rows/maxScrollback", async () => {
    const t = await run(`EmbeddedTerminal {
      id: term; width: 30; height: 4; cols: 10; rows: 2; maxScrollback: 64
      property int resizes: 0
      property string size: ""
      Component.onCompleted: write("early")
      onTerminalResized: (c, r) => { resizes++; size = c + "x" + r }
    }`)
    await t.renderOnce()
    const item = byId(t, "term") as any
    expect(item.proxy.screenText()).toContain("early")
    expect(item.peek("resizes")).toBeGreaterThan(0)
    expect(item.peek("size")).toBe("30x4")
  })

  test("EmbeddedTerminal focus goes to the emulator and yields keys, except hostKeys", async () => {
    const t = await run(`Column {
      property string log: ""
      Shortcut { sequence: "q"; onActivated: log += "q" }
      Shortcut { sequence: "escape"; onActivated: log += "E" }
      Shortcut { sequence: "ctrl+x"; onActivated: log += "X" }
      Shortcut { sequence: "ctrl+q"; context: "application"; onActivated: log += "A" }
      Keys.onPressed: (e) => { log += "k" + e.key }
      EmbeddedTerminal { id: term; width: 20; height: 3; hostKeys: ["escape", "ctrl+x"] }
      TextInput { id: input }
    }`)
    const item = byId(t, "term") as any
    const vt = item.terminal as EmbeddedTerminalRenderable
    const inputs: string[] = []
    item.connect("input", (text: string, source: string) => inputs.push(`${source}:${text}`))
    item.set("focus", true)
    expect(vt.focused).toBe(true)
    expect(item.peek("activeFocus")).toBe(true)
    expect(t.renderer.currentFocusedRenderable).toBe(vt)

    await t.pressKey("q")
    await t.pressEscape()
    await t.pressKey("x", { ctrl: true })
    await t.pressKey("q", { ctrl: true })
    expect(t.root.peek("log")).toBe("EXA")
    expect(inputs).toEqual(["input:q"])

    // Blur: window shortcuts and Keys handlers see everything again.
    item.set("focus", false)
    expect(vt.focused).toBe(false)
    expect(item.peek("focused")).toBe(false)
    await t.pressKey("q")
    expect(t.root.peek("log")).toBe("EXAq")

    // Focusing another item clears the claim; forceActiveFocus() brings it back.
    byId(t, "input").set("focus", true)
    expect(t.renderer.currentFocusedRenderable).not.toBe(vt)
    item.proxy.forceActiveFocus()
    expect(t.renderer.currentFocusedRenderable).toBe(vt)
  })

  test("EmbeddedTerminal attach() drives an external child and detach() stops it", async () => {
    const t = await run(`EmbeddedTerminal { id: term; width: 20; height: 3 }`)
    const item = byId(t, "term") as any
    const writes: string[] = []
    const sizes: string[] = []
    const dec = new TextDecoder()
    const dispose = item.proxy.attach({
      write: (d: Uint8Array) => writes.push(dec.decode(d)),
      resize: (c: number, r: number) => sizes.push(`${c}x${r}`),
    })
    expect(item.peek("attached")).toBe(true)
    expect(sizes).toEqual(["20x3"])
    item.proxy.send("ls\r")
    item.set("focus", true)
    await t.pressKey("a")
    expect(writes).toEqual(["ls\r", "a"])
    dispose()
    expect(item.peek("attached")).toBe(false)
    item.proxy.send("x")
    expect(writes).toHaveLength(2)
  })

  const haveSh = existsSync("/bin/sh")
  test.skipIf(!haveSh)("EmbeddedTerminal runs a command in a PTY with TERM set and reports the exit", async () => {
    const t = await run(`EmbeddedTerminal {
      id: term; width: 40; height: 4
      command: "/bin/sh"; args: ["-c", "echo T=$TERM C=$COLORTERM F=$FOO; exit 3"]
      env: ({ FOO: "bar" })
      property int startedPid: 0
      property string exit: ""
      onStarted: (pid) => startedPid = pid
      onExited: (code, signal) => exit = code + "/" + signal
    }`)
    const item = byId(t, "term") as any
    expect(item.peek("running")).toBe(true)
    expect(item.peek("pid")).toBeGreaterThan(0)
    expect(item.peek("startedPid")).toBe(item.peek("pid"))
    const deadline = Date.now() + 5000
    while (item.peek("running") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
    expect(item.peek("running")).toBe(false)
    expect(item.peek("exitCode")).toBe(3)
    expect(item.peek("exit")).toBe("3/null")
    await t.renderOnce()
    expect(item.proxy.screenText()).toContain("T=xterm-256color C=truecolor F=bar")
  })

  test.skipIf(!haveSh)("EmbeddedTerminal restart() and kill() manage the process", async () => {
    const t = await run(`EmbeddedTerminal {
      id: term; width: 30; height: 4
      command: ["/bin/sh", "-c", "echo up; sleep 30"]
      property int exits: 0
      onExited: exits++
    }`)
    const item = byId(t, "term") as any
    const first = item.peek("pid")
    expect(first).toBeGreaterThan(0)
    expect(await item.proxy.restart()).toBe(true)
    expect(item.peek("running")).toBe(true)
    expect(item.peek("pid")).not.toBe(first)
    expect(item.peek("exits")).toBe(1)
    expect(item.proxy.kill("SIGTERM")).toBe(true)
    const deadline = Date.now() + 5000
    while (item.peek("running") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
    expect(item.peek("running")).toBe(false)
    expect(item.peek("exits")).toBe(2)
    expect(item.peek("exitSignal")).toBe("SIGTERM")
    expect(item.proxy.kill()).toBe(false)
  })
})

describe("Portal", () => {
  test("children are mounted into the target", async () => {
    const t = await run(`
      Column {
        Rectangle { id: host; width: 20; height: 2 }
        Item {
          id: owner
          Portal { id: portal; target: host; Text { id: inner; text: "portaled" } }
        }
      }`)
    const host = byId(t, "host")
    const portal = byId(t, "portal")
    if (!isVisual(host) || !isVisual(portal)) throw new Error("not visual")
    expect(portal.renderable.parent).toBe(host.contentRenderable)
    expect(await t.snapshot()).toContain("portaled")
    host.destroy()
    expect(portal.renderable.parent).toBe(t.renderer.root)
  })
})

describe("visual parity", () => {
  test("mouse signals, sizeChanged, implicit size, display and focused", async () => {
    const t = await run(`
      Item {
        property var events: []
        property var sizes: []
        Rectangle {
          id: box
          width: 10; height: 3
          onMouseDown: (e) => events = events.concat(["down"])
          onMouseUp: (e) => events = events.concat(["up"])
          onSizeChanged: (w, h) => sizes = sizes.concat([w + "x" + h])
        }
        Item { id: imp; implicitWidth: 7; implicitHeight: 2 }
        Item { id: hid; display: "none" }
        TextInput { id: inp; width: 5 }
      }`)
    await t.click(2, 1)
    expect(t.proxy.events).toEqual(["down", "up"])
    byId(t, "box").set("width", 12)
    await t.renderOnce()
    expect(t.proxy.sizes).toContain("12x3")
    const imp = renderableOf<{ width: number; height: number }>(t, "imp")
    expect(imp.width).toBe(7)
    expect(imp.height).toBe(2)
    expect(renderableOf<{ visible: boolean }>(t, "hid").visible).toBe(false)
    const inp = byId(t, "inp")
    expect(inp.peek("focused")).toBe(false)
    inp.set("focus", true)
    expect(inp.peek("focused")).toBe(true)
    expect(inp.peek("activeFocus")).toBe(true)
    expect(() => inp.set("focused", false)).toThrow()
  })
})

describe("layout parity", () => {
  test("absolute position, zIndex, opacity, min/max, paddingX, overflow", async () => {
    const t = await run(`
      Item {
        Rectangle {
          id: abs
          position: "absolute"; left: 5; top: 2; zIndex: 3; opacity: 0.5
          width: 6; height: 2; minWidth: 4; maxHeight: 5; paddingX: 1; overflow: "hidden"
          Text { text: "abs" }
        }
      }`)
    const r = renderableOf<any>(t, "abs")
    await t.renderOnce()
    expect(r.x).toBe(5)
    expect(r.y).toBe(2)
    expect(r.zIndex).toBe(3)
    expect(r.opacity).toBe(0.5)
    expect(r.overflow).toBe("hidden")
    expect(t.captureCharFrame().split("\n")[2]).toContain("abs")
  })
})

describe("Screen service", () => {
  test("Screen.width/height follow resize and onResized fires", async () => {
    const t = await run(`
      Item {
        property var log: []
        Text { id: size; text: Screen.width + "x" + Screen.height }
        Connections { target: Screen; function onResized(w, h) { log = log.concat([w + "," + h]) } }
      }`)
    expect(await t.snapshot()).toContain("40x10")
    await t.resize(50, 12)
    expect(await t.snapshot()).toContain("50x12")
    expect(t.proxy.log).toEqual(["50,12"])
  })

  test("Screen.onResized as an attached handler", async () => {
    const t = await run(`
      Item {
        property string last: ""
        Screen.onResized: (w, h) => last = w + "x" + h
      }`)
    await t.resize(30, 8)
    expect(t.proxy.last).toBe("30x8")
  })

  test("notify, copyToClipboard (fake service), writeToScrollback", async () => {
    const t = await run(`Item {}`, {
      renderer: { screenMode: "split-footer", externalOutputMode: "capture-stdout", footerHeight: 4 } as never,
    })
    const screen = screenFor(t.engine)
    const notes: unknown[] = []
    ;(t.renderer as any).triggerNotification = (m: string, title?: string) => {
      notes.push([m, title])
      return true
    }
    ;(screen.proxy as any).notify("done", "build")
    expect(notes).toEqual([["done", "build"]])

    const copied: string[] = []
    screen.setClipboard({
      writeText: async (text: string) => {
        copied.push(text)
        return { host: { status: "success" }, terminal: { status: "skipped" } }
      },
      dispose() {},
    } as never)
    await (screen.proxy as any).copyToClipboard("copied!")
    expect(copied).toEqual(["copied!"])

    ;(screen.proxy as any).writeToScrollback("log line")
    await t.renderOnce()
    expect(t.setup.externalOutput.takeText()).toContain("log line")
  })

  test("Window.title sets the terminal title; paste reaches Keys.onPaste", async () => {
    const t = await run(`
      Window {
        title: "My App"
        property string pasted: ""
        Item { id: it; focus: true; Keys.onPaste: (e) => { pasted = e.text; e.accepted = true } }
      }`)
    await t.paste("clip text")
    expect(t.proxy.pasted).toBe("clip text")
  })

  test("selection: Screen.selectedText, selectionChanged and Text.selectedText()", async () => {
    const t = await run(`
      Item {
        property string sel: ""
        Text { id: txt; text: "select me please"; selectable: true }
        Connections { target: Screen; function onSelectionChanged(text) { sel = text } }
      }`)
    await t.setup.mockMouse.drag(0, 0, 9, 0)
    await t.renderOnce()
    expect(t.proxy.sel.length).toBeGreaterThan(0)
    expect("select me please").toContain(t.proxy.sel)
    expect((byId(t, "txt").proxy as any).selectedText()).toBe(t.proxy.sel)
    const screen = screenFor(t.engine).proxy as any
    expect(screen.hasSelection).toBe(true)
    screen.clearSelection()
    expect(screen.selectedText).toBe("")
  })

  test("Window.title, focus/blur, theme mode, console mode", async () => {
    const titles: string[] = []
    const orig = CliRenderer.prototype.setTerminalTitle
    CliRenderer.prototype.setTerminalTitle = function (this: CliRenderer, title: string) {
      titles.push(title)
      return orig.call(this, title)
    }
    try {
      const t = await run(`
        Window {
          property string label: "one"
          title: "App " + label
          Text { text: Screen.focused ? "focused" : "blurred" }
        }`)
      expect(titles).toContain("App one")
      t.proxy.label = "two"
      expect(titles).toContain("App two")
      expect(await t.snapshot()).toContain("focused")
      t.renderer.emit("blur")
      expect(await t.snapshot()).toContain("blurred")
      t.renderer.emit("theme_mode", "light")
      const screen = screenFor(t.engine).proxy as any
      expect(screen.themeMode).toBe("light")
      screen.consoleMode = "console-overlay"
      expect(t.renderer.consoleMode).toBe("console-overlay")
      expect(() => screen.toggleConsole()).not.toThrow()
    } finally {
      CliRenderer.prototype.setTerminalTitle = orig
    }
  })

  test("Window.onPaste receives unhandled pastes with text and bytes", async () => {
    const t = await run(`
      Window {
        property string pasted: ""
        property int size: 0
        Window.onPaste: (e) => { pasted = e.text; size = e.bytes.length }
      }`)
    await t.paste("xyz")
    expect(t.proxy.pasted).toBe("xyz")
    expect(t.proxy.size).toBe(3)
  })

  test("Keys.onReleased", async () => {
    const t = await run(`
      Item {
        property int released: 0
        Item { focus: true; Keys.onReleased: released++ }
      }`)
    t.renderer.keyInput.processParsedKey({
      name: "a", ctrl: false, meta: false, shift: false, option: false, sequence: "a", number: false,
      raw: "a", eventType: "release", source: "kitty",
    })
    expect(t.proxy.released).toBe(1)
  })
})

describe("animation", () => {
  test("NumberAnimation advances deterministically and finishes", async () => {
    const t = await run(`
      Item {
        id: root
        property real x: 0
        property int done: 0
        NumberAnimation { id: anim; target: root; property: "x"; from: 0; to: 100; duration: 100; onFinished: done++ }
      }`)
    ;(byId(t, "anim").proxy as any).start()
    expect(byId(t, "anim").peek("running")).toBe(true)
    await t.advance(50)
    expect(t.proxy.x).toBeCloseTo(50, 5)
    await t.advance(60)
    expect(t.proxy.x).toBe(100)
    expect(t.proxy.done).toBe(1)
    expect(byId(t, "anim").peek("running")).toBe(false)
  })

  test("easing, running: true, loops and Sequential/Parallel", async () => {
    const t = await run(`
      Item {
        id: root
        property real a: 0
        property real b: 0
        property real c: 0
        SequentialAnimation {
          id: seq
          running: true
          NumberAnimation { target: root; property: "a"; to: 10; duration: 100; easing.type: Easing.InQuad }
          PauseAnimation { duration: 50 }
          ParallelAnimation {
            NumberAnimation { target: root; property: "b"; to: 4; duration: 40 }
            PropertyAnimation { target: root; properties: "c"; to: 8; duration: 80 }
          }
        }
      }`)
    expect(byId(t, "seq").peek("running")).toBe(true)
    await t.advance(50)
    expect(t.proxy.a).toBeCloseTo(2.5, 5) // InQuad(0.5) * 10
    await t.advance(100)
    expect(t.proxy.a).toBe(10)
    expect(t.proxy.b).toBe(0)
    await t.advance(40)
    expect(t.proxy.b).toBe(4)
    expect(t.proxy.c).toBeCloseTo(4, 5)
    await t.advance(40)
    expect(t.proxy.c).toBe(8)
    expect(byId(t, "seq").peek("running")).toBe(false)
  })

  test("stop, pause/resume, loops, detaching on destroy", async () => {
    const t = await run(`
      Item {
        id: root
        property real x: 0
        NumberAnimation { id: anim; target: root; property: "x"; from: 0; to: 10; duration: 10; loops: 2 }
      }`)
    const anim = byId(t, "anim").proxy as any
    anim.start()
    await t.advance(5)
    anim.pause()
    await t.advance(100)
    expect(t.proxy.x).toBeCloseTo(5, 5)
    anim.resume()
    await t.advance(10)
    expect(anim.running).toBe(true) // second loop
    await t.advance(10)
    expect(anim.running).toBe(false)
    expect(t.proxy.x).toBe(10)
    anim.start()
    anim.stop()
    expect(anim.running).toBe(false)
    expect((timelineEngine as any).renderer).toBe(t.renderer)
    t.engine.destroy()
    expect((timelineEngine as any).renderer).toBe(null)
  })
})

describe("new examples", () => {
  const example = (name: string) => ({ file: `${import.meta.dir}/../examples/${name}` })

  test("responsive.qml switches layout on resize", async () => {
    const t = (current = await testQml(example("responsive.qml"), { width: 80, height: 24 }))
    expect(await t.snapshot()).toContain("Terminal: 80x24 (wide layout)")
    await t.resize(50, 20)
    const frame = await t.snapshot()
    expect(frame).toContain("Terminal: 50x20 (narrow layout)")
    expect(frame).toContain("Stacked")
    expect(frame).toContain("Resized 1 times")
    expect(t.warnings).toEqual([])
  })

  test("table.qml reacts to keys", async () => {
    const t = (current = await testQml(example("table.qml"), { width: 80, height: 24 }))
    expect(await t.snapshot()).not.toContain("search")
    await t.pressArrow("right")
    await t.pressArrow("right")
    const frame = await t.snapshot()
    expect(frame).toContain("Services (5 of 5)")
    expect(frame).toContain("search")
  })

  test("animation.qml animates with advance()", async () => {
    const t = (current = await testQml(example("animation.qml"), { width: 80, height: 24 }))
    expect(await t.snapshot()).toContain("] 0%")
    await t.advance(750)
    expect(await t.snapshot()).toContain("] 50%")
    await t.advance(750)
    expect(await t.snapshot()).toContain("] 100%")
    expect(t.errors).toEqual([])
  })
})

describe("engine teardown hooks", () => {
  test("Screen and Keyboard are torn down through engine.onDestroy (no destroy() wrapper)", async () => {
    const t = await run(`Item { property var kb: Keyboard; Text { text: Screen.width } }`)
    expect(Object.hasOwn(t.engine, "destroy")).toBe(false)
    const screen = screenFor(t.engine)
    const keyboard = toQmlObject(t.proxy.kb)!
    expect(keyboard.isDestroyed).toBe(false)
    t.engine.destroy()
    expect(screen.isDestroyed).toBe(true)
    expect(keyboard.isDestroyed).toBe(true)
    expect(t.root.isDestroyed).toBe(true)
  })
})

describe("Portal retargeting", () => {
  test("the old target's destroy hook is dropped when the target changes", async () => {
    const t = await run(`
      Column {
        Rectangle { id: a; width: 20; height: 2 }
        Rectangle { id: b; width: 20; height: 2 }
        Portal { id: portal; target: a; Text { text: "p" } }
      }`)
    const a = byId(t, "a")
    const b = byId(t, "b")
    const portal = byId(t, "portal")
    if (!isVisual(b) || !isVisual(portal)) throw new Error("not visual")
    portal.set("target", b)
    expect(portal.renderable.parent).toBe(b.contentRenderable)
    a.destroy()
    expect(portal.renderable.parent).toBe(b.contentRenderable)
    b.destroy()
    expect(portal.renderable.parent).toBe(t.renderer.root)
  })
})

describe("testQml manual clock", () => {
  test("QML Timer runs on advance(ms)", async () => {
    const t = await run(`
      Item {
        property int count: 0
        Timer { interval: 100; running: true; repeat: true; onTriggered: count++ }
      }`)
    expect(t.scheduler).not.toBeNull()
    expect(t.proxy.count).toBe(0)
    await t.advance(350)
    expect(t.proxy.count).toBe(3)
    await t.advance(50)
    expect(t.proxy.count).toBe(4)
  })

  test("a one-shot Timer that stops itself, and Qt.callLater on the next render", async () => {
    const t = await run(`
      Item {
        property int shots: 0
        property int later: 0
        Timer { id: once; interval: 30; running: true; onTriggered: shots++ }
        function bump() { later++ }
        Component.onCompleted: Qt.callLater(bump)
      }`)
    await t.renderOnce()
    expect(t.proxy.later).toBe(1)
    await t.advance(100)
    expect(t.proxy.shots).toBe(1)
  })

  test("an animation started by a Timer gets only the remaining time", async () => {
    const t = await run(`
      Item {
        property real v: 0
        NumberAnimation { id: anim; target: parent; property: "v"; from: 0; to: 100; duration: 100 }
        Timer { interval: 50; running: true; onTriggered: anim.start() }
      }`)
    await t.advance(100)
    expect(t.proxy.v).toBeGreaterThan(30)
    expect(t.proxy.v).toBeLessThan(70)
  })

  test("pressEscape / pressKey('ESCAPE') are delivered without advancing time", async () => {
    const t = await run(`
      Item {
        property string log: ""
        focus: true
        Keys.onPressed: (e) => log += e.key + ";"
      }`)
    const before = t.clock!.now()
    await t.pressEscape()
    expect(t.proxy.log).toBe("escape;")
    await t.pressKey("ESCAPE")
    await t.pressKey("a")
    expect(t.proxy.log).toBe("escape;escape;a;")
    expect(t.clock!.now()).toBe(before)
  })

  test("a caller-supplied scheduler is used as is", async () => {
    const scheduler = new ManualScheduler()
    const t = await run(`Item { property int n: 0; Timer { interval: 10; running: true; onTriggered: n++ } }`, { scheduler })
    expect(t.scheduler).toBeNull()
    await t.advance(20)
    expect(t.proxy.n).toBe(0)
    scheduler.advance(10)
    expect(t.proxy.n).toBe(1)
  })
})

describe("optional QRCode", () => {
  const installed = loadQrCodeModule() !== null

  test.if(!installed)("without @opentui/qrcode, QRCode is not a type and says what to install", async () => {
    const t = await run(`Item {}`)
    expect(t.engine.hasType("QRCode")).toBe(false)
    let message = ""
    try {
      await testQml(`import OpenTUI\nItem { QRCode { text: "hi" } }`, { width: 10, height: 4 })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('type "QRCode" is not available')
    expect(message).toContain("install the optional package @opentui/qrcode")
  })

  test.if(installed)("with @opentui/qrcode, QRCode renders", async () => {
    const t = await run(`Item { QRCode { id: qr; text: "hello"; errorCorrection: "high" } }`, { width: 40, height: 20 })
    expect(t.engine.hasType("QRCode")).toBe(true)
    expect((byId(t, "qr") as any).renderable.errorCorrectionLevel).toBe("H")
    expect(await t.snapshot()).toContain("█")
  })
})

describe("failed instantiation", () => {
  test("a document failing half-way leaves no renderables behind", async () => {
    const t = await run(`Column { id: host }`)
    const host = byId(t, "host")
    if (!isVisual(host)) throw new Error("not visual")
    const rootChildren = t.renderer.root.getChildren().length
    const component = t.engine.loadSource(`import OpenTUI\nItem { Text { text: "leak" } Bogus {} }`)
    expect(() => t.engine.createObject(component, host)).toThrow(/unknown type "Bogus"/)
    expect(host.children).toHaveLength(0)
    expect(host.contentRenderable.getChildren()).toHaveLength(0)
    expect(t.renderer.root.getChildren().length).toBe(rootChildren)
    expect(await t.snapshot()).not.toContain("leak")
  })
})
