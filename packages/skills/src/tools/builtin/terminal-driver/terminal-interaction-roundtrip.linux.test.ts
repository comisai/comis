// SPDX-License-Identifier: Apache-2.0
/**
 * TR-03/04/05 (Linux/VPS) — the LIVE-PTY interaction round-trip: the four
 * implemented interaction tools (send_text / send_key / resize / wait) driven
 * through the REAL TerminalSessionRegistry (120-03) + the REAL Terminal Worker
 * with the REAL node-pty `forkpty` backend (`loadPty = defaultLoadPty`) + real
 * injected timers, against a real interactive program (`/bin/cat`).
 *
 * This is the macOS-unprovable half (the macOS author box's node-pty cannot
 * `posix_spawnp` in-harness — the 119-03/119-04 precedent): a real submit ->
 * settle -> observe loop AND a real control-key exit. `describe.skipIf(
 * process.platform !== "linux")` so it COMPILES + SKIPS on macOS and runs live on
 * `comisvps` (where forkpty works). The orchestrator flips it green on the VPS
 * post-execute. Mirrors the `bwrap-egress-integration.test.ts` Linux-gate idiom +
 * the 119-04 macOS sibling's bridge shape, but end-to-end through the TOOLS (not
 * the worker directly).
 *
 * `cat` is a minimal line-buffered interactive program: it echoes each submitted
 * line and exits on EOF (C-d). It needs no REPL setup and is universally present.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { realpathSync } from "node:fs";

import {
  createTerminalSessionCreateTool,
  createTerminalSessionReadTool,
  createTerminalSessionSendTextTool,
  createTerminalSessionSendKeyTool,
  createTerminalSessionResizeTool,
  createTerminalSessionWaitTool,
  type TerminalToolDeps,
} from "./terminal-tools.js";
import {
  createTerminalSessionRegistry,
  type FakeWorkerChild,
  type WaitResult,
} from "./terminal-session-registry.js";
import { createTerminalWorker, defaultLoadPty } from "./terminal-worker-entry.js";
import { encodeFrame, createFrameDecoder, type TerminalRequestFrame } from "./terminal-ipc.js";
import type { AllowEntryLike } from "./allowlist-matcher.js";

function isLinux(): boolean {
  return process.platform === "linux";
}

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** Resolve `/bin/cat` (or its realpath) on the host. */
function catPath(): string {
  for (const candidate of ["/bin/cat", "/usr/bin/cat"]) {
    try {
      return realpathSync(candidate);
    } catch {
      /* next */
    }
  }
  throw new Error("no cat binary");
}

/**
 * The in-process bridge wiring the REAL node-pty loader (`defaultLoadPty`) + REAL
 * timers so the worker drives a live PTY via forkpty on the VPS. The OS pipe is
 * still bridged in-process here; the FULL separate-process posture is exercised by
 * the daemon wiring + the VPS smoke at a higher tier.
 */
function makeBridgedPtyWorkerChild(): FakeWorkerChild {
  const worker = createTerminalWorker({ loadPty: defaultLoadPty, logger: noopLogger });
  const decoder = createFrameDecoder();
  let onStdout: ((chunk: Buffer) => void) | undefined;
  const child: FakeWorkerChild = {
    pid: 5253,
    stdin: {
      write(chunk: Buffer): boolean {
        for (const frame of decoder.push(chunk)) {
          void worker.handle(frame as TerminalRequestFrame).then((reply) => onStdout?.(encodeFrame(reply)));
        }
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
    kill(): void {},
  };
  return child;
}

function toolDeps(registry: ReturnType<typeof createTerminalSessionRegistry>, entry: AllowEntryLike): TerminalToolDeps {
  return {
    registry,
    allowEntries: [entry],
    detectProvider: () => ({}) as never,
    logger: noopLogger,
    eventBus: { emit: () => true },
    nowMs: () => Date.now(),
    agentId: "agent-interaction-linux",
  };
}

// ===========================================================================
// THE VPS LIVE-PTY INTERACTION ASSERTION (120-05, TR-03/04/05) — through the
// TOOLS. Drives a REAL `cat` via a REAL forkpty worker (real injected timers) and
// proves the full submit -> settle -> observe loop AND that a real control key
// (C-d / EOF) exits a live program — end-to-end through the agent-facing tools.
// On macOS this entire describe block is skipped.
// ===========================================================================
describe.skipIf(!isLinux())("TR-03/04/05 (Linux) — live-PTY interaction round-trip through the tools", () => {
  it("send_text(submit) echoes, wait forText observes it, then send_key C-d exits (submit->settle->observe + control key)", async () => {
    const cat = catPath();
    const registry = createTerminalSessionRegistry({
      spawnWorker: makeBridgedPtyWorkerChild,
      logger: noopLogger,
      nowMs: () => Date.now(),
    });
    const entry: AllowEntryLike = { id: "cat", match: { path: cat } };

    const createTool = createTerminalSessionCreateTool(toolDeps(registry, entry));
    const readTool = createTerminalSessionReadTool(toolDeps(registry, entry));
    const sendTextTool = createTerminalSessionSendTextTool(toolDeps(registry, entry));
    const sendKeyTool = createTerminalSessionSendKeyTool(toolDeps(registry, entry));
    const resizeTool = createTerminalSessionResizeTool(toolDeps(registry, entry));
    const waitTool = createTerminalSessionWaitTool(toolDeps(registry, entry));

    // create a real-PTY `cat` session.
    const created = await createTool.execute("create-call", { allowId: "cat", command: cat, cols: 80, rows: 24 });
    const { sessionId } = created.details as { sessionId: string };
    expect(sessionId.length).toBeGreaterThan(0);

    // submit "hello": text -> settle -> \r. `cat` echoes the line.
    await sendTextTool.execute("send-call", { sessionId, text: "hello", submit: true, bracketedPaste: false });

    // wait forText: the echoed "hello" appears (bounded; resolves on text).
    const waited = (await waitTool.execute("wait-text", { sessionId, forText: "hello", timeoutMs: 3000 }))
      .details as WaitResult;
    expect(waited.isComplete).toBe(true);

    // read: the live program echoed the submitted line.
    const screen = (await readTool.execute("read-call", { sessionId })).details as { screen: string; alive: boolean };
    expect(screen.screen).toContain("hello");
    expect(screen.alive).toBe(true);

    // resize the live PTY and confirm the geometry is coherent.
    const resized = (await resizeTool.execute("resize-call", { sessionId, cols: 100, rows: 30 })).details as {
      ok: boolean;
    };
    expect(resized.ok).toBe(true);

    // send_key C-d (EOF) -> `cat` exits. wait forExit observes the real exit.
    await sendKeyTool.execute("eof-call", { sessionId, keys: ["C-d"] });
    const exited = (await waitTool.execute("wait-exit", { sessionId, forExit: true, timeoutMs: 3000 }))
      .details as WaitResult;
    expect(exited.isComplete).toBe(true);
    expect(exited.reason).toBe("exit");

    // a final read confirms the live program is no longer alive.
    const finalView = (await readTool.execute("read-final", { sessionId })).details as { alive: boolean };
    expect(finalView.alive).toBe(false);

    await registry.cleanup();
  });
});
