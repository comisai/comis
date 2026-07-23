// SPDX-License-Identifier: Apache-2.0
/**
 * attachBackend — backend selection, including under an UNSANDBOXED plan.
 *
 * An `unsandboxed` plan (operator `unsafeDisableSandbox`) runs the CLI directly (no bwrap). It
 * STILL takes the durable tmux backend when requested: the tmux SERVER is started with the
 * already-scrubbed `plan.env` (no daemon secrets in its global env — the security floor), and the
 * per-session `new-session -e` injection hands each pane the current scrubbed env (freshness).
 * `has-session` never starts a server (verified on tmux 3.4), so `new-session` is the sole
 * server-starting command and it always runs scrubbed — parity with the sandbox-off PTY path.
 * These prove the unsandboxed durable request takes tmux (not a PTY downgrade), that the scrubbed
 * `plan.env` is what reaches the tmux backend, and that a jailed durable request still uses tmux.
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

describe("attachBackend — unsandboxed durable drives take the tmux backend (server env scrubbed + per-session -e)", () => {
  it("takes the tmux backend (NOT a PTY downgrade) for a durable backend:'tmux' request when the plan is unsandboxed", () => {
    const ptySpawn = vi.fn(() => fakePty());
    const loadPty: () => PtyModuleLike = () => ({ spawn: ptySpawn });
    const tmuxSpawn = vi.fn(() => fakePty());
    const loadTmux: TmuxBackendLike = { spawn: tmuxSpawn, reattach: () => undefined };
    const state = makeState();
    // The scrubbed env the plan hands the backend — no daemon secrets (buildSpawnPlan already
    // ran scrubChildEnv); this IS what starts the tmux server + rides each new-session `-e`.
    const scrubbedEnv = { PATH: "/usr/bin", AZURE_DEVOPS_EXT_PAT: "current-pat" } as NodeJS.ProcessEnv;

    attachBackend({
      plan: { bin: "/bin/claude", argv: ["--go"], env: scrubbedEnv, cwd: "/ws/projects/app", unsandboxed: true },
      cols: 80,
      rows: 24,
      state,
      loadPty,
      spawnPipe: () => {
        throw new Error("pipe not expected");
      },
      logger: makeLogger(),
      requestedBackend: "tmux", // the operator asked for a durable drive…
      loadTmux,
      sessionId: "s1",
    });

    // …and it gets one — session persistence is preserved even with the sandbox off.
    expect(tmuxSpawn).toHaveBeenCalledTimes(1);
    expect(ptySpawn).not.toHaveBeenCalled();
    expect(state.backend).toBe("tmux");
    // The scrubbed plan.env is exactly what the tmux backend receives (→ the server + each `-e`).
    expect(tmuxSpawn.mock.calls[0]?.[0]).toMatchObject({ env: scrubbedEnv });
  });

  it("falls back to PTY when a durable tmux request is unsandboxed but NO tmux loader is wired (tmux-less host)", () => {
    const ptySpawn = vi.fn(() => fakePty());
    const state = makeState();
    attachBackend({
      plan: { bin: "/bin/claude", argv: ["--go"], env: {}, cwd: "/ws/projects/app", unsandboxed: true },
      cols: 80,
      rows: 24,
      state,
      loadPty: () => ({ spawn: ptySpawn }),
      spawnPipe: () => {
        throw new Error("pipe not expected");
      },
      logger: makeLogger(),
      requestedBackend: "tmux",
      loadTmux: undefined, // no tmux on this host
      sessionId: "s1b",
    });
    expect(ptySpawn).toHaveBeenCalledTimes(1);
    expect(state.backend).toBe("pty");
    expect(ptySpawn.mock.calls[0]?.[2]).toMatchObject({ cwd: "/ws/projects/app" });
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
