/**
 * QML parser: source text -> `QmlDocument` (see ./ast.ts).
 *
 * The QML structure (pragmas, imports, object definitions, members) is parsed
 * properly. Embedded JavaScript is NOT parsed: the parser only finds its extent
 * and slices the raw source. Blocks (`{ ... }`) and function bodies are
 * captured by bracket balancing; binding expressions use a newline-termination
 * heuristic (see `scanExpression`) that mirrors QML's ASI-like behaviour.
 */

import {
  QmlSyntaxError,
  type ArrayBinding,
  type BindingValue,
  type EnumDeclaration,
  type FunctionDeclaration,
  type ImportStatement,
  type ObjectBinding,
  type ObjectDefinition,
  type PragmaStatement,
  type PropertyBinding,
  type PropertyDeclaration,
  type QmlDocument,
  type ScriptBinding,
  type SignalDeclaration,
  type SourceLocation,
  type SourcePosition,
} from "./ast.ts"
import { tokenize, type Token } from "./lexer.ts"

/** Parse a QML document. Throws `QmlSyntaxError` (with position) on invalid input. */
export function parseQml(source: string, filename?: string): QmlDocument {
  return new Parser(source, filename).parseDocument()
}

// ---------------------------------------------------------------------------
// Token classification tables used by the expression newline heuristic
// ---------------------------------------------------------------------------

const ASSIGNMENT_OPERATORS = [
  "=", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "|=", "^=", "&&=", "||=", "??=",
]

const BINARY_OPERATORS = [
  "==", "===", "!=", "!==", "<", ">", "<=", ">=", "*", "/", "%", "**", "&", "|", "^", "<<", ">>", ">>>",
  "&&", "||", "??",
]

/**
 * A line ending in one of these punctuators is obviously unfinished, so the
 * expression continues on the next line.
 */
const CONTINUES_AFTER_PUNCT = new Set([
  ...ASSIGNMENT_OPERATORS,
  ...BINARY_OPERATORS,
  "+", "-", "!", "~", ",", ".", "?.", "?", ":", "(", "[", "{", "=>", "...",
])

/** A line ending in one of these keywords is unfinished. */
const CONTINUES_AFTER_KEYWORD = new Set([
  "new", "typeof", "void", "delete", "return", "in", "instanceof", "else", "await", "yield", "throw",
  "case", "of", "as", "extends",
])

/**
 * If the next line starts with one of these punctuators, it cannot begin a new
 * member, so it continues the expression. Deliberately NOT included: `+`, `-`,
 * `(`, `[`, `!`, `~`, `++`, `--`, template literals — QML treats those as the
 * start of something new (like JS ASI would for most of them in QML context).
 */
const CONTINUES_BEFORE_PUNCT = new Set([
  ...ASSIGNMENT_OPERATORS,
  ...BINARY_OPERATORS,
  ".", "?.", "?", ":", ",", "=>", ")", "]",
])

/** Keywords that, at the start of the next line, continue the expression / statement. */
const CONTINUES_BEFORE_KEYWORD = new Set(["instanceof", "in", "as", "else", "catch", "finally"])

/**
 * Identifiers that are keywords/operators rather than values; used by the
 * "two values side by side on one line" check (e.g. `width: 1 height: 2`).
 */
const NON_VALUE_KEYWORDS = new Set([
  "new", "typeof", "void", "delete", "return", "in", "of", "instanceof", "else", "await", "yield",
  "throw", "case", "as", "function", "class", "async", "let", "const", "var", "extends", "do", "if",
  "for", "while", "switch", "try", "catch", "finally", "with", "import", "export", "default", "break",
  "continue", "static", "get", "set",
])

/** JS keywords that may legitimately be followed by `{` (so `kw {` is not a grouped binding). */
const KEYWORDS_BEFORE_BRACE = new Set(["else", "do", "try", "finally", "static", "return", "case", "default"])

const OPENERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" }
const CLOSERS = new Set([")", "]", "}"])

/** QML distinguishes type names from property names by an uppercase first letter. */
function isUpperStart(name: string): boolean {
  const ch = String.fromCodePoint(name.codePointAt(0) ?? 0)
  return ch !== ch.toLowerCase()
}

function describe(tok: Token): string {
  if (tok.type === "eof") return "end of file"
  return `'${tok.value.length > 30 ? tok.value.slice(0, 30) + "..." : tok.value}'`
}

class Parser {
  private readonly tokens: Token[]
  private i = 0

  constructor(
    private readonly source: string,
    private readonly filename?: string,
  ) {
    this.tokens = tokenize(source, filename)
  }

  // -------------------------------------------------------------------------
  // Token helpers
  // -------------------------------------------------------------------------

  private peek(k = 0): Token {
    return this.tokens[Math.min(this.i + k, this.tokens.length - 1)]
  }

  private next(): Token {
    const tok = this.tokens[this.i]
    if (tok.type !== "eof") this.i++
    return tok
  }

  private prevToken(): Token {
    return this.tokens[this.i - 1]
  }

  private isPunct(tok: Token, value: string): boolean {
    return tok.type === "punctuator" && tok.value === value
  }

  private isIdent(tok: Token, value?: string): boolean {
    return tok.type === "identifier" && (value === undefined || tok.value === value)
  }

  private error(message: string, at: Token | SourcePosition): never {
    const pos = "type" in at ? at.start : at
    throw new QmlSyntaxError(message, pos, this.filename)
  }

  private expectPunct(value: string, context: string): Token {
    const tok = this.peek()
    if (!this.isPunct(tok, value)) this.error(`expected '${value}' ${context}, found ${describe(tok)}`, tok)
    return this.next()
  }

  private expectIdent(context: string): Token {
    const tok = this.peek()
    if (tok.type !== "identifier") this.error(`expected ${context}, found ${describe(tok)}`, tok)
    return this.next()
  }

  private loc(start: Token, end: Token): SourceLocation {
    return { start: start.start, end: end.end }
  }

  private slice(start: Token, end: Token): string {
    return this.source.slice(start.start.offset, end.end.offset).trim()
  }

  /**
   * Members must be separated by `;` or a newline. Consumes an optional `;` and
   * checks that whatever follows is on a new line (or closes the object).
   * A member that ends with `}` (a child object, a grouped property, an object-valued
   * binding or a block handler) needs no separator: `Text {} Text {}` is valid, like in Qt.
   */
  private endMember(): void {
    const tok = this.peek()
    if (this.isPunct(tok, ";")) {
      this.next()
      return
    }
    if (this.isPunct(tok, "}") || tok.type === "eof" || tok.newlineBefore) return
    const prev = this.prevToken()
    if (prev && this.isPunct(prev, "}")) return
    this.error(`expected ';' or newline, found ${describe(tok)}`, tok)
  }

  /** `a.b.c` — returns the segments and the first/last tokens. */
  private parseDottedName(context: string): { parts: string[]; first: Token; last: Token } {
    const first = this.expectIdent(context)
    const parts = [first.value]
    let last = first
    while (this.isPunct(this.peek(), ".") && this.isIdent(this.peek(1))) {
      this.next()
      last = this.next()
      parts.push(last.value)
    }
    return { parts, first, last }
  }

  /** A type name: `int`, `Ctrl.Button`, `list<Item>`. */
  private parseTypeName(context: string): { name: string; last: Token } {
    const { parts, last } = this.parseDottedName(context)
    let name = parts.join(".")
    let end = last
    if (this.isPunct(this.peek(), "<")) {
      this.next()
      const inner = this.parseTypeName("type argument")
      end = this.expectPunct(">", `to close type argument of '${name}'`)
      name = `${name}<${inner.name}>`
    }
    return { name, last: end }
  }

  /**
   * Consumes a bracketed region starting at the current `(`, `[` or `{` token up
   * to and including its matching closer. Returns the closing token.
   */
  private skipBalanced(): Token {
    const stack: Token[] = []
    for (;;) {
      const tok = this.peek()
      if (tok.type === "eof") {
        const open = stack[stack.length - 1]
        this.error(`unterminated '${open.value}': missing '${OPENERS[open.value]}' (opened at line ${open.start.line}, column ${open.start.column})`, open)
      }
      if (tok.type === "punctuator") {
        if (OPENERS[tok.value]) stack.push(tok)
        else if (CLOSERS.has(tok.value)) this.popMatching(stack, tok)
      }
      this.next()
      if (stack.length === 0) return tok
    }
  }

  private popMatching(stack: Token[], closer: Token): void {
    const open = stack.pop()
    if (!open) this.error(`unmatched ${describe(closer)}`, closer)
    const expected = OPENERS[open.value]
    if (expected !== closer.value) {
      this.error(
        `expected '${expected}' to close '${open.value}' (opened at line ${open.start.line}, column ${open.start.column}), found ${describe(closer)}`,
        closer,
      )
    }
  }

  // -------------------------------------------------------------------------
  // Document level
  // -------------------------------------------------------------------------

  parseDocument(): QmlDocument {
    if (this.peek().type === "eof") {
      this.error("empty document: expected a root object definition", this.peek())
    }
    const pragmas: PragmaStatement[] = []
    const imports: ImportStatement[] = []
    for (;;) {
      const tok = this.peek()
      if (this.isIdent(tok, "pragma") && this.isIdent(this.peek(1))) pragmas.push(this.parsePragma())
      else if (this.isIdent(tok, "import") && !this.isPunct(this.peek(1), "{")) imports.push(this.parseImport())
      else break
    }
    if (this.peek().type === "eof") this.error("expected a root object definition", this.peek())
    const root = this.parseObjectDefinition()
    const trailing = this.peek()
    if (trailing.type !== "eof") {
      this.error(`unexpected ${describe(trailing)} after the root object (a document has exactly one root object)`, trailing)
    }
    return { type: "Document", filename: this.filename, source: this.source, pragmas, imports, root }
  }

  /** `pragma Singleton` / `pragma ComponentBehavior: Bound` */
  private parsePragma(): PragmaStatement {
    const start = this.next()
    const nameTok = this.expectIdent("pragma name")
    let end = nameTok
    let value: string | undefined
    if (this.isPunct(this.peek(), ":")) {
      this.next()
      const first = this.peek()
      if (first.type === "eof" || first.newlineBefore || this.isPunct(first, ";")) {
        this.error(`expected a value for pragma '${nameTok.value}'`, first)
      }
      // The value runs to the end of the line (e.g. `pragma ValueTypeBehavior: Addressable, Inline`).
      while (!this.peek().newlineBefore && this.peek().type !== "eof" && !this.isPunct(this.peek(), ";")) end = this.next()
      value = this.slice(first, end)
    }
    this.endMember()
    return { type: "Pragma", name: nameTok.value, value, loc: this.loc(start, end) }
  }

  /** `import QtQuick 2.15`, `import QtQuick.Controls as C`, `import "dir" as D` */
  private parseImport(): ImportStatement {
    const start = this.next()
    const node: ImportStatement = { type: "Import", loc: this.loc(start, start) }
    let end: Token
    const tok = this.peek()
    if (tok.type === "string") {
      node.path = tok.stringValue
      end = this.next()
    } else if (tok.type === "identifier") {
      const name = this.parseDottedName("module name")
      node.uri = name.parts.join(".")
      end = name.last
    } else {
      this.error(`expected a module name or quoted path after 'import', found ${describe(tok)}`, tok)
    }
    if (this.peek().type === "number" && !this.peek().newlineBefore) {
      end = this.next()
      node.version = end.value
    }
    if (this.isIdent(this.peek(), "as") && !this.peek().newlineBefore) {
      this.next()
      const q = this.expectIdent("import qualifier after 'as'")
      if (!isUpperStart(q.value)) this.error(`import qualifier '${q.value}' must start with an uppercase letter`, q)
      node.qualifier = q.value
      end = q
    }
    node.loc = this.loc(start, end)
    this.endMember()
    return node
  }

  // -------------------------------------------------------------------------
  // Objects and members
  // -------------------------------------------------------------------------

  /** `Type { members }` or `Qualifier.Type { members }` */
  private parseObjectDefinition(): ObjectDefinition {
    const { parts, first } = this.parseDottedName("object type name")
    return this.parseObjectBody(parts.join("."), first)
  }

  private parseObjectBody(name: string, start: Token): ObjectDefinition {
    const open = this.expectPunct("{", `after type name '${name}'`)
    const obj: ObjectDefinition = { type: "Object", name, members: [], loc: this.loc(start, start) }
    const close = this.parseMemberList(open, name, (prefix) => this.parseMember(obj, prefix), [])
    obj.loc = this.loc(start, close)
    return obj
  }

  /**
   * Parses members until the `}` matching `open`; returns that closing token.
   * `parseOne` handles a single member (with the grouped-property prefix).
   */
  private parseMemberList(open: Token, what: string, parseOne: (prefix: string[]) => void, prefix: string[]): Token {
    for (;;) {
      const tok = this.peek()
      if (this.isPunct(tok, ";")) {
        this.next()
        continue
      }
      if (this.isPunct(tok, "}")) return this.next()
      if (tok.type === "eof") {
        this.error(
          `expected '}' to close '${what}' (opened at line ${open.start.line}, column ${open.start.column}), found end of file`,
          tok,
        )
      }
      parseOne(prefix)
    }
  }

  /**
   * One member of an object body. `prefix` is non-empty inside a grouped
   * property (`anchors { ... }`), where only bindings and nested groups are allowed.
   */
  private parseMember(obj: ObjectDefinition, prefix: string[]): void {
    const tok = this.peek()
    const inGroup = prefix.length > 0
    if (tok.type !== "identifier") {
      this.error(`unexpected ${describe(tok)}: expected a property binding, declaration or object definition`, tok)
    }
    const n1 = this.peek(1)

    if (!inGroup && n1.type === "identifier") {
      switch (tok.value) {
        case "property":
        case "readonly":
        case "required":
        case "default":
          obj.members.push(this.parsePropertyDeclaration())
          return
        case "signal":
          obj.members.push(this.parseSignal())
          return
        case "function":
          obj.members.push(this.parseFunction())
          return
        case "enum":
          obj.members.push(this.parseEnum())
          return
        case "component":
          this.error("inline components are not supported yet", tok)
      }
    }

    if (tok.value === "id" && this.isPunct(n1, ":")) {
      if (inGroup) this.error("'id' is not allowed inside a grouped property", tok)
      this.next()
      this.next()
      const idTok = this.peek()
      if (idTok.type !== "identifier") this.error(`expected an identifier after 'id:', found ${describe(idTok)}`, idTok)
      if (isUpperStart(idTok.value)) this.error(`id '${idTok.value}' must not start with an uppercase letter`, idTok)
      if (obj.id !== undefined) this.error(`duplicate id: object already has id '${obj.id}'`, tok)
      this.next()
      obj.id = idTok.value
      this.endMember()
      return
    }

    const name = this.parseDottedName("property name")
    const after = this.peek()

    if (this.isPunct(after, ":")) {
      this.next()
      const value = this.parseBindingValue()
      const binding: PropertyBinding = {
        type: "PropertyBinding",
        name: [...prefix, ...name.parts],
        value,
        loc: { start: name.first.start, end: value.loc.end },
      }
      obj.members.push(binding)
      this.endMember()
      return
    }

    if (this.isPunct(after, "{")) {
      const last = name.parts[name.parts.length - 1]
      if (isUpperStart(last)) {
        // Child object: `Rectangle { }`, `Ctrl.Button { }`
        if (inGroup) this.error(`object definitions are not allowed inside grouped property '${prefix.join(".")}'`, name.first)
        obj.members.push(this.parseObjectBody(name.parts.join("."), name.first))
      } else {
        // Grouped property: `anchors { fill: parent }` -> anchors.fill
        const open = this.next()
        const groupPrefix = [...prefix, ...name.parts]
        this.parseMemberList(open, groupPrefix.join("."), (p) => this.parseMember(obj, p), groupPrefix)
      }
      this.endMember()
      return
    }

    if (this.isIdent(after, "on")) {
      this.error(`'${name.parts.join(".")} on <property>' value-source/interceptor syntax is not supported`, after)
    }
    this.error(`expected ':' or '{' after '${name.parts.join(".")}', found ${describe(after)}`, after)
  }

  // -------------------------------------------------------------------------
  // Binding values
  // -------------------------------------------------------------------------

  /** True if tokens at `k` form `Upper(.Ident)* {` — the start of an object definition. */
  private objectStartsAt(k: number): boolean {
    const first = this.peek(k)
    if (first.type !== "identifier" || !isUpperStart(first.value)) return false
    let j = k + 1
    while (this.isPunct(this.peek(j), ".") && this.isIdent(this.peek(j + 1))) j += 2
    return this.isPunct(this.peek(j), "{")
  }

  private parseBindingValue(): BindingValue {
    const tok = this.peek()
    if (this.objectStartsAt(0)) {
      const object = this.parseObjectDefinition()
      const value: ObjectBinding = { type: "ObjectValue", object, loc: object.loc }
      return value
    }
    if (this.isPunct(tok, "[") && this.objectStartsAt(1)) return this.parseArrayBinding()
    if (this.isPunct(tok, "{")) {
      const close = this.skipBalanced()
      const value: ScriptBinding = {
        type: "Script",
        source: this.slice(tok, close),
        isBlock: true,
        loc: this.loc(tok, close),
      }
      return value
    }
    return this.scanExpression()
  }

  /** `[ State { }, State { } ]` */
  private parseArrayBinding(): ArrayBinding {
    const open = this.next()
    const objects: ObjectDefinition[] = []
    for (;;) {
      objects.push(this.parseObjectDefinition())
      const tok = this.peek()
      if (this.isPunct(tok, ",")) {
        this.next()
        if (this.isPunct(this.peek(), "]")) break
        continue
      }
      if (this.isPunct(tok, "]")) break
      this.error(`expected ',' or ']' in object list, found ${describe(tok)}`, tok)
    }
    const close = this.next()
    return { type: "ArrayValue", objects, loc: this.loc(open, close) }
  }

  /**
   * Captures a JavaScript expression (or single statement) as raw source.
   *
   * Tokens are consumed while tracking (), [] and {} nesting (template literals
   * are single tokens, so their `${}` never affect depth). At depth 0 the
   * expression ends:
   * - before `;` (left for `endMember` to consume),
   * - before the `}` closing the enclosing object,
   * - at a line break, unless the expression is obviously unfinished
   *   (see `continuesAcrossNewline`).
   */
  private scanExpression(): ScriptBinding {
    const first = this.peek()
    if (first.type === "eof" || (first.type === "punctuator" && (first.value === ";" || CLOSERS.has(first.value)))) {
      this.error(`expected a value, found ${describe(first)}`, first)
    }
    const startIndex = this.i
    const stack: Token[] = []
    let last = first
    for (;;) {
      const tok = this.peek()
      if (tok.type === "eof") {
        if (stack.length) {
          const open = stack[stack.length - 1]
          this.error(`unterminated '${open.value}': missing '${OPENERS[open.value]}' (opened at line ${open.start.line}, column ${open.start.column})`, open)
        }
        break
      }
      if (stack.length === 0 && tok !== first) {
        if (this.isPunct(tok, ";") || this.isPunct(tok, "}")) break
        if (tok.newlineBefore) {
          if (!this.continuesAcrossNewline(last)) break
        } else if (this.isValueEnd(last) && this.isValueStart(tok)) {
          this.error(`unexpected ${describe(tok)}: expected ';' or newline between members`, tok)
        }
      }
      if (tok.type === "punctuator") {
        if (OPENERS[tok.value]) stack.push(tok)
        else if (CLOSERS.has(tok.value)) this.popMatching(stack, tok)
      }
      last = this.next()
    }
    const source = this.slice(first, last)
    const value: ScriptBinding = { type: "Script", source, isBlock: false, loc: this.loc(first, last) }
    const literal = this.literalOf(first, last, this.i - startIndex)
    if (literal) value.literal = literal
    return value
  }

  /**
   * The newline heuristic. Called at depth 0 when the next token starts a new
   * line; `last` is the final token on the previous line. Returns true if the
   * expression continues onto the next line.
   */
  private continuesAcrossNewline(last: Token): boolean {
    const next = this.peek()
    // 1. The next line unambiguously starts a new QML member: stop, even if the
    //    previous line looks unfinished (it is then a syntax error in the script,
    //    reported by the runtime, instead of swallowing the next member).
    if (this.looksLikeMemberStart()) return false
    // 2. The previous line is obviously unfinished (`a +`, `cond ?`, `(m) =>`).
    if (last.type === "punctuator" && CONTINUES_AFTER_PUNCT.has(last.value)) return true
    if (last.type === "identifier" && CONTINUES_AFTER_KEYWORD.has(last.value)) return true
    // 3. The next line starts with a token that cannot start a member (`.foo()`, `? a`, `&& b`).
    if (next.type === "punctuator" && CONTINUES_BEFORE_PUNCT.has(next.value)) return true
    if (next.type === "identifier" && CONTINUES_BEFORE_KEYWORD.has(next.value)) return true
    return false
  }

  /**
   * Strong member starts only — patterns that are never valid JavaScript at the
   * start of a continuation line. (`name: value` is NOT included because it is
   * ambiguous with a multi-line conditional `cond ?\n a : b`.)
   */
  private looksLikeMemberStart(): boolean {
    const t0 = this.peek()
    const t1 = this.peek(1)
    if (t0.type !== "identifier") return false
    switch (t0.value) {
      case "property":
      case "signal":
      case "enum":
        return t1.type === "identifier"
      case "readonly":
      case "required":
      case "default":
        return this.isIdent(t1, "property")
      case "component":
        return t1.type === "identifier" && this.isPunct(this.peek(2), ":")
      case "id":
        return this.isPunct(t1, ":")
    }
    // `Type {`, `Qualified.Type {` or grouped `anchors {`
    if (KEYWORDS_BEFORE_BRACE.has(t0.value)) return false
    let j = 1
    while (this.isPunct(this.peek(j), ".") && this.isIdent(this.peek(j + 1))) j += 2
    return this.isPunct(this.peek(j), "{")
  }

  /** Token that can end an operand (used for the same-line adjacency check). */
  private isValueEnd(tok: Token): boolean {
    if (tok.type === "number" || tok.type === "string" || tok.type === "template" || tok.type === "regex") return true
    if (tok.type === "identifier") return !NON_VALUE_KEYWORDS.has(tok.value)
    return this.isPunct(tok, "]")
  }

  /** Token that can start an operand (used for the same-line adjacency check). */
  private isValueStart(tok: Token): boolean {
    if (tok.type === "number" || tok.type === "string" || tok.type === "template" || tok.type === "regex") return true
    if (tok.type === "identifier") return !NON_VALUE_KEYWORDS.has(tok.value)
    return false
  }

  /** Literal fast path: the tokens are a single string/number/bool/null, or `-number`. */
  private literalOf(first: Token, last: Token, count: number): ScriptBinding["literal"] {
    if (count === 1) {
      if (first.type === "string") return { value: first.stringValue ?? "" }
      if (first.type === "number" && first.numberValue !== undefined) return { value: first.numberValue }
      if (first.type === "identifier") {
        if (first.value === "true") return { value: true }
        if (first.value === "false") return { value: false }
        if (first.value === "null") return { value: null }
      }
      return undefined
    }
    if (count === 2 && this.isPunct(first, "-") && last.type === "number" && last.numberValue !== undefined) {
      return { value: -last.numberValue }
    }
    return undefined
  }

  // -------------------------------------------------------------------------
  // Declarations
  // -------------------------------------------------------------------------

  /** `[default|readonly|required]* property <type> <name> [: value]` */
  private parsePropertyDeclaration(): PropertyDeclaration {
    const start = this.peek()
    let isDefault = false
    let readonly = false
    let required = false
    for (;;) {
      const tok = this.peek()
      if (this.isIdent(tok, "default")) isDefault = true
      else if (this.isIdent(tok, "readonly")) readonly = true
      else if (this.isIdent(tok, "required")) required = true
      else break
      this.next()
    }
    const kw = this.peek()
    if (!this.isIdent(kw, "property")) this.error(`expected 'property' after '${this.prevToken().value}', found ${describe(kw)}`, kw)
    this.next()
    const type = this.parseTypeName("property type")
    const nameTok = this.expectIdent("property name")
    const decl: PropertyDeclaration = {
      type: "PropertyDeclaration",
      name: nameTok.value,
      propertyType: type.name,
      readonly,
      required,
      isDefault,
      loc: this.loc(start, nameTok),
    }

    if (type.name === "alias") {
      this.expectPunct(":", `after alias property '${nameTok.value}' (an alias needs a target)`)
      const target = this.parseDottedName("alias target (an id or id.property path)")
      if (!this.peek().newlineBefore && !this.isPunct(this.peek(), ";") && !this.isPunct(this.peek(), "}") && this.peek().type !== "eof") {
        this.error(`alias target must be an id or id.property path, found ${describe(this.peek())}`, this.peek())
      }
      decl.aliasTarget = target.parts
      decl.loc = this.loc(start, target.last)
    } else if (this.isPunct(this.peek(), ":")) {
      this.next()
      decl.value = this.parseBindingValue()
      decl.loc = { start: start.start, end: decl.value.loc.end }
    }
    this.endMember()
    return decl
  }

  /** `signal name`, `signal name()`, `signal name(int x, y: int)` */
  private parseSignal(): SignalDeclaration {
    const start = this.next()
    const nameTok = this.expectIdent("signal name")
    let end = nameTok
    const params: SignalDeclaration["params"] = []
    if (this.isPunct(this.peek(), "(")) {
      this.next()
      while (!this.isPunct(this.peek(), ")")) {
        if (this.isPunct(this.peek(1), ":")) {
          // Qt 6 style: `x: int`
          const pName = this.expectIdent("signal parameter name")
          this.next()
          params.push({ name: pName.value, type: this.parseTypeName("signal parameter type").name })
        } else {
          // Qt 5 style: `int x`, or an untyped `x`
          const first = this.parseTypeName("signal parameter")
          if (this.isIdent(this.peek())) params.push({ name: this.next().value, type: first.name })
          else params.push({ name: first.name })
        }
        if (this.isPunct(this.peek(), ",")) this.next()
        else if (!this.isPunct(this.peek(), ")")) this.error(`expected ',' or ')' in signal parameters, found ${describe(this.peek())}`, this.peek())
      }
      end = this.next()
    }
    this.endMember()
    return { type: "SignalDeclaration", name: nameTok.value, params, loc: this.loc(start, end) }
  }

  /** `function name(a, b: int = 1, ...rest): type { body }` */
  private parseFunction(): FunctionDeclaration {
    const start = this.next()
    const nameTok = this.expectIdent("function name")
    this.expectPunct("(", `after function name '${nameTok.value}'`)
    const params: FunctionDeclaration["params"] = []
    while (!this.isPunct(this.peek(), ")")) {
      const tok = this.peek()
      let name: string
      if (this.isPunct(tok, "...")) {
        this.next()
        name = "..." + this.expectIdent("rest parameter name").value
      } else if (this.isPunct(tok, "{") || this.isPunct(tok, "[")) {
        // Destructuring pattern: keep its source as the "name".
        const close = this.skipBalanced()
        name = this.slice(tok, close)
      } else {
        name = this.expectIdent("parameter name").value
      }
      const param: FunctionDeclaration["params"][number] = { name }
      if (this.isPunct(this.peek(), ":")) {
        this.next()
        param.type = this.parseTypeName("parameter type").name
      }
      if (this.isPunct(this.peek(), "=")) {
        this.next()
        param.defaultValue = this.scanUntilParamEnd()
      }
      params.push(param)
      if (this.isPunct(this.peek(), ",")) this.next()
      else if (!this.isPunct(this.peek(), ")")) this.error(`expected ',' or ')' in parameter list, found ${describe(this.peek())}`, this.peek())
    }
    this.next() // )
    let returnType: string | undefined
    if (this.isPunct(this.peek(), ":")) {
      this.next()
      returnType = this.parseTypeName("return type").name
    }
    const open = this.peek()
    if (!this.isPunct(open, "{")) this.error(`expected '{' to start the body of function '${nameTok.value}', found ${describe(open)}`, open)
    const close = this.skipBalanced()
    const decl: FunctionDeclaration = {
      type: "FunctionDeclaration",
      name: nameTok.value,
      params,
      body: this.slice(open, close),
      loc: this.loc(start, close),
    }
    if (returnType !== undefined) decl.returnType = returnType
    this.endMember()
    return decl
  }

  /** Default parameter value: raw source up to `,` or `)` at depth 0. */
  private scanUntilParamEnd(): string {
    const first = this.peek()
    const stack: Token[] = []
    let last: Token | null = null
    for (;;) {
      const tok = this.peek()
      if (tok.type === "eof") this.error("unterminated parameter list", first)
      if (stack.length === 0 && (this.isPunct(tok, ",") || this.isPunct(tok, ")"))) break
      if (tok.type === "punctuator") {
        if (OPENERS[tok.value]) stack.push(tok)
        else if (CLOSERS.has(tok.value)) this.popMatching(stack, tok)
      }
      last = this.next()
    }
    if (!last) this.error("expected a default value after '='", first)
    return this.slice(first, last)
  }

  /** `enum Name { A, B = 2, C }` */
  private parseEnum(): EnumDeclaration {
    const start = this.next()
    const nameTok = this.expectIdent("enum name")
    this.expectPunct("{", `after enum name '${nameTok.value}'`)
    const values: EnumDeclaration["values"] = []
    while (!this.isPunct(this.peek(), "}")) {
      const key = this.expectIdent("enum key")
      const entry: EnumDeclaration["values"][number] = { name: key.value }
      if (this.isPunct(this.peek(), "=")) {
        this.next()
        let sign = 1
        if (this.isPunct(this.peek(), "-")) {
          this.next()
          sign = -1
        }
        const num = this.peek()
        if (num.type !== "number" || num.numberValue === undefined) this.error(`expected a number for enum key '${key.value}', found ${describe(num)}`, num)
        this.next()
        entry.value = sign * num.numberValue
      }
      values.push(entry)
      if (this.isPunct(this.peek(), ",")) this.next()
      else if (!this.isPunct(this.peek(), "}")) this.error(`expected ',' or '}' in enum '${nameTok.value}', found ${describe(this.peek())}`, this.peek())
    }
    const close = this.next()
    this.endMember()
    return { type: "EnumDeclaration", name: nameTok.value, values, loc: this.loc(start, close) }
  }
}
