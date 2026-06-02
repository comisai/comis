// SPDX-License-Identifier: Apache-2.0
/**
 * TR-01 (Linux/VPS) — the LIVE create→read→kill round-trip under the real
 * process boundary + the 118-proven `--permission` worker posture, driving a
 * real PTY via node-pty `forkpty`. Mirrors `bwrap-egress-integration.test.ts`'s
 * gate: `describe.skipIf(process.platform !== "linux")` so it COMPILES + SKIPS
 * on the macOS author box and runs live on `comisvps` (where forkpty + bwrap
 * work). The orchestrator flips it green on the VPS post-execute.
 *
 * Unlike the macOS sibling (which forces the degraded pipe backend because this
 * box's node-pty cannot `posix_spawnp`), here the worker uses the REAL pty
 * backend, and the bare-metal fail-closed (bwrap removed → create rejects) is
 * also exercisable on the VPS.
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
import { createTerminalWorker, defaultLoadPty } from "./terminal-worker-entry.js";
import { encodeFrame, createFrameDecoder, type TerminalRequestFrame } from "./terminal-ipc.js";
import type { AllowEntryLike } from "./allowlist-matcher.js";

function isLinux(): boolean {
  return process.platform === "linux";
}

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

function realShell(): string {
  for (const candidate of ["/bin/bash", "/usr/bin/bash", "/bin/sh"]) {
    try {
      return realpathSync(candidate);
    } catch {
      /* next */
    }
  }
  throw new Error("no shell binary");
}

/**
 * The in-process bridge — same as the macOS sibling but wiring the REAL node-pty
 * loader (`defaultLoadPty`) so the worker drives a live PTY via forkpty on the
 * VPS. The OS pipe is still bridged in-process here; the FULL separate-process
 * `buildProductionSpawnWorker` posture is exercised by the daemon wiring + the
 * VPS smoke at a higher tier.
 */
function makeBridgedPtyWorkerChild(): FakeWorkerChild {
  const worker = createTerminalWorker({ loadPty: defaultLoadPty, logger: noopLogger });
  const decoder = createFrameDecoder();
  let onStdout: ((chunk: Buffer) => void) | undefined;
  const child: FakeWorkerChild = {
    pid: 4243,
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
    agentId: "agent-roundtrip-linux",
  };
}

describe.skipIf(!isLinux())("TR-01 (Linux) — live PTY create→read→kill round-trip under the worker posture", () => {
  it("creates a real-PTY session, reads its grid, kills it, and it drops from list", async () => {
    const shell = realShell();
    const registry = createTerminalSessionRegistry({
      spawnWorker: makeBridgedPtyWorkerChild,
      logger: noopLogger,
      nowMs: () => Date.now(),
    });
    const entry: AllowEntryLike = {
      id: "bash",
      match: { path: shell, argsPrefix: ["--norc", "--noprofile", "-c", "echo TR01_LINUX_OK; sleep 0.3"] },
    };

    const createTool = createTerminalSessionCreateTool(toolDeps(registry, entry));
    const readTool = createTerminalSessionReadTool(toolDeps(registry, entry));
    const listTool = createTerminalSessionListTool(toolDeps(registry, entry));
    const killTool = createTerminalSessionKillTool(toolDeps(registry, entry));

    const created = await createTool.execute("create-call", { allowId: "bash", command: shell, cols: 100, rows: 30 });
    const { sessionId } = created.details as { sessionId: string };
    expect(sessionId.length).toBeGreaterThan(0);

    let screen = "";
    for (let i = 0; i < 40; i++) {
      const res = await readTool.execute("read-call", { sessionId });
      screen = (res.details as { screen: string }).screen;
      if (screen.includes("TR01_LINUX_OK")) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    // On a live PTY the marker renders onto the grid.
    expect(screen).toContain("TR01_LINUX_OK");

    const before = (await listTool.execute("list-call", {})).details as Array<{ sessionId: string }>;
    expect(before.map((r) => r.sessionId)).toContain(sessionId);

    const killed = await killTool.execute("kill-call", { sessionId });
    expect((killed.details as { ok: boolean }).ok).toBe(true);

    const after = (await listTool.execute("list-call", {})).details as Array<{ sessionId: string }>;
    expect(after.map((r) => r.sessionId)).not.toContain(sessionId);

    await registry.cleanup();
  });
});
