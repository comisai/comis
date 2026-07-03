// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the length-prefixed JSON IPC framer.
 *
 * Pure-JS → runs green on macOS. Proves the framing + correlation contract the
 * worker and the daemon-side reply router route over:
 *   - length-prefixed JSON frames round-trip losslessly (uint32-BE prefix);
 *   - a stateful decoder reassembles arbitrary chunk splits (no premature/double emit);
 *   - two replies for one session correlate by (sessionId,requestId), NEVER arrival order
 *     (the framing half of out-of-order correlation);
 *   - event frames decode distinctly from reply frames (the separate push channel).
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import {
  encodeFrame,
  decodeFrames,
  createFrameDecoder,
  correlate,
  FrameTooLargeError,
  MAX_FRAME_BYTES,
  type TerminalReplyFrame,
} from "./terminal-ipc.js";

const TRACE_ID = "11111111-2222-4333-8444-555555555555";

describe("encodeFrame / decodeFrames", () => {
  it("round-trips a request frame with a uint32-BE length prefix, preserving traceId", () => {
    const frame = {
      sessionId: "s1",
      requestId: "r1",
      traceId: TRACE_ID,
      method: "read" as const,
      params: { cols: 120 },
    };
    const buf = encodeFrame(frame);

    // First 4 bytes are a big-endian uint32 of the JSON body length.
    const declaredLen = buf.readUInt32BE(0);
    expect(declaredLen).toBe(buf.length - 4);
    expect(buf.length).toBeGreaterThan(4);

    const frames = decodeFrames(buf);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(frame);
    // traceId survives the round-trip intact.
    expect((frames[0] as { traceId: string }).traceId).toBe(TRACE_ID);
  });
});

describe("createFrameDecoder", () => {
  it("reassembles a frame fed in two arbitrary slices (split mid-prefix AND mid-body)", () => {
    const frame = {
      sessionId: "s1",
      requestId: "r1",
      traceId: TRACE_ID,
      method: "read" as const,
      params: {},
    };
    const buf = encodeFrame(frame);

    // Split inside the 4-byte length prefix (offset 2).
    const decoderA = createFrameDecoder();
    expect(decoderA.push(buf.subarray(0, 2))).toEqual([]); // no full prefix yet
    const emittedA = decoderA.push(buf.subarray(2));
    expect(emittedA).toHaveLength(1);
    expect(emittedA[0]).toEqual(frame);

    // Split inside the body (one byte past the prefix).
    const decoderB = createFrameDecoder();
    expect(decoderB.push(buf.subarray(0, 5))).toEqual([]); // prefix complete, body partial → no emit
    const emittedB = decoderB.push(buf.subarray(5));
    expect(emittedB).toHaveLength(1);
    expect(emittedB[0]).toEqual(frame);
  });

  it("emits each of two concatenated frames exactly once, never double-emitting", () => {
    const f1 = { sessionId: "s1", requestId: "r1", traceId: TRACE_ID, method: "read" as const, params: {} };
    const f2 = { sessionId: "s1", requestId: "r2", traceId: TRACE_ID, method: "kill" as const, params: {} };
    const decoder = createFrameDecoder();

    const both = Buffer.concat([encodeFrame(f1), encodeFrame(f2)]);
    const emitted = decoder.push(both);
    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toEqual(f1);
    expect(emitted[1]).toEqual(f2);

    // Nothing left buffered → a subsequent empty push emits nothing (no double emit).
    expect(decoder.push(Buffer.alloc(0))).toEqual([]);
  });
});

describe("correlate (the framing half of out-of-order correlation)", () => {
  it("matches an out-of-order reply to its request by (sessionId,requestId), not arrival order", () => {
    // Two requests for the SAME session; replies encoded in REVERSE order.
    const reply1: TerminalReplyFrame = { sessionId: "s1", requestId: "r1", ok: true, result: { grid: "one" } };
    const reply2: TerminalReplyFrame = { sessionId: "s1", requestId: "r2", ok: true, result: { grid: "two" } };

    const wire = Buffer.concat([encodeFrame(reply2), encodeFrame(reply1)]); // r2 then r1
    const decoder = createFrameDecoder();
    const decoded = decoder.push(wire) as TerminalReplyFrame[];

    // Both replies decode and each carries its own requestId.
    expect(decoded.map((f) => f.requestId)).toEqual(["r2", "r1"]);

    // A pending map of request resolvers keyed by (sessionId,requestId).
    const resolvedBy: Record<string, TerminalReplyFrame> = {};
    const pending = new Map<string, (f: TerminalReplyFrame) => void>([
      ["s1:r1", (f) => { resolvedBy.r1 = f; }],
      ["s1:r2", (f) => { resolvedBy.r2 = f; }],
    ]);

    // Route both replies through correlate, in the WIRE order (r2 first, r1 second).
    for (const f of decoded) {
      expect(correlate(pending, f)).toBe(true);
    }

    // The r1 request is resolved by the r1 reply even though it arrived SECOND.
    // (Frames cross the wire as JSON, so the resolver receives a structurally-equal
    // decoded copy — the load-bearing assertion is that r1's VALUE reached r1's waiter.)
    expect(resolvedBy.r1).toEqual(reply1);
    expect(resolvedBy.r2).toEqual(reply2);
    expect(resolvedBy.r1.result).toEqual({ grid: "one" });
  });

  it("returns false when no pending request matches the reply key (no spurious resolution)", () => {
    const pending = new Map<string, (f: TerminalReplyFrame) => void>();
    const orphan: TerminalReplyFrame = { sessionId: "s1", requestId: "ghost", ok: false, error: "gone" };
    expect(correlate(pending, orphan)).toBe(false);
  });
});

describe("createFrameDecoder — max-frame guard (memory-DoS / desync)", () => {
  it("throws FrameTooLargeError on a length prefix above MAX_FRAME_BYTES instead of buffering toward a ~4 GiB body", () => {
    // A single hostile/corrupt uint32 length prefix (0xFFFFFFFF = ~4 GiB) with
    // NO body. The pre-patch decoder computes frameEnd = 4 + 4294967295, sees
    // buffered.length < frameEnd, breaks, and RETAINS the buffer forever —
    // unbounded growth as a steadily-writing peer keeps feeding bytes.
    const hostile = Buffer.alloc(4);
    hostile.writeUInt32BE(0xffffffff, 0);

    const decoder = createFrameDecoder();
    expect(() => decoder.push(hostile)).toThrow(FrameTooLargeError);
  });

  it("the thrown FrameTooLargeError carries the offending length + the cap (so the caller can log/resync)", () => {
    const hostile = Buffer.alloc(4);
    hostile.writeUInt32BE(0xffffffff, 0);
    const decoder = createFrameDecoder();

    let caught: unknown;
    try {
      decoder.push(hostile);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FrameTooLargeError);
    expect((caught as FrameTooLargeError).declaredBytes).toBe(0xffffffff);
    expect((caught as FrameTooLargeError).maxBytes).toBe(MAX_FRAME_BYTES);
  });

  it("does NOT grow the accumulation buffer toward an oversized body — a 2nd push still rejects, never OOMs", () => {
    // Prove the buffer is not silently accumulating: feed the oversized prefix,
    // then a follow-on chunk. The pre-patch decoder would Buffer.concat the
    // follow-on onto the retained buffer (unbounded); the guarded decoder keeps
    // rejecting the oversized prefix rather than buffering toward 4 GiB.
    const hostile = Buffer.alloc(4);
    hostile.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    const decoder = createFrameDecoder();

    expect(() => decoder.push(hostile)).toThrow(FrameTooLargeError);
    // A subsequent body chunk must not be silently swallowed into an ever-growing buffer.
    expect(() => decoder.push(Buffer.alloc(1024, 0x41))).toThrow(FrameTooLargeError);
  });

  it("still decodes a legitimately large frame at exactly MAX_FRAME_BYTES (the cap is inclusive, not off-by-one)", () => {
    // A valid JSON body whose encoded length is EXACTLY the cap must decode (the
    // cap is a ceiling, not a strict-less-than that would reject a maximal-but-
    // valid screen+JSON frame). `JSON.stringify("x".repeat(n))` is `"` + n×`x` +
    // `"` = n+2 bytes, so target n = MAX_FRAME_BYTES-2 to land the body at the cap.
    const body = Buffer.from(JSON.stringify("x".repeat(MAX_FRAME_BYTES - 2)), "utf8");
    expect(body.length).toBe(MAX_FRAME_BYTES); // body sits exactly on the inclusive cap
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(body.length, 0);
    const decoder = createFrameDecoder();
    // Should NOT throw — a body length == cap is accepted (and here is valid JSON).
    expect(() => decoder.push(Buffer.concat([prefix, body]))).not.toThrow();
  });
});

describe("event channel separation", () => {
  it("decodes an event frame distinctly from a reply frame (routed by requestId/event presence)", () => {
    const reply: TerminalReplyFrame = { sessionId: "s1", requestId: "r1", ok: true, result: {} };
    const event = {
      sessionId: "s1",
      event: "terminal:session_state" as const,
      payload: { status: "running" },
    };

    const decoder = createFrameDecoder();
    const decoded = decoder.push(Buffer.concat([encodeFrame(reply), encodeFrame(event)]));
    expect(decoded).toHaveLength(2);

    const [first, second] = decoded;
    // The consumer routes by the presence of requestId (reply) vs event (push channel).
    expect("requestId" in first).toBe(true);
    expect("event" in first).toBe(false);
    expect("event" in second).toBe(true);
    expect("requestId" in second).toBe(false);
    expect((second as { event: string }).event).toBe("terminal:session_state");
  });
});
