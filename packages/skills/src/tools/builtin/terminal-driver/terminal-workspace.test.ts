// SPDX-License-Identifier: Apache-2.0
/**
 * Per-session jail workspace allocation.
 *
 * The create path must ALLOCATE a real per-session workspace directory and thread
 * it as `workspace`+`cwd` onto the create frame, so the worker's `buildSpawnPlan`
 * binds it RW + `--chdir`s into it. Without this the plan defaults the jail
 * workspace/cwd to the daemon HOME — unusable under `--uid 65534` (nobody cannot
 * chdir HOME), and at `filesystem:workspace` binding HOME would be far too broad.
 * `terminal-interaction-roundtrip.linux.test.ts` fails `created.ok:false` for
 * exactly this (the jailed `cat` cannot spawn with the HOME cwd under uid 65534).
 *
 * These macOS tests prove two things RED-first:
 *   1. {@link allocateSessionWorkspace} creates a REAL dir that EXISTS and is
 *      mode-accessible to a net-new uid (world rwx — the jail child runs as 65534,
 *      not the daemon uid, so it must be able to chdir + create files), keyed to the
 *      session id; {@link cleanupSessionWorkspace} removes it best-effort.
 *   2. The registry's `create` allocates a workspace and threads a REAL existing dir
 *      onto the create frame's `workspace`+`cwd`, and `kill` cleans it up.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, statSync, rmSync } from "node:fs";

import {
  allocateSessionWorkspace,
  cleanupSessionWorkspace,
  prepareAgentTerminalWorkspace,
  AGENT_TERMINAL_SUBDIR,
} from "./terminal-workspace.js";
import {
  createTerminalSessionRegistry,
  type TerminalSessionRegistryDeps,
  type FakeWorkerChild,
} from "./terminal-session-registry.js";
import {
  encodeFrame,
  createFrameDecoder,
  type TerminalRequestFrame,
  type TerminalReplyFrame,
} from "./terminal-ipc.js";

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** A fake worker child that records every create frame the registry writes. */
function makeFakeWorker(
  autoReply?: (frame: TerminalRequestFrame) => TerminalReplyFrame | undefined,
): { child: FakeWorkerChild; requestFrames: TerminalRequestFrame[] } {
  const emitter = new EventEmitter();
  const requestFrames: TerminalRequestFrame[] = [];
  const decoder = createFrameDecoder();
  const stdout = new EventEmitter();
  const stdin = {
    write: (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) {
        const req = frame as TerminalRequestFrame;
        requestFrames.push(req);
        const reply = autoReply?.(req);
        if (reply) queueMicrotask(() => stdout.emit("data", encodeFrame(reply)));
      }
      return true;
    },
  };
  const child: FakeWorkerChild = {
    pid: 4242,
    stdin: stdin as unknown as FakeWorkerChild["stdin"],
    stdout: stdout as unknown as FakeWorkerChild["stdout"],
    on: (event: string, cb: (arg?: unknown) => void) => {
      emitter.on(event, cb);
      return child;
    },
    kill: vi.fn(),
  };
  return { child, requestFrames };
}

function baseDeps(
  spawnWorker: TerminalSessionRegistryDeps["spawnWorker"],
  over: Partial<TerminalSessionRegistryDeps> = {},
): TerminalSessionRegistryDeps {
  return { spawnWorker, logger: makeLogger(), nowMs: () => 1_700_000_000_000, ...over };
}

/** Single owner threaded through these registry calls (create/kill are owner-scoped). */
const OWNER = { agentId: "a", sessionKey: "s" };

describe("allocateSessionWorkspace — a real per-session jail workspace (gap 2)", () => {
  it("creates a real directory that exists and is keyed to the session id", () => {
    const sessionId = "11111111-2222-3333-4444-555555555555";
    const { workspace } = allocateSessionWorkspace(sessionId);
    try {
      expect(existsSync(workspace)).toBe(true);
      expect(statSync(workspace).isDirectory()).toBe(true);
      // The dir name carries a session-derived tag so an operator can correlate it.
      expect(workspace).toContain("comis-terminal-");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("makes the workspace mode-accessible to the net-new uid (world rwx; the child runs as 65534)", () => {
    const { workspace } = allocateSessionWorkspace("aaaa");
    try {
      // The jailed child runs as uid 65534 (nobody), NOT the daemon uid, so it must
      // be able to chdir into + create files in the bound workspace. The mkdtemp
      // default (0o700, daemon-owned) would deny that — assert the low 3 perm bits
      // grant world rwx (the dir is a throwaway, isolated, cleaned on kill).
      const mode = statSync(workspace).mode & 0o777;
      expect(mode & 0o007).toBe(0o007); // world rwx — nobody can enter + write
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("cleanupSessionWorkspace removes the directory (best-effort, idempotent)", () => {
    const { workspace } = allocateSessionWorkspace("bbbb");
    expect(existsSync(workspace)).toBe(true);
    cleanupSessionWorkspace(workspace);
    expect(existsSync(workspace)).toBe(false);
    // Idempotent — a second cleanup (already gone) does not throw.
    expect(() => cleanupSessionWorkspace(workspace)).not.toThrow();
  });
});

describe("prepareAgentTerminalWorkspace — the PERSISTENT, agent-scoped workspace (daemon allocator)", () => {
  it("returns <agentWorkspaceDir>/terminal and creates it world-rwx + recursive (reusable across sessions)", () => {
    const calls: { mkdir: string[]; chmod: Array<[string, number]> } = { mkdir: [], chmod: [] };
    const ws = prepareAgentTerminalWorkspace("/home/u/.comis/workspace/agent-a", {
      mkdir: (p) => calls.mkdir.push(p),
      chmod: (p, m) => calls.chmod.push([p, m]),
    });
    const expected = `/home/u/.comis/workspace/agent-a/${AGENT_TERMINAL_SUBDIR}`;
    expect(ws).toBe(expected);
    // mkdir is recursive (idempotent across the agent's sessions) + chmod is world-rwx
    // (a jailed dedicated-uid child must be able to write the daemon-owned dir).
    expect(calls.mkdir).toEqual([expected]);
    expect(calls.chmod).toEqual([[expected, 0o777]]);
  });

  it("really creates the dir on disk (default fs deps) and is idempotent on a second call", () => {
    const base = allocateSessionWorkspace("agent-root").workspace; // a throwaway agent-workspace stand-in
    try {
      const ws1 = prepareAgentTerminalWorkspace(base);
      expect(existsSync(ws1)).toBe(true);
      expect(ws1.endsWith(`/${AGENT_TERMINAL_SUBDIR}`)).toBe(true);
      expect(statSync(ws1).mode & 0o007).toBe(0o007); // world rwx
      // Idempotent: a second prepare on the same agent dir does not throw (recursive mkdir).
      expect(() => prepareAgentTerminalWorkspace(base)).not.toThrow();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("createTerminalSessionRegistry — threads a real per-session workspace onto the create frame (gap 2)", () => {
  it("create allocates a real existing dir and threads it as workspace+cwd on the frame", async () => {
    const fake = makeFakeWorker();
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child));

    await registry.create({ allowId: "cat", bin: "/bin/cat", argv: [], cols: 80, rows: 24 }, OWNER);

    const createFrame = fake.requestFrames.find((f) => f.method === "create");
    expect(createFrame).toBeDefined();
    const workspace = createFrame?.params["workspace"];
    const cwd = createFrame?.params["cwd"];
    // A REAL, allocated dir (not undefined, not the daemon HOME default).
    expect(typeof workspace).toBe("string");
    expect((workspace as string).length).toBeGreaterThan(0);
    expect(existsSync(workspace as string)).toBe(true);
    expect(statSync(workspace as string).isDirectory()).toBe(true);
    // cwd defaults to the same workspace (the jail --chdir target).
    expect(cwd).toBe(workspace);

    await registry.cleanup();
  });

  it("kill cleans up the allocated workspace (no per-session dir leak)", async () => {
    const fake = makeFakeWorker();
    // Use the REAL default allocator/cleaner (no injection) — a stronger test: the
    // create frame carries a real dir, and kill must rm that real dir off disk.
    const registry = createTerminalSessionRegistry(baseDeps(() => fake.child));

    const { sessionId } = await registry.create({
      allowId: "cat",
      bin: "/bin/cat",
      argv: [],
      cols: 80,
      rows: 24,
    }, OWNER);
    const createFrame = fake.requestFrames.find((f) => f.method === "create");
    const allocated = createFrame?.params["workspace"] as string;
    expect(existsSync(allocated)).toBe(true);

    await registry.kill(sessionId, OWNER);

    // The killed session's real workspace dir is removed off disk (best-effort rm).
    expect(existsSync(allocated)).toBe(false);
  });
});
