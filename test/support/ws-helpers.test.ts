// SPDX-License-Identifier: Apache-2.0
/**
 * Unit coverage for `sendJsonRpc` (test/support/ws-helpers.ts) — specifically
 * the mid-request socket-death rejection.
 *
 * `rpcRequest` (and therefore the `tg rpc` keystone) routes
 * through `sendJsonRpc`, so a dropped socket mid-dispatch must surface as a
 * prompt transport error rather than stalling to the full RPC timeout. These
 * tests drive a FAKE WebSocket (an EventTarget with send/close) so the
 * socket-death path is deterministic without a real daemon.
 *
 * Runs under the root vitest config (`test/support/**` is collected there).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { sendJsonRpc } from "./ws-helpers.js";

/**
 * A minimal fake WebSocket: an EventTarget exposing the surface `sendJsonRpc`
 * uses (`addEventListener`/`removeEventListener`/`send`/`close`) plus test
 * hooks to dispatch `message`/`close`/`error` and observe what was sent.
 */
class FakeWebSocket extends EventTarget {
  sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  /** Dispatch a JSON-RPC response as a `message` event (data is JSON-stringified). */
  emitMessage(payload: unknown): void {
    this.dispatchEvent(
      Object.assign(new Event("message"), { data: JSON.stringify(payload) }),
    );
  }

  /** Dispatch a socket `close` (mid-request death). */
  emitClose(): void {
    this.dispatchEvent(new Event("close"));
  }

  /** Dispatch a socket `error`. */
  emitError(): void {
    this.dispatchEvent(new Event("error"));
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("sendJsonRpc — mid-request socket death", () => {
  it("rejects PROMPTLY when the socket closes before the response (not after the full timeout)", async () => {
    const ws = new FakeWebSocket();
    const promise = sendJsonRpc(ws as unknown as WebSocket, "obs.fleet.health", {}, 1, {
      timeoutMs: 30_000,
    });
    // Attach a rejection expectation BEFORE the close so we can assert it settles.
    const settled = expect(promise).rejects.toThrow(/socket|closed|connection/i);
    // The socket dies mid-request — no response will ever arrive.
    ws.emitClose();
    await settled;
  });

  it("rejects PROMPTLY when the socket errors before the response", async () => {
    const ws = new FakeWebSocket();
    const promise = sendJsonRpc(ws as unknown as WebSocket, "config.get", {}, 7, {
      timeoutMs: 30_000,
    });
    const settled = expect(promise).rejects.toThrow(/socket|error|connection/i);
    ws.emitError();
    await settled;
  });

  it("a socket close does NOT wait for the timeout to elapse", async () => {
    vi.useFakeTimers();
    const ws = new FakeWebSocket();
    let rejected = false;
    const promise = sendJsonRpc(ws as unknown as WebSocket, "health", {}, 2, {
      timeoutMs: 30_000,
    }).catch(() => {
      rejected = true;
    });
    // Close the socket but advance the clock only a TINY amount — far less than
    // the 30s timeout. Pre-fix, nothing listens for `close`, so the promise is
    // still pending here. Post-fix, the close listener has already rejected it.
    ws.emitClose();
    await vi.advanceTimersByTimeAsync(10);
    await promise;
    expect(rejected).toBe(true);
  });

  it("still resolves the matching response normally (close listener does not break the happy path)", async () => {
    const ws = new FakeWebSocket();
    const promise = sendJsonRpc(ws as unknown as WebSocket, "obs.explain", {}, 3, {
      timeoutMs: 30_000,
    });
    ws.emitMessage({ jsonrpc: "2.0", id: 3, result: { ok: true } });
    await expect(promise).resolves.toMatchObject({ id: 3, result: { ok: true } });
  });

  it("a close AFTER the response resolved is harmless (no late rejection)", async () => {
    const ws = new FakeWebSocket();
    const promise = sendJsonRpc(ws as unknown as WebSocket, "health", {}, 4, {
      timeoutMs: 30_000,
    });
    ws.emitMessage({ jsonrpc: "2.0", id: 4, result: "pong" });
    await expect(promise).resolves.toMatchObject({ id: 4, result: "pong" });
    // A trailing close (the caller's own ws.close() in rpcRequest's finally)
    // must not throw / reject anything — the listeners were already removed.
    expect(() => ws.emitClose()).not.toThrow();
  });
});
