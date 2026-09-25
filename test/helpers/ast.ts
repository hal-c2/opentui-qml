/**
 * Tiny builder for hand-written QML ASTs (runtime tests that don't want to depend on the parser).
 *
 *   doc(obj("QtObject", [prop("x", "int", "1"), bind("y", "x * 2")], "root"))
 */
import type {
  BindingValue,
  FunctionDeclaration,
  ImportStatement,
  Member,
  ObjectDefinition,
  PropertyBinding,
  PropertyDeclaration,
  QmlDocument,
  ScriptBinding,
  SignalDeclaration,
  SourceLocation,
} from "../../src/parser/ast.ts"

let line = 1
const loc = (): SourceLocation => ({
  start: { line, column: 1, offset: 0 },
  end: { line: line++, column: 1, offset: 0 },
})

/** Script value; `{ ... }` sources are blocks. */
export function script(source: string): ScriptBinding {
  const trimmed = source.trim()
  return { type: "Script", source, isBlock: trimmed.startsWith("{") && trimmed.endsWith("}"), loc: loc() }
}

type ValueInput = string | ObjectDefinition | ObjectDefinition[] | BindingValue

function toValue(value: ValueInput): BindingValue {
  if (typeof value === "string") return script(value)
  if (Array.isArray(value)) return { type: "ArrayValue", objects: value, loc: loc() }
  if (value.type === "Object") return { type: "ObjectValue", object: value, loc: loc() }
  return value
}

/** `a.b: value` (value: JS source, an object definition, or an array of them). */
export function bind(path: string, value: ValueInput): PropertyBinding {
  return { type: "PropertyBinding", name: path.split("."), value: toValue(value), loc: loc() }
}

/** `property <type> name: value`; for aliases pass the target as `value` ("label.text"). */
export function prop(
  name: string,
  propertyType: string,
  value?: ValueInput,
  flags: { readonly?: boolean; required?: boolean; isDefault?: boolean } = {},
): PropertyDeclaration {
  const decl: PropertyDeclaration = {
    type: "PropertyDeclaration",
    name,
    propertyType,
    readonly: flags.readonly ?? false,
    required: flags.required ?? false,
    isDefault: flags.isDefault ?? false,
    loc: loc(),
  }
  if (propertyType === "alias" && typeof value === "string") decl.aliasTarget = value.split(".")
  else if (value !== undefined) decl.value = toValue(value)
  return decl
}

export function signal(name: string, params: string[] = []): SignalDeclaration {
  return { type: "SignalDeclaration", name, params: params.map((p) => ({ name: p })), loc: loc() }
}

export function fn(name: string, params: string[], body: string): FunctionDeclaration {
  return { type: "FunctionDeclaration", name, params: params.map((p) => ({ name: p })), body, loc: loc() }
}

export function obj(name: string, members: Member[] = [], id?: string): ObjectDefinition {
  const def: ObjectDefinition = { type: "Object", name, members, loc: loc() }
  if (id) def.id = id
  return def
}

export function doc(root: ObjectDefinition, imports: Array<Omit<ImportStatement, "type" | "loc">> = []): QmlDocument {
  return {
    type: "Document",
    source: "",
    pragmas: [],
    imports: imports.map((i) => ({ type: "Import", ...i, loc: loc() })),
    root,
  }
}
