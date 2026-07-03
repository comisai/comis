// SPDX-License-Identifier: Apache-2.0
/**
 * (Linux/VPS) — the LIVE create→read→kill round-trip under the real
 * process boundary + the proven `--permission` worker posture, driving a
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
import { execFileSync } from "node:child_process";

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
import { createTerminalWorker, defaultLoadPty } from "./terminal-worker-entry.js";
import { encodeFrame, createFrameDecoder, type TerminalRequestFrame } from "./terminal-ipc.js";
import type { AllowEntryLike, TerminalScope } from "./allowlist-matcher.js";

function isLinux(): boolean {
  return process.platform === "linux";
}

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * The registry threads the daemon-resolved bwrapPath onto the create frame
 * (the fail-closed provider seam). The worker now ALWAYS jails (bwrap [scope args] -- bin argv),
 * so without a bwrapPath create fails closed. Resolved once like `BwrapProvider`.
 */
function resolveBwrapPath(): string {
  return execFileSync("which", ["bwrap"], { encoding: "utf8" }).trim();
}

/**
 * The operator-declared sandbox scope on the allow entry — sourced
 * EXCLUSIVELY from the matched entry (the create tool has no scope param). bash runs
 * fine in this workspace jail; the create tool threads it onto the frame.
 */
const WORKSPACE_SCOPE: TerminalScope = {
  filesystem: "workspace",
  network: "none",
  credentialPaths: [],
  uid: "dedicated",
};

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
    // No-limit caps (the live create→read→kill round-trip does not exercise the caps).
    caps: createSessionCaps(undefined, () => Date.now()),
  };
}

describe.skipIf(!isLinux())("Linux — live PTY create→read→kill round-trip under the worker posture", () => {
  it("creates a real-PTY session, reads its grid, kills it, and it drops from list", async () => {
    const shell = realShell();
    const registry = createTerminalSessionRegistry({
      spawnWorker: makeBridgedPtyWorkerChild,
      logger: noopLogger,
      nowMs: () => Date.now(),
      // The registry threads this onto the create frame so the worker jails
      // bash (without it the worker fail-closes — no unjailed spawn).
      bwrapPath: resolveBwrapPath(),
    });
    const entry: AllowEntryLike = {
      id: "bash",
      match: { path: shell, argsPrefix: ["--norc", "--noprofile", "-c", "echo TR01_LINUX_OK; sleep 0.3"] },
      // The operator scope rides the frame to the jail composer.
      scope: WORKSPACE_SCOPE,
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
    // On a live PTY the marker renders onto the grid. This read goes through the
    // TOOL layer, so the untrusted-content rule applies: the screen is REDACTED
    // then wrapped as untrusted external content. Assert BOTH halves — the wrap IS
    // present (the injection-defense framing is not bypassed) AND the marker survives
    // INSIDE it (the live PTY genuinely rendered it). We do NOT weaken that rule.
    expect(screen).toMatch(/<<<UNTRUSTED_[a-f0-9]+>>>/); // the wrap start marker
    expect(screen).toMatch(/<<<END_UNTRUSTED_[a-f0-9]+>>>/); // the wrap end marker
    expect(screen).toContain("TR01_LINUX_OK"); // the marker, framed within the wrap

    const before = (await listTool.execute("list-call", {})).details as Array<{ sessionId: string }>;
    expect(before.map((r) => r.sessionId)).toContain(sessionId);

    const killed = await killTool.execute("kill-call", { sessionId });
    expect((killed.details as { ok: boolean }).ok).toBe(true);

    const after = (await listTool.execute("list-call", {})).details as Array<{ sessionId: string }>;
    expect(after.map((r) => r.sessionId)).not.toContain(sessionId);

    await registry.cleanup();
  });
});
