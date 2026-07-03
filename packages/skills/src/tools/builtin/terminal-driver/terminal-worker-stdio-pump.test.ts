// SPDX-License-Identifier: Apache-2.0
/**
 * The stdio frame-pump is the testable core of the standalone
 * worker process entry (`terminal-worker-main.ts`). The pump decodes
 * length-prefixed request frames off the worker's stdin, dispatches each to the
 * in-process `createTerminalWorker().handle`, and writes the encoded reply back
 * to stdout — the SERVER half of the worker IPC (the daemon forks
 * `node worker-main.js`).
 *
 * This is platform-agnostic (no fork, no bwrap) so it runs on the macOS author
 * box; the real separate-process fork + jail is covered by
 * terminal-worker-fork.linux.test.ts on the VPS.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";

import { createStdioPump } from "./terminal-worker-stdio-pump.js";
import {
  encodeFrame,
  createFrameDecoder,
  type TerminalReplyFrame,
  type TerminalRequestFrame,
} from "./terminal-ipc.js";

function req(over: Partial<TerminalRequestFrame> = {}): TerminalRequestFrame {
  return {
    sessionId: "sess-1",
    requestId: "req-1",
    traceId: "trace-1",
    method: "create",
    params: {},
    ...over,
  };
}

function decodeOne(buf: Buffer): TerminalReplyFrame {
  const frames = createFrameDecoder().push(buf);
  return frames[0] as TerminalReplyFrame;
}

describe("terminal worker stdio pump", () => {
  it("decodes a request frame from stdin, dispatches to handle, writes the encoded reply", async () => {
    const reply: TerminalReplyFrame = {
      sessionId: "sess-1",
      requestId: "req-1",
      ok: true,
      result: { sessionId: "sess-1" },
    };
    const handle = vi.fn(async (_f: TerminalRequestFrame) => reply);
    const writes: Buffer[] = [];
    const pump = createStdioPump({ handle, writeReply: (b) => writes.push(b) });

    const frame = req();
    pump.push(encodeFrame(frame));

    await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(1));
    expect(handle).toHaveBeenCalledWith(frame);
    await vi.waitFor(() => expect(writes.length).toBe(1));
    expect(decodeOne(writes[0])).toEqual(reply);
  });

  it("reassembles a request frame split across two stdin chunks (length-prefix framing)", async () => {
    const reply: TerminalReplyFrame = { sessionId: "sess-1", requestId: "req-1", ok: true };
    const handle = vi.fn(async () => reply);
    const writes: Buffer[] = [];
    const pump = createStdioPump({ handle, writeReply: (b) => writes.push(b) });

    const encoded = encodeFrame(req());
    pump.push(encoded.subarray(0, 3)); // partial: prefix not even complete
    expect(handle).not.toHaveBeenCalled();
    pump.push(encoded.subarray(3)); // remainder

    await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(1));
  });

  it("dispatches two frames in one chunk, each correlated by requestId", async () => {
    const handle = vi.fn(async (f: TerminalRequestFrame) => ({
      sessionId: f.sessionId,
      requestId: f.requestId,
      ok: true,
    }));
    const writes: Buffer[] = [];
    const pump = createStdioPump({ handle, writeReply: (b) => writes.push(b) });

    const a = encodeFrame(req({ requestId: "a" }));
    const b = encodeFrame(req({ requestId: "b" }));
    pump.push(Buffer.concat([a, b]));

    await vi.waitFor(() => expect(writes.length).toBe(2));
    const ids = writes.map((w) => decodeOne(w).requestId).sort();
    expect(ids).toEqual(["a", "b"]);
  });

  it("on handle rejection, writes an ok:false reply so the registry waiter never hangs", async () => {
    const handle = vi.fn(async () => {
      throw new Error("boom");
    });
    const writes: Buffer[] = [];
    const onError = vi.fn();
    const pump = createStdioPump({ handle, writeReply: (b) => writes.push(b), onError });

    pump.push(encodeFrame(req()));

    await vi.waitFor(() => expect(writes.length).toBe(1));
    const reply = decodeOne(writes[0]);
    expect(reply.ok).toBe(false);
    expect(reply.sessionId).toBe("sess-1");
    expect(reply.requestId).toBe("req-1");
    expect(reply.error).toContain("boom");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("a corrupt oversized length prefix is reported via onError, not buffered toward a DoS", () => {
    const handle = vi.fn(async () => ({ sessionId: "x", requestId: "y", ok: true }));
    const onError = vi.fn();
    const pump = createStdioPump({ handle, writeReply: () => {}, onError });

    // 0xFFFFFFFF body length — far over MAX_FRAME_BYTES.
    const hostile = Buffer.alloc(8);
    hostile.writeUInt32BE(0xffffffff, 0);
    pump.push(hostile);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(handle).not.toHaveBeenCalled();
  });
});
