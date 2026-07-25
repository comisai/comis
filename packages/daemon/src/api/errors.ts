// SPDX-License-Identifier: Apache-2.0
// @allow-throw: Typed RPC error classes — boundary throws caught by rpc-dispatch.ts and reclassified to JSON-RPC error responses.
/**
 * Typed RPC error classes for severity-aware classification in
 * `rpc-dispatch.ts`. The dispatcher uses `instanceof` checks to map these
 * to `{ errorKind, level }` so caller mistakes (precondition violations,
 * validation failures) log at `warn` instead of `error` — keeping the
 * operator's alerting posture meaningful.
 *
 * Throw these instead of bare `Error`: with only bare errors the dispatcher
 * must match on message substrings to pick an errorKind, defaulting all
 * unmatched cases to `error`/`internal` and triggering operator alerts
 * for routine "wrong session state" calls.
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

/**
 * Caller lacks the admin TRUST this control-plane method requires (an operator on a
 * non-admin token, or using the wrong route). This is an EXPECTED
 * authorization denial — NOT an internal/handler fault. `classifyRpcError` maps it to
 * `errorKind:"auth"`, `level:"warn"` so an operator's wrong-trust call (e.g. obs.explain over
 * a non-admin token) does NOT read as a system ERROR / trip operator alerts (the denial itself
 * is correct + the gate still fired; only the LOG classification changes). Throw this typed
 * error rather than a bare `Error("Admin access required …")`, which the dispatcher would
 * mis-classify as internal/error — typed errors are the sanctioned path.
 */
export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}
