/**
 * OpenTUI visual component layer: registers every visual type, the rich-text span types, the
 * animation types and the keymap types with an engine, installs the `Screen`, `Easing` and
 * `Animation` globals and the `Keyboard` singleton, and re-exports everything for TypeScript use.
 */
import type { QmlEngine } from "../runtime/engine.ts"
import type { QmlObject } from "../runtime/object.ts"
import type { QmlTypeFactory } from "../runtime/types.ts"
import { Item, isVisual } from "./visual.ts"
import { Window } from "./window.ts"
import { Rectangle } from "./rectangle.ts"
import { Column, Grid, Row } from "./layouts.ts"
import { SPAN_TYPES, Text } from "./text.ts"
import { TextArea, TextInput } from "./inputs.ts"
import { ListView, TabBar } from "./lists.ts"
import { ScrollView } from "./containers.ts"
import { AsciiText, Code, Markdown } from "./misc.ts"
import { Action, KeyBinding, Keymap, Shortcut } from "./keymap.ts"
import { Diff, LineNumbers, ScrollBar, Slider, TextTable } from "./widgets.ts"
import { EmbeddedTerminal, FrameBuffer, Image } from "./graphics.ts"
import { Portal } from "./portal.ts"
import { registerQrCode } from "./qrcode.ts"
import {
  ANIMATION_STATICS,
  EASING_GLOBAL,
  NumberAnimation,
  ParallelAnimation,
  PauseAnimation,
  SequentialAnimation,
  detachTimelineEngine,
} from "./animation.ts"
import { screenFor } from "./screen.ts"
import { destroyKeyboardHost, keyboardFor } from "./keymap-host.ts"

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
  ...SPAN_TYPES,
  Diff,
  LineNumbers,
  LineNumber: LineNumbers,
  TextTable,
  Slider,
  ScrollBar,
  FrameBuffer,
  Canvas: FrameBuffer,
  Image,
  EmbeddedTerminal,
  Terminal: EmbeddedTerminal,
  Portal,
  NumberAnimation,
  PropertyAnimation: NumberAnimation,
  PauseAnimation,
  SequentialAnimation,
  ParallelAnimation,
  Shortcut,
  Keymap,
  KeyBinding,
  Action,
}

const servicesInstalled = new WeakSet<QmlEngine>()

/**
 * Register the OpenTUI visual types and the keymap types (replacing same-named types), and
 * install the `Screen` singleton plus the `Easing` / `Animation` globals, and register the
 * `Keyboard` singleton (created lazily). Destroying the engine also destroys `Screen`, the
 * engine's `@opentui/keymap` Keymap and `Keyboard`, and detaches OpenTUI's timeline engine.
 */
export function registerOpenTuiTypes(engine: QmlEngine): void {
  for (const [name, factory] of Object.entries(OPENTUI_TYPES)) engine.registerType(name, factory)
  // Optional: `QRCode` only when @opentui/qrcode is installed (else a "not available" hint).
  registerQrCode(engine)
  engine.globals.Screen = screenFor(engine).proxy
  engine.globals.Easing = EASING_GLOBAL
  engine.globals.Animation = ANIMATION_STATICS
  engine.registerSingleton("Keyboard", (e: QmlEngine) => keyboardFor(e))
  if (servicesInstalled.has(engine)) return
  servicesInstalled.add(engine)
  engine.onDestroy(() => {
    screenFor(engine).destroy()
    destroyKeyboardHost(engine)
    detachTimelineEngine(engine)
  })
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
export type { QmlMouseEvent, QmlPasteEvent } from "./visual.ts"
export { ScreenObject, screenFor } from "./screen.ts"
export { Diff, LineNumbers, ORIENTATION_STATICS, ScrollBar, Slider, TextTable } from "./widgets.ts"
export { EmbeddedTerminal, FrameBuffer, Image } from "./graphics.ts"
export type { QmlPainter } from "./graphics.ts"
export { Portal } from "./portal.ts"
export { QRCODE_NOT_AVAILABLE, QRCode, loadQrCodeModule, registerQrCode } from "./qrcode.ts"
export {
  ANIMATION_STATICS,
  Animation,
  AnimationGroup,
  EASING_GLOBAL,
  NumberAnimation,
  ParallelAnimation,
  PauseAnimation,
  SequentialAnimation,
  detachTimelineEngine,
  easingFunction,
} from "./animation.ts"
export { Window } from "./window.ts"
export { Rectangle } from "./rectangle.ts"
export { Column, Grid, Row } from "./layouts.ts"
export { SPAN_TYPES, Span, TEXT_STATICS, Text, toTextAlign, toWrapMode } from "./text.ts"
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
export type { KeymapEntry, ParsedKeySequence, QmlCommandEvent } from "./keymap.ts"
export {
  KeyboardHost,
  KeyboardObject,
  destroyKeyboardHost,
  formatKeyParts,
  keyboardFor,
  keyboardHostFor,
  keymapFor,
  toKeymapKeys,
} from "./keymap-host.ts"
export type { ActiveKeyInfo, CommandInfo, QmlKeymap, QmlKeymapLayer } from "./keymap-host.ts"
export { KeyDispatcher, keyDispatcherFor, makeQmlKeyEvent } from "./key-dispatcher.ts"
export type { KeyDispatchEntry, QmlKeyEvent } from "./key-dispatcher.ts"
