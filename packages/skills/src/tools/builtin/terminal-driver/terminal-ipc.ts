// SPDX-License-Identifier: Apache-2.0
/**
 * Length-prefixed JSON IPC framing for the Terminal Worker boundary.
 *
 * The worker and the daemon-side registry exchange JSON frames over a pipe.
 * Each frame is `[uint32-BE body-length][utf8 JSON body]`. Requests correlate
 * by `(sessionId, requestId)` — NEVER by arrival order (a busy session may
 * reply out of order). A separate push channel carries `terminal:*` event
 * frames; consumers route a decoded frame by the presence of `requestId`
 * (request/reply) vs `event` (push). Each request frame carries `traceId` so
 * the worker can re-establish the originating ALS context.
 *
 * Pure JS — no `node-pty` / `@comis/infra` import. The decoder holds its
 * accumulation buffer in CLOSURE scope (no module-global mutable state, as
 * enforced by the `globals.test.ts` architecture gate). No raw
 * wall-clock or timer globals — this module is a pure transform.
 *
 * @module
 */

/** A request: daemon → worker. Carries the method + params and the trace context. */
export interface TerminalRequestFrame {
  sessionId: string;
  requestId: string;
  traceId: string;
  method: string;
  params: Record<string, unknown>;
}

/** A reply: worker → daemon. Correlates back to a request by `(sessionId,requestId)`. */
export interface TerminalReplyFrame {
  sessionId: string;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** A push-channel event: worker → daemon. Has no `requestId` — it is unsolicited. */
export interface TerminalEventFrame {
  sessionId: string;
  event: string;
  payload: unknown;
}

/** The discriminated union of every frame shape on the IPC wire. */
export type TerminalFrame =
  | TerminalRequestFrame
  | TerminalReplyFrame
  | TerminalEventFrame;

/** The 4-byte big-endian length prefix that precedes every JSON body. */
const LENGTH_PREFIX_BYTES = 4;

/**
 * Hard ceiling on a single frame's declared body length.
 *
 * The length prefix is an attacker/garbage-controlled `uint32` (0 …
 * 4 294 967 295). Without a ceiling, one corrupt/hostile prefix (e.g.
 * `0xFFFFFFFF`) drives the streaming decoder to buffer every subsequent byte
 * forever, waiting for a ~4 GiB body that never completes — an unbounded
 * `Buffer.concat` growth (memory DoS) that also permanently desyncs the stream.
 *
 * 16 MiB is ample for the worker↔daemon traffic (a screen grid + JSON envelope
 * is kilobytes; even a large scrollback dump is well under this). Anything
 * larger is treated as corrupt/hostile: the decoder REFUSES to buffer toward it
 * and throws {@link FrameTooLargeError} so the caller can drop the frame, log
 * `errorKind:"validation"`, and — at the registry — treat the worker as corrupt
 * and re-spawn it. The load-bearing property is the bound itself.
 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * Thrown by the decoder when a frame's declared body length exceeds
 * {@link MAX_FRAME_BYTES}. Carries the offending `declaredBytes` and the
 * `maxBytes` ceiling so the caller can log a precise `errorKind:"validation"`
 * diagnostic and resync/re-spawn rather than grow the buffer toward a hostile
 * length. A typed error (not a bare `Error`) so the registry's stdout handler
 * can branch on `instanceof` if it ever needs frame-specific recovery.
 */
export class FrameTooLargeError extends Error {
  readonly declaredBytes: number;
  readonly maxBytes: number;
  constructor(declaredBytes: number, maxBytes: number) {
    super(
      `terminal IPC frame body length ${declaredBytes} exceeds the ${maxBytes}-byte cap (corrupt/hostile length prefix)`,
    );
    this.name = "FrameTooLargeError";
    this.declaredBytes = declaredBytes;
    this.maxBytes = maxBytes;
  }
}

/**
 * Encode a frame as `[uint32-BE body-length][utf8 JSON body]`.
 *
 * The length prefix lets the decoder reassemble a frame from arbitrary chunk
 * boundaries on the underlying pipe (a single `write` is not a single `read`).
 */
export function encodeFrame(frame: TerminalFrame): Buffer {
  const body = Buffer.from(JSON.stringify(frame), "utf8");
  const len = Buffer.alloc(LENGTH_PREFIX_BYTES);
  len.writeUInt32BE(body.length, 0);
  return Buffer.concat([len, body]);
}

/**
 * Decode all complete frames present in a single, fully-buffered input.
 *
 * Convenience for callers that already hold the whole buffer (e.g. tests, or a
 * synchronous read of a complete message). For a streaming pipe use
 * {@link createFrameDecoder}, which carries partial state across chunks.
 */
export function decodeFrames(buf: Buffer): TerminalFrame[] {
  const decoder = createFrameDecoder();
  return decoder.push(buf);
}

/**
 * A stateful streaming decoder. Feed it raw chunks from a pipe via `push`; it
 * returns the frames that became complete on that chunk (possibly zero, after
 * appending to its CLOSURE-scoped accumulation buffer). A frame is emitted
 * exactly once, only after its full body has arrived — never prematurely on a
 * partial prefix/body, never twice.
 */
export function createFrameDecoder(): { push(chunk: Buffer): TerminalFrame[] } {
  // Closure-local accumulation buffer — NOT module scope (no module-global state).
  let buffered: Buffer = Buffer.alloc(0);

  function push(chunk: Buffer): TerminalFrame[] {
    if (chunk.length > 0) {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
    }

    const out: TerminalFrame[] = [];
    // Drain every complete frame currently in the buffer.
    for (;;) {
      if (buffered.length < LENGTH_PREFIX_BYTES) break; // not even a full length prefix yet
      const bodyLen = buffered.readUInt32BE(0);
      // Refuse a corrupt/hostile length before reserving toward it. Never
      // grow `buffered` toward a multi-GiB body — that is the DoS primitive. The
      // caller (registry stdout handler) catches this, drops the worker as
      // corrupt, and re-spawns. The buffer is left intact (not consumed): a 2nd
      // push re-reads the same oversized prefix and re-throws — it never silently
      // accumulates the follow-on bytes.
      //
      // @allow-throw: the framer is a decode-protocol boundary — a typed decode
      // error IS the contract here (symmetric with the built-in JSON.parse throw
      // on the very next decode step). The sole caller (registry stdout 'data'
      // handler) wraps decoder.push in try/catch, logs errorKind:
      // "validation", and drops/re-spawns the worker; it never reaches
      // uncaughtException. Returning a Result here would force every push() caller
      // (incl. the tests' in-process bridge) to branch on a discriminated union on
      // the hot decode path for a condition that only fires on corrupt/hostile
      // input — the throw + single guarded catch is the cleaner boundary.
      if (bodyLen > MAX_FRAME_BYTES) {
        throw new FrameTooLargeError(bodyLen, MAX_FRAME_BYTES);
      }
      const frameEnd = LENGTH_PREFIX_BYTES + bodyLen;
      if (buffered.length < frameEnd) break; // body not fully arrived yet

      const body = buffered.subarray(LENGTH_PREFIX_BYTES, frameEnd);
      out.push(JSON.parse(body.toString("utf8")) as TerminalFrame);
      buffered = buffered.subarray(frameEnd); // consume the frame; keep any trailing bytes
    }
    return out;
  }

  return { push };
}

/**
 * The daemon-side reply router. Resolve a pending request by the
 * `(sessionId,requestId)` key — independent of the order replies arrive in
 * (the framing half of out-of-order correlation). Returns `true` if a pending
 * resolver matched (and was invoked + removed), `false` for an orphan/duplicate
 * reply with no waiter.
 *
 * The worker uses {@link encodeFrame}/{@link createFrameDecoder} symmetrically
 * on its side; this helper is the correlation gate on the daemon side.
 */
export function correlate(
  pending: Map<string, (f: TerminalReplyFrame) => void>,
  frame: TerminalReplyFrame,
): boolean {
  const key = `${frame.sessionId}:${frame.requestId}`;
  const resolve = pending.get(key);
  if (!resolve) return false;
  pending.delete(key);
  resolve(frame);
  return true;
}
