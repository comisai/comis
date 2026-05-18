// SPDX-License-Identifier: Apache-2.0
/**
 * Pino redact transport.
 *
 * Returns a `Transform` stream that runs `redactSecretsInText` over
 * every chunk emitted by Pino and forwards the result downstream. Pino
 * spawns transports in a worker thread; the function default-export
 * shape is what the Pino transport factory invokes (see Pino's
 * `transport: { target: "<path>" }` resolution: it imports `target`
 * and calls the default export).
 *
 * The transport runs the FREE-FORM REGEX pass — credential bodies that
 * survived structured-field redaction (e.g., embedded inside a `msg`
 * value, a stringified error, or a non-credential-keyed field that
 * happens to contain a Bearer token). Structured-field credential
 * dropping is already handled by the per-line `redact:` config in
 * `packages/infra/src/logging/logger.ts` (via Pino fast-redact) — this
 * transport is the second-line defense for in-text leakage.
 *
 * Pino calls the transport ONCE per process (the worker is long-lived);
 * the returned `Transform` reads JSON lines from stdin and writes
 * filtered JSON lines back. Each chunk is a JSON-encoded log object
 * with a trailing `"\n"`; we redact and re-emit with the trailing
 * newline preserved.
 *
 * The infra-package re-export shim
 * (`packages/infra/src/logging/redact-transport.ts`) is the production
 * resolution path — Pino transports run in a worker that may not have
 * `@comis/observability` reachable in its module graph, but
 * `@comis/infra` is always present at daemon startup.
 *
 * @module
 */

import { Transform, type TransformCallback } from "node:stream";

import { redactSecretsInText } from "./redact-text.js";

/**
 * Pino's transport target signature.
 *
 * Pino invokes the default export with `_opts` (whatever the user
 * passes via `transport.options`); the function must return a
 * Writable / Duplex stream that Pino can pipe log lines into.
 */
export default function pinoRedactTransport(_opts?: unknown): Transform {
  return new Transform({
    transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: TransformCallback) {
      try {
        const input = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        const filtered = redactSecretsInText(input);
        callback(null, filtered);
      } catch (err) {
        // Pino transport invariant: never throw. If redaction itself
        // errors (impossible in pure-function path; only here as a
        // safety net), pass the chunk through unmodified to preserve
        // the log line. The transport must remain a strict Transform —
        // dropping a chunk would silently lose log output.
        callback(null, chunk);
        void err;
      }
    },
  });
}
