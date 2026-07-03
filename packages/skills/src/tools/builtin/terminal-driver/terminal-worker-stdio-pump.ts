// SPDX-License-Identifier: Apache-2.0
/**
 * terminal-worker-stdio-pump — the SERVER half of the worker IPC, extracted
 * from `terminal-worker-main.ts` so it is unit-testable WITHOUT a fork (the
 * bootstrap just wires real process IO into it).
 *
 * Decodes length-prefixed request frames off the worker's stdin, dispatches each
 * to `createTerminalWorker().handle`, and writes the encoded reply to stdout.
 * A decoder error (corrupt/oversized length prefix → {@link FrameTooLargeError})
 * and a `handle` rejection are both surfaced via `onError`; a rejection ALSO
 * synthesizes an `ok:false` reply so the daemon-side registry waiter resolves
 * instead of hanging until its timeout (the "never strand the waiter" invariant).
 *
 * LEAF + INFRA-FREE: value-imports only the IPC codec (sibling leaf) — no
 * `@comis/infra`, no node globals.
 *
 * @module
 */

import {
  createFrameDecoder,
  encodeFrame,
  type TerminalFrame,
  type TerminalReplyFrame,
  type TerminalRequestFrame,
} from "./terminal-ipc.js";

/** Dependencies of the pump — all IO injected so the pump is fork-free testable. */
export interface StdioPumpDeps {
  /** Dispatch one request frame to the in-process worker; resolves to the reply frame. */
  handle: (frame: TerminalRequestFrame) => Promise<TerminalReplyFrame>;
  /** Write one encoded reply frame to the worker's stdout (production: `fs.writeSync(1, b)`). */
  writeReply: (bytes: Buffer) => void;
  /** Decode/dispatch error sink (production: the worker's file logger). `frame` absent for a decoder error. */
  onError?: (err: unknown, frame?: TerminalRequestFrame) => void;
}

/** A pump fed stdin chunks via {@link StdioPump.push}. */
export interface StdioPump {
  push(chunk: Buffer): void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Build a stdio pump. The decoder is closure-local (no module-global state).
 * `push` decodes synchronously (so a decoder throw is caught here, never
 * buffered toward a DoS) and fires `handle` asynchronously per frame; replies
 * are written in `handle`'s resolution order — the daemon correlates by
 * `requestId`, never arrival order, so out-of-order replies are correct
 * by construction.
 */
export function createStdioPump(deps: StdioPumpDeps): StdioPump {
  const decoder = createFrameDecoder();
  return {
    push(chunk: Buffer): void {
      let frames: TerminalFrame[];
      try {
        frames = decoder.push(chunk);
      } catch (err) {
        // Corrupt/oversized length prefix: never buffer toward a memory DoS.
        // Surface it; the daemon treats a wedged worker as corrupt + respawns.
        deps.onError?.(err);
        return;
      }
      for (const frame of frames) {
        const request = frame as TerminalRequestFrame;
        void deps
          .handle(request)
          .then((reply) => deps.writeReply(encodeFrame(reply)))
          .catch((err) => {
            deps.onError?.(err, request);
            // Never strand the registry waiter: synthesize a fail reply it can resolve.
            const failReply: TerminalReplyFrame = {
              sessionId: request.sessionId,
              requestId: request.requestId,
              ok: false,
              error: errorMessage(err),
            };
            deps.writeReply(encodeFrame(failReply));
          });
      }
    },
  };
}
