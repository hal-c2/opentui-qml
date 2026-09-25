/**
 * Thin wrapper over the solid-js reactive core.
 *
 * IMPORTANT: `import "solid-js"` resolves to solid's *server* build in Bun/Node, which is
 * non-reactive (signals never notify). We import the browser build explicitly, exactly like
 * `@opentui/solid` does. Every other runtime module must import reactivity from here so the
 * quirk lives in one place.
 */
export {
  batch,
  createComputed,
  createMemo,
  createRoot,
  createSignal,
  getOwner,
  onCleanup,
  runWithOwner,
  untrack,
} from "solid-js/dist/solid.js"

export type { Accessor, Owner, Setter, Signal } from "solid-js/dist/solid.js"
