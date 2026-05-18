// SPDX-License-Identifier: Apache-2.0
/**
 * Pino transport resolution shim.
 *
 * Pino transports run in a worker thread; the `target` string in
 * `transport: { target: "<path>" }` is resolved from the worker's CWD.
 * In production tarballs built by `packages/comis/scripts/prepack.js`,
 * `@comis/observability` is bundled via `bundledDependencies` inside
 * `node_modules/@comis/observability/dist/redact/`; that path is not
 * guaranteed to resolve from the daemon's runtime CWD in every install
 * mode (`npm install -g comisai`, Docker, VPS).
 *
 * `@comis/infra/dist/logging/redact-transport.js` IS always reachable
 * because the daemon imports `@comis/infra` at startup — its resolution
 * is the load-bearing one. This shim re-exports the default function
 * from `@comis/observability` so logger.ts can pass the stable
 * `@comis/infra/dist/logging/redact-transport.js` path to Pino's
 * transport `target` config.
 *
 * Research §3.3 mitigation. See the design header in
 * `packages/observability/src/redact/pino-redact-transport.ts`.
 *
 * **Build-cycle note:** `@comis/observability` depends on `@comis/infra`
 * (for `appendRegularFile`), so a static type-import here would create a
 * project-reference cycle (`tsc --build` can't order them). The shim
 * uses a dynamic require via `createRequire(import.meta.url)` so the
 * type-only dependency is broken — TS only needs the
 * `node:stream.Transform` declaration at compile time, and the runtime
 * resolution happens via Node's normal package resolution when the
 * Pino worker thread loads this file.
 *
 * @module
 */

import { createRequire } from "node:module";
import type { Transform } from "node:stream";

const require_ = createRequire(import.meta.url);

/** Pino transport factory contract (same shape pino-redact-transport.ts exports). */
type PinoRedactTransportFactory = (opts?: unknown) => Transform;

/**
 * Default export — invoked by Pino's transport loader.
 *
 * Re-exports the `@comis/observability/dist/redact/pino-redact-transport.js`
 * default function. Resolved at module-load time (not at every call) so
 * Pino sees a stable callable shape.
 */
const factory: PinoRedactTransportFactory = (
  require_(
    "@comis/observability/dist/redact/pino-redact-transport.js",
  ) as { default: PinoRedactTransportFactory }
).default;

export default factory;
