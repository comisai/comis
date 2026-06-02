// SPDX-License-Identifier: Apache-2.0
/**
 * TR-01 — the headline create→read→kill→list round-trip on an allowlisted bash,
 * wired through the REAL TerminalSessionRegistry (119-03) + the REAL Terminal
 * Worker (`createTerminalWorker`, 119-03) + the REAL allowlist matcher (119-02),
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
 * Per the plan that still yields a stable sessionId + a (text) grid; the pty-grid
 * richness is asserted on the VPS where forkpty works.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { realpathSync } from "node:fs";

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
import { createTerminalWorker } from "./terminal-worker-entry.js";
import { encodeFrame, createFrameDecoder, type TerminalRequestFrame } from "./terminal-ipc.js";
import type { AllowEntryLike } from "./allowlist-matcher.js";

// Barrel re-export check (Test 2): the 9 factories + the registry must be
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
function makeBridgedWorkerChild(): FakeWorkerChild {
  // A real worker with the pipe backend forced (this box's node-pty can't spawn).
  const worker = createTerminalWorker({
    loadPty: () => {
      throw new Error("node-pty forced unavailable on this host (degraded pipe backend)");
    },
    logger: noopLogger,
  });

  const decoder = createFrameDecoder();
  let onStdout: ((chunk: Buffer) => void) | undefined;
  const stdinDecoder = decoder;

  const child: FakeWorkerChild = {
    pid: 4242,
    stdin: {
      write(chunk: Buffer): boolean {
        // Decode any complete request frames and dispatch them to the worker.
        for (const frame of stdinDecoder.push(chunk)) {
          void worker.handle(frame as TerminalRequestFrame).then((reply) => {
            onStdout?.(encodeFrame(reply));
          });
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

describe("TR-01 — create→read→kill→list round-trip (real registry + worker, degraded pipe backend)", () => {
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

    // LIST — the killed session has dropped (TR-01 headline).
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
