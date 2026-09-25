/**
 * QML / JavaScript tokenizer.
 *
 * The parser only needs a token stream precise enough to find where QML
 * structure starts and ends and where embedded JavaScript begins and ends; JS
 * itself is never parsed into an AST. Every token carries its exact source
 * range, so the parser can slice raw script text straight out of the source
 * (which keeps comments inside scripts intact).
 *
 * Supported:
 * - identifiers (ASCII, `$`, `_`, Unicode ID_Start / ID_Continue incl. astral code points)
 * - numbers: decimal ints/floats (`1`, `1.5`, `.5`, `1e-3`), hex/octal/binary
 *   (`0xFF`, `0o7`, `0b1`), numeric separators (`1_000`), BigInt suffix (`10n`)
 * - strings in single or double quotes with escapes and line continuations
 * - template literals, including arbitrarily nested `${ ... }` substitutions
 *   (the whole template is ONE token)
 * - line and block comments (skipped; they only affect `newlineBefore`)
 * - all JS punctuators, longest match first (`>>>=`, `...`, `?.`, `??=`, ...)
 * - regular expression literals
 *
 * Known limitation (regex vs. division): like most lightweight JS tokenizers we
 * decide whether `/` starts a regex from the previous token only. After an
 * identifier (other than a keyword such as `return`/`typeof`), a literal, `)`,
 * `]` or `}` it is division; everywhere else it starts a regex. This misreads
 * rare code such as `if (x) /re/.test(s)` or a regex at the start of a
 * statement directly following a block `}`.
 */

import { QmlSyntaxError, type SourcePosition } from "./ast.ts"

export type TokenType = "identifier" | "number" | "string" | "template" | "regex" | "punctuator" | "eof"

export interface Token {
  type: TokenType
  /** Raw source text of the token (empty for EOF). */
  value: string
  start: SourcePosition
  end: SourcePosition
  /** True when at least one line terminator separates this token from the previous one. */
  newlineBefore: boolean
  /** Strings: the cooked value (escapes processed). */
  stringValue?: string
  /** Numbers: the numeric value (undefined for BigInt literals). */
  numberValue?: number
}

/** Punctuators, longest first so the scanner can take the first match. */
const PUNCTUATORS: readonly string[] = [
  ">>>=",
  "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=",
  "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=",
  "&=", "|=", "^=", "**", "<<", ">>",
  "{", "}", "(", ")", "[", "]", ";", ",", "<", ">", "+", "-", "*", "/", "%", "&", "|", "^", "!",
  "~", "?", ":", "=", ".", "@", "#",
]

/** Keywords after which an expression (and thus a regex literal) may follow. */
const KEYWORDS_BEFORE_EXPRESSION = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do",
  "else", "yield", "await",
])

const ID_START = /[\p{ID_Start}$_]/u
const ID_CONTINUE = /[\p{ID_Continue}$‌‍]/u
const UNICODE_SPACE = /\s/u

function isLineTerminator(ch: string): boolean {
  return ch === "\n" || ch === "\r" || ch === " " || ch === " "
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9"
}

/** Maps 0-based offsets to 1-based line/column positions. */
export class LineMap {
  private readonly lineStarts: number[] = [0]
  private readonly bomOffset: number

  constructor(source: string) {
    for (let i = 0; i < source.length; i++) {
      const ch = source[i]
      if (ch === "\r") {
        if (source[i + 1] === "\n") i++
        this.lineStarts.push(i + 1)
      } else if (ch === "\n" || ch === " " || ch === " ") {
        this.lineStarts.push(i + 1)
      }
    }
    // A leading byte-order mark is invisible to humans; don't count it as a column.
    this.bomOffset = source.charCodeAt(0) === 0xfeff ? 1 : 0
  }

  position(offset: number): SourcePosition {
    let lo = 0
    let hi = this.lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.lineStarts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    let column = offset - this.lineStarts[lo] + 1
    if (lo === 0 && this.bomOffset && offset > 0) column -= this.bomOffset
    return { line: lo + 1, column, offset }
  }
}

export class Lexer {
  private pos = 0
  readonly lines: LineMap

  constructor(
    readonly source: string,
    readonly filename?: string,
  ) {
    this.lines = new LineMap(source)
  }

  /** Tokenize the whole source. The returned array always ends with an EOF token. */
  tokenize(): Token[] {
    const tokens: Token[] = []
    let prev: Token | null = null
    for (;;) {
      const tok = this.readToken(prev)
      tokens.push(tok)
      if (tok.type === "eof") return tokens
      prev = tok
    }
  }

  private error(message: string, offset: number): never {
    throw new QmlSyntaxError(message, this.lines.position(offset), this.filename)
  }

  private charAt(i: number): string {
    return this.source[i] ?? ""
  }

  private codePointAt(i: number): string {
    const cp = this.source.codePointAt(i)
    return cp === undefined ? "" : String.fromCodePoint(cp)
  }

  /** Skip whitespace and comments. Returns true if a line terminator was crossed. */
  private skipTrivia(): boolean {
    const src = this.source
    let newline = false
    while (this.pos < src.length) {
      const ch = src[this.pos]
      if (isLineTerminator(ch)) {
        newline = true
        this.pos++
      } else if (ch === " " || ch === "\t" || ch === "\v" || ch === "\f" || ch === "﻿" || ch === " ") {
        this.pos++
      } else if (ch === "/" && src[this.pos + 1] === "/") {
        this.pos += 2
        while (this.pos < src.length && !isLineTerminator(src[this.pos])) this.pos++
      } else if (ch === "/" && src[this.pos + 1] === "*") {
        const start = this.pos
        const end = src.indexOf("*/", this.pos + 2)
        if (end < 0) this.error("unterminated block comment", start)
        for (let i = this.pos + 2; i < end; i++) {
          if (isLineTerminator(src[i])) {
            newline = true
            break
          }
        }
        this.pos = end + 2
      } else if (ch.charCodeAt(0) > 127 && UNICODE_SPACE.test(ch)) {
        this.pos++
      } else {
        break
      }
    }
    return newline
  }

  private make(type: TokenType, start: number, newlineBefore: boolean, extra?: Partial<Token>): Token {
    return {
      type,
      value: this.source.slice(start, this.pos),
      start: this.lines.position(start),
      end: this.lines.position(this.pos),
      newlineBefore,
      ...extra,
    }
  }

  /** Whether a `/` at this point starts a regular expression, judged by the previous token. */
  private static regexAllowedAfter(prev: Token | null): boolean {
    if (!prev) return true
    switch (prev.type) {
      case "number":
      case "string":
      case "template":
      case "regex":
        return false
      case "identifier":
        return KEYWORDS_BEFORE_EXPRESSION.has(prev.value)
      case "punctuator":
        return !(prev.value === ")" || prev.value === "]" || prev.value === "}" || prev.value === "++" || prev.value === "--")
      default:
        return true
    }
  }

  readToken(prev: Token | null): Token {
    const newlineBefore = this.skipTrivia()
    const src = this.source
    const start = this.pos
    if (this.pos >= src.length) return this.make("eof", start, newlineBefore)

    const ch = src[this.pos]

    if (ch === '"' || ch === "'") return this.readString(ch, newlineBefore)
    if (ch === "`") {
      this.readTemplate()
      return this.make("template", start, newlineBefore)
    }
    if (isDigit(ch) || (ch === "." && isDigit(src[this.pos + 1]))) return this.readNumber(newlineBefore)

    const cp = this.codePointAt(this.pos)
    if (ID_START.test(cp)) {
      this.pos += cp.length
      for (;;) {
        const c = this.codePointAt(this.pos)
        if (c && ID_CONTINUE.test(c)) this.pos += c.length
        else break
      }
      return this.make("identifier", start, newlineBefore)
    }

    if (ch === "/" && Lexer.regexAllowedAfter(prev)) return this.readRegex(newlineBefore)

    for (const p of PUNCTUATORS) {
      if (src.startsWith(p, this.pos)) {
        // `a?.5:1` is a conditional, not optional chaining.
        if (p === "?." && isDigit(src[this.pos + 2])) continue
        this.pos += p.length
        return this.make("punctuator", start, newlineBefore)
      }
    }

    this.error(`unexpected character ${JSON.stringify(cp)}`, start)
  }

  private readString(quote: string, newlineBefore: boolean): Token {
    const src = this.source
    const start = this.pos
    this.pos++
    let cooked = ""
    for (;;) {
      if (this.pos >= src.length) this.error("unterminated string literal", start)
      const ch = src[this.pos]
      if (ch === quote) {
        this.pos++
        break
      }
      if (ch === "\n" || ch === "\r") this.error("unterminated string literal", start)
      if (ch === "\\") {
        cooked += this.readEscape(start)
        continue
      }
      cooked += ch
      this.pos++
    }
    return this.make("string", start, newlineBefore, { stringValue: cooked })
  }

  /** Reads an escape sequence starting at the backslash; returns its cooked value. */
  private readEscape(literalStart: number): string {
    const src = this.source
    this.pos++ // backslash
    if (this.pos >= src.length) this.error("unterminated string literal", literalStart)
    const ch = src[this.pos]
    this.pos++
    switch (ch) {
      case "n":
        return "\n"
      case "t":
        return "\t"
      case "r":
        return "\r"
      case "b":
        return "\b"
      case "f":
        return "\f"
      case "v":
        return "\v"
      case "0":
        return "\0" // legacy octal escapes (`\012`) are not supported; only `\0`
      case "\r":
        if (src[this.pos] === "\n") this.pos++
        return ""
      case "\n":
      case " ":
      case " ":
        return "" // line continuation
      case "x": {
        const hex = src.slice(this.pos, this.pos + 2)
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) this.error("invalid hexadecimal escape sequence", this.pos - 2)
        this.pos += 2
        return String.fromCharCode(parseInt(hex, 16))
      }
      case "u": {
        if (src[this.pos] === "{") {
          const close = src.indexOf("}", this.pos)
          const hex = close < 0 ? "" : src.slice(this.pos + 1, close)
          if (!/^[0-9a-fA-F]{1,6}$/.test(hex) || parseInt(hex, 16) > 0x10ffff)
            this.error("invalid Unicode escape sequence", this.pos - 2)
          this.pos = close + 1
          return String.fromCodePoint(parseInt(hex, 16))
        }
        const hex = src.slice(this.pos, this.pos + 4)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.error("invalid Unicode escape sequence", this.pos - 2)
        this.pos += 4
        return String.fromCharCode(parseInt(hex, 16))
      }
      default:
        return ch
    }
  }

  /**
   * Scans a template literal starting at the backtick. Substitutions are
   * tokenized recursively (so strings, comments, regexes and nested templates
   * inside `${ ... }` are handled), tracking brace depth to find the `}` that
   * resumes the template.
   */
  private readTemplate(): void {
    const src = this.source
    const start = this.pos
    this.pos++ // backtick
    for (;;) {
      if (this.pos >= src.length) this.error("unterminated template literal", start)
      const ch = src[this.pos]
      if (ch === "`") {
        this.pos++
        return
      }
      if (ch === "\\") {
        this.pos += 2
        continue
      }
      if (ch === "$" && src[this.pos + 1] === "{") {
        this.pos += 2
        let depth = 0
        let prev: Token | null = null
        for (;;) {
          const tok = this.readToken(prev)
          if (tok.type === "eof") this.error("unterminated template literal", start)
          if (tok.type === "punctuator") {
            if (tok.value === "{") depth++
            else if (tok.value === "}") {
              if (depth === 0) break
              depth--
            }
          }
          prev = tok
        }
        continue
      }
      this.pos++
    }
  }

  private readNumber(newlineBefore: boolean): Token {
    const src = this.source
    const start = this.pos
    const digitsWhile = (re: RegExp) => {
      while (this.pos < src.length && re.test(src[this.pos])) this.pos++
    }
    let isBigInt = false
    const prefix = src.slice(this.pos, this.pos + 2).toLowerCase()
    if (prefix === "0x" || prefix === "0o" || prefix === "0b") {
      this.pos += 2
      const re = prefix === "0x" ? /[0-9a-fA-F_]/ : prefix === "0o" ? /[0-7_]/ : /[01_]/
      const digitsStart = this.pos
      digitsWhile(re)
      if (this.pos === digitsStart) this.error("invalid number literal", start)
    } else {
      digitsWhile(/[0-9_]/)
      if (src[this.pos] === ".") {
        this.pos++
        digitsWhile(/[0-9_]/)
      }
      if (src[this.pos] === "e" || src[this.pos] === "E") {
        const save = this.pos
        this.pos++
        if (src[this.pos] === "+" || src[this.pos] === "-") this.pos++
        if (isDigit(src[this.pos])) digitsWhile(/[0-9_]/)
        else this.pos = save
      }
    }
    if (src[this.pos] === "n") {
      isBigInt = true
      this.pos++
    }
    const next = this.codePointAt(this.pos)
    if (next && (ID_START.test(next) || isDigit(next))) {
      this.error("identifier starts immediately after numeric literal", this.pos)
    }
    const text = src.slice(start, this.pos)
    const numberValue = isBigInt ? undefined : Number(text.replace(/_/g, ""))
    return this.make("number", start, newlineBefore, { numberValue })
  }

  private readRegex(newlineBefore: boolean): Token {
    const src = this.source
    const start = this.pos
    this.pos++ // opening slash
    let inClass = false
    for (;;) {
      if (this.pos >= src.length || isLineTerminator(src[this.pos])) {
        this.error("unterminated regular expression literal", start)
      }
      const ch = src[this.pos]
      if (ch === "\\") {
        this.pos += 2
        continue
      }
      if (ch === "[") inClass = true
      else if (ch === "]") inClass = false
      else if (ch === "/" && !inClass) {
        this.pos++
        break
      }
      this.pos++
    }
    for (;;) {
      const c = this.codePointAt(this.pos)
      if (c && ID_CONTINUE.test(c)) this.pos += c.length
      else break
    }
    return this.make("regex", start, newlineBefore)
  }
}

/** Tokenize QML source. Throws `QmlSyntaxError` on lexical errors. */
export function tokenize(source: string, filename?: string): Token[] {
  return new Lexer(source, filename).tokenize()
}
