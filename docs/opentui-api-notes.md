# OpenTUI core API notes (verified against @opentui/core 0.5.12)

Quick reference for the component layer. All renderables are constructed as
`new XRenderable(renderer, { id, ...options })` and every option is also a settable property
afterwards (`box.width = 12`, `text.content = "x"`).

## Tree
- `renderable.add(child, index?)`, `remove(child)`, `insertBefore(child, anchor)`, `getChildren()`, `parent`
- `renderer.root.add(...)`; `renderer.destroy()` exits the alternate screen. Never `process.exit()`.
- `renderable.destroyRecursively()`; `destroy()`
- `renderable.focus()`, `blur()`, `focused`, `focusable` (setter), `renderer.currentFocusedRenderable`
- `renderable.onSizeChange = () => {}`; `renderable.width/height` getters return the laid-out size (numbers), `x`/`y` layout position
- `renderable.onKeyDown = (key: KeyEvent) => void` (fires when focused); `renderer.keyInput.on("keypress", (key: KeyEvent) => {})` global
- `KeyEvent`: `name` ("a", "escape", "up", "down", "left", "right", "return", "tab", "f1"...), `sequence`, `ctrl`, `shift`, `meta`, `option`, `eventType` ("press"|"release"|"repeat"), `preventDefault()`, `stopPropagation()`
- `renderer.on("resize", (w, h) => {})`, `renderer.width`, `renderer.height`, `renderer.themeMode`
- Layout props on every Renderable (settable): width, height (number | "auto" | "50%"), minWidth, maxWidth, minHeight, maxHeight, flexGrow, flexShrink, flexBasis, flexDirection ("row"|"column"|"row-reverse"|"column-reverse"), flexWrap, alignItems, alignSelf, justifyContent, position ("relative"|"absolute"), top/right/bottom/left, margin/marginX/marginY/marginTop/..., padding/paddingX/paddingY/paddingTop/..., overflow ("visible"|"hidden"|"scroll"), zIndex, visible, opacity, translateX, translateY
- Box-only: gap, rowGap, columnGap

## BoxRenderable (Box.d.ts)
backgroundColor, border (boolean | ["top","left",...]), borderStyle ("single"|"double"|"rounded"|"bold"|"heavy"|...), borderColor, focusedBorderColor, title, titleColor, titleAlignment ("left"|"center"|"right"), bottomTitle, bottomTitleAlignment, shouldFill, focusable, customBorderChars

## TextRenderable (Text.d.ts, TextBufferRenderable.d.ts)
content (string | StyledText), fg, bg, attributes (TextAttributes.BOLD|ITALIC|UNDERLINE|DIM|STRIKETHROUGH|INVERSE bitmask), selectable, wrapMode ("none"|"char"|"word"), textAlign ("left"|"center"|"right"), truncate
Styled text: `import { t, bold, fg, underline } from "@opentui/core"`; `t\`${bold("x")}\``

## InputRenderable (Input.d.ts) extends TextareaRenderable
value, placeholder (string), maxLength, minLength, backgroundColor, textColor, focusedBackgroundColor, focusedTextColor, placeholderColor, cursorColor?; events via `input.on(InputRenderableEvents.INPUT, (value) => {})`, `.CHANGE` (committed), `.ENTER` (submit). `focus()` required to type.

## TextareaRenderable
initialValue, `value` get/set (check: uses `.value`? verify with `Object.getOwnPropertyNames`), placeholder, placeholderColor, backgroundColor, textColor, focusedBackgroundColor, wrapMode, onSubmit; events `TextareaRenderableEvents`? (verify export name in renderables/Textarea.d.ts)

## SelectRenderable (Select.d.ts)
options: `{ name, description, value? }[]`, selectedIndex, backgroundColor, textColor, focusedBackgroundColor, focusedTextColor, selectedBackgroundColor, selectedTextColor, descriptionColor, selectedDescriptionColor, showScrollIndicator, wrapSelection, showDescription, showSelectionIndicator, font, itemSpacing, fastScrollStep; methods getSelectedOption(), getSelectedIndex(), setSelectedIndex(i), moveUp(), moveDown(), selectCurrent(); events `SelectRenderableEvents.SELECTION_CHANGED (index, option)`, `.ITEM_SELECTED (index, option)`. Needs `height` to be visible (each item is 1 line, +1 with description? verify).

## TabSelectRenderable (TabSelect.d.ts)
options `{ name, description, value? }[]`, tabWidth, backgroundColor, textColor, focusedBackgroundColor, focusedTextColor, selectedBackgroundColor, selectedTextColor, selectedDescriptionColor, showScrollArrows, showDescription, showUnderline, wrapSelection; setOptions(), setSelectedIndex(); events `TabSelectRenderableEvents.SELECTION_CHANGED/ITEM_SELECTED`

## ScrollBoxRenderable (ScrollBox.d.ts) extends BoxRenderable
`add()` routes children into `.content`; stickyScroll, stickyStart, scrollTop, scrollLeft, scrollBy(delta), scrollTo(pos), scrollX/scrollY (options), viewportCulling, scrollbarOptions; padding applies to content. Focus it to scroll with keys.

## ASCIIFontRenderable
text, font ("tiny"|"block"|"slick"|"shade"|...), color (ColorInput | ColorInput[]), backgroundColor, selectable

## CodeRenderable
content, filetype, wrapMode, conceal, drawUnstyledText, syntaxStyle (needs tree-sitter assets; may be async)

## MarkdownRenderable
content, fg, bg, conceal, wrapMode, borders...

## SliderRenderable
value, min, max, viewPortSize, backgroundColor, foregroundColor, onChange

## Colors
Strings "#rrggbb", "#rgb", CSS names, "transparent" are accepted by all color setters; `RGBA.fromHex`, `parseColor` exported.

## Testing (`@opentui/core/testing`)
```ts
const t = await createTestRenderer({ width: 40, height: 10 })
t.renderer.root.add(...)
await t.renderOnce()          // or t.flush()
t.captureCharFrame()          // string of rows
t.mockInput.pressKey("ARROW_DOWN"); t.mockInput.pressKey("q"); await t.mockInput.typeText("abc"); t.mockInput.pressEnter()
t.resize(80, 24)
t.renderer.destroy()
```
Verified: Box border + title + Text child renders; `text.content = "..."` and `box.width = 12` update on next renderOnce; InputRenderable receives typeText after focus() and emits INPUT events.
