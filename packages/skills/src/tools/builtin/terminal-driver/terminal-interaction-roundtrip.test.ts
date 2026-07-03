// SPDX-License-Identifier: Apache-2.0
/**
 * The end-to-end INTERACTION round-trip: the four implemented
 * interaction tools (send_text / send_key / resize / wait) driven through the
 * REAL TerminalSessionRegistry (the forwarding layer) + the REAL Terminal Worker
 * (the handlers + the key-grammar/settle leaves) + a REAL bash subprocess.
 *
 * This is the consumer-half integration proof: it composes the
 * whole stack (tool -> registry.sendText/sendKey/resize/wait -> encodeFrame ->
 * worker.handle{SendText,SendKey,Resize,Wait} -> settle -> reply -> decode ->
 * tool) and asserts the agent-observable behaviour:
 *   - send_text { submit:true } runs a command (the \r after the settle) and the
 *     echo appears on a subsequent read — the submit ordering is proven end-to-end.
 *   - send_key { keys:["C-c"] } delivers the control byte (the round-trip resolves
 *     a {screen,cursor} without error; the genuine SIGINT effect needs a PTY and
 *     is the VPS assertion in the sibling .linux.test.ts).
 *   - wait settles on idle and HONESTLY times out (isComplete:false) when an
 *     impossible forText cannot match — the load-bearing not-complete signal,
 *     end-to-end through the tool.
 *   - resize keeps the geometry coherent (a subsequent read/list reflects cols).
 *
 * Backend: this box's node-pty prebuild cannot `posix_spawnp`, so the worker is
 * wired with a `loadPty` that throws -> the DEGRADED pipe backend (a real
 * `child_process.spawn` of bash). That still yields a
 * stable sessionId + a text grid; the live-PTY interaction (a real SIGINT / a real
 * control-key exit) is the VPS-gated `.linux.test.ts`.
 *
 * Determinism: the in-worker settle is driven by an injected FAST fake timer that
 * fires on a tiny real delay SCALED from the requested ms (so the idle window
 * still fires BEFORE a larger overall-timeout window — relative ordering is
 * preserved without any dependence on the real 120ms wall-clock idle default).
 * There is no raw `setTimeout` driving the assertions' settle resolution.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { realpathSync } from "node:fs";
import { spawn as childSpawn } from "node:child_process";

import type { PipeChildLike } from "./terminal-worker-entry.js";

import {
  createTerminalSessionCreateTool,
  createTerminalSessionReadTool,
  createTerminalSessionListTool,
  createTerminalSessionSendTextTool,
  createTerminalSessionSendKeyTool,
  createTerminalSessionResizeTool,
  createTerminalSessionWaitTool,
  type TerminalToolDeps,
} from "./terminal-tools.js";
import {
  createTerminalSessionRegistry,
  type FakeWorkerChild,
  type SendResult,
  type WaitResult,
} from "./terminal-session-registry.js";
import { createTerminalWorker } from "./terminal-worker-entry.js";
import { createSessionCaps } from "./terminal-caps.js";
import { encodeFrame, createFrameDecoder, type TerminalRequestFrame } from "./terminal-ipc.js";
import type { AllowEntryLike } from "./allowlist-matcher.js";

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** Resolve a real shell binary on the test host. */
function realShell(): string {
  for (const candidate of ["/bin/bash", "/usr/bin/bash", "/bin/sh"]) {
    try {
      return realpathSync(candidate);
    } catch {
      /* next */
    }
  }
  throw new Error("no shell binary on test host");
}

/**
 * A FAST fake timer for the in-worker settle: fires the callback after a tiny
 * real delay SCALED down from the requested ms. Scaling (not collapsing to 0)
 * preserves the relative ordering of the idle window vs the overall timeout, so a
 * settle with a large `forIdleMs` + a small `timeoutMs` still times out (the
 * honest isComplete:false) and a settle with a small idle window settles idle.
 * The `.unref()`-style real timer never holds the loop (Vitest awaits the
 * resolved reply). NOT the real 120ms wall-clock default.
 */
const SETTLE_SCALE = 40;
function makeFastTimer(): {
  setTimer: (cb: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
} {
  return {
    setTimer: (cb: () => void, ms: number) => {
      const scaled = Math.max(1, Math.round(ms / SETTLE_SCALE));
      const h = setTimeout(cb, scaled);
      if (typeof (h as { unref?: () => void }).unref === "function") (h as { unref: () => void }).unref();
      return h;
    },
    clearTimer: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

/**
 * An in-process bridge: a fake worker child whose stdin decodes request frames,
 * runs them through a REAL `createTerminalWorker` (degraded pipe backend + the
 * fast injected settle timer), and pushes the encoded replies back through the
 * registered stdout `data` callback. Replaces the OS pipe so the full daemon-side
 * interaction path runs deterministically on macOS.
 */
/**
 * macOS jail-unwrapping pipe spawner: the worker spawns
 * `bwrap [scopeArgs] -- bin ...argv`; with no real bwrap on macOS this bridge spawns
 * the child AFTER the `--` directly so the deterministic macOS interaction round-trip
 * survives. The LIVE bwrap jail is the VPS `.linux.test.ts` sibling; the
 * argv composition is unit-asserted on macOS in terminal-worker-entry.test.ts.
 */
function unwrapBwrapSpawn(
  wrappedBin: string,
  wrappedArgv: string[],
  opts: { env: NodeJS.ProcessEnv },
): PipeChildLike {
  const sep = wrappedArgv.indexOf("--");
  const childBin = sep >= 0 ? wrappedArgv[sep + 1] : wrappedBin;
  const childArgv = sep >= 0 ? wrappedArgv.slice(sep + 2) : wrappedArgv;
  return childSpawn(childBin, childArgv, {
    env: opts.env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as unknown as PipeChildLike;
}

function makeBridgedWorkerChild(): FakeWorkerChild {
  const timer = makeFastTimer();
  const worker = createTerminalWorker({
    loadPty: () => {
      throw new Error("node-pty forced unavailable on this host (degraded pipe backend)");
    },
    spawnPipe: unwrapBwrapSpawn,
    bwrapPath: "/usr/bin/bwrap",
    logger: noopLogger,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });

  const decoder = createFrameDecoder();
  let onStdout: ((chunk: Buffer) => void) | undefined;
  // The serialization queue — each decoded frame chains onto it (in-order handling).
  let frameQueue: Promise<void> = Promise.resolve();

  const child: FakeWorkerChild = {
    pid: 5252,
    stdin: {
      write(chunk: Buffer): boolean {
        // Serialize frame handling (chain onto frameQueue) to mirror a real worker's
        // SEQUENTIAL frame loop: create's async handler (the scope-jail
        // composition) must complete + attach the backend before the next frame
        // (send_text/resize/wait) runs — otherwise a concurrent send writes to a
        // not-yet-attached backend and is dropped.
        for (const frame of decoder.push(chunk)) {
          frameQueue = frameQueue.then(async () => {
            const reply = await worker.handle(frame as TerminalRequestFrame);
            onStdout?.(encodeFrame(reply));
          });
        }
        void frameQueue;
        return true;
      },
    },
    stdout: {
      on(_event: "data", cb: (chunk: Buffer) => void): void {
        onStdout = cb;
      },
    },
    on(): FakeWorkerChild {
      return child;
    },
    kill(): void {
      /* the bridged worker has no separate process to signal */
    },
  };
  return child;
}

function toolDeps(registry: ReturnType<typeof createTerminalSessionRegistry>, entry: AllowEntryLike): TerminalToolDeps {
  return {
    registry,
    allowEntries: [entry],
    detectProvider: () => ({}) as never, // a present provider — fail-closed gate passes
    logger: noopLogger,
    eventBus: { emit: () => true },
    nowMs: () => Date.now(),
    agentId: "agent-interaction",
    // No-limit caps (these round-trips assert the interaction path, not the caps).
    caps: createSessionCaps(undefined, () => Date.now()),
  };
}

/** Build the four implemented interaction tools + the create/read/list tools over one registry. */
function buildTools(registry: ReturnType<typeof createTerminalSessionRegistry>, entry: AllowEntryLike) {
  return {
    create: createTerminalSessionCreateTool(toolDeps(registry, entry)),
    read: createTerminalSessionReadTool(toolDeps(registry, entry)),
    list: createTerminalSessionListTool(toolDeps(registry, entry)),
    sendText: createTerminalSessionSendTextTool(toolDeps(registry, entry)),
    sendKey: createTerminalSessionSendKeyTool(toolDeps(registry, entry)),
    resize: createTerminalSessionResizeTool(toolDeps(registry, entry)),
    wait: createTerminalSessionWaitTool(toolDeps(registry, entry)),
  };
}

/** Read until the screen contains `marker` (the echo arrived) or a bounded cap. */
async function readUntil(
  readTool: ReturnType<typeof createTerminalSessionReadTool>,
  sessionId: string,
  marker: string,
): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const res = await readTool.execute("read-call", { sessionId });
    const screen = (res.details as { screen: string }).screen;
    if (screen.includes(marker)) return screen;
    await new Promise((r) => setTimeout(r, 20));
  }
  const res = await readTool.execute("read-call", { sessionId });
  return (res.details as { screen: string }).screen;
}

/**
 * A submit-echo bash entry for the submit path on the DEGRADED PIPE backend.
 *
 * On a real PTY the line discipline maps the submit `\r` to `\n` and echoes input;
 * the degraded pipe backend has neither (the macOS box can't `posix_spawnp` a PTY).
 * So this bash reads ONE `\r`-delimited line (exactly what `send_text`
 * submit writes — the worker writes the text, settles, then writes `\r`), prints
 * the marker, and EXITS (exit flushes the otherwise block-buffered pipe so the ring
 * captures it). This proves the full tool -> registry -> worker -> bash submit
 * ordering end-to-end without a PTY. The live-PTY `\r`->`\n` echo is the VPS sibling.
 */
function bashSubmitEchoEntry(shell: string): AllowEntryLike {
  return {
    id: "bash",
    match: {
      path: shell,
      argsPrefix: ["--norc", "--noprofile", "-c", "IFS= read -r -d $'\\r' line; printf 'GOT:%s\\n' \"$line\""],
    },
  };
}

/** A permissive interactive-bash entry: stays alive reading stdin so keys/wait/resize land. */
function bashInteractiveEntry(shell: string): AllowEntryLike {
  return {
    id: "bash",
    // A `read`-loop bash that stays alive until EOF — used by the send_key / wait /
    // resize round-trips (they assert the tool resolves a coherent snapshot, not the
    // submit echo). Works on the degraded pipe backend.
    match: { path: shell, argsPrefix: ["--norc", "--noprofile", "-c", "while IFS= read -r line; do :; done"] },
  };
}

describe("terminal interaction round-trip — send_text submit ordering (real registry + worker + bash, degraded pipe)", () => {
  it("send_text { submit:true } runs a command and the echo appears on a subsequent read (submit path)", async () => {
    const shell = realShell();
    const registry = createTerminalSessionRegistry({
      spawnWorker: makeBridgedWorkerChild,
      logger: noopLogger,
      nowMs: () => Date.now(),
    });
    const entry = bashSubmitEchoEntry(shell);
    const tools = buildTools(registry, entry);

    const created = await tools.create.execute("create-call", { allowId: "bash", command: shell, cols: 100, rows: 30 });
    const { sessionId } = created.details as { sessionId: string };
    expect(sessionId.length).toBeGreaterThan(0);

    // send_text "echo HELLO" with submit -> worker writes text, settles, writes \r
    // as a SEPARATE write. The bash reads the \r-delimited line and prints
    // "GOT:echo HELLO" (then exits, flushing the pipe) — proving the submit \r ran
    // the line end-to-end through the tool->registry->worker->bash path.
    const sent = await tools.sendText.execute("send-call", { sessionId, text: "echo HELLO", submit: true });
    const body = sent.details as SendResult;
    expect(body).toHaveProperty("screen");
    expect(body).toHaveProperty("cursor");

    const screen = await readUntil(tools.read, sessionId, "GOT:echo HELLO");
    expect(screen).toContain("GOT:echo HELLO");

    await registry.cleanup();
  });
});

describe("terminal interaction round-trip — send_key delivers bytes (degraded pipe)", () => {
  it("send_key { keys:['C-c'] } resolves a {screen,cursor} end-to-end (the byte reached the backend)", async () => {
    const shell = realShell();
    const registry = createTerminalSessionRegistry({
      spawnWorker: makeBridgedWorkerChild,
      logger: noopLogger,
      nowMs: () => Date.now(),
    });
    const entry = bashInteractiveEntry(shell);
    const tools = buildTools(registry, entry);

    const created = await tools.create.execute("create-call", { allowId: "bash", command: shell, cols: 80, rows: 24 });
    const { sessionId } = created.details as { sessionId: string };

    // Degraded pipe backend: a real SIGINT needs a PTY (the VPS assertion). Here
    // we prove the write reached the child's stdin and the tool resolved cleanly.
    const res = await tools.sendKey.execute("key-call", { sessionId, keys: ["C-c"] });
    const body = res.details as SendResult;
    expect(body).toHaveProperty("screen");
    expect(body).toHaveProperty("cursor");

    await registry.cleanup();
  });
});

describe("terminal interaction round-trip — wait settles + honestly times out", () => {
  it("wait resolves isComplete:true when the session is idle (idle settle, end-to-end)", async () => {
    const shell = realShell();
    const registry = createTerminalSessionRegistry({
      spawnWorker: makeBridgedWorkerChild,
      logger: noopLogger,
      nowMs: () => Date.now(),
    });
    const entry = bashInteractiveEntry(shell);
    const tools = buildTools(registry, entry);

    const created = await tools.create.execute("create-call", { allowId: "bash", command: shell, cols: 80, rows: 24 });
    const { sessionId } = created.details as { sessionId: string };

    const waited = await tools.wait.execute("wait-call", { sessionId, forIdleMs: 120, timeoutMs: 4000 });
    const body = waited.details as WaitResult;
    expect(body.isComplete).toBe(true);
    expect(["idle", "text", "exit"]).toContain(body.reason);

    await registry.cleanup();
  });

  it("wait with an impossible forText + a short timeout resolves isComplete:false (the honest timeout, end-to-end)", async () => {
    const shell = realShell();
    const registry = createTerminalSessionRegistry({
      spawnWorker: makeBridgedWorkerChild,
      logger: noopLogger,
      nowMs: () => Date.now(),
    });
    const entry = bashInteractiveEntry(shell);
    const tools = buildTools(registry, entry);

    const created = await tools.create.execute("create-call", { allowId: "bash", command: shell, cols: 80, rows: 24 });
    const { sessionId } = created.details as { sessionId: string };

    // A huge idle window (never fires under the scaled timer in this short test) +
    // an impossible forText -> only the overall timeout fires -> isComplete:false.
    const waited = await tools.wait.execute("wait-call", {
      sessionId,
      forIdleMs: 9_000_000,
      forText: "THIS_NEVER_APPEARS_ON_SCREEN",
      timeoutMs: 600,
    });
    const body = waited.details as WaitResult;
    expect(body.isComplete).toBe(false);
    expect(body.reason).toBe("timeout");
    expect(body.matched).toBe(false);

    await registry.cleanup();
  });
});

describe("terminal interaction round-trip — resize keeps geometry coherent", () => {
  it("resize { cols:100, rows:30 } resolves { ok:true } and a subsequent list reflects cols:100", async () => {
    const shell = realShell();
    const registry = createTerminalSessionRegistry({
      spawnWorker: makeBridgedWorkerChild,
      logger: noopLogger,
      nowMs: () => Date.now(),
    });
    const entry = bashInteractiveEntry(shell);
    const tools = buildTools(registry, entry);

    const created = await tools.create.execute("create-call", { allowId: "bash", command: shell, cols: 80, rows: 24 });
    const { sessionId } = created.details as { sessionId: string };

    const resized = await tools.resize.execute("resize-call", { sessionId, cols: 100, rows: 30 });
    expect((resized.details as { ok: boolean }).ok).toBe(true);

    // The registry updated the handle geometry on the ok reply — a read
    // reflects the new cols (the snapshot stays coherent through the stack).
    const view = (await tools.read.execute("read-call", { sessionId })).details as { cols: number; rows: number };
    expect(view.cols).toBe(100);
    expect(view.rows).toBe(30);

    await registry.cleanup();
  });
});
