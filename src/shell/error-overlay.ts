/**
 * `ShellErrorOverlay`: the box the shell host shows on top of the default shell when the user
 * shell failed to load. It is a plain QML document (registered as a document type by
 * `runShell`), so it follows the same rules as any brick: `position: "absolute"` and a high `z`
 * keep it out of the shell's layout, and an `escape` `Shortcut` (checked before the shell's own
 * keys) hides it while it is visible.
 */
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { QmlSyntaxError } from "../parser/ast.ts"
import type { QmlComponent, QmlEngine } from "../runtime/engine.ts"
import { QmlRuntimeError } from "../runtime/expression.ts"
import type { QmlObject } from "../runtime/object.ts"

export const SHELL_ERROR_OVERLAY_TYPE = "ShellErrorOverlay"

export const SHELL_ERROR_OVERLAY_HINT = "Esc to dismiss · Runtime.reload() to retry"

/** QML source of the overlay. Properties: `file`, `line`, `column`, `message`, `hint`. */
export const SHELL_ERROR_OVERLAY_QML = `import OpenTUI

Rectangle {
    id: overlay
    property string file: ""
    property int line: 0
    property int column: 0
    property string message: ""
    property string hint: ${JSON.stringify(SHELL_ERROR_OVERLAY_HINT)}
    readonly property string location: file + (line > 0 ? ":" + line + (column > 0 ? ":" + column : "") : "")

    position: "absolute"
    top: 0
    left: 0
    width: "100%"
    z: 10000
    color: "#1a1b26"
    border.width: 1
    border.color: "#f7768e"
    title: " shell error "
    titleColor: "#f7768e"
    paddingX: 1
    flexDirection: "column"

    Text { text: overlay.location; color: "#e0af68"; font.bold: true; visible: overlay.location !== "" }
    Text { text: overlay.message; color: "#c0caf5"; wrapMode: "word" }
    Text { text: "Showing the default shell. " + overlay.hint; color: "#565f89" }

    Shortcut {
        sequence: "escape"
        priority: 1000000
        enabled: overlay.visible
        onActivated: overlay.visible = false
    }
}
`

/** Where an error happened, for the overlay (`line` / `column` are 0 when unknown). */
export interface ShellErrorLocation {
  file: string
  line: number
  column: number
  message: string
}

/** Split a load error into file, line, column and the bare message. */
export function describeShellError(error: unknown, fallbackFile = ""): ShellErrorLocation {
  if (error instanceof QmlSyntaxError) {
    const prefix = `${error.filename ?? "<qml>"}:${error.position.line}:${error.position.column}: `
    return {
      file: error.filename ?? fallbackFile,
      line: error.position.line,
      column: error.position.column,
      message: error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message,
    }
  }
  const text = error instanceof Error ? error.message : String(error)
  if (error instanceof QmlRuntimeError) {
    const prefix = `${error.filename ?? "<qml>"}:${error.line ?? 0}: `
    return {
      file: error.filename ?? fallbackFile,
      line: error.line ?? 0,
      column: 0,
      message: text.startsWith(prefix) ? text.slice(prefix.length) : text,
    }
  }
  // "path/File.qml:12:3: message", "path/File.qml:12: message", "path/File.qml: message"
  const m = /^(\S+?\.(?:qml|m?js)|qmldir\S*|\S+\/qmldir)(?::(\d+))?(?::(\d+))?:\s+([\s\S]*)$/.exec(text)
  if (m) return { file: m[1]!, line: Number(m[2] ?? 0), column: Number(m[3] ?? 0), message: m[4]! }
  return { file: fallbackFile, line: 0, column: 0, message: text }
}

// A directory without .qml files, so the overlay's own-directory lookup finds nothing.
const OVERLAY_FILENAME = join(dirname(fileURLToPath(import.meta.url)), "ShellErrorOverlay.qml")

const overlayComponents = new WeakMap<QmlEngine, QmlComponent>()

/** Register `ShellErrorOverlay` as a document type on `engine` (idempotent); returns it. */
export function registerShellErrorOverlay(engine: QmlEngine): QmlComponent {
  let component = overlayComponents.get(engine)
  if (!component) {
    component = engine.loadSource(SHELL_ERROR_OVERLAY_QML, OVERLAY_FILENAME)
    overlayComponents.set(engine, component)
    engine.registerDocumentType(SHELL_ERROR_OVERLAY_TYPE, component)
  }
  return component
}

/** Insert an overlay describing `error` as the first child of `root`. */
export function showShellErrorOverlay(engine: QmlEngine, root: QmlObject, error: unknown, file = ""): QmlObject {
  const component = registerShellErrorOverlay(engine)
  const where = describeShellError(error, file)
  return engine.instantiate(component.document.root, {
    component,
    parent: root,
    index: 0,
    initialProperties: { file: where.file, line: where.line, column: where.column, message: where.message },
  })
}
