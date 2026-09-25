/**
 * QML AST — the shared contract between the parser and the runtime.
 *
 * Design notes:
 * - JavaScript inside QML (binding expressions, handler bodies, function bodies)
 *   is NOT parsed into a JS AST. It is captured as raw source text and later
 *   compiled by the runtime with `new Function`. The parser only needs to find
 *   where each script starts and ends (bracket balancing + string/comment/template
 *   awareness + a newline-termination heuristic for expressions).
 * - Grouped property bindings (`anchors { fill: parent }`) and dotted bindings
 *   (`anchors.fill: parent`, `Layout.fillWidth: true`, `Component.onCompleted: ...`)
 *   are both represented as a PropertyBinding whose `name` is a path array.
 */

export interface SourcePosition {
  /** 1-based line */
  line: number
  /** 1-based column */
  column: number
  /** 0-based character offset into the source */
  offset: number
}

export interface SourceLocation {
  start: SourcePosition
  end: SourcePosition
}

export interface QmlDocument {
  type: "Document"
  filename?: string
  source: string
  pragmas: PragmaStatement[]
  imports: ImportStatement[]
  root: ObjectDefinition
}

export interface PragmaStatement {
  type: "Pragma"
  name: string
  value?: string
  loc: SourceLocation
}

export interface ImportStatement {
  type: "Import"
  /** `import QtQuick 2.15` -> uri "QtQuick". Undefined for path/file imports. */
  uri?: string
  /** `import "components"` or `import "./Foo.js"` -> path "components" */
  path?: string
  /** "2.15" if present */
  version?: string
  /** `import Foo as Bar` -> "Bar" */
  qualifier?: string
  loc: SourceLocation
}

export interface ObjectDefinition {
  type: "Object"
  /**
   * Type name as written, possibly qualified: "Item", "QtQuick.Item", "Bar.Foo".
   * The runtime resolves qualifiers.
   */
  name: string
  /** `id: foo` — extracted from the members, NOT left as a PropertyBinding. */
  id?: string
  members: Member[]
  loc: SourceLocation
}

export type Member =
  | PropertyBinding
  | PropertyDeclaration
  | SignalDeclaration
  | FunctionDeclaration
  | EnumDeclaration
  | ObjectDefinition

/**
 * `name: value`, `a.b.c: value`, `group { a: 1 }` (flattened to `group.a: 1`),
 * `onClicked: { ... }`, `Component.onCompleted: ...`, `Keys.onPressed: ...`.
 * Handlers are ordinary PropertyBindings whose last path segment starts with "on".
 */
export interface PropertyBinding {
  type: "PropertyBinding"
  /** Path segments: `anchors.fill` -> ["anchors", "fill"]; `width` -> ["width"] */
  name: string[]
  value: BindingValue
  loc: SourceLocation
}

export type BindingValue = ScriptBinding | ObjectBinding | ArrayBinding

/**
 * Raw JS source.
 * - `width: parent.width * 2` -> source "parent.width * 2", isBlock false
 * - `onClicked: { count++; foo() }` -> source "{ count++; foo() }" (braces included), isBlock true
 * - `onClicked: function(mouse) { ... }` -> source is the function expression, isBlock false
 * - `text: "hi"` -> source "\"hi\"", isBlock false (the runtime evaluates it; no literal special-casing required,
 *   but the parser MAY set `literal` when the source is a plain string/number/boolean literal to allow fast paths)
 */
export interface ScriptBinding {
  type: "Script"
  source: string
  isBlock: boolean
  /** Set when `source` is exactly a string / number / boolean / null literal. */
  literal?: { value: string | number | boolean | null }
  loc: SourceLocation
}

/** `delegate: Item { ... }` or `contentItem: Rectangle { }` */
export interface ObjectBinding {
  type: "ObjectValue"
  object: ObjectDefinition
  loc: SourceLocation
}

/** `states: [ State { }, State { } ]` — a bracketed list of object definitions. A JS array literal like `[1,2]` is a ScriptBinding. */
export interface ArrayBinding {
  type: "ArrayValue"
  objects: ObjectDefinition[]
  loc: SourceLocation
}

/**
 * `property int count: 0`
 * `readonly property string name: "x"`
 * `required property var model`
 * `default property list<Item> content`
 * `property alias text: label.text`
 * `property var foo` (no default)
 */
export interface PropertyDeclaration {
  type: "PropertyDeclaration"
  name: string
  /** "int" | "string" | "var" | "bool" | "real" | "double" | "color" | "alias" | "list<Item>" | "Item" | ... as written */
  propertyType: string
  readonly: boolean
  required: boolean
  isDefault: boolean
  /** Only for `propertyType === "alias"`: the target path, e.g. ["label", "text"] */
  aliasTarget?: string[]
  value?: BindingValue
  loc: SourceLocation
}

/** `signal clicked` / `signal moved(int x, int y)` / `signal moved(x: int, y: int)` */
export interface SignalDeclaration {
  type: "SignalDeclaration"
  name: string
  params: { name: string; type?: string }[]
  loc: SourceLocation
}

/**
 * `function add(a, b) { return a + b }`
 * `function add(a: int, b: int): int { ... }` — type annotations are stripped from params/return.
 */
export interface FunctionDeclaration {
  type: "FunctionDeclaration"
  name: string
  params: { name: string; type?: string; defaultValue?: string }[]
  returnType?: string
  /** Body source including the surrounding braces: "{ return a + b }" */
  body: string
  loc: SourceLocation
}

/** `enum Color { Red, Green = 5, Blue }` */
export interface EnumDeclaration {
  type: "EnumDeclaration"
  name: string
  values: { name: string; value?: number }[]
  loc: SourceLocation
}

export class QmlSyntaxError extends Error {
  constructor(
    message: string,
    public readonly position: SourcePosition,
    public readonly filename?: string,
  ) {
    super(`${filename ?? "<qml>"}:${position.line}:${position.column}: ${message}`)
    this.name = "QmlSyntaxError"
  }
}
