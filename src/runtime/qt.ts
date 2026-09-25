/**
 * The `Qt` global object and color helpers.
 */
import { QtBinding } from "./object.ts"
import type { QmlEngine } from "./engine.ts"

export { QtBinding }

export interface QtGlobal {
  /** `x = Qt.binding(() => a + b)` re-establishes a binding when assigned. */
  binding(fn: () => unknown): QtBinding
  /** Quit the app: destroys the renderer (never calls process.exit). */
  quit(): void
  /** Call `fn(...args)` once, later (deduplicated per function until it runs). */
  callLater(fn: (...args: unknown[]) => unknown, ...args: unknown[]): void
  /** Color from 0..1 components → `"#rrggbbaa"`. */
  rgba(r: number, g: number, b: number, a?: number): string
  /** Color from 0..1 hue/saturation/lightness/alpha → `"#rrggbbaa"`. */
  hsla(h: number, s: number, l: number, a?: number): string
  hsva(h: number, s: number, v: number, a?: number): string
  /** Darker color (HSV value divided by `factor`, default 2). */
  darker(color: unknown, factor?: number): string
  /** Lighter color (HSV value multiplied by `factor`, default 1.5). */
  lighter(color: unknown, factor?: number): string
  /** Overlay `tint` on `base` using the tint's alpha (`base * (1 - a) + tint * a`); returns `"#rrggbbaa"`. */
  tint(base: unknown, tint: unknown): string
  colorEqual(a: unknown, b: unknown): boolean
  /** Basic Qt date formatting (`yyyy MM dd hh mm ss zzz AP`). */
  formatDateTime(date: unknown, format?: string): string
  formatDate(date: unknown, format?: string): string
  formatTime(date: unknown, format?: string): string
  point(x: number, y: number): { x: number; y: number }
  size(width: number, height: number): { width: number; height: number }
  rect(x: number, y: number, width: number, height: number): { x: number; y: number; width: number; height: number }
  platform: { os: string }
  [key: string]: unknown
}

/** Create the `Qt` global bound to an engine (for `quit`, `callLater`'s scheduler). */
export function createQtGlobal(engine: QmlEngine): QtGlobal {
  const pending = new Map<Function, unknown[]>()
  let scheduled = false
  const flush = (): void => {
    scheduled = false
    const calls = [...pending]
    pending.clear()
    for (const [fn, args] of calls) {
      try {
        fn(...args)
      } catch (err) {
        engine.reportError(err, "Qt.callLater")
      }
    }
  }

  const qt: QtGlobal = {
    binding: (fn) => {
      if (typeof fn !== "function") throw new TypeError("Qt.binding(): argument must be a function")
      return new QtBinding(fn)
    },
    quit: () => {
      const renderer = engine.renderer as { destroy?: () => void } | undefined
      renderer?.destroy?.()
    },
    callLater: (fn, ...args) => {
      if (typeof fn !== "function") throw new TypeError("Qt.callLater(): argument must be a function")
      pending.set(fn, args)
      if (!scheduled) {
        scheduled = true
        engine.scheduler.setTimeout(flush, 0)
      }
    },
    rgba: (r, g, b, a = 1) => toHex({ r, g, b, a }),
    hsla: (h, s, l, a = 1) => toHex({ ...hslToRgb(h, s, l), a }),
    hsva: (h, s, v, a = 1) => toHex({ ...hsvToRgb(h, s, v), a }),
    darker: (color, factor = 2) => {
      const c = parseColorValue(color)
      if (!c) return String(color)
      const hsv = rgbToHsv(c)
      return toHex({ ...hsvToRgb(hsv.h, hsv.s, hsv.v / (factor > 0 ? factor : 1)), a: c.a })
    },
    lighter: (color, factor = 1.5) => {
      const c = parseColorValue(color)
      if (!c) return String(color)
      const hsv = rgbToHsv(c)
      let v = hsv.v * factor
      let s = hsv.s
      if (v > 1) {
        s = Math.max(0, s - (v - 1))
        v = 1
      }
      return toHex({ ...hsvToRgb(hsv.h, s, v), a: c.a })
    },
    tint: (base, tint) => {
      const b = parseColorValue(base)
      const t = parseColorValue(tint)
      if (!b || !t) return String(base)
      const mix = (x: number, y: number): number => x * (1 - t.a) + y * t.a
      return toHex({ r: mix(b.r, t.r), g: mix(b.g, t.g), b: mix(b.b, t.b), a: b.a })
    },
    colorEqual: (a, b) => {
      const x = parseColorValue(a)
      const y = parseColorValue(b)
      return !!x && !!y && toHex(x) === toHex(y)
    },
    formatDateTime: (date, format = "yyyy-MM-dd hh:mm:ss") => formatDate(date, format),
    formatDate: (date, format = "yyyy-MM-dd") => formatDate(date, format),
    formatTime: (date, format = "hh:mm:ss") => formatDate(date, format),
    point: (x, y) => ({ x, y }),
    size: (width, height) => ({ width, height }),
    rect: (x, y, width, height) => ({ x, y, width, height }),
    platform: { os: "tui" },
    // Alignment enums (string-valued; visual components interpret them).
    AlignLeft: "AlignLeft",
    AlignRight: "AlignRight",
    AlignHCenter: "AlignHCenter",
    AlignJustify: "AlignJustify",
    AlignTop: "AlignTop",
    AlignBottom: "AlignBottom",
    AlignVCenter: "AlignVCenter",
    AlignCenter: "AlignCenter",
    Horizontal: "Horizontal",
    Vertical: "Vertical",
  }
  return qt
}

// -------------------------------------------------------------------------------------------
// Colors (components in 0..1)

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

const NAMED_COLORS: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  lime: "#00ff00",
  blue: "#0000ff",
  yellow: "#ffff00",
  cyan: "#00ffff",
  aqua: "#00ffff",
  magenta: "#ff00ff",
  fuchsia: "#ff00ff",
  gray: "#808080",
  grey: "#808080",
  darkgray: "#a9a9a9",
  darkgrey: "#a9a9a9",
  lightgray: "#d3d3d3",
  lightgrey: "#d3d3d3",
  silver: "#c0c0c0",
  maroon: "#800000",
  olive: "#808000",
  navy: "#000080",
  purple: "#800080",
  teal: "#008080",
  orange: "#ffa500",
  pink: "#ffc0cb",
  brown: "#a52a2a",
  gold: "#ffd700",
  indigo: "#4b0082",
  violet: "#ee82ee",
  steelblue: "#4682b4",
  skyblue: "#87ceeb",
  darkblue: "#00008b",
  darkgreen: "#006400",
  darkred: "#8b0000",
  lightblue: "#add8e6",
  lightgreen: "#90ee90",
  coral: "#ff7f50",
  salmon: "#fa8072",
  tomato: "#ff6347",
  crimson: "#dc143c",
  khaki: "#f0e68c",
  beige: "#f5f5dc",
  ivory: "#fffff0",
  lavender: "#e6e6fa",
  turquoise: "#40e0d0",
  tan: "#d2b48c",
  chocolate: "#d2691e",
  orchid: "#da70d6",
  plum: "#dda0dd",
  slategray: "#708090",
  slategrey: "#708090",
  dimgray: "#696969",
  dimgrey: "#696969",
  transparent: "#00000000",
}

/**
 * Parse `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, CSS color names, or an RGBA-like object
 * (`{ r, g, b, a }` with 0..1 floats, as OpenTUI's RGBA). Returns null if unparseable.
 */
export function parseColorValue(value: unknown): Rgba | null {
  if (value && typeof value === "object") {
    const o = value as Partial<Rgba>
    if (typeof o.r === "number" && typeof o.g === "number" && typeof o.b === "number") {
      return { r: o.r, g: o.g, b: o.b, a: typeof o.a === "number" ? o.a : 1 }
    }
    return null
  }
  if (typeof value !== "string") return null
  let s = value.trim().toLowerCase()
  if (NAMED_COLORS[s]) s = NAMED_COLORS[s]!
  const m = /^#([0-9a-f]{3,8})$/.exec(s)
  if (!m) return null
  let hex = m[1]!
  if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join("")
  if (hex.length !== 6 && hex.length !== 8) return null
  const n = (i: number): number => parseInt(hex.slice(i, i + 2), 16) / 255
  return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) : 1 }
}

/** `"#rrggbbaa"` for any color value. */
export function toHex(c: Rgba): string {
  const h = (x: number): string =>
    Math.round(Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0)) * 255)
      .toString(16)
      .padStart(2, "0")
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${h(c.a)}`
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  h = ((h % 1) + 1) % 1
  if (s === 0) return { r: l, g: l, b: l }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hue = (t: number): number => {
    t = ((t % 1) + 1) % 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return { r: hue(h + 1 / 3), g: hue(h), b: hue(h - 1 / 3) }
}

function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  h = ((h % 1) + 1) % 1
  const i = Math.floor(h * 6)
  const f = h * 6 - i
  const p = v * (1 - s)
  const q = v * (1 - f * s)
  const t = v * (1 - (1 - f) * s)
  switch (i % 6) {
    case 0:
      return { r: v, g: t, b: p }
    case 1:
      return { r: q, g: v, b: p }
    case 2:
      return { r: p, g: v, b: t }
    case 3:
      return { r: p, g: q, b: v }
    case 4:
      return { r: t, g: p, b: v }
    default:
      return { r: v, g: p, b: q }
  }
}

function rgbToHsv(c: Rgba): { h: number; s: number; v: number } {
  const max = Math.max(c.r, c.g, c.b)
  const min = Math.min(c.r, c.g, c.b)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === c.r) h = ((c.g - c.b) / d) % 6
    else if (max === c.g) h = (c.b - c.r) / d + 2
    else h = (c.r - c.g) / d + 4
    h /= 6
  }
  return { h: (h + 1) % 1, s: max === 0 ? 0 : d / max, v: max }
}

// -------------------------------------------------------------------------------------------
// Dates

function formatDate(value: unknown, format: string): string {
  const d = value instanceof Date ? value : new Date(value as string | number)
  if (Number.isNaN(d.getTime())) return ""
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0")
  const hasAp = /ap/i.test(format)
  const hours12 = d.getHours() % 12 === 0 ? 12 : d.getHours() % 12
  const tokens: Record<string, () => string> = {
    yyyy: () => String(d.getFullYear()),
    yy: () => pad(d.getFullYear() % 100),
    MMMM: () => d.toLocaleString("en", { month: "long" }),
    MMM: () => d.toLocaleString("en", { month: "short" }),
    MM: () => pad(d.getMonth() + 1),
    M: () => String(d.getMonth() + 1),
    dddd: () => d.toLocaleString("en", { weekday: "long" }),
    ddd: () => d.toLocaleString("en", { weekday: "short" }),
    dd: () => pad(d.getDate()),
    d: () => String(d.getDate()),
    hh: () => pad(hasAp ? hours12 : d.getHours()),
    h: () => String(hasAp ? hours12 : d.getHours()),
    HH: () => pad(d.getHours()),
    H: () => String(d.getHours()),
    mm: () => pad(d.getMinutes()),
    m: () => String(d.getMinutes()),
    ss: () => pad(d.getSeconds()),
    s: () => String(d.getSeconds()),
    zzz: () => pad(d.getMilliseconds(), 3),
    z: () => String(d.getMilliseconds()),
    AP: () => (d.getHours() < 12 ? "AM" : "PM"),
    ap: () => (d.getHours() < 12 ? "am" : "pm"),
  }
  const re = /'([^']*)'|yyyy|yy|MMMM|MMM|MM|M|dddd|ddd|dd|d|hh|h|HH|H|mm|m|ss|s|zzz|z|AP|ap/g
  return format.replace(re, (match, quoted: string | undefined) =>
    quoted !== undefined ? quoted : (tokens[match]?.() ?? match),
  )
}
