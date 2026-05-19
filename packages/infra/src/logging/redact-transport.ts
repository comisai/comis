// SPDX-License-Identifier: Apache-2.0
/** Pino transport resolution shim (static re-export).
 *
 * The shim exists so logger.ts can pass the stable
 * `@comis/infra/dist/logging/redact-transport.js` path to Pino's transport
 * `target` field. Pino transports run in a worker thread; the `target`
 * string is resolved from the worker's CWD, and the
 * `@comis/infra/dist/logging/redact-transport.js` path is the
 * load-bearing one because the daemon imports `@comis/infra` at startup
 * (its resolution is guaranteed across all install modes: `npm install
 * -g comisai`, Docker, VPS). The factory itself lives in
 * @comis/observability; we re-export statically here (no `createRequire`)
 * so the module graph is cycle-free and TypeScript-visible.
 *
 * A prior implementation used `createRequire(import.meta.url)` to
 * dynamically resolve the factory at module-load time, hiding the static
 * type-graph arrow from `tsc`. That trick was needed when
 * @comis/observability also depended on @comis/infra (for fs-safe
 * primitives), since a static re-export would have introduced a
 * `tsc --build` project-reference cycle. Moving fs-safe out of
 * @comis/infra broke the cycle at the source — @comis/observability no
 * longer needs @comis/infra — so the static re-export is now safe and
 * preferred.
 *
 * Subpath form: the explicit `./dist/redact/pino-redact-transport.js`
 * subpath is used (not the bare `./redact/pino-redact-transport` form)
 * because `packages/observability/package.json` `exports` map only
 * declares the explicit dist-relative key. Verified at runtime via
 * `node -e "import(...)"` from inside `packages/infra/` (the only
 * package that consumes this subpath).
 *
 * @module
 */

export { default } from "@comis/observability/dist/redact/pino-redact-transport.js";
