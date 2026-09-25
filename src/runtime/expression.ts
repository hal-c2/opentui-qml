/**
 * Compiling QML-embedded JavaScript.
 *
 * Every script is compiled once (cached by source) with `new Function` into:
 *
 * ```js
 * function (__scope, __args) {
 *   with (__scope) { return (function () { "use strict"; <body> }).call(this) }
 * }
 * ```
 *
 * - `__scope` is the scope Proxy from `scope.ts`; identifiers resolve through the QML scope
 *   chain first and fall through to real JS globals when the proxy's `has` returns false.
 * - The outer function must be sloppy for `with`. The body runs in a nested *strict* function
 *   so that assigning to an unknown name throws a ReferenceError instead of silently creating a
 *   global, and so `var` declarations stay local. Lookups still go through the `with` scope.
 * - Expressions: `<body>` is `return (SOURCE\n)`. Blocks: `<body>` is the block itself
 *   (`{ ... }`), so there is no implicit return — only explicit `return` statements yield a
 *   value (QML allows `width: { if (a) return 1; return 2 }`).
 */
import type { FunctionDeclaration, ScriptBinding } from "../parser/ast.ts"
import type { QmlScope } from "./scope.ts"

/** An error thrown while evaluating a QML script; the message is prefixed with `file:line:`. */
export class QmlRuntimeError extends Error {
  constructor(
    message: string,
    public readonly filename?: string,
    public readonly line?: number,
    options?: { cause?: unknown },
  ) {
    super(`${filename ?? "<qml>"}:${line ?? 0}: ${message}`, options)
    this.name = "QmlRuntimeError"
  }
}

export interface CompileOptions {
  /** `{ ... }` block (statements) rather than an expression. Ignored for ScriptBinding input. */
  isBlock?: boolean
  filename?: string
  /** 1-based line of the script start, for error messages. */
  line?: number
}

/** A compiled script, ready to evaluate against any scope. */
export interface CompiledScript {
  readonly source: string
  readonly isBlock: boolean
  readonly filename?: string
  readonly line?: number
  /** Present when the script is a plain literal (fast path, no evaluation needed). */
  readonly literal?: { value: string | number | boolean | null }
  /**
   * Evaluate with `scope` as the `with` target. `thisValue` defaults to `scope.thisValue`.
   * `args` is available to the script as `__args`. Errors are rethrown as `QmlRuntimeError`.
   */
  evaluate(scope: QmlScope, thisValue?: unknown, args?: readonly unknown[]): unknown
}

type RawScript = (this: unknown, scope: object, args: readonly unknown[]) => unknown

/** Compiled functions keyed by kind + source (shared by all objects using the same text). */
const cache = new Map<string, { fn: RawScript; isBlock: boolean }>()

function build(body: string): RawScript {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(
    "__scope",
    "__args",
    `with (__scope) { return (function () { "use strict";\n${body}\n}).call(this) }`,
  ) as RawScript
}

function compileRaw(source: string, isBlock: boolean): { fn: RawScript; isBlock: boolean } {
  const key = (isBlock ? "B:" : "E:") + source
  const hit = cache.get(key)
  if (hit) return hit
  let fn: RawScript
  if (isBlock) {
    fn = build(source)
  } else {
    try {
      fn = build(`return (${source}\n)`)
    } catch (err) {
      // Not a single expression (e.g. `foo(); bar()`): fall back to statements.
      if (!(err instanceof SyntaxError)) throw err
      const block = compileRaw(source, true)
      cache.set(key, block)
      return block
    }
  }
  const entry = { fn, isBlock }
  cache.set(key, entry)
  return entry
}

/**
 * Compile a script. Accepts a parser `ScriptBinding` or raw source text.
 * Throws `QmlRuntimeError` on syntax errors.
 */
export function compileScript(script: ScriptBinding | string, opts: CompileOptions = {}): CompiledScript {
  const source = typeof script === "string" ? script : script.source
  const isBlock = typeof script === "string" ? !!opts.isBlock : script.isBlock
  const literal = typeof script === "string" ? undefined : script.literal
  const filename = opts.filename
  const line = opts.line ?? (typeof script === "string" ? undefined : script.loc?.start.line)

  if (literal !== undefined) {
    const value = literal.value
    return { source, isBlock: false, filename, line, literal, evaluate: () => value }
  }

  let compiled: { fn: RawScript; isBlock: boolean }
  try {
    compiled = compileRaw(source, isBlock)
  } catch (err) {
    throw wrapError(err, filename, line)
  }
  const { fn } = compiled
  return {
    source,
    isBlock: compiled.isBlock,
    filename,
    line,
    evaluate(scope, thisValue, args) {
      try {
        return fn.call(thisValue === undefined ? scope.thisValue : thisValue, scope.proxy, args ?? [])
      } catch (err) {
        throw wrapError(err, filename, line)
      }
    },
  }
}

/**
 * Compile a QML `function name(a, b) { ... }` member. Evaluating the result yields the JS
 * function (a closure over the scope), which the engine installs as a method.
 */
export function compileFunction(decl: FunctionDeclaration, opts: CompileOptions = {}): CompiledScript {
  const params = decl.params
    .map((p) => (p.defaultValue !== undefined ? `${p.name} = ${p.defaultValue}` : p.name))
    .join(", ")
  const source = `function ${decl.name}(${params}) ${decl.body}`
  return compileScript(source, { isBlock: false, filename: opts.filename, line: opts.line ?? decl.loc?.start.line })
}

/** Normalise anything thrown by a script into a `QmlRuntimeError`. */
export function wrapError(err: unknown, filename?: string, line?: number): QmlRuntimeError {
  if (err instanceof QmlRuntimeError) return err
  const message =
    err instanceof Error ? `${err.name && err.name !== "Error" ? `${err.name}: ` : ""}${err.message}` : String(err)
  return new QmlRuntimeError(message, filename, line, { cause: err })
}

/**
 * Turn a compiled handler script into a callable signal handler.
 *
 * - Signal parameters (`signal moved(int x)`) are injected by name into a per-call scope layer,
 *   so `onMoved: console.log(x)` and `onMoved: { console.log(x) }` work.
 * - If an *expression* handler evaluates to a function (`onMoved: function(x) {...}`,
 *   `onMoved: (x) => ...`, or `onMoved: someMethod`), that function is called with the
 *   signal arguments and `this` = the scope object.
 */
export function createHandler(
  compiled: CompiledScript,
  scope: QmlScope,
  params: readonly string[] = [],
): (...args: unknown[]) => unknown {
  return function qmlHandler(...args: unknown[]): unknown {
    let callScope = scope
    if (params.length > 0) {
      const values: Record<string, unknown> = {}
      params.forEach((p, i) => (values[p] = args[i]))
      callScope = scope.extend(values)
    }
    const result = compiled.evaluate(callScope, scope.thisValue, args)
    if (!compiled.isBlock && typeof result === "function") {
      try {
        return (result as (...a: unknown[]) => unknown).apply(scope.thisValue, args)
      } catch (err) {
        throw wrapError(err, compiled.filename, compiled.line)
      }
    }
    return result
  }
}

/** Clear the compiled-function cache (mainly for tests). */
export function clearScriptCache(): void {
  cache.clear()
}
