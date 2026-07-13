// SPDX-License-Identifier: Apache-2.0
/**
 * attachBackend — the backend selection under an UNSANDBOXED plan.
 *
 * An `unsandboxed` plan (operator `unsafeDisableSandbox`) runs the CLI directly (no bwrap), so it
 * MUST NOT take the tmux backend: a tmux server inherits — and would leak — the daemon env that the
 * jail's per-session `--unsetenv` normally strips (the scrubbed `plan.env` only protects the session
 * that STARTS the server; a pre-existing server bypasses it). These prove a durable `backend:"tmux"`
 * request is downgraded to the PTY path + WARN, and that `plan.cwd` reaches the direct spawn.
 */
import { describe, it, expect, vi } from "vitest";

import { attachBackend } from "./terminal-worker-backend-attach.js";
import type {
  FakePtyLike,
  PtyModuleLike,
  SessionState,
  TmuxBackendLike,
  WorkerLogger,
} from "./terminal-worker-types.js";

function fakePty(): FakePtyLike {
  return {
    pid: 123,
    onData: () => {},
    onExit: () => {},
    write: () => {},
    resize: () => {},
    kill: () => {},
  };
}

function makeState(): SessionState {
  return {
    backend: "pty",
    cols: 80,
    rows: 24,
    ring: "",
    alive: true,
    interactions: 0,
    ringListeners: new Set(),
    exitListeners: new Set(),
  };
}

function makeLogger(): WorkerLogger & { warns: unknown[] } {
  const warns: unknown[] = [];
  return {
    warns,
    info: () => {},
    warn: (obj: unknown) => {
      warns.push(obj);
    },
    error: () => {},
  } as unknown as WorkerLogger & { warns: unknown[] };
}

describe("attachBackend — unsandboxed plans never take the tmux backend", () => {
  it("downgrades a durable backend:'tmux' request to PTY (+WARN) when the plan is unsandboxed", () => {
    const ptySpawn = vi.fn(() => fakePty());
    const loadPty: () => PtyModuleLike = () => ({ spawn: ptySpawn });
    const tmuxSpawn = vi.fn(() => fakePty());
    const loadTmux: TmuxBackendLike = { spawn: tmuxSpawn, reattach: () => undefined };
    const logger = makeLogger();
    const state = makeState();

    attachBackend({
      plan: { bin: "/bin/claude", argv: ["--go"], env: {}, cwd: "/ws/projects/app", unsandboxed: true },
      cols: 80,
      rows: 24,
      state,
      loadPty,
      spawnPipe: () => {
        throw new Error("pipe not expected");
      },
      logger,
      requestedBackend: "tmux", // the operator asked for a durable drive…
      loadTmux,
      sessionId: "s1",
    });

    expect(tmuxSpawn).not.toHaveBeenCalled(); // …but tmux is refused under no-sandbox
    expect(ptySpawn).toHaveBeenCalledTimes(1);
    expect(state.backend).toBe("pty");
    // The direct spawn runs in the session's project dir (no bwrap --chdir to carry it).
    expect(ptySpawn.mock.calls[0]?.[2]).toMatchObject({ cwd: "/ws/projects/app" });
    // The downgrade is loud, never silent.
    expect(logger.warns.length).toBeGreaterThan(0);
  });

  it("CONTROL: a jailed (sandboxed) plan still takes the tmux backend for a durable request", () => {
    const tmuxSpawn = vi.fn(() => fakePty());
    const loadTmux: TmuxBackendLike = { spawn: tmuxSpawn, reattach: () => undefined };
    const state = makeState();

    attachBackend({
      plan: { bin: "/usr/bin/bwrap", argv: ["--", "/bin/claude"], env: {} }, // no `unsandboxed`
      cols: 80,
      rows: 24,
      state,
      loadPty: () => ({ spawn: () => fakePty() }),
      spawnPipe: () => {
        throw new Error("pipe not expected");
      },
      logger: makeLogger(),
      requestedBackend: "tmux",
      loadTmux,
      sessionId: "s2",
    });

    expect(tmuxSpawn).toHaveBeenCalledTimes(1); // jailed durable drive uses tmux as before
    expect(state.backend).toBe("tmux");
  });
});
