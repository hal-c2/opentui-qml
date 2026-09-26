/**
 * `QRCode` — a QR code drawn by `@opentui/qrcode`'s `QRCodeRenderable`. The package is an
 * OPTIONAL dependency: `registerOpenTuiTypes` registers `QRCode` only when it can be loaded, and
 * otherwise registers it as "not available" so a document using it fails with an
 * "install @opentui/qrcode" message.
 *
 * Properties: `text` (aliases `value`, `content`), `errorCorrection` (alias
 * `errorCorrectionLevel`: "L" | "M" | "Q" | "H", or "low" | "medium" | "quartile" | "high"),
 * `color` (alias `foregroundColor`), `backgroundColor`, `quietZone` (modules), `scale`,
 * `fit` ("contain" | "none"), `fallbackText` (alias `fallbackContent`, shown when the code does
 * not fit) and `fallbackColor`, plus every Item property. Methods: `version()`, `moduleCount()`.
 */
import { createRequire } from "node:module"
import type { Renderable } from "@opentui/core"
import type { QmlEngine } from "../runtime/engine.ts"
import { Item, nextRenderableId } from "./visual.ts"

/** The part of `@opentui/qrcode` used here (the package may not be installed, so no type import). */
interface QrCodeModule {
  QRCodeRenderable: new (ctx: unknown, options?: Record<string, unknown>) => Renderable & {
    readonly version: number
    readonly moduleCount: number
  }
}

export const QRCODE_PACKAGE = "@opentui/qrcode"

/** Shown when a document uses `QRCode` without the package. */
export const QRCODE_NOT_AVAILABLE = `install the optional package ${QRCODE_PACKAGE} (bun add ${QRCODE_PACKAGE}) to use QRCode`

let loaded: QrCodeModule | null | undefined

/** Load `@opentui/qrcode` synchronously (memoised). Null when it is not installed. */
export function loadQrCodeModule(): QrCodeModule | null {
  if (loaded !== undefined) return loaded
  try {
    const mod = createRequire(import.meta.url)(QRCODE_PACKAGE) as Partial<QrCodeModule>
    loaded = typeof mod?.QRCodeRenderable === "function" ? (mod as QrCodeModule) : null
  } catch {
    loaded = null
  }
  return loaded
}

const ECL: Record<string, string> = { l: "L", low: "L", m: "M", medium: "M", q: "Q", quartile: "Q", h: "H", high: "H" }

function toErrorCorrection(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined
  return ECL[String(v).toLowerCase()] ?? String(v)
}

export class QRCode extends Item {
  declare readonly renderable: ReturnType<typeof createQrRenderable>

  constructor(engine: QmlEngine, typeName: string) {
    super(engine, typeName)
    this.passthrough("text", { type: "string", target: "content", value: "", map: (v) => (v === null ? "" : String(v)) })
    this.defineAlias("value", this, "text")
    this.defineAlias("content", this, "text")
    this.passthrough("errorCorrection", { type: "var", target: "errorCorrectionLevel", map: toErrorCorrection })
    this.defineAlias("errorCorrectionLevel", this, "errorCorrection")
    this.passthrough("color", { color: true, target: "foregroundColor" })
    this.defineAlias("foregroundColor", this, "color")
    this.passthrough("backgroundColor", { color: true })
    this.passthrough("quietZone", { type: "int" })
    this.passthrough("scale", { type: "int" })
    this.passthrough("fit", { type: "string" })
    this.passthrough("fallbackText", { type: "string", target: "fallbackContent" })
    this.defineAlias("fallbackContent", this, "fallbackText")
    this.passthrough("fallbackColor", { color: true })
    this.defineMethod("version", () => this.renderable.version)
    this.defineMethod("moduleCount", () => this.renderable.moduleCount)
  }

  protected override createRenderable(engine: QmlEngine, typeName: string): Renderable {
    return createQrRenderable(engine, typeName)
  }

  protected override get acceptsVisualChildren(): boolean {
    return false
  }
}

function createQrRenderable(engine: QmlEngine, typeName: string) {
  const mod = loadQrCodeModule()
  if (!mod) throw new Error(`QRCode: ${QRCODE_NOT_AVAILABLE}`)
  return new mod.QRCodeRenderable(engine.renderer, { id: nextRenderableId(typeName) })
}

/** Register `QRCode` when `@opentui/qrcode` is installed, else mark it not available. */
export function registerQrCode(engine: QmlEngine): boolean {
  if (loadQrCodeModule()) {
    engine.registerType("QRCode", QRCode)
    return true
  }
  engine.registerTypeNotAvailable("QRCode", QRCODE_NOT_AVAILABLE)
  return false
}
