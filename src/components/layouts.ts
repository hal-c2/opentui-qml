/**
 * Positioners and layouts, all plain flex Boxes:
 *
 * - `Column` / `ColumnLayout`: `flexDirection: "column"`.
 * - `Row` / `RowLayout`: `flexDirection: "row"`.
 * - `Grid`: `flexDirection: "row"` + `flexWrap: "wrap"` (children flow and wrap; `columns` /
 *   `rows` are accepted but a true grid is not computed: give children a fixed width instead).
 *
 * `spacing` maps to the Box `gap`. `Layout.fillWidth` & co. on children are handled by `Item`.
 */
import type { QmlEngine } from "../runtime/engine.ts"
import { Item } from "./visual.ts"

export class Column extends Item {
  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    this.write("flexDirection", "column")
  }
}

export class Row extends Item {
  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    this.write("flexDirection", "row")
  }
}

export class Grid extends Item {
  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    this.write("flexDirection", "row")
    this.write("flexWrap", "wrap")
    this.defineProperty("columns", { type: "int", value: 0 })
    this.defineProperty("rows", { type: "int", value: 0 })
  }
}
