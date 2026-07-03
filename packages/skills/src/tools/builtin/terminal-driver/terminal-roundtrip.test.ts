// SPDX-License-Identifier: Apache-2.0
/**
 * The headline create→read→kill→list round-trip on an allowlisted bash,
 * wired through the REAL TerminalSessionRegistry + the REAL Terminal
 * Worker (`createTerminalWorker`) + the REAL allowlist matcher,
 * driving a REAL bash subprocess.
 *
 * The OS process boundary is stood in for by an IN-PROCESS pipe bridge (a fake
 * child whose stdin/stdout pump frames straight into `worker.handle`) so the
 * full daemon-side path runs deterministically on macOS: tool → matchAllowEntry
 * → buildDirectSpawn → registry.create → encodeFrame → worker.handleCreate →
 * spawn bash → ring → read reply → decode → tool. The LIVE process-boundary +
 * `--permission`/bwrap posture round-trip is the VPS-gated `.linux.test.ts`.
 *
 * Backend: this box's node-pty prebuild cannot `posix_spawnp` (the macOS
 * spawn-helper is non-functional here), so the worker is wired with a `loadPty`
 * that throws → the DEGRADED pipe backend (a real `child_process.spawn` of bash).
 * That still yields a stable sessionId + a (text) grid; the pty-grid
 * richness is asserted on the VPS where forkpty works.
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
  createTerminalSessionKillTool,
  type TerminalToolDeps,
} from "./terminal-tools.js";
import {
  createTerminalSessionRegistry,
  type FakeWorkerChild,
} from "./terminal-session-registry.js";
import { createSessionCaps } from "./terminal-caps.js";
import { createTerminalWorker } from "./terminal-worker-entry.js";
import { encodeFrame, createFrameDecoder, type TerminalRequestFrame } from "./terminal-ipc.js";
import type { AllowEntryLike } from "./allowlist-matcher.js";

// Barrel re-export check: the 9 factories + the registry must be
// importable from the terminal-driver barrel (re-exported onward by the
// `./tools` subpath; the daemon wiring is the public-export consumer).
import * as barrel from "./index.js";

const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** Resolve a real shell binary on the test host. */
function realShell(): string {
  for (const candidate of ["/bin/bash", "/usr/bin/bash", "/bin/sh"]) {
    try {
      return realpathSync(candidate);
    } catch {
      /* try next */
    }
  }
  throw new Error("no shell binary on test host");
}

/**
 * An in-process bridge: a fake worker child whose stdin decodes request frames,
 * runs them through a REAL `createTerminalWorker` (degraded pipe backend), and
 * pushes the encoded replies back through the registered stdout `data` callback.
 * This replaces the OS pipe so the full daemon-side path runs on macOS.
 */
/**
 * macOS jail-unwrapping pipe spawner: the worker spawns
 * `bwrap [scopeArgs] -- bin ...argv` for BOTH backends. There is no real bwrap on
 * the macOS author box, so this in-process bridge UNWRAPS the jail — it spawns the
 * child that appears AFTER the `--` separator directly. This keeps the deterministic
 * macOS daemon-path round-trip alive; the LIVE bwrap jail enforcement (bwrap as
 * arg0, the scope matrix, the real child INSIDE the namespaces) is the VPS-gated
 * `.linux.test.ts` sibling. The bwrap argv composition itself is unit-
 * asserted on macOS in terminal-worker-entry.test.ts (recording pty.spawn).
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
  // A real worker with the pipe backend forced (this box's node-pty can't spawn) +
  // a resolved bwrapPath (so the fail-closed branch passes) + the macOS
  // jail-unwrapping spawnPipe (the real bwrap jail is the VPS .linux sibling).
  const worker = createTerminalWorker({
    loadPty: () => {
      throw new Error("node-pty forced unavailable on this host (degraded pipe backend)");
    },
    spawnPipe: unwrapBwrapSpawn,
    bwrapPath: "/usr/bin/bwrap",
    logger: noopLogger,
  });

  const decoder = createFrameDecoder();
  let onStdout: ((chunk: Buffer) => void) | undefined;
  const stdinDecoder = decoder;
  // The serialization queue — frames are handled in arrival order (a real worker's
  // sequential frame loop), so create's async jail composition finishes (and the
  // backend attaches) before a subsequent read/kill frame runs.
  let frameQueue: Promise<void> = Promise.resolve();

  const child: FakeWorkerChild = {
    pid: 4242,
    stdin: {
      write(chunk: Buffer): boolean {
        // Decode complete request frames and dispatch them to the worker IN ORDER.
        for (const frame of stdinDecoder.push(chunk)) {
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
    agentId: "agent-roundtrip",
    // No-limit caps (these round-trips assert the create/read/kill path, not the
    // caps; a pass-through caps keeps every send audited but never rejected/evicted).
    caps: createSessionCaps(undefined, () => Date.now()),
  };
}

/** Poll the registry read until the ring is non-empty (the bash echo arrived) or a cap. */
async function readUntilGrid(
  readTool: ReturnType<typeof createTerminalSessionReadTool>,
  sessionId: string,
): Promise<{ screen: string; cols: number; rows: number; alive: boolean }> {
  for (let i = 0; i < 40; i++) {
    const res = await readTool.execute("read-call", { sessionId });
    const view = res.details as { screen: string; cols: number; rows: number; alive: boolean };
    if (view.screen.includes("TR01_OK")) return view;
    await new Promise((r) => setTimeout(r, 25));
  }
  // Final read regardless (assert the shape even if the marker raced).
  const res = await readTool.execute("read-call", { sessionId });
  return res.details as { screen: string; cols: number; rows: number; alive: boolean };
}

describe("create→read→kill→list round-trip (real registry + worker, degraded pipe backend)", () => {
  it("creates a session, reads a grid, kills it, and the killed id drops from list", async () => {
    const shell = realShell();
    const registry = createTerminalSessionRegistry({
      spawnWorker: makeBridgedWorkerChild,
      logger: noopLogger,
      nowMs: () => Date.now(),
    });
    // Drive bash to print a marker then stay briefly alive so read can observe it.
    const entry: AllowEntryLike = {
      id: "bash",
      match: { path: shell, argsPrefix: ["--norc", "--noprofile", "-c", "echo TR01_OK; sleep 0.3"] },
    };

    const createTool = createTerminalSessionCreateTool(toolDeps(registry, entry));
    const readTool = createTerminalSessionReadTool(toolDeps(registry, entry));
    const listTool = createTerminalSessionListTool(toolDeps(registry, entry));
    const killTool = createTerminalSessionKillTool(toolDeps(registry, entry));

    // CREATE — a stable, non-empty sessionId.
    const created = await createTool.execute("create-call", { allowId: "bash", command: shell, cols: 100, rows: 30 });
    const { sessionId } = created.details as { sessionId: string };
    expect(typeof sessionId).toBe("string");
    expect(sessionId.length).toBeGreaterThan(0);

    // READ — a grid (the bash marker) + the read shape.
    const view = await readUntilGrid(readTool, sessionId);
    expect(typeof view.screen).toBe("string");
    expect(view.screen).toContain("TR01_OK");
    expect(view.cols).toBe(100);
    expect(view.rows).toBe(30);

    // LIST — the live session is present before the kill.
    const before = (await listTool.execute("list-call", {})).details as Array<{ sessionId: string }>;
    expect(before.map((r) => r.sessionId)).toContain(sessionId);

    // KILL — { ok }.
    const killed = await killTool.execute("kill-call", { sessionId });
    expect((killed.details as { ok: boolean }).ok).toBe(true);

    // LIST — the killed session has dropped (the headline assertion).
    const after = (await listTool.execute("list-call", {})).details as Array<{ sessionId: string }>;
    expect(after.map((r) => r.sessionId)).not.toContain(sessionId);

    await registry.cleanup();
  });
});

describe("barrel — the 9 factories + the registry are importable from @comis/skills", () => {
  it("re-exports the implemented + stub factories + the registry constructor", () => {
    const names = [
      "createTerminalSessionCreateTool",
      "createTerminalSessionReadTool",
      "createTerminalSessionListTool",
      "createTerminalSessionKillTool",
      "createTerminalSessionSendTextTool",
      "createTerminalSessionSendKeyTool",
      "createTerminalSessionWaitTool",
      "createTerminalSessionStatusTool",
      "createTerminalSessionResizeTool",
      "createTerminalSessionRegistry",
    ] as const;
    for (const name of names) {
      expect(typeof (barrel as Record<string, unknown>)[name]).toBe("function");
    }
  });
});

// ===========================================================================
// The read tool's format/scrollback params reach the worker END-TO-END
// (real registry + real worker + real bash, through the REAL read tool — NOT a
// FakeRegistry). Proves the schema-only gap is closed at the seam: ansi
// carries SGR while text strips it, and scrollback exposes an off-screen line the
// default read omits — all observed through `readTool.execute(...)`.
// ===========================================================================

/** Read the grid through the real read tool with the given params; poll until a marker lands. */
async function readToolUntil(
  readTool: ReturnType<typeof createTerminalSessionReadTool>,
  sessionId: string,
  params: Record<string, unknown>,
  marker: string,
): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const res = await readTool.execute("read-call", { sessionId, ...params });
    const view = res.details as { screen: string };
    if (view.screen.includes(marker)) return view.screen;
    await new Promise((r) => setTimeout(r, 25));
  }
  const res = await readTool.execute("read-call", { sessionId, ...params });
  return (res.details as { screen: string }).screen;
}

describe("read tool format/scrollback reach the worker end-to-end (through the real tool)", () => {
  it("ansi preserves SGR while text strips it, and scrollback surfaces an off-screen line", async () => {
    const shell = realShell();
    const registry = createTerminalSessionRegistry({
      spawnWorker: makeBridgedWorkerChild,
      logger: noopLogger,
      nowMs: () => Date.now(),
    });
    // Emit a RED-coloured marker line (SGR), then 60 numbered lines so the early
    // ones scroll above a 24-row viewport. `MARK_END` is the last line (always in
    // the viewport) so the poll terminates on a settled grid.
    const script =
      'printf "\\033[31mREDMARK\\033[0m\\n"; for i in $(seq 1 60); do echo "LINE-$i"; done; echo MARK_END; sleep 0.4';
    const entry: AllowEntryLike = {
      id: "bash",
      match: { path: shell, argsPrefix: ["--norc", "--noprofile", "-c", script] },
    };

    const createTool = createTerminalSessionCreateTool(toolDeps(registry, entry));
    const readTool = createTerminalSessionReadTool(toolDeps(registry, entry));

    const created = await createTool.execute("create-call", { allowId: "bash", command: shell, cols: 80, rows: 24 });
    const { sessionId } = created.details as { sessionId: string };

    // ANSI: the SGR escape survives (serialize() preserves it).
    const ansi = await readToolUntil(readTool, sessionId, { format: "ansi" }, "MARK_END");
    expect(ansi).toContain("\x1b[");

    // TEXT (default format): the plain grid strips SGR — no escape bytes.
    const text = await readToolUntil(readTool, sessionId, { format: "text" }, "MARK_END");
    expect(text).not.toContain("\x1b[");

    // The two formats differ for the SAME grid — the param genuinely reached the worker.
    expect(ansi).not.toBe(text);

    // SCROLLBACK: a deep read surfaces an early line that scrolled above the
    // 24-row viewport; the default (scrollback:0) read does not.
    const deep = await readToolUntil(readTool, sessionId, { format: "text", scrollback: 80 }, "MARK_END");
    const shallow = await readToolUntil(readTool, sessionId, { format: "text", scrollback: 0 }, "MARK_END");
    expect(deep).toContain("LINE-1\n");
    expect(shallow).not.toContain("LINE-1\n");

    await registry.cleanup();
  });
});
