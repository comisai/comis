// SPDX-License-Identifier: Apache-2.0
/**
 * (Linux/VPS) — the LIVE **separate-process** worker fork the production daemon
 * actually uses: `buildProductionSpawnWorker(resolveWorkerMainPath(), dataDir)`
 * forks `node <--permission posture> terminal-worker-main.js`, and the registry
 * drives create→read→kill over the REAL §2.3 stdio IPC.
 *
 * This is the coverage that was missing: every other terminal test injects the
 * in-process `makeBridgedPtyWorkerChild` double, so the production fork path
 * (the daemon's actual behavior) had ZERO coverage — which is how a missing
 * `worker-main.js` shipped as "complete". This test forks the genuine entry.
 *
 * It runs against the BUILT dist worker-main (the daemon forks compiled JS, not
 * the `.ts` source), so it `skipIf`s when the dist isn't built. Two tiers:
 *   - Part A (any Linux): NO bwrapPath → the worker forks, the IPC round-trips,
 *     and the worker FAIL-CLOSES (`ok:false`, session not alive) — proving the
 *     fork + frame-pump + IPC server half work end-to-end (SEC-16, no unjailed spawn).
 *   - Part B (`skipIf` no bwrap): real bwrapPath → create a jailed bash PTY, read
 *     its grid, kill it — the full jailed round-trip through the real fork.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { realpathSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve as pathResolve } from "node:path";

import {
  createTerminalSessionCreateTool,
  createTerminalSessionReadTool,
  createTerminalSessionListTool,
  createTerminalSessionKillTool,
  type TerminalToolDeps,
} from "./terminal-tools.js";
import { createTerminalSessionRegistry } from "./terminal-session-registry.js";
import { createSessionCaps } from "./terminal-caps.js";
import { buildProductionSpawnWorker } from "./terminal-worker-launch.js";
import type { AllowEntryLike, TerminalScope } from "./allowlist-matcher.js";

function isLinux(): boolean {
  return process.platform === "linux";
}

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** The compiled worker entry the daemon forks (dist sibling of this src test). */
function distWorkerMainPath(): string {
  return fileURLToPath(
    new URL("../../../../dist/tools/builtin/terminal-driver/terminal-worker-main.js", import.meta.url),
  );
}

function bwrapPathOrUndefined(): string | undefined {
  try {
    return execFileSync("which", ["bwrap"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function realShell(): string {
  for (const c of ["/bin/bash", "/usr/bin/bash", "/bin/sh"]) {
    try {
      return realpathSync(c);
    } catch {
      /* next */
    }
  }
  throw new Error("no shell binary");
}

const WORKSPACE_SCOPE: TerminalScope = {
  filesystem: "workspace",
  network: "none",
  credentialPaths: [],
  uid: "dedicated",
};

function toolDeps(
  registry: ReturnType<typeof createTerminalSessionRegistry>,
  entry: AllowEntryLike,
): TerminalToolDeps {
  return {
    registry,
    allowEntries: [entry],
    detectProvider: () => ({}) as never,
    logger: noopLogger,
    eventBus: { emit: () => true },
    nowMs: () => Date.now(),
    agentId: "agent-worker-fork-linux",
    caps: createSessionCaps(undefined, () => Date.now()),
  };
}

const distBuilt = existsSync(distWorkerMainPath());

describe.skipIf(!isLinux() || !distBuilt)(
  "Linux — production SEPARATE-PROCESS worker fork (buildProductionSpawnWorker → node worker-main.js)",
  () => {
    const dataDir = pathResolve(tmpdir(), "comis-worker-fork-test");
    const realFork = () => buildProductionSpawnWorker(distWorkerMainPath(), dataDir)();

    it("Part A: forks the real worker, the IPC round-trips, and a no-bwrap create FAIL-CLOSES (ok:false, not alive)", async () => {
      const shell = realShell();
      const registry = createTerminalSessionRegistry({
        spawnWorker: realFork,
        logger: noopLogger,
        nowMs: () => Date.now(),
        // No bwrapPath → the worker must fail-closed (never an unjailed spawn).
      });
      const entry: AllowEntryLike = {
        id: "bash",
        match: { path: shell, argsPrefix: ["--norc", "--noprofile", "-c", "echo NOJAIL"] },
        scope: WORKSPACE_SCOPE,
      };
      const createTool = createTerminalSessionCreateTool(toolDeps(registry, entry));
      const listTool = createTerminalSessionListTool(toolDeps(registry, entry));

      const created = await createTool.execute("create-a", { allowId: "bash", command: shell, cols: 80, rows: 24 });
      const details = created.details as { sessionId?: string; alive?: boolean };
      // The real worker forked + the create frame round-tripped over IPC; with no
      // bwrap the worker fail-closed, so no live session exists (SEC-16). Either the
      // create reports not-alive, or the session never lands in list as alive.
      const list = (await listTool.execute("list-a", {})).details as Array<{ sessionId: string; alive: boolean }>;
      const live = list.find((s) => s.sessionId === details.sessionId && s.alive);
      expect(live).toBeUndefined();

      await registry.cleanup();
    }, 30000);

    it.skipIf(!bwrapPathOrUndefined())(
      "Part B: forks the real worker + jails a bash PTY (bwrap), reads its grid (wrapped), kills it",
      async () => {
        const shell = realShell();
        const registry = createTerminalSessionRegistry({
          spawnWorker: realFork,
          logger: noopLogger,
          nowMs: () => Date.now(),
          bwrapPath: bwrapPathOrUndefined(),
        });
        const entry: AllowEntryLike = {
          id: "bash",
          match: { path: shell, argsPrefix: ["--norc", "--noprofile", "-c", "echo FORK_JAIL_OK; sleep 0.4"] },
          scope: WORKSPACE_SCOPE,
        };
        const createTool = createTerminalSessionCreateTool(toolDeps(registry, entry));
        const readTool = createTerminalSessionReadTool(toolDeps(registry, entry));
        const killTool = createTerminalSessionKillTool(toolDeps(registry, entry));

        const created = await createTool.execute("create-b", { allowId: "bash", command: shell, cols: 100, rows: 30 });
        const { sessionId } = created.details as { sessionId: string };
        expect(sessionId.length).toBeGreaterThan(0);

        let screen = "";
        for (let i = 0; i < 60; i++) {
          const res = await readTool.execute("read-b", { sessionId });
          screen = (res.details as { screen: string }).screen;
          if (screen.includes("FORK_JAIL_OK")) break;
          await new Promise((r) => setTimeout(r, 25));
        }
        // The read goes through the tool layer → §3.6 untrusted-content wrap + the
        // live PTY genuinely rendered the marker inside it.
        expect(screen).toMatch(/<<<UNTRUSTED_[a-f0-9]+>>>/);
        expect(screen).toContain("FORK_JAIL_OK");

        const killed = await killTool.execute("kill-b", { sessionId });
        expect((killed.details as { ok: boolean }).ok).toBe(true);

        await registry.cleanup();
      },
      45000,
    );
  },
);
