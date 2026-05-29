// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for finalizer-stage — FINAL-01e/f/g.
 *
 * RED-first TDD: tests written before the implementation.
 * Covers: bufferBody (cap, bodyPrefix fold, error paths),
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

/** Create a minimal socket-like EventEmitter for bufferBody tests. */
function makeSocketMock(): EventEmitter & { resume(): this; pause(): this } {
  const ee = new EventEmitter() as EventEmitter & { resume(): this; pause(): this };
  ee.resume = function () { return this; };
  ee.pause = function () { return this; };
  return ee;
}

describe("FINAL-01e — bufferBody: cap-exceeded path returns null", () => {
  it("resolves null when a single data chunk exceeds the cap", async () => {
    const socket = makeSocketMock();
    const promise = bufferBody(socket as never, "", 10);
    // Emit a single chunk larger than cap=10
    socket.emit("data", Buffer.allocUnsafe(11));
    const result = await promise;
    expect(result).toBeNull();
  });

  it("resolves null immediately when bodyPrefix alone exceeds cap", async () => {
    const socket = makeSocketMock();
    // bodyPrefix of 6 bytes, cap=5
    const promise = bufferBody(socket as never, "hello!", 5);
    const result = await promise;
    expect(result).toBeNull();
  });

  it("resolves null when cumulative chunks exceed cap", async () => {
    const socket = makeSocketMock();
    const promise = bufferBody(socket as never, "", 10);
    // Two 6-byte chunks: total 12 > cap 10
    socket.emit("data", Buffer.from("abcdef"));
    socket.emit("data", Buffer.from("ghijkl"));
    const result = await promise;
    expect(result).toBeNull();
  });
});

describe("FINAL-01f — bufferBody: bodyPrefix fold and normal completion", () => {
  it("folds bodyPrefix + data chunk into a single Buffer on success", async () => {
    const socket = makeSocketMock();
    // "hello" (5 bytes) + "world" (5 bytes) = 10 bytes, cap=100
    const promise = bufferBody(socket as never, "hello", 100);
    socket.emit("data", Buffer.from("world"));
    socket.emit("end");
    const result = await promise;
    expect(result).not.toBeNull();
    expect(result!.equals(Buffer.from("helloworld"))).toBe(true);
  });

  it("concatenates two chunks with no bodyPrefix", async () => {
    const socket = makeSocketMock();
    const promise = bufferBody(socket as never, "", 100);
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
    const promise = bufferBody(socket as never, prefix, 100);
    socket.emit("end");
    const result = await promise;
    expect(result).not.toBeNull();
    expect(result!.equals(Buffer.from(prefix, "latin1"))).toBe(true);
  });

  it("resolves null when socket emits error before end", async () => {
    const socket = makeSocketMock();
    const promise = bufferBody(socket as never, "", 100);
    socket.emit("error", new Error("socket error"));
    const result = await promise;
    expect(result).toBeNull();
  });

  it("resolves null when socket emits close before end", async () => {
    const socket = makeSocketMock();
    const promise = bufferBody(socket as never, "", 100);
    socket.emit("close");
    const result = await promise;
    expect(result).toBeNull();
  });
});

describe("FINAL-01g — runFinalizer / runAwsSigV4Finalizer", () => {
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

  it("runAwsSigV4Finalizer returns body+headers unchanged and logs step=finalizer_skipped hint=sigv4 deferred", () => {
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
    expect(finalizerLogs[0]!.payload["hint"]).toBe("sigv4 deferred");
  });
});
