// SPDX-License-Identifier: Apache-2.0
// @allow-throw: exhaustiveness guard — RequestFinalizer.kind closed union
/**
 * Body-buffering and finalizer dispatch for the MITM broker pipeline.
 *
 * Runs after applyInjections (Step 6) and before net.connect (Step 6.5).
 * Buffers the request body up to MAX_BODY_BYTES; returns null on cap exceed
 * (caller must 413 before opening upstream socket).
 *
 * The awsSigV4 finalizer is currently a tested no-op; real signing is deferred.
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
 * AFTER attaching all listeners to preserve ordering.
 *
 * contentLength: when provided (from the inner request Content-Length header),
 * buffering stops as soon as total bytes >= contentLength, without waiting for
 * socket EOF. Required for HTTP/1.1 keep-alive connections where the client
 * does not close the connection after the request body.
 *
 * contentLength = 0: resolves immediately with an empty Buffer (before
 * resume() is called). This handles GET/HEAD/DELETE/empty-POST on keep-alive
 * connections, where the client never sends a body and never emits EOF.
 *
 * contentLength < 0: treated as absent (invalid); cap + timeout govern.
 *
 * Chunked Transfer-Encoding note: when a client sends Transfer-Encoding:
 * chunked with no Content-Length, bufferBody is called with
 * contentLength = undefined. It then relies on the cap + timeout to settle.
 * The raw chunk-framing bytes are buffered verbatim (not decoded). For the
 * current awsSigV4 no-op this is transparent; a real signing finalizer
 * must decode chunked framing before signing. To avoid this,
 * mitm-broker.ts rejects chunked requests with 411 Length Required when a
 * finalizer is configured.
 *
 * scheduleTimeout: caller-injected timer factory — `(cb, ms) => cancelFn`.
 * Provides a backstop deadline so that an under-filled Content-Length (a
 * client that declares N bytes but sends fewer) does not block forever.
 * On deadline expiry, settle(null) is called, which flows into the existing
 * 413 / timeout fail-closed path in mitm-broker.ts. The cancel function
 * returned by scheduleTimeout is called on any normal settle to prevent
 * the timer from firing after the promise has already resolved. Pass a
 * no-op `(_cb, _ms) => () => {}` in tests that do not exercise the timeout
 * path; pass the TimerPort-backed adaptor in production.
 *
 * Returns the full body Buffer on success, or null if:
 *   - total bytes exceed cap (caller must 413 — do NOT call net.connect)
 *   - timeout deadline fires before body is fully received (fail closed)
 *   - socket emits "error" or "close" before "end" (fail closed)
 */
export function bufferBody(
  innerSocket: net.Socket | tls.TLSSocket,
  bodyPrefix: string,
  cap: number,
  contentLength?: number,
  scheduleTimeout: (cb: () => void, ms: number) => () => void = (_cb, _ms) => () => {},
  timeoutMs = 30_000,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    // Schedule deadline backstop — fires settle(null) if the body never arrives.
    // cancelTimeout is called in settle() to prevent the timer from firing
    // after the promise has already resolved (double-settle is idempotent but
    // unnecessary).
    const cancelTimeout = scheduleTimeout(() => settle(null), timeoutMs);

    function settle(result: Buffer | null): void {
      if (settled) return;
      settled = true;
      cancelTimeout();
      innerSocket.pause();
      innerSocket.off("data", onData);
      innerSocket.off("end", onEnd);
      innerSocket.off("error", onError);
      innerSocket.off("close", onError);
      resolve(result);
    }

    function checkContentLength(): void {
      // contentLength < 0 is invalid — treat as absent (cap+timeout govern).
      if (contentLength !== undefined && contentLength >= 0 && total >= contentLength) {
        settle(Buffer.concat(chunks));
      }
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
      // Seed may already satisfy content-length (e.g. small bodies in one segment)
      checkContentLength();
      if (settled) return;
    }

    // Check content-length unconditionally — handles contentLength=0
    // (GET/HEAD/DELETE on keep-alive) which must resolve immediately without
    // waiting for a socket EOF that never arrives.
    checkContentLength();
    if (settled) return;

    function onData(chunk: Buffer): void {
      total += chunk.length;
      if (total > cap) {
        settle(null);
        return;
      }
      chunks.push(chunk);
      checkContentLength();
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
 * AWS SigV4 finalizer — currently a no-op.
 *
 * Signing is deferred. Logs the deferral at debug level so
 * the skip is observable in operator logs (not silent).
 * Returns body and headers unchanged.
 */
export function runAwsSigV4Finalizer(
  body: Buffer,
  headers: Headers,
  log: ComisLogger,
): FinalizerResult {
  log.debug(
    { step: "finalizer_skipped", hint: "AWS SigV4 request signing is unavailable" },
    "AWS SigV4 finalizer skipped; request was not signed",
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
