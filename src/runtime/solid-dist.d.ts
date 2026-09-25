/**
 * Type declarations for the solid-js *browser* build.
 *
 * `solid-js` ships types only for its package root. The root export resolves to the
 * non-reactive server build under Bun/Node, so the runtime imports
 * `solid-js/dist/solid.js` directly (see `reactive.ts`). The two builds share the same API,
 * so re-export the root types for the dist path.
 */
declare module "solid-js/dist/solid.js" {
  export * from "solid-js"
}
