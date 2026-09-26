import { describe, expect, test } from "bun:test"
import {
  parseQml,
  QmlSyntaxError,
  tokenize,
  type BindingValue,
  type EnumDeclaration,
  type FunctionDeclaration,
  type Member,
  type ObjectDefinition,
  type PropertyBinding,
  type PropertyDeclaration,
  type ScriptBinding,
  type SignalDeclaration,
} from "../src/parser/index.ts"

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function root(src: string): ObjectDefinition {
  return parseQml(src).root
}

function bindings(obj: ObjectDefinition): PropertyBinding[] {
  return obj.members.filter((m): m is PropertyBinding => m.type === "PropertyBinding")
}

function binding(obj: ObjectDefinition, name: string): PropertyBinding {
  const b = bindings(obj).find((b) => b.name.join(".") === name)
  if (!b) throw new Error(`no binding ${name}; have ${bindings(obj).map((b) => b.name.join(".")).join(", ")}`)
  return b
}

function script(value: BindingValue): ScriptBinding {
  if (value.type !== "Script") throw new Error(`expected Script, got ${value.type}`)
  return value
}

/** Source of the binding `name` on the root object. */
function src(qml: string, name: string): string {
  return script(binding(root(qml), name).value).source
}

function member<T extends Member["type"]>(obj: ObjectDefinition, type: T, index = 0): Extract<Member, { type: T }> {
  const found = obj.members.filter((m) => m.type === type)
  if (!found[index]) throw new Error(`no ${type} #${index}`)
  return found[index] as Extract<Member, { type: T }>
}

function syntaxError(qml: string): QmlSyntaxError {
  try {
    parseQml(qml, "test.qml")
  } catch (e) {
    if (e instanceof QmlSyntaxError) return e
    throw e
  }
  throw new Error("expected a QmlSyntaxError")
}

// ---------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------

describe("lexer", () => {
  test("numbers: int, float, hex, exponent, separators", () => {
    const toks = tokenize("1 1.5 .5 0xFF 1e3 2.5E-2 1_000 0b101 0o17 10n")
    expect(toks.filter((t) => t.type === "number").map((t) => t.numberValue)).toEqual([
      1, 1.5, 0.5, 255, 1000, 0.025, 1000, 5, 15, undefined,
    ])
  })

  test("strings with escapes are cooked", () => {
    const [a, b] = tokenize(`"a\\n\\"b\\u0041\\x41" 'it\\'s \\u{1F600}'`)
    expect(a.stringValue).toBe('a\n"bAA')
    expect(b.stringValue).toBe("it's \u{1F600}")
  })

  test("multi-char punctuators use longest match", () => {
    const toks = tokenize("a >>>= b === c !== d => ... &&= ?? ?. ** >>> ??=")
    expect(toks.filter((t) => t.type === "punctuator").map((t) => t.value)).toEqual([
      ">>>=", "===", "!==", "=>", "...", "&&=", "??", "?.", "**", ">>>", "??=",
    ])
  })

  test("`?.` followed by a digit is a conditional", () => {
    const toks = tokenize("a?.5:1")
    expect(toks.map((t) => t.value)).toEqual(["a", "?", ".5", ":", "1", ""])
  })

  test("identifiers with $, _ and unicode", () => {
    const toks = tokenize("$foo _bar café 名前 𝑥y")
    expect(toks.filter((t) => t.type === "identifier").map((t) => t.value)).toEqual(["$foo", "_bar", "café", "名前", "𝑥y"])
  })

  test("template literal with nested substitutions is one token", () => {
    const toks = tokenize("`a ${ {b: `c${ '}' }`}.b } d` x")
    expect(toks[0].type).toBe("template")
    expect(toks[0].value).toBe("`a ${ {b: `c${ '}' }`}.b } d`")
    expect(toks[1].value).toBe("x")
  })

  test("regex vs division", () => {
    const toks = tokenize("a / b / c; x = /ab+c\\/[/]/gi.test(s)")
    expect(toks.filter((t) => t.type === "regex").map((t) => t.value)).toEqual(["/ab+c\\/[/]/gi"])
    expect(toks.filter((t) => t.value === "/").length).toBe(2)
  })

  test("positions track lines, columns and offsets (CRLF)", () => {
    const toks = tokenize("a\r\n  bb\r\n\tc")
    expect(toks[1].start).toEqual({ line: 2, column: 3, offset: 5 })
    expect(toks[1].end).toEqual({ line: 2, column: 5, offset: 7 })
    expect(toks[2].start).toEqual({ line: 3, column: 2, offset: 10 })
    expect(toks[1].newlineBefore).toBe(true)
  })

  test("comments are skipped; block comments with newlines set newlineBefore", () => {
    const toks = tokenize("a /* x */ b // c\nd /* \n */ e")
    expect(toks.map((t) => [t.value, t.newlineBefore])).toEqual([
      ["a", false], ["b", false], ["d", true], ["e", true], ["", false],
    ])
  })
})

// ---------------------------------------------------------------------------
// document level
// ---------------------------------------------------------------------------

describe("pragmas and imports", () => {
  test("pragmas", () => {
    const doc = parseQml("pragma Singleton\npragma ComponentBehavior: Bound\nQtObject {}")
    expect(doc.pragmas.map((p) => [p.name, p.value])).toEqual([
      ["Singleton", undefined],
      ["ComponentBehavior", "Bound"],
    ])
  })

  test("all import forms", () => {
    const doc = parseQml(`
import QtQuick
import QtQuick 2.15;
import QtQuick.Controls as Ctrl
import QtQuick.Layouts 1.15 as L
import "components"
import "./dir" as D
import "lib.js" as Lib
Item {}
`)
    const strip = doc.imports.map(({ loc, type, ...rest }) => rest)
    expect(strip).toEqual([
      { uri: "QtQuick" },
      { uri: "QtQuick", version: "2.15" },
      { uri: "QtQuick.Controls", qualifier: "Ctrl" },
      { uri: "QtQuick.Layouts", version: "1.15", qualifier: "L" },
      { path: "components" },
      { path: "./dir", qualifier: "D" },
      { path: "lib.js", qualifier: "Lib" },
    ])
    expect(doc.imports[1].loc.start).toEqual({ line: 3, column: 1, offset: 16 })
  })

  test("document carries filename and source", () => {
    const doc = parseQml("Item {}", "main.qml")
    expect(doc.filename).toBe("main.qml")
    expect(doc.source).toBe("Item {}")
    expect(doc.root.name).toBe("Item")
  })

  test("BOM, CRLF, tabs and trailing whitespace", () => {
    const doc = parseQml("﻿import QtQuick\r\n\r\nItem {\r\n\twidth: 10   \r\n\theight: 20\t\r\n}\r\n")
    expect(doc.imports[0].loc.start).toEqual({ line: 1, column: 1, offset: 1 })
    expect(bindings(doc.root).map((b) => [b.name[0], script(b.value).source])).toEqual([
      ["width", "10"],
      ["height", "20"],
    ])
    expect(binding(doc.root, "height").loc.start.line).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// objects and bindings
// ---------------------------------------------------------------------------

describe("objects and bindings", () => {
  test("id is extracted, not a binding", () => {
    const r = root("Item { id: root; width: 5 }")
    expect(r.id).toBe("root")
    expect(bindings(r).map((b) => b.name)).toEqual([["width"]])
  })

  test("qualified type names and nested children", () => {
    const r = root("Item {\n  Ctrl.Button { id: b }\n  Rectangle { Text {} }\n}")
    const kids = r.members.filter((m): m is ObjectDefinition => m.type === "Object")
    expect(kids.map((k) => k.name)).toEqual(["Ctrl.Button", "Rectangle"])
    expect(kids[0].id).toBe("b")
    expect((kids[1].members[0] as ObjectDefinition).name).toBe("Text")
  })

  test("members separated by semicolons on one line", () => {
    const r = root('Item { width: 1; height: 2; text: "a;b"; }')
    expect(bindings(r).map((b) => script(b.value).source)).toEqual(["1", "2", '"a;b"'])
  })

  test("dotted and attached bindings are path arrays", () => {
    const r = root(`Item {
  anchors.fill: parent
  Layout.fillWidth: true
  Component.onCompleted: console.log("done")
  Keys.onPressed: (event) => handle(event)
  a.b.c: 1
}`)
    expect(bindings(r).map((b) => b.name)).toEqual([
      ["anchors", "fill"],
      ["Layout", "fillWidth"],
      ["Component", "onCompleted"],
      ["Keys", "onPressed"],
      ["a", "b", "c"],
    ])
    expect(script(binding(r, "Layout.fillWidth").value).literal).toEqual({ value: true })
  })

  test("grouped bindings flatten (including nested groups)", () => {
    const r = root(`Item {
  anchors { fill: parent; margins: 2 }
  border {
    width: 1
    color: "red"
  }
  font { bold: true; outer { inner: 3 } }
}`)
    expect(bindings(r).map((b) => [b.name.join("."), script(b.value).source])).toEqual([
      ["anchors.fill", "parent"],
      ["anchors.margins", "2"],
      ["border.width", "1"],
      ["border.color", '"red"'],
      ["font.bold", "true"],
      ["font.outer.inner", "3"],
    ])
  })

  test("handlers are ordinary bindings: block, expression, function, arrow", () => {
    const r = root(`Item {
  onClicked: { count++; foo() }
  onPressed: foo()
  onReleased: function(mouse) { log(mouse) }
  onMoved: (x, y) => { log(x, y) }
}`)
    const click = script(binding(r, "onClicked").value)
    expect(click).toMatchObject({ source: "{ count++; foo() }", isBlock: true })
    expect(script(binding(r, "onPressed").value)).toMatchObject({ source: "foo()", isBlock: false })
    expect(script(binding(r, "onReleased").value)).toMatchObject({ source: "function(mouse) { log(mouse) }", isBlock: false })
    expect(script(binding(r, "onMoved").value)).toMatchObject({ source: "(x, y) => { log(x, y) }", isBlock: false })
  })

  test("multi-line block handler", () => {
    const r = root(`Item {
  onClicked: {
    if (a) {
      b("}")
    } // }
    c = \`\${d}}\`
  }
  width: 3
}`)
    expect(script(binding(r, "onClicked").value).source).toBe('{\n    if (a) {\n      b("}")\n    } // }\n    c = `${d}}`\n  }')
    expect(script(binding(r, "width").value).source).toBe("3")
  })

  test("literals", () => {
    const r = root(`Item {
  s: "hi"
  s2: 'x\\ty'
  n: 42
  f: 1.5
  h: 0x10
  neg: -1
  t: true
  fl: false
  nu: null
  e: 1 + 2
  u: undefined
  tpl: \`x\`
}`)
    const lit = (n: string) => script(binding(r, n).value).literal
    expect(lit("s")).toEqual({ value: "hi" })
    expect(lit("s2")).toEqual({ value: "x\ty" })
    expect(lit("n")).toEqual({ value: 42 })
    expect(lit("f")).toEqual({ value: 1.5 })
    expect(lit("h")).toEqual({ value: 16 })
    expect(lit("neg")).toEqual({ value: -1 })
    expect(lit("t")).toEqual({ value: true })
    expect(lit("fl")).toEqual({ value: false })
    expect(lit("nu")).toEqual({ value: null })
    expect(lit("e")).toBeUndefined()
    expect(lit("u")).toBeUndefined()
    expect(lit("tpl")).toBeUndefined()
  })

  test("ObjectBinding for Type { } values, including qualified types", () => {
    const r = root(`Item {
  delegate: Text { text: modelData }
  contentItem: Ctrl.Label {}
  color: Theme.primary
  point: Qt.point(1, 2)
}`)
    const d = binding(r, "delegate").value
    expect(d.type).toBe("ObjectValue")
    if (d.type === "ObjectValue") expect(d.object.name).toBe("Text")
    const c = binding(r, "contentItem").value
    expect(c.type === "ObjectValue" && c.object.name).toBe("Ctrl.Label")
    expect(script(binding(r, "color").value).source).toBe("Theme.primary")
    expect(script(binding(r, "point").value).source).toBe("Qt.point(1, 2)")
  })

  test("ArrayBinding vs JS array literals", () => {
    const r = root(`Item {
  states: [ State { name: "a" }, State { name: "b" }, ]
  one: [Ctrl.Item {}]
  empty: []
  nums: [1, 2, 3]
  strs: ["a", "b"]
  calls: [Qt.point(1, 2)]
  objs: [{ a: 1 }]
}`)
    const s = binding(r, "states").value
    expect(s.type).toBe("ArrayValue")
    if (s.type === "ArrayValue") expect(s.objects.map((o) => o.name)).toEqual(["State", "State"])
    const one = binding(r, "one").value
    expect(one.type === "ArrayValue" && one.objects[0].name).toBe("Ctrl.Item")
    for (const [n, text] of [["empty", "[]"], ["nums", "[1, 2, 3]"], ["strs", '["a", "b"]'], ["calls", "[Qt.point(1, 2)]"], ["objs", "[{ a: 1 }]"]]) {
      expect(script(binding(r, n).value).source).toBe(text)
    }
  })

  test("object literal in parens is an expression, bare braces are a block", () => {
    const r = root("Item {\n  a: ({a: 1, b: [2]})\n  b: { return 1 }\n}")
    expect(script(binding(r, "a").value)).toMatchObject({ source: "({a: 1, b: [2]})", isBlock: false })
    expect(script(binding(r, "b").value)).toMatchObject({ source: "{ return 1 }", isBlock: true })
  })

  test("comments inside and after scripts", () => {
    const r = root(`Item {
  // leading comment
  width: a /* inline */ + b // trailing
  /* block
     comment */
  height: 2
}`)
    expect(script(binding(r, "width").value).source).toBe("a /* inline */ + b")
    expect(script(binding(r, "height").value).source).toBe("2")
  })

  test("value on the line after the colon", () => {
    expect(src("Item {\n  onClicked:\n    doIt()\n  x: 1\n}", "onClicked")).toBe("doIt()")
  })

  test("statement-style handler", () => {
    const r = root("Item {\n  onClicked: if (a) {\n    b()\n  } else {\n    c()\n  }\n  x: 1\n}")
    expect(script(binding(r, "onClicked").value).source).toBe("if (a) {\n    b()\n  } else {\n    c()\n  }")
  })
})

// ---------------------------------------------------------------------------
// newline termination heuristic
// ---------------------------------------------------------------------------

describe("expression newline heuristic", () => {
  test("multi-line ternary: operators at line start", () => {
    expect(src("Item {\n  color: pressed\n    ? \"red\"\n    : \"blue\"\n  x: 1\n}", "color")).toBe('pressed\n    ? "red"\n    : "blue"')
  })

  test("multi-line ternary: operators at line end", () => {
    expect(src("Item {\n  width: cond ?\n    a :\n    b\n  x: 1\n}", "width")).toBe("cond ?\n    a :\n    b")
  })

  test("ternary whose branch looks like `name : value`", () => {
    expect(src("Item {\n  width: cond ?\n    foo : bar\n  x: 1\n}", "width")).toBe("cond ?\n    foo : bar")
  })

  test("chained method calls on the next line", () => {
    const qml = "Item {\n  text: items\n    .filter(x => x.ok)\n    ?.map(x => x.name)\n    .join(\", \")\n  y: 2\n}"
    expect(src(qml, "text")).toBe('items\n    .filter(x => x.ok)\n    ?.map(x => x.name)\n    .join(", ")')
  })

  test("binary operators at line end", () => {
    expect(src("Item {\n  width: a +\n    b *\n    c\n  height: 1\n}", "width")).toBe("a +\n    b *\n    c")
    expect(src("Item {\n  visible: a &&\n    b ||\n    c\n}", "visible")).toBe("a &&\n    b ||\n    c")
  })

  test("logical operators at line start", () => {
    expect(src("Item {\n  visible: a\n    && b\n    || c\n    ?? d\n}", "visible")).toBe("a\n    && b\n    || c\n    ?? d")
  })

  test("a binding followed by another member on the next line", () => {
    const r = root("Item {\n  width: parent.width\n  height: 10\n  Text {}\n  property int z: 3\n}")
    expect(script(binding(r, "width").value).source).toBe("parent.width")
    expect(r.members.map((m) => m.type)).toEqual(["PropertyBinding", "PropertyBinding", "Object", "PropertyDeclaration"])
  })

  test("next line starting with + - ( [ continues the expression (JS ASI, as in Qt)", () => {
    expect(src("Item {\n  width: a\n  + b\n}", "width")).toBe("a\n  + b")
    expect(src("Item {\n  width: a\n  (b)\n}", "width")).toBe("a\n  (b)")
    expect(src("Item {\n  width: a\n  [b]\n}", "width")).toBe("a\n  [b]")
  })

  test("next line starting with ! ~ ++ -- does not continue (and errors as a member)", () => {
    expect(() => parseQml("Item {\n  width: a\n  !b\n}")).toThrow(QmlSyntaxError)
    expect(() => parseQml("Item {\n  width: a\n  ~b\n}")).toThrow(QmlSyntaxError)
    expect(() => parseQml("Item {\n  width: a\n  ++b\n}")).toThrow(QmlSyntaxError)
  })

  test("string concatenation with + at the start of the next line", () => {
    const r = root('Text {\n    text: "a"\n        + root.name\n        + "!"\n    x: 1\n}')
    expect(script(binding(r, "text").value).source).toBe('"a"\n        + root.name\n        + "!"')
    expect(bindings(r).map((b) => b.name.join("."))).toEqual(["text", "x"])
  })

  test("`x: 1` then `-1` on the next line is `1 - 1` (no literal fast path)", () => {
    const r = root("Item {\n  x: 1\n    -1\n  y: 2\n}")
    const v = script(binding(r, "x").value)
    expect(v.source).toBe("1\n    -1")
    expect(v.literal).toBeUndefined()
    expect(script(binding(r, "y").value).literal).toEqual({ value: 2 })
  })

  test("other operators at line start: * / % == != < > = ,", () => {
    for (const op of ["*", "/", "%", "==", "!=", "<", ">", "<=", "===", "**"]) {
      expect(src(`Item {\n  p: a\n    ${op} b\n  q: 1\n}`, "p")).toBe(`a\n    ${op} b`)
    }
  })

  test("ternary with ? and : at line starts", () => {
    expect(src("Text {\n  text: cond\n    ? a\n    : b\n  x: 1\n}", "text")).toBe("cond\n    ? a\n    : b")
  })

  test("member call on the next line", () => {
    expect(src("Item {\n  x: foo\n    .bar()\n  y: 1\n}", "x")).toBe("foo\n    .bar()")
  })

  test("array literal spanning lines followed by a method call", () => {
    expect(src("Text {\n  text: [\n    1,\n    2\n  ].join()\n  x: 1\n}", "text")).toBe("[\n    1,\n    2\n  ].join()")
  })

  test("template literal on the next line is a tagged template", () => {
    expect(src("Item {\n  p: tag\n    `x`\n  q: 1\n}", "p")).toBe("tag\n    `x`")
  })

  test("`name: value` after an unfinished line is a new binding unless a ternary is pending", () => {
    const r = root("Item {\n  width: a +\n  height: 2\n}")
    expect(script(binding(r, "width").value).source).toBe("a +")
    expect(script(binding(r, "height").value).source).toBe("2")
    const d = root("Item {\n  width: a ||\n  anchors.fill: parent\n}")
    expect(bindings(d).map((b) => b.name.join("."))).toEqual(["width", "anchors.fill"])
    // A `?` earlier in the expression makes `foo : bar` the else-branch.
    expect(src("Item {\n  width: cond ? x\n    : y\n  z: 1\n}", "width")).toBe("cond ? x\n    : y")
    expect(src("Item {\n  width: (c ? 1 : 2) ?\n    foo : bar\n  z: 1\n}", "width")).toBe("(c ? 1 : 2) ?\n    foo : bar")
  })

  test("consecutive bindings still parse separately", () => {
    const r = root("Item {\n  x: 1\n  y: 2\n  text: a\n  b: c ? d : e\n  f: g\n}")
    expect(bindings(r).map((b) => b.name.join("."))).toEqual(["x", "y", "text", "b", "f"])
    expect(script(binding(r, "text").value).source).toBe("a")
    expect(script(binding(r, "b").value).source).toBe("c ? d : e")
  })

  test("arrow functions spanning lines", () => {
    expect(src("Item {\n  onClicked: (m) =>\n    doThing(m)\n  x: 1\n}", "onClicked")).toBe("(m) =>\n    doThing(m)")
    expect(src("Item {\n  onClicked: (m) => {\n    a(m)\n    b()\n  }\n  x: 1\n}", "onClicked")).toBe("(m) => {\n    a(m)\n    b()\n  }")
  })

  test("function call arguments spanning lines", () => {
    expect(src("Item {\n  text: qsTr(\"%1 of %2\",\n    a,\n    b)\n  x: 1\n}", "text")).toBe('qsTr("%1 of %2",\n    a,\n    b)')
  })

  test("object literal in parens spanning lines", () => {
    expect(src("Item {\n  m: ({\n    a: 1,\n    b: 2\n  })\n  x: 1\n}", "m")).toBe("({\n    a: 1,\n    b: 2\n  })")
  })

  test("nested template literals with braces inside ${}", () => {
    const qml = "Item {\n  text: `a ${ {k: `v${ x ? '}' : \"{\" }`}.k } b\n  c`\n  x: 1\n}"
    expect(src(qml, "text")).toBe("`a ${ {k: `v${ x ? '}' : \"{\" }`}.k } b\n  c`")
  })

  test("regex literal in a binding", () => {
    expect(src("Item {\n  valid: /^[a-z}]+$/.test(text)\n  x: 1\n}", "valid")).toBe("/^[a-z}]+$/.test(text)")
  })

  test("declaration keyword on the next line ends an unfinished expression", () => {
    const r = root("Item {\n  width: a +\n  property int b: 1\n}")
    expect(script(binding(r, "width").value).source).toBe("a +")
    expect(member(r, "PropertyDeclaration").name).toBe("b")
  })

  test("closing brace on the same line ends the expression", () => {
    const r = root("Item { Text { text: a + b }\n width: 3 }")
    const text = r.members[0] as ObjectDefinition
    expect(script(binding(text, "text").value).source).toBe("a + b")
  })

  test("round trip: `Item { p: SRC }` yields SRC", () => {
    const sources = [
      "1",
      "-1",
      "'str'",
      '"a\\"b"',
      "a.b.c",
      "a ? b : c",
      "foo(1, 2)[3]",
      "(a, b) => a + b",
      "function(x) { return x * 2 }",
      "({a: 1, b: {c: 2}})",
      "[1, [2, 3], {a: 4}]",
      "`t ${a + `n ${b}`} e`",
      "x instanceof Y",
      "typeof x === 'string'",
      "a?.b ?? c",
      "new Date().getTime() / 1000",
      "/re}/g.test(s)",
      "a /* } */ + b",
      "items.map(i => ({ name: i }))",
      "Qt.rgba(1, 0, 0, 0.5)",
      "!visible",
      "a = b",
      "x as Item",
      "async () => await f()",
      "void 0",
    ]
    for (const s of sources) {
      expect(src(`Item { p: ${s} }`, "p")).toBe(s)
      expect(src(`Item {\n  p: ${s}\n  q: 1\n}`, "p")).toBe(s)
    }
  })
})

// ---------------------------------------------------------------------------
// declarations
// ---------------------------------------------------------------------------

describe("declarations", () => {
  test("property declarations with modifiers and values", () => {
    const r = root(`Item {
  property int x
  property int y: 5
  readonly property string s: "a"
  required property var model
  default property list<Item> content
  default required property var both
  property Item target: null
  property var handler: function() {}
  property var obj: ({a: 1})
  property Ctrl.Button btn
}`)
    const decls = r.members.filter((m): m is PropertyDeclaration => m.type === "PropertyDeclaration")
    expect(decls.map((d) => [d.name, d.propertyType, d.readonly, d.required, d.isDefault])).toEqual([
      ["x", "int", false, false, false],
      ["y", "int", false, false, false],
      ["s", "string", true, false, false],
      ["model", "var", false, true, false],
      ["content", "list<Item>", false, false, true],
      ["both", "var", false, true, true],
      ["target", "Item", false, false, false],
      ["handler", "var", false, false, false],
      ["obj", "var", false, false, false],
      ["btn", "Ctrl.Button", false, false, false],
    ])
    expect(decls[0].value).toBeUndefined()
    expect(script(decls[1].value!).literal).toEqual({ value: 5 })
    expect(script(decls[6].value!).literal).toEqual({ value: null })
    expect(script(decls[7].value!).source).toBe("function() {}")
    expect(script(decls[8].value!).source).toBe("({a: 1})")
  })

  test("property alias", () => {
    const r = root("Item {\n  property alias text: label.text\n  property alias lbl: label\n}")
    const [a, b] = r.members as PropertyDeclaration[]
    expect(a.aliasTarget).toEqual(["label", "text"])
    expect(a.propertyType).toBe("alias")
    expect(b.aliasTarget).toEqual(["label"])
  })

  test("property with object and list values", () => {
    const r = root("Item {\n  property list<Item> items: [ Item {}, Rectangle {} ]\n  property Item child: Text { text: 'x' }\n}")
    const [items, child] = r.members as PropertyDeclaration[]
    expect(items.value?.type).toBe("ArrayValue")
    expect(child.value?.type).toBe("ObjectValue")
  })

  test("modifier words can still be used as binding names", () => {
    const r = root("Item {\n  readonly: true\n  default: 1\n  property: 2\n}")
    expect(bindings(r).map((b) => b.name[0])).toEqual(["readonly", "default", "property"])
  })

  test("signals", () => {
    const r = root(`Item {
  signal clicked
  signal pressed()
  signal moved(int x, int y)
  signal moved2(x: int, y: list<Item>)
  signal untyped(a, b)
}`)
    const sigs = r.members as SignalDeclaration[]
    expect(sigs.map((s) => [s.name, s.params])).toEqual([
      ["clicked", []],
      ["pressed", []],
      ["moved", [{ name: "x", type: "int" }, { name: "y", type: "int" }]],
      ["moved2", [{ name: "x", type: "int" }, { name: "y", type: "list<Item>" }]],
      ["untyped", [{ name: "a" }, { name: "b" }]],
    ])
  })

  test("functions", () => {
    const r = root(`Item {
  function f() { }
  function g(a, b = 1, c = [1, 2]) { return a + b }
  function h(a: int, b: string): bool {
    const o = { x: "}" }
    const re = /[}]/
    return \`\${a}\${b}\` !== "{"
  }
  function rest(first, ...others) {}
}`)
    const fns = r.members as FunctionDeclaration[]
    expect(fns[0]).toMatchObject({ name: "f", params: [], body: "{ }" })
    expect(fns[1].params).toEqual([{ name: "a" }, { name: "b", defaultValue: "1" }, { name: "c", defaultValue: "[1, 2]" }])
    expect(fns[1].body).toBe("{ return a + b }")
    expect(fns[2].params).toEqual([{ name: "a", type: "int" }, { name: "b", type: "string" }])
    expect(fns[2].returnType).toBe("bool")
    expect(fns[2].body.startsWith("{\n    const o")).toBe(true)
    expect(fns[2].body.endsWith('!== "{"\n  }')).toBe(true)
    expect(fns[3].params.map((p) => p.name)).toEqual(["first", "...others"])
  })

  test("enums", () => {
    const e = member(root("Item {\n  enum Color { Red, Green = 2, Blue, Neg = -1, }\n}"), "EnumDeclaration") as EnumDeclaration
    expect(e.name).toBe("Color")
    expect(e.values).toEqual([{ name: "Red" }, { name: "Green", value: 2 }, { name: "Blue" }, { name: "Neg", value: -1 }])
  })

  test("inline components throw a clear error", () => {
    const e = syntaxError("Item {\n  component Foo: Rectangle { }\n}")
    expect(e.message).toContain("inline components are not supported yet")
    expect(e.position.line).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// locations
// ---------------------------------------------------------------------------

describe("locations", () => {
  test("loc on objects, bindings and values", () => {
    const qml = "Item {\n  width: 10 + 2\n  Text { }\n}"
    const r = root(qml)
    expect(r.loc.start).toEqual({ line: 1, column: 1, offset: 0 })
    expect(r.loc.end).toEqual({ line: 4, column: 2, offset: qml.length })
    const w = binding(r, "width")
    expect(w.loc.start).toEqual({ line: 2, column: 3, offset: 9 })
    expect(w.value.loc.start).toEqual({ line: 2, column: 10, offset: 16 })
    expect(qml.slice(w.value.loc.start.offset, w.value.loc.end.offset)).toBe("10 + 2")
    const text = r.members[1] as ObjectDefinition
    expect(qml.slice(text.loc.start.offset, text.loc.end.offset)).toBe("Text { }")
  })

  test("loc slices reproduce declarations", () => {
    const qml = "Item {\n  property int count: 0\n  signal moved(int x)\n  function f(a) { return a }\n  enum E { A }\n}"
    const r = root(qml)
    expect(r.members.map((m) => qml.slice(m.loc.start.offset, m.loc.end.offset))).toEqual([
      "property int count: 0",
      "signal moved(int x)",
      "function f(a) { return a }",
      "enum E { A }",
    ])
  })
})

// ---------------------------------------------------------------------------
// realistic document
// ---------------------------------------------------------------------------

describe("realistic app", () => {
  const APP = `// Todo app
pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls as Ctrl
import "components"

ApplicationWindow {
    id: window
    title: "Todos"
    color: "#1e1e2e"

    property int doneCount: 0
    property var todos: [
        { text: "Write parser", done: true },
        { text: "Write runtime", done: false },
    ]
    readonly property int remaining: todos.length - doneCount
    signal todoAdded(string text)

    function addTodo(text: string) {
        todos = todos.concat([{ text: text, done: false }])
        todoAdded(text)
    }

    Column {
        anchors { fill: parent; margins: 1 }
        spacing: 1

        Text {
            text: \`\${window.remaining} of \${window.todos.length} remaining\`
            font.bold: true
            color: window.remaining > 0
                ? "#f38ba8"
                : "#a6e3a1"
        }

        TextInput {
            id: input
            placeholderText: "What needs doing?"
            focus: true
            onAccepted: {
                if (text.trim() !== "") {
                    window.addTodo(text)
                    text = ""
                }
            }
        }

        Repeater {
            model: window.todos
            delegate: Text {
                required property var modelData
                text: (modelData.done ? "[x] " : "[ ] ") + modelData.text
            }
        }
    }

    Keys.onPressed: (event) => {
        if (event.key === "escape") Qt.quit()
    }
    Component.onCompleted: console.log("ready")
}
`

  test("parses the whole app", () => {
    const doc = parseQml(APP, "Todo.qml")
    expect(APP.split("\n").length).toBeGreaterThanOrEqual(60)
    expect(doc.pragmas[0]).toMatchObject({ name: "ComponentBehavior", value: "Bound" })
    expect(doc.imports.length).toBe(3)
    const r = doc.root
    expect(r.name).toBe("ApplicationWindow")
    expect(r.id).toBe("window")
    expect(r.members.map((m) => m.type)).toEqual([
      "PropertyBinding",
      "PropertyBinding",
      "PropertyDeclaration",
      "PropertyDeclaration",
      "PropertyDeclaration",
      "SignalDeclaration",
      "FunctionDeclaration",
      "Object",
      "PropertyBinding",
      "PropertyBinding",
    ])
    const todos = r.members[3] as PropertyDeclaration
    expect(script(todos.value!).source.startsWith("[\n        { text")).toBe(true)
    expect(script(todos.value!).source.endsWith("},\n    ]")).toBe(true)

    const column = r.members[7] as ObjectDefinition
    expect(bindings(column).map((b) => b.name.join("."))).toEqual(["anchors.fill", "anchors.margins", "spacing"])
    const [text, input, repeater] = column.members.filter((m): m is ObjectDefinition => m.type === "Object")
    expect(script(binding(text, "color").value).source).toBe('window.remaining > 0\n                ? "#f38ba8"\n                : "#a6e3a1"')
    expect(binding(text, "font.bold").value).toMatchObject({ literal: { value: true } })
    expect(input.id).toBe("input")
    expect(script(binding(input, "onAccepted").value).isBlock).toBe(true)
    const delegate = binding(repeater, "delegate").value
    expect(delegate.type).toBe("ObjectValue")
    if (delegate.type === "ObjectValue") {
      expect(delegate.object.members[0]).toMatchObject({ type: "PropertyDeclaration", required: true, name: "modelData" })
    }
    expect(script(binding(r, "Keys.onPressed").value).source.startsWith("(event) => {")).toBe(true)
    const expectedLine = APP.split("\n").findIndex((l) => l.includes("Component.onCompleted")) + 1
    expect(binding(r, "Component.onCompleted").loc.start).toMatchObject({ line: expectedLine, column: 5 })
  })
})

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

describe("errors", () => {
  test("empty and whitespace/comment-only documents", () => {
    expect(syntaxError("").message).toContain("empty document")
    expect(syntaxError("  // nothing\n\n").message).toContain("empty document")
    expect(syntaxError("import QtQuick\n").message).toContain("root object")
  })

  test("error message includes filename and position", () => {
    const e = syntaxError("Item {\n  width 5\n}")
    expect(e).toBeInstanceOf(QmlSyntaxError)
    expect(e.filename).toBe("test.qml")
    expect(e.position).toMatchObject({ line: 2, column: 9 })
    expect(e.message).toBe("test.qml:2:9: expected ':' or '{' after 'width', found '5'")
  })

  test("unterminated string", () => {
    const e = syntaxError('Item {\n  text: "abc\n}')
    expect(e.message).toContain("unterminated string")
    expect(e.position).toMatchObject({ line: 2, column: 9 })
  })

  test("unterminated template literal", () => {
    const e = syntaxError("Item {\n\n  text: `abc ${x}\n}")
    expect(e.message).toContain("unterminated template")
    expect(e.position.line).toBe(3)
  })

  test("unterminated block comment", () => {
    const e = syntaxError("Item {\n  /* never\n closed }")
    expect(e.message).toContain("unterminated block comment")
    expect(e.position).toMatchObject({ line: 2, column: 3 })
  })

  test("unterminated block script", () => {
    const e = syntaxError("Item {\n  onClicked: {\n    foo()\n")
    expect(e.message).toContain("unterminated '{'")
    expect(e.position).toMatchObject({ line: 2, column: 14 })
  })

  test("missing closing brace of an object", () => {
    const e = syntaxError("Item {\n  Rectangle {\n    width: 1\n  }\n")
    expect(e.message).toContain("expected '}' to close 'Item' (opened at line 1, column 6)")
    expect(e.position.line).toBe(5)
  })

  test("mismatched brackets", () => {
    const e = syntaxError("Item {\n  width: (1 + 2]\n}")
    expect(e.message).toContain("expected ')' to close '('")
    expect(e.position).toMatchObject({ line: 2, column: 16 })
    const e2 = syntaxError("Item {\n  width: 1 + 2)\n}")
    expect(e2.message).toContain("unmatched ')'")
  })

  test("missing value", () => {
    expect(syntaxError("Item { width: }").message).toContain("expected a value")
    expect(syntaxError("Item { width: ; }").message).toContain("expected a value")
  })

  test("two members on one line without separator", () => {
    const e = syntaxError("Item {\n  width: 1 height: 2\n}")
    expect(e.message).toContain("expected ';' or newline")
    expect(e.position).toMatchObject({ line: 2, column: 12 })
    expect(syntaxError("Item { property int a property int b }").message).toContain("expected ';' or newline")
  })

  test("content after the root object", () => {
    const e = syntaxError("Item {}\nItem {}")
    expect(e.message).toContain("after the root object")
    expect(e.position.line).toBe(2)
  })

  test("bad ids", () => {
    expect(syntaxError("Item { id: Foo }").message).toContain("must not start with an uppercase letter")
    expect(syntaxError('Item { id: "foo" }').message).toContain("expected an identifier after 'id:'")
    expect(syntaxError("Item { id: a; id: b }").message).toContain("duplicate id")
  })

  test("unexpected tokens and characters", () => {
    expect(syntaxError("Item {\n  : 5\n}").position.line).toBe(2)
    expect(syntaxError("Item {\n  x: 1 \\ 2\n}").message).toContain("unexpected character")
    expect(syntaxError("item").message).toContain("expected '{' after type name 'item'")
  })

  test("value source syntax is reported as unsupported", () => {
    expect(syntaxError("Item {\n  Behavior on x { }\n}").message).toContain("not supported")
  })

  test("invalid declarations", () => {
    expect(syntaxError("Item { readonly foo: 1 }").message).toContain("expected 'property' after 'readonly'")
    expect(syntaxError("Item { readonly int foo }").message).toContain("expected 'property'")
    expect(syntaxError("Item { property alias a }").message).toContain("alias")
    expect(syntaxError("Item { property alias a: b + 1 }").message).toContain("alias target")
    expect(syntaxError("Item { signal s(int x int y) }").message).toContain("signal parameters")
    expect(syntaxError("Item { function f(a b) {} }").message).toContain("parameter list")
    expect(syntaxError("Item { function f() }").message).toContain("expected '{'")
    expect(syntaxError("Item { enum E { A = x } }").message).toContain("expected a number")
    expect(syntaxError("import QtQuick as ctrl\nItem {}").message).toContain("uppercase")
  })

  test("object definitions inside a grouped property are rejected", () => {
    expect(syntaxError("Item { anchors { Item {} } }").message).toContain("not allowed inside grouped property 'anchors'")
  })
})

describe("sibling objects on one line", () => {
  const objects = (members: Member[]) => members.filter((m): m is ObjectDefinition => m.type === "Object")

  test("objects separated only by whitespace after `}`", () => {
    const doc = parseQml(`Row { Text { text: "a" } Text { text: "b" } }`)
    expect(objects(doc.root.members).map((o) => o.name)).toEqual(["Text", "Text"])
  })

  test("with ids, semicolons and following bindings", () => {
    const doc = parseQml(`Row { Item { id: a } Item { id: b }; Item {} width: 3 }`)
    expect(objects(doc.root.members).map((o) => o.id)).toEqual(["a", "b", undefined])
    const width = doc.root.members.find((m): m is PropertyBinding => m.type === "PropertyBinding" && m.name.join(".") === "width")
    expect(width).toBeDefined()
  })

  test("nested one-liners and object-valued bindings", () => {
    const doc = parseQml(`Item { Row { Text {} Text {} } property Item x: Item {} Rectangle {} }`)
    const [row, rect] = objects(doc.root.members)
    expect(row!.name).toBe("Row")
    expect(objects(row!.members).length).toBe(2)
    expect(rect!.name).toBe("Rectangle")
  })

  test("bindings without separators are still rejected", () => {
    expect(() => parseQml(`Item { width: 1 height: 2 }`)).toThrow(QmlSyntaxError)
    expect(() => parseQml(`Item { Text {} width: 1 height: 2 }`)).toThrow(QmlSyntaxError)
  })
})
