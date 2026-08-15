// SPDX-License-Identifier: Apache-2.0
/**
 * (Linux/VPS) — the LIVE **separate-process** worker fork the production daemon
 * actually uses: `buildProductionSpawnWorker(resolveWorkerMainPath(), dataDir)`
 * forks `node <--permission posture> terminal-worker-main.js`, and the registry
 * drives create→read→kill over the REAL stdio IPC.
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
 *     fork + frame-pump + IPC server half work end-to-end (no unjailed spawn).
 *   - Part B (`skipIf` no bwrap): real bwrapPath → create a jailed bash PTY, read
 *     its grid, kill it — the full jailed round-trip through the real fork.
 *   - Part C: a managed terminal can read and write only its leased root, cannot
 *     reach a sibling lease or service credential, reaches one host Unix socket
 *     only at its fixed target, and stops every call after confirmed termination.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import { createServer } from "node:net";
import { err, ok, type Result } from "@comis/shared";

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
import { managedTerminalAttachmentTargetPath } from "./terminal-managed-binding.js";
import {
  buildTmuxHasSessionArgv,
  buildTmuxKillArgv,
  tmuxSocketPathForSession,
} from "./terminal-tmux-backend.js";
import { terminalWorkerDir } from "./terminal-worker-main.js";
import type { SessionDescriptor } from "./terminal-reattach-match.js";
import type { SessionDescriptorStorePort } from "./terminal-session-reattach.js";

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

function tmuxPathOrUndefined(): string | undefined {
  try {
    return execFileSync("which", ["tmux"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function tmuxExitStatus(argv: string[]): Result<number | null, Error> {
  const [command, ...args] = argv;
  if (command === undefined) return err(new Error("tmux command is unavailable"));
  const completed = spawnSync(command, args, { stdio: "ignore" });
  return completed.error === undefined ? ok(completed.status) : err(completed.error);
}

function killTmuxAndConfirm(tmuxPath: string, name: string, socketPath?: string): Result<void, Error> {
  if (socketPath === undefined) return err(new Error("tmux socket authority is unavailable"));
  tmuxExitStatus(buildTmuxKillArgv({ tmuxPath, socketPath, name }));
  const probe = tmuxExitStatus(buildTmuxHasSessionArgv({ tmuxPath, socketPath, name }));
  if (!probe.ok) return probe;
  return probe.value === 0
    ? err(new Error("tmux session remained alive after termination"))
    : ok(undefined);
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
  ephemeralWritablePaths: [],
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
      // bwrap the worker fail-closed, so no live session exists (no unjailed spawn). The
      // fail-close is ASYNC: the registry fires the create frame WITHOUT blocking the
      // turn (so `create` returns with the session still optimistically `running`),
      // then an out-of-band `ok:false` reply ("no sandbox provider: cannot materialize
      // the terminal scope jail") flips it `lost`. So POLL the list until the session
      // is gone — listing immediately races the reply on a loaded CI runner (the
      // session is briefly `alive:true` before the flip lands).
      // The budget is wall-clock, not a poll count: a 3s ceiling passed when this
      // file ran alone and failed when it ran with the other 17 linux suites on a
      // 2-core box — the fork + IPC reply simply took longer than the polls allowed.
      // A fail-closed assertion that flakes under load is one people learn to
      // ignore, so wait generously (still far under the 30s test timeout) and
      // report how long it waited, keeping "slow to fail-closed" distinguishable
      // from "never fail-closed".
      const FAIL_CLOSE_BUDGET_MS = 20_000;
      const startedAt = Date.now();
      let live: { sessionId: string; alive: boolean } | undefined;
      let waitedMs = 0;
      do {
        const list = (await listTool.execute("list-a", {})).details as Array<{ sessionId: string; alive: boolean }>;
        live = list.find((s) => s.sessionId === details.sessionId && s.alive);
        if (live === undefined) break;
        await new Promise((r) => setTimeout(r, 50));
        waitedMs = Date.now() - startedAt;
      } while (waitedMs < FAIL_CLOSE_BUDGET_MS);
      expect(live, `an unjailed session was still alive after ${waitedMs}ms with no bwrapPath`).toBeUndefined();

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
        // The read goes through the tool layer → the untrusted-content wrap + the
        // live PTY genuinely rendered the marker inside it.
        expect(screen).toMatch(/<<<UNTRUSTED_[a-f0-9]+>>>/);
        expect(screen).toContain("FORK_JAIL_OK");

        const killed = await killTool.execute("kill-b", { sessionId });
        expect((killed.details as { ok: boolean }).ok).toBe(true);

        await registry.cleanup();
      },
      45000,
    );

    it.skipIf(!bwrapPathOrUndefined() || !tmuxPathOrUndefined() || !existsSync("/usr/bin/python3"))(
      "Part C: confines a managed terminal to its leased root and fixed attachment until confirmed revocation",
      async () => {
        const scratch = realpathSync(mkdtempSync(join(tmpdir(), "terminal-attachment-")));
        const dataDir = join(scratch, "data");
        const workspace = join(scratch, "workspace");
        const siblingWorkspace = join(scratch, "sibling-workspace");
        const leasedMarkerPath = join(workspace, "lease-marker.txt");
        const leasedWritePath = join(workspace, "lease-write.txt");
        const siblingMarkerPath = join(siblingWorkspace, "sibling-marker.txt");
        const siblingWritePath = join(siblingWorkspace, "sibling-write.txt");
        const serviceCredentialPath = join(dataDir, "service-control.credential");
        const sourcePath = join(scratch, "worker.sock");
        const targetName = `attachment-${"a".repeat(32)}.sock`;
        const targetPath = managedTerminalAttachmentTargetPath(targetName);
        mkdirSync(dataDir, { mode: 0o700 });
        mkdirSync(workspace, { mode: 0o700 });
        mkdirSync(siblingWorkspace, { mode: 0o700 });
        writeFileSync(leasedMarkerPath, "LEASE_MARKER", { mode: 0o600 });
        writeFileSync(siblingMarkerPath, "SIBLING_MARKER", { mode: 0o600 });
        writeFileSync(serviceCredentialPath, "CONTROL_CREDENTIAL_MARKER", { mode: 0o600 });
        let calls = 0;
        const server = createServer((socket) => {
          socket.once("data", () => {
            calls += 1;
            socket.end("ATTACHMENT_OK\n");
          });
        });
        await new Promise<void>((resolveListen, rejectListen) => {
          server.once("error", rejectListen);
          server.listen(sourcePath, () => resolveListen());
        });
        const descriptors = new Map<string, SessionDescriptor>();
        const descriptorStore: SessionDescriptorStorePort = {
          persist: (descriptor) => {
            descriptors.set(descriptor.sessionId, descriptor);
            return ok(undefined);
          },
          recover: () => Array.from(descriptors.values()),
          remove: (sessionId) => {
            descriptors.delete(sessionId);
            return ok(undefined);
          },
        };
        const tmuxPath = tmuxPathOrUndefined();
        if (tmuxPath === undefined) throw new Error("tmux binary disappeared after test selection");
        const registry = createTerminalSessionRegistry({
          spawnWorker: buildProductionSpawnWorker(distWorkerMainPath(), dataDir),
          logger: noopLogger,
          nowMs: () => Date.now(),
          bwrapPath: bwrapPathOrUndefined(),
          tmuxSocketForSession: (sessionId) =>
            tmuxSocketPathForSession(terminalWorkerDir(dataDir), sessionId),
          durability: {
            descriptorStore,
            killTmuxSession: (name, socketPath) =>
              killTmuxAndConfirm(tmuxPath, name, socketPath),
            retireManagedSession: async () => ok(undefined),
          },
          resolveRootProcessIdentity: async (pid) => ({ pid, startIdentity: `test:${pid}` }),
          cleanupWorkspace: () => undefined,
        });
        const owner = { agentId: "agent-attachment-linux", sessionKey: "session-attachment-linux" };
        const python = [
          "import pathlib,socket,sys,time",
          "source,target,leased_marker,leased_write,sibling_marker,sibling_write,credential=sys.argv[1:8]",
          "print('LEASE_READ_OK' if pathlib.Path(leased_marker).read_text() == 'LEASE_MARKER' else 'LEASE_READ_WRONG', flush=True)",
          "pathlib.Path(leased_write).write_text('LEASE_WRITE_OK')",
          "print('LEASE_WRITE_OK', flush=True)",
          "for label,path in [('SIBLING',sibling_marker),('CONTROL_CREDENTIAL',credential)]:",
          " try:",
          "  pathlib.Path(path).read_text(); print(label + '_EXPOSED', flush=True)",
          " except OSError:",
          "  print(label + '_BLOCKED', flush=True)",
          "try:",
          " pathlib.Path(sibling_write).write_text('SIBLING_WRITE_EXPOSED'); print('SIBLING_WRITE_EXPOSED', flush=True)",
          "except OSError:",
          " print('SIBLING_WRITE_BLOCKED', flush=True)",
          "probe=socket.socket(socket.AF_UNIX)",
          "try:",
          " probe.connect(source); print('SOURCE_EXPOSED', flush=True); probe.close()",
          "except OSError:",
          " print('SOURCE_BLOCKED', flush=True)",
          "attachment_mode=pathlib.Path(target).parent.stat().st_mode & 0o777",
          "print('ATTACHMENT_DIR_OWNER_ONLY' if attachment_mode == 0o700 else 'ATTACHMENT_DIR_MODE_' + oct(attachment_mode), flush=True)",
          "attachment_calls=0",
          "while True:",
          " call=socket.socket(socket.AF_UNIX); call.connect(target); call.sendall(b'PING')",
          " response=call.recv(64).decode().strip(); call.close(); attachment_calls += 1",
          " if attachment_calls <= 2: print(response, flush=True)",
          " time.sleep(0.05)",
        ].join("\n");

        try {
          const created = await registry.create({
            allowId: "python-attachment-probe",
            bin: "/usr/bin/python3",
            argv: [
              "-c",
              python,
              sourcePath,
              targetPath,
              leasedMarkerPath,
              leasedWritePath,
              siblingMarkerPath,
              siblingWritePath,
              serviceCredentialPath,
            ],
            cols: 100,
            rows: 30,
            durable: true,
            scope: { filesystem: "workspace", network: "none", credentialPaths: [], ephemeralWritablePaths: [], uid: "daemon" },
            workspace,
            cwd: workspace,
            managedBinding: {
              managedRunId: "managed-run_attachment",
              workspaceLeaseId: "workspace-lease_attachment",
              serviceInstanceId: "service-instance_attachment",
            },
            executionAttachments: [{
              executionAttachmentId: "execution-attachment_a",
              sourcePath,
              targetName,
            }],
          }, owner);
          let screen = "";
          for (let attempt = 0; attempt < 100; attempt += 1) {
            screen = (await registry.read(created.sessionId, owner)).screen;
            if (
              screen.includes("LEASE_READ_OK")
              && screen.includes("LEASE_WRITE_OK")
              && screen.includes("SIBLING_BLOCKED")
              && screen.includes("SIBLING_WRITE_BLOCKED")
              && screen.includes("CONTROL_CREDENTIAL_BLOCKED")
              && screen.includes("SOURCE_BLOCKED")
              && screen.includes("ATTACHMENT_DIR_OWNER_ONLY")
              && screen.includes("ATTACHMENT_OK")
              && calls >= 2
            ) break;
            await new Promise((resolvePoll) => setTimeout(resolvePoll, 25));
          }
          expect(screen).toContain("LEASE_READ_OK");
          expect(screen).not.toContain("LEASE_READ_WRONG");
          expect(screen).toContain("LEASE_WRITE_OK");
          expect(readFileSync(leasedWritePath, "utf8")).toBe("LEASE_WRITE_OK");
          expect(screen).toContain("SIBLING_BLOCKED");
          expect(screen).not.toContain("SIBLING_EXPOSED");
          expect(screen).toContain("SIBLING_WRITE_BLOCKED");
          expect(screen).not.toContain("SIBLING_WRITE_EXPOSED");
          expect(existsSync(siblingWritePath)).toBe(false);
          expect(screen).toContain("CONTROL_CREDENTIAL_BLOCKED");
          expect(screen).not.toContain("CONTROL_CREDENTIAL_EXPOSED");
          expect(screen).toContain("SOURCE_BLOCKED");
          expect(screen).not.toContain("SOURCE_EXPOSED");
          expect(screen).toContain("ATTACHMENT_DIR_OWNER_ONLY");
          expect(screen).toContain("ATTACHMENT_OK");
          expect(calls).toBeGreaterThanOrEqual(2);

          await expect(registry.terminateAndConfirm(created.sessionId, owner)).resolves.toEqual({
            ok: true,
            value: undefined,
          });
          expect(descriptors.size).toBe(0);
          await new Promise((resolveDrain) => setTimeout(resolveDrain, 150));
          const callsAfterRevocation = calls;
          await new Promise((resolveProbe) => setTimeout(resolveProbe, 250));
          expect(calls).toBe(callsAfterRevocation);
        } finally {
          await registry.cleanup();
          await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
          rmSync(scratch, { recursive: true, force: true });
        }
      },
      45000,
    );
  },
);
