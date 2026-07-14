// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for finalizer-stage.
 *
 * Covers: bufferBody (cap, bodyPrefix fold, error paths),
 *         bufferBody (contentLength-guided stop),
 *         runFinalizer (awsSigV4 dispatch + exhaustiveness guard),
 *         runAwsSigV4Finalizer (no-op + deferral log).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { bufferBody, runFinalizer, runAwsSigV4Finalizer, MAX_BODY_BYTES } from "./finalizer-stage.js";
import { makeMockLogger } from "../../../../test/support/mock-logger.js";
import type { RequestFinalizer } from "@comis/core";

// ── Socket mock ────────────────────────────────────────────────────────────────

/** Create a minimal socket-like EventEmitter for bufferBody tests. */
function makeSocketMock(): EventEmitter & { resume(): this; pause(): this } {
  const ee = new EventEmitter() as EventEmitter & { resume(): this; pause(): this };
  ee.resume = function () { return this; };
  ee.pause = function () { return this; };
  return ee;
}

// ── Fake scheduleTimeout for deterministic timeout tests ──────────────────────

/**
 * A fake scheduleTimeout that returns a controller with `fire()` and a cancel.
 * Pass `fst.scheduleTimeout` to bufferBody; call `fst.fire()` to trigger timeout.
 */
function makeFakeScheduleTimeout(): {
  scheduleTimeout: (cb: () => void, _ms: number) => () => void;
  fire(): void;
} {
  let _cb: (() => void) | null = null;
  let _cancelled = false;
  return {
    scheduleTimeout: (cb) => {
      _cb = cb;
      return () => { _cancelled = true; };
    },
    fire() {
      if (!_cancelled && _cb) _cb();
    },
  };
}

/** A no-op scheduleTimeout that never fires — used for tests that settle normally. */
function noopScheduleTimeout(_cb: () => void, _ms: number): () => void {
  return () => {};
}

// ── cap-exceeded path ─────────────────────────────────────────────────────────

describe("bufferBody: cap-exceeded path returns null", () => {
  it("resolves null when a single data chunk exceeds the cap", async () => {
    const socket = makeSocketMock();
    const promise = bufferBody(socket as never, "", 10, undefined, noopScheduleTimeout);
    // Emit a single chunk larger than cap=10
    socket.emit("data", Buffer.allocUnsafe(11));
    const result = await promise;
    expect(result).toBeNull();
  });

  it("resolves null immediately when bodyPrefix alone exceeds cap", async () => {
    const socket = makeSocketMock();
    // bodyPrefix of 6 bytes, cap=5
    const promise = bufferBody(socket as never, "hello!", 5, undefined, noopScheduleTimeout);
    const result = await promise;
    expect(result).toBeNull();
  });

  it("resolves null when cumulative chunks exceed cap", async () => {
    const socket = makeSocketMock();
    const promise = bufferBody(socket as never, "", 10, undefined, noopScheduleTimeout);
    // Two 6-byte chunks: total 12 > cap 10
    socket.emit("data", Buffer.from("abcdef"));
    socket.emit("data", Buffer.from("ghijkl"));
    const result = await promise;
    expect(result).toBeNull();
  });
});

// ── bodyPrefix fold and normal completion ─────────────────────────────────────

describe("bufferBody: bodyPrefix fold and normal completion", () => {
  it("folds bodyPrefix + data chunk into a single Buffer on success", async () => {
    const socket = makeSocketMock();
    // "hello" (5 bytes) + "world" (5 bytes) = 10 bytes, cap=100
    const promise = bufferBody(socket as never, "hello", 100, undefined, noopScheduleTimeout);
    socket.emit("data", Buffer.from("world"));
    socket.emit("end");
    const result = await promise;
    expect(result).not.toBeNull();
    expect(result!.equals(Buffer.from("helloworld"))).toBe(true);
  });

  it("concatenates two chunks with no bodyPrefix", async () => {
    const socket = makeSocketMock();
    const promise = bufferBody(socket as never, "", 100, undefined, noopScheduleTimeout);
    socket.emit("data", Buffer.from("foo"));
    socket.emit("data", Buffer.from("bar"));
    socket.emit("end");
    const result = await promise;
    expect(result).not.toBeNull();
    expect(result!.equals(Buffer.from("foobar"))).toBe(true);
  });

  it("returns Buffer.from(bodyPrefix, 'latin1') when end is emitted with no data chunks", async () => {
    const socket = makeSocketMock();
    const prefix = "prefixonly";
    const promise = bufferBody(socket as never, prefix, 100, undefined, noopScheduleTimeout);
    socket.emit("end");
    const result = await promise;
    expect(result).not.toBeNull();
    expect(result!.equals(Buffer.from(prefix, "latin1"))).toBe(true);
  });

  it("resolves null when socket emits error before end", async () => {
    const socket = makeSocketMock();
    const promise = bufferBody(socket as never, "", 100, undefined, noopScheduleTimeout);
    socket.emit("error", new Error("socket error"));
    const result = await promise;
    expect(result).toBeNull();
  });

  it("resolves null when socket emits close before end", async () => {
    const socket = makeSocketMock();
    const promise = bufferBody(socket as never, "", 100, undefined, noopScheduleTimeout);
    socket.emit("close");
    const result = await promise;
    expect(result).toBeNull();
  });
});

// ── runFinalizer / runAwsSigV4Finalizer ───────────────────────────────────────

describe("runFinalizer / runAwsSigV4Finalizer", () => {
  it("runFinalizer delegates to runAwsSigV4Finalizer for kind='awsSigV4'", () => {
    const log = makeMockLogger();
    const body = Buffer.from("test body");
    const headers = new Headers({ "content-type": "application/json" });
    const finalizer: RequestFinalizer = { kind: "awsSigV4" };
    const result = runFinalizer(finalizer, body, headers, log as never);
    // body and headers must be returned unchanged (same reference)
    expect(result.body).toBe(body);
    expect(result.headers).toBe(headers);
  });

  it("runFinalizer throws an error containing 'Unknown finalizer kind' for unknown kinds", () => {
    const log = makeMockLogger();
    const body = Buffer.from("test body");
    const headers = new Headers();
    const unknown = { kind: "unknownKind" } as unknown as RequestFinalizer;
    expect(() => runFinalizer(unknown, body, headers, log as never)).toThrow(
      /Unknown finalizer kind/,
    );
  });

  it("reports clearly that the unchanged AWS request was not signed", () => {
    const log = makeMockLogger();
    const body = Buffer.from("payload");
    const headers = new Headers({ authorization: "Bearer token" });
    const result = runAwsSigV4Finalizer(body, headers, log as never);
    // Same references
    expect(result.body).toBe(body);
    expect(result.headers).toBe(headers);
    // Log assertion
    const debugCalls = log._calls("debug");
    const finalizerLogs = debugCalls.filter((c) => c.payload["step"] === "finalizer_skipped");
    expect(finalizerLogs).toHaveLength(1);
    expect(finalizerLogs[0]!.payload["hint"]).toBe("AWS SigV4 request signing is unavailable");
    expect(finalizerLogs[0]!.msg).toBe("AWS SigV4 finalizer skipped; request was not signed");
  });
});

// ── contentLength-guided stop ─────────────────────────────────────────────────

describe("bufferBody: contentLength-guided stop", () => {
  it("stops accumulating at contentLength bytes without waiting for socket end", async () => {
    // RED: current code has this path; test verifies it works correctly.
    const socket = makeSocketMock();
    const promise = bufferBody(socket as never, "", 100, 5, noopScheduleTimeout);
    socket.emit("data", Buffer.from("hello")); // exactly 5 bytes
    const result = await promise;
    expect(result).not.toBeNull();
    expect(result!.equals(Buffer.from("hello"))).toBe(true);
  });

  it("bodyPrefix alone satisfies contentLength — resolves before any data", async () => {
    // RED: current code has bodyPrefix check before resume(); should work.
    const socket = makeSocketMock();
    const promise = bufferBody(socket as never, "hello", 100, 5, noopScheduleTimeout);
    // No data events — bodyPrefix alone satisfies contentLength=5
    const result = await promise;
    expect(result).not.toBeNull();
    expect(result!.equals(Buffer.from("hello", "latin1"))).toBe(true);
  });

  it("contentLength=0 resolves immediately with empty Buffer without waiting for EOF", async () => {
    // RED: current code treats CL=0 as absent (parseInt("0",10) || undefined === undefined)
    // so bufferBody waits for socket end. This test asserts immediate resolution.
    const socket = makeSocketMock();
    const promise = bufferBody(socket as never, "", 100, 0, noopScheduleTimeout);
    // No end event emitted — should resolve immediately
    const result = await promise;
    expect(result).not.toBeNull();
    expect((result as Buffer).length).toBe(0);
  });

  it("negative contentLength (-1) is treated as absent — cap+timeout governs", async () => {
    // Negative CL is invalid; bufferBody treats it as absent (cap+timeout path).
    // The socket closes first here to resolve — we just verify no immediate resolve.
    const socket = makeSocketMock();
    const fst = makeFakeScheduleTimeout();
    const promise = bufferBody(socket as never, "", 100, -1, fst.scheduleTimeout);
    // Fire the timeout — should return null (timeout → settle(null))
    fst.fire();
    const result = await promise;
    expect(result).toBeNull();
  });

  it("declared contentLength > cap — caller handles this; bufferBody still returns null on timeout", async () => {
    // When CL is declared but > cap, the cap check fires first on data arrival.
    // Here we verify that timeout also settles with null when no data arrives.
    const fst = makeFakeScheduleTimeout();
    const socket = makeSocketMock();
    const promise = bufferBody(socket as never, "", 10, 20, fst.scheduleTimeout);
    // No data — timeout fires → settle(null)
    fst.fire();
    const result = await promise;
    expect(result).toBeNull();
  });

  it("timeout fires when contentLength is under-filled — returns null for 413 path", async () => {
    // RED: current code has NO timeout. Under-filled CL hangs forever.
    // After fix: bufferBody must accept a scheduleTimeout and fire it → settle(null).
    const fst = makeFakeScheduleTimeout();
    const socket = makeSocketMock();
    // Declare CL=1000, send only 1 byte, then fire the timeout
    const promise = bufferBody(socket as never, "", MAX_BODY_BYTES, 1000, fst.scheduleTimeout);
    socket.emit("data", Buffer.from("x")); // 1 byte — total=1, far short of CL=1000
    fst.fire(); // simulate deadline expiry
    const result = await promise;
    // Timeout fires → settle(null) → caller 413s
    expect(result).toBeNull();
  });

  it("timeout is cancelled when contentLength is satisfied before deadline", async () => {
    // After fix: when the full body arrives before timeout, the cancel fn is called.
    // Verify by checking that after settlement, firing the timeout has no effect.
    const fst = makeFakeScheduleTimeout();
    const socket = makeSocketMock();
    const promise = bufferBody(socket as never, "", 100, 5, fst.scheduleTimeout);
    socket.emit("data", Buffer.from("hello")); // satisfies CL=5
    const result = await promise;
    expect(result).not.toBeNull();
    // Even if we call fire() after settlement it should be no-op (already resolved)
    fst.fire();
    // promise is already settled — re-awaiting returns same result
    const result2 = await promise;
    expect(result2).not.toBeNull();
  });

  it("default scheduleTimeout (no 5th arg) — normal socket EOF resolves successfully", async () => {
    // Exercises the default parameter value for scheduleTimeout.
    // Without passing the 5th arg, bufferBody uses the built-in no-op default.
    const socket = makeSocketMock();
    const promise = bufferBody(socket as never, "abc", 100);
    socket.emit("end");
    const result = await promise;
    expect(result).not.toBeNull();
    expect(result!.equals(Buffer.from("abc", "latin1"))).toBe(true);
  });
});
