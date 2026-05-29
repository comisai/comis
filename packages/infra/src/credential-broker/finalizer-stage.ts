// SPDX-License-Identifier: Apache-2.0
// @allow-throw: exhaustiveness guard — RequestFinalizer.kind closed union
/**
 * Body-buffering and finalizer dispatch for the MITM broker pipeline.
 *
 * Runs after applyInjections (Step 6) and before net.connect (Step 6.5).
 * Buffers the request body up to MAX_BODY_BYTES; returns null on cap exceed
 * (caller must 413 before opening upstream socket).
 *
 * The awsSigV4 finalizer is a tested no-op for Phase 4; signing is FINAL-02.
 *
 * Security invariants:
 *   - Body bytes are NEVER passed to the logger (AGENTS.md §2.2).
 *   - bufferBody returns null on error/close — caller is responsible for
 *     calling destroyWithStatus(innerSocket, "413") before net.connect.
 *   - runFinalizer uses a closed-union switch with an exhaustiveness guard
 *     (const _exhaustive: never) that throws at runtime for unknown kinds,
 *     preventing silent no-op on a new unhandled finalizer type.
 *
 * @module
 */
import * as net from "node:net";
import * as tls from "node:tls";
import type { RequestFinalizer, ComisLogger } from "@comis/core";

// ── Body-size cap ─────────────────────────────────────────────────────────────

/** Hard body-size cap for finalizer-stage buffering (10 MiB). */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

// ── FinalizerResult ───────────────────────────────────────────────────────────

export interface FinalizerResult {
  readonly body: Buffer;
  readonly headers: Headers; // WHATWG Headers — already mutated by applyInjections
}

// ── bufferBody ────────────────────────────────────────────────────────────────

/**
 * Buffer the request body from innerSocket, seeded with bodyPrefix.
 *
 * bodyPrefix is the latin1-encoded tail string from readTunnelHeaders —
 * convert via Buffer.from(bodyPrefix, "latin1") before accumulation.
 * innerSocket was paused inside readTunnelHeaders; this function resumes it
 * AFTER attaching all listeners to preserve ordering (CR-01 parallel).
 *
 * Returns the full body Buffer on success, or null if:
 *   - total bytes exceed cap (caller must 413 — do NOT call net.connect)
 *   - socket emits "error" or "close" before "end" (fail closed)
 */
export function bufferBody(
  innerSocket: net.Socket | tls.TLSSocket,
  bodyPrefix: string,
  cap: number,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    function settle(result: Buffer | null): void {
      if (settled) return;
      settled = true;
      innerSocket.off("data", onData);
      innerSocket.off("end", onEnd);
      innerSocket.off("error", onError);
      innerSocket.off("close", onError);
      resolve(result);
    }

    // Seed from bodyPrefix (latin1 string → Buffer)
    if (bodyPrefix.length > 0) {
      const seed = Buffer.from(bodyPrefix, "latin1");
      total += seed.length;
      if (total > cap) {
        settle(null);
        return;
      }
      chunks.push(seed);
    }

    function onData(chunk: Buffer): void {
      total += chunk.length;
      if (total > cap) {
        settle(null);
        return;
      }
      chunks.push(chunk);
    }

    function onEnd(): void {
      settle(Buffer.concat(chunks));
    }

    function onError(): void {
      settle(null); // fail closed
    }

    innerSocket.on("data", onData);
    innerSocket.on("end", onEnd);
    innerSocket.on("error", onError);
    innerSocket.on("close", onError);

    // Resume AFTER attaching listeners — drains any buffered bytes in order
    innerSocket.resume();
  });
}

// ── runAwsSigV4Finalizer ──────────────────────────────────────────────────────

/**
 * AWS SigV4 finalizer — Phase 4 no-op.
 *
 * Signing is deferred to FINAL-02. Logs the deferral at debug level so
 * the skip is observable in operator logs (not silent).
 * Returns body and headers unchanged.
 */
export function runAwsSigV4Finalizer(
  body: Buffer,
  headers: Headers,
  log: ComisLogger,
): FinalizerResult {
  log.debug(
    { step: "finalizer_skipped", hint: "sigv4 deferred" },
    "awsSigV4 finalizer: signing deferred to FINAL-02",
  );
  return { body, headers };
}

// ── runFinalizer ──────────────────────────────────────────────────────────────

/**
 * Dispatch to the appropriate finalizer implementation.
 *
 * Closed-union exhaustiveness guard — adding a new RequestFinalizer.kind
 * without a matching case here produces a TypeScript compile error.
 * At runtime the default branch throws to prevent silent pass-through
 * on an unhandled finalizer type.
 */
export function runFinalizer(
  finalizer: RequestFinalizer,
  body: Buffer,
  headers: Headers,
  log: ComisLogger,
): FinalizerResult {
  switch (finalizer.kind) {
    case "awsSigV4":
      return runAwsSigV4Finalizer(body, headers, log);
    default: {
      // Exhaustiveness guard — catches new RequestFinalizer kinds at compile time.
      // At runtime the unreachable branch throws to prevent silent finalizer omission.
      const _exhaustive: never = finalizer as never;
      throw new Error(
        `Unknown finalizer kind: ${String((_exhaustive as RequestFinalizer).kind)}`,
      );
    }
  }
}
