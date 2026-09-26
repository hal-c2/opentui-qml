/**
 * QML modules: `qmldir` parsing, module directories and JavaScript resource files.
 *
 * `import A.B.C [version] [as Q]` looks for the directory `A/B/C` under each engine import path
 * (see `QmlEngine.importPaths`). The directory is a module if it contains a `qmldir` file, or if
 * it contains `.qml` files (then every `Foo.qml` is exported as `Foo`).
 *
 * Supported `qmldir` subset:
 *   module A.B.C                      # module identifier (a mismatch with the import is a warning)
 *   TypeName [version] File.qml       # exported type
 *   singleton TypeName [version] File.qml
 *   internal TypeName File.qml        # visible only to documents inside the module directory
 *   Name [version] file.js            # JavaScript resource, exposed as the namespace `Name`
 *   # comment, typeinfo, plugin, optional plugin, classname, prefer, depends, import,
 *   designersupported, linktarget, static, system  → ignored
 *
 * JavaScript files (`import "lib.js" as Lib`, or qmldir JS entries) are evaluated once per
 * engine as a library (`.pragma library` / `.import` lines are ignored); their top-level
 * `function` / `var` / `let` / `const` / `class` declarations become the namespace's members.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { QmlRuntimeError } from "./expression.ts"

export interface QmldirEntry {
  name: string
  /** `"1.0"`; undefined for unversioned / internal entries. */
  version?: string
  /** Path relative to the module directory. */
  file: string
  singleton: boolean
  internal: boolean
  kind: "qml" | "js"
}

export interface Qmldir {
  module?: string
  entries: QmldirEntry[]
}

const IGNORED_DIRECTIVES = new Set([
  "typeinfo",
  "plugin",
  "optional",
  "classname",
  "prefer",
  "depends",
  "import",
  "designersupported",
  "linktarget",
  "static",
  "system",
  "default",
])

/** Parse the text of a `qmldir` file. Unknown lines are reported through `warn`. */
export function parseQmldir(text: string, filename = "qmldir", warn?: (message: string) => void): Qmldir {
  const out: Qmldir = { entries: [] }
  const lines = text.split(/\r?\n/)
  lines.forEach((raw, i) => {
    const line = raw.replace(/#.*$/, "").trim()
    if (!line) return
    const words = line.split(/\s+/)
    const head = words[0]!
    if (head === "module") {
      out.module = words[1]
      return
    }
    if (IGNORED_DIRECTIVES.has(head)) return
    let singleton = false
    let internal = false
    let rest = words
    if (head === "singleton") {
      singleton = true
      rest = words.slice(1)
    } else if (head === "internal") {
      internal = true
      rest = words.slice(1)
    }
    const [name, second, third] = rest
    const file = third ?? second
    const version = third !== undefined ? second : undefined
    if (!name || !file || !/^[A-Za-z_$][\w$]*$/.test(name) || !/\.(qml|m?js)$/.test(file)) {
      warn?.(`${filename}:${i + 1}: unsupported qmldir line "${line}"`)
      return
    }
    out.entries.push({ name, version, file, singleton, internal, kind: file.endsWith(".qml") ? "qml" : "js" })
  })
  return out
}

/** Compare dotted versions (`"1.2"` vs `"1.10"`). Missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number(n) || 0)
  const pb = b.split(".").map((n) => Number(n) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** A module directory (with or without `qmldir`). Created and cached by the engine. */
export class QmlModule {
  /** Module identifier (the `module` line, the import uri, or the directory path). */
  readonly uri: string
  readonly dir: string
  readonly qmldir: Qmldir | null

  constructor(dir: string, uri: string | undefined, warn?: (message: string) => void) {
    this.dir = dir
    const qmldirPath = join(dir, "qmldir")
    this.qmldir = existsSync(qmldirPath) ? parseQmldir(readFileSync(qmldirPath, "utf8"), qmldirPath, warn) : null
    this.uri = this.qmldir?.module ?? uri ?? dir
    if (uri && this.qmldir?.module && this.qmldir.module !== uri) {
      warn?.(`${qmldirPath}: module "${this.qmldir.module}" does not match import "${uri}"`)
    }
  }

  /** True if `file` lives inside this module's directory (internal types are visible to it). */
  contains(file: string | undefined): boolean {
    if (!file) return false
    const rel = relative(this.dir, file)
    return !!rel && !rel.startsWith("..") && !isAbsolute(rel)
  }

  /**
   * The best `qmldir` entry named `name` of the given kind: the highest version not above
   * `version` (when given). Internal entries only for `fromFile` inside the module.
   */
  entry(name: string, kind: "qml" | "js", version?: string, fromFile?: string): QmldirEntry | undefined {
    if (!this.qmldir) return undefined
    let best: QmldirEntry | undefined
    for (const e of this.qmldir.entries) {
      if (e.name !== name || e.kind !== kind) continue
      if (e.internal && !this.contains(fromFile)) continue
      if (version && e.version && compareVersions(e.version, version) > 0) continue
      if (!best || (e.version && (!best.version || compareVersions(e.version, best.version) > 0))) best = e
    }
    return best
  }

  /** Absolute path of an entry's file. */
  pathOf(entry: QmldirEntry): string {
    return resolve(this.dir, entry.file)
  }

  /** Is `path` exported by a `singleton` qmldir entry? */
  isSingletonFile(path: string): boolean {
    return this.qmldir?.entries.some((e) => e.singleton && this.pathOf(e) === path) ?? false
  }

  /** Plain `Name.qml` file in the directory (for modules without qmldir / the own directory). */
  plainFile(name: string): string | undefined {
    if (!/^[A-Z]/.test(name)) return undefined
    const path = join(this.dir, `${name}.qml`)
    return existsSync(path) ? path : undefined
  }
}

/** Does `dir` look like a module directory (a `qmldir` or at least one `.qml` file)? */
export function isModuleDirectory(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false
    if (existsSync(join(dir, "qmldir"))) return true
    return readdirSync(dir).some((f) => f.endsWith(".qml"))
  } catch {
    return false
  }
}

/** Relative directory for a module uri: `A.B.C` → `A/B/C`. */
export function uriToPath(uri: string): string {
  return uri.split(".").join(sep)
}

// -------------------------------------------------------------------------------------------
// JavaScript resources

/**
 * Names declared at the top level of a script (brace depth 0): `function f`, `async function f`,
 * `class C`, `var|let|const a[, b]` (simple identifiers only; destructuring is skipped).
 */
export function topLevelDeclarations(source: string): string[] {
  const names = new Set<string>()
  let depth = 0
  let i = 0
  let code = ""
  // Blank out strings, comments and nested blocks so that only depth-0 code remains.
  while (i < source.length) {
    const c = source[i]!
    const n = source[i + 1]
    if (c === "/" && n === "/") {
      while (i < source.length && source[i] !== "\n") i++
      continue
    }
    if (c === "/" && n === "*") {
      const end = source.indexOf("*/", i + 2)
      i = end < 0 ? source.length : end + 2
      code += " "
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      i++
      while (i < source.length && source[i] !== c) i += source[i] === "\\" ? 2 : 1
      i++
      code += depth === 0 ? '""' : ""
      continue
    }
    if (c === "{" || c === "(" || c === "[") {
      if (depth === 0) code += c
      depth++
    } else if (c === "}" || c === ")" || c === "]") {
      depth = Math.max(0, depth - 1)
      if (depth === 0) code += c
    } else if (depth === 0) code += c
    i++
  }
  for (const m of code.matchAll(/(?:^|[;\n}\s])(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]!)
  for (const m of code.matchAll(/(?:^|[;\n}\s])class\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]!)
  for (const m of code.matchAll(/(?:^|[;\n}\s])(?:var|let|const)\s+([^;\n]*)/g)) {
    // `a = 1, b = 2` (initialisers were reduced to depth-0 text), skip destructuring patterns.
    for (const part of m[1]!.split(",")) {
      const id = /^\s*([A-Za-z_$][\w$]*)\s*(?:=|$)/.exec(part)
      if (id) names.add(id[1]!)
    }
  }
  return [...names]
}

/**
 * Evaluate a JS resource as a library and return its namespace object. `globals` are
 * visible to the script as parameters (`Qt`, `qsTr`, ...).
 */
export function evaluateScript(path: string, globals: Record<string, unknown>): Record<string, unknown> {
  if (!existsSync(path)) throw new QmlRuntimeError(`JavaScript file "${path}" not found`, path)
  const raw = readFileSync(path, "utf8")
  // Drop `.pragma library` / `.import ...` directives (keep the line count for error positions).
  const source = raw.replace(/^[ \t]*\.(pragma|import)\b[^\n]*/gm, "")
  const names = topLevelDeclarations(source)
  const params = Object.keys(globals).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k))
  const body = `${source}\n;return { ${names.map((n) => `get ${n}() { return ${n} }, set ${n}(v) { ${n} = v }`).join(", ")} }\n//# sourceURL=${path}`
  let factory: Function
  try {
    factory = new Function(...params, body)
  } catch (err) {
    throw new QmlRuntimeError(`cannot compile JavaScript file: ${err instanceof Error ? err.message : String(err)}`, path, undefined, {
      cause: err,
    })
  }
  // The namespace's members are live getters/setters into the script's closure.
  return factory(...params.map((p) => globals[p])) as Record<string, unknown>
}
