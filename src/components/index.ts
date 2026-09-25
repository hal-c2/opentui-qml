/**
 * OpenTUI visual component layer: registers every visual type and the keymap types with an
 * engine, and re-exports them for TypeScript use.
 */
import type { QmlEngine } from "../runtime/engine.ts"
import type { QmlObject } from "../runtime/object.ts"
import type { QmlTypeFactory } from "../runtime/types.ts"
import { Item, isVisual } from "./visual.ts"
import { Window } from "./window.ts"
import { Rectangle } from "./rectangle.ts"
import { Column, Grid, Row } from "./layouts.ts"
import { Text } from "./text.ts"
import { TextArea, TextInput } from "./inputs.ts"
import { ListView, TabBar } from "./lists.ts"
import { ScrollView } from "./containers.ts"
import { AsciiText, Code, Markdown } from "./misc.ts"
import { Action, KeyBinding, Keymap, Shortcut } from "./keymap.ts"

/** Every type registered by `registerOpenTuiTypes`, by QML name. */
export const OPENTUI_TYPES: Readonly<Record<string, QmlTypeFactory>> = {
  Item,
  Window,
  ApplicationWindow: Window,
  Rectangle,
  Column,
  ColumnLayout: Column,
  Row,
  RowLayout: Row,
  Grid,
  GridLayout: Grid,
  Text,
  Label: Text,
  TextInput,
  TextField: TextInput,
  TextArea,
  ListView,
  TabBar,
  ScrollView,
  Flickable: ScrollView,
  AsciiText,
  BigText: AsciiText,
  Markdown,
  Code,
  Shortcut,
  Keymap,
  KeyBinding,
  Action,
}

/** Register the OpenTUI visual types and the keymap types (replacing same-named types). */
export function registerOpenTuiTypes(engine: QmlEngine): void {
  for (const [name, factory] of Object.entries(OPENTUI_TYPES)) engine.registerType(name, factory)
}

/** Add a visual root object's renderable to the renderer's root. Returns the object. */
export function mount<T extends QmlObject>(engine: QmlEngine, root: T): T {
  if (!isVisual(root)) throw new TypeError(`${root.describe()} is not a visual object and cannot be mounted`)
  engine.renderer.root.add(root.renderable)
  return root
}

export {
  Item,
  VisualObject,
  coerceDimension,
  isVisual,
  nextRenderableId,
  toColor,
  visualForRenderable,
  visualIndexFor,
} from "./visual.ts"
export type { QmlMouseEvent } from "./visual.ts"
export { Window } from "./window.ts"
export { Rectangle } from "./rectangle.ts"
export { Column, Grid, Row } from "./layouts.ts"
export { TEXT_STATICS, Text, toTextAlign, toWrapMode } from "./text.ts"
export { TextArea, TextInput } from "./inputs.ts"
export { ListView, TabBar, toListOption } from "./lists.ts"
export type { ListOption } from "./lists.ts"
export { ScrollView } from "./containers.ts"
export { AsciiText, Code, Markdown } from "./misc.ts"
export {
  Action,
  KeyBinding,
  Keymap,
  Shortcut,
  applyKeymapOverrides,
  formatKeySequence,
  keyEventMatches,
  normalizeKeyName,
  parseKeySequence,
} from "./keymap.ts"
export type { KeymapEntry, ParsedKeySequence } from "./keymap.ts"
export { KeyDispatcher, keyDispatcherFor, makeQmlKeyEvent } from "./key-dispatcher.ts"
export type { KeyDispatchEntry, QmlKeyEvent } from "./key-dispatcher.ts"
