// SPDX-License-Identifier: Apache-2.0
// @allow-throw: Typed RPC error classes — boundary throws caught by rpc-dispatch.ts and reclassified to JSON-RPC error responses.
/**
 * Typed RPC error classes for severity-aware classification in
 * `rpc-dispatch.ts`. The dispatcher uses `instanceof` checks to map these
 * to `{ errorKind, level }` so caller mistakes (precondition violations,
 * validation failures) log at `warn` instead of `error` — keeping the
 * operator's alerting posture meaningful.
 *
 * Pre-Fix C, every handler `throw`ed bare `Error` and the dispatcher
 * matched on message substrings to pick an errorKind, defaulting all
 * unmatched cases to `error`/`internal` and triggering operator alerts
 * for routine "wrong session state" calls (see ~/.comis/logs/ analysis).
 *
 * @module
 */

/** Caller violated a precondition (e.g., resource not in expected state). */
export class PreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreconditionError";
  }
}

/** Caller supplied invalid input (shape, type, or value out of range). */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
