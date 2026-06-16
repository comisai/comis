// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the tmux worker backend (124-08, OPS-05) — the pure
 * command-builder + the FakePtyLike-shaped factory.
 *
 * Pure-JS / fully-injected → runs green on macOS WITHOUT a live tmux server (the
 * tmux command runner is a capturing fake; the LIVE survival/re-attach across a
 * worker re-spawn is the Linux-gated sibling `terminal-tmux-backend.linux.test.ts`).
 * Proves the OPS-05 survival mechanism's logic (RESEARCH Pitfall 6):
 *   - the session name is DETERMINISTIC from the sessionId (`comis-<id>`) — a
 *     restart can re-attach by name, never re-create under a random name;
 *   - the backend CREATES (`new-session -d`) when `hasSession` is false and
 *     RE-ATTACHES (no `new-session`) when true — never an unconditional create;
 *   - the evict/teardown path emits `kill-session -t comis-<id>`;
 *   - the handle satisfies the FakePtyLike seam (onData→ring, onExit→markExited,
 *     write/resize/kill forwarded), so it drops into the SAME backend interface
 *     as node-pty | pipe.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";

import {
  tmuxSessionName,
  buildTmuxSpawnArgv,
  buildTmuxHasSessionArgv,
  buildTmuxKillArgv,
  buildTmuxSendKeysArgv,
  buildTmuxCaptureArgv,
  buildTmuxResizeArgv,
  createTmuxBackend,
  defaultRunTmux,
  type TmuxChild,
  type TmuxBackendDeps,
} from "./terminal-tmux-backend.js";
import type { FakePtyLike } from "./terminal-worker-types.js";

/**
 * A capturing fake tmux command runner: records every argv it was asked to run and
 * returns a controllable child. The test drives the session's stdout via `emit` and
 * its exit via `close` (the `capture-pane`/`pipe-pane` analog wired by the backend).
 */
function makeFakeTmux(over: { hasSession?: boolean } = {}): {
  deps: (extra?: Partial<TmuxBackendDeps>) => TmuxBackendDeps;
  argvs: string[][];
  spawned: () => string[][];
  emit: (chunk: string) => void;
  close: (code?: number) => void;
  runTmuxCalls: number;
} {
  const argvs: string[][] = [];
  let onData: ((chunk: Buffer) => void) | undefined;
  let onClose: ((code?: number) => void) | undefined;
  let runTmuxCalls = 0;

  const runTmux = vi.fn((argv: string[]): TmuxChild => {
    argvs.push(argv);
    runTmuxCalls += 1;
    return {
      pid: 9191,
      stdout: {
        on: (_event: "data", cb: (chunk: Buffer) => void) => {
          onData = cb;
        },
      },
      stdin: { write: vi.fn() },
      on: (event: "close" | "error", cb: (arg?: unknown) => void) => {
        if (event === "close") onClose = cb as (code?: number) => void;
      },
      kill: vi.fn(),
    };
  });

  return {
    deps: (extra: Partial<TmuxBackendDeps> = {}): TmuxBackendDeps => ({
      sessionId: "abc",
      bin: "/usr/local/bin/claude",
      argv: ["--dangerously-skip-permissions"],
      cols: 120,
      rows: 40,
      env: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
      tmuxPath: "/opt/homebrew/bin/tmux",
      socketPath: "/data/x/terminal-worker/tmux.sock",
      hasSession: () => over.hasSession ?? false,
      runTmux,
      ...extra,
    }),
    argvs,
    spawned: () => argvs,
    emit: (chunk: string) => onData?.(Buffer.from(chunk, "utf8")),
    close: (code = 0) => onClose?.(code),
    get runTmuxCalls() {
      return runTmuxCalls;
    },
  };
}

describe("terminal-tmux-backend — defaultRunTmux argv invariant (IN-02)", () => {
  it("throws an ACTIONABLE error on an empty argv instead of spawning undefined", () => {
    // Every buildTmux*Argv puts tmuxPath first, so production never passes []. A future
    // empty-argv caller bug must fail with a legible message naming the function +
    // invariant, not the opaque node `The "file" argument must be of type string` from
    // childSpawn(undefined, …) the bare `bin!` non-null assertion would have produced.
    expect(() => defaultRunTmux([], { PATH: "/usr/bin" } as NodeJS.ProcessEnv)).toThrow(/defaultRunTmux: empty argv/);
  });
});

describe("terminal-tmux-backend — deterministic session name (OPS-05 survival)", () => {
  it("derives a STABLE, recoverable session name comis-<sessionId> (never a random/UUID name)", () => {
    expect(tmuxSessionName("abc")).toBe("comis-abc");
    expect(tmuxSessionName("s-42")).toBe("comis-s-42");
    // Stable across calls — the same sessionId always maps to the same name (so a
    // restart re-attaches by name rather than re-creating).
    expect(tmuxSessionName("abc")).toBe(tmuxSessionName("abc"));
  });
});

describe("terminal-tmux-backend — pure command builders (the spawn-posture analog)", () => {
  it("buildTmuxSpawnArgv creates a DETACHED named session running the driven bin+argv", () => {
    const argv = buildTmuxSpawnArgv({
      tmuxPath: "/opt/homebrew/bin/tmux",
      name: "comis-abc",
      bin: "/usr/local/bin/claude",
      binArgv: ["--flag"],
      cols: 120,
      rows: 40,
    });
    // tmux new-session -d -s comis-abc -x 120 -y 40 -- /usr/local/bin/claude --flag
    expect(argv[0]).toBe("/opt/homebrew/bin/tmux");
    expect(argv).toContain("new-session");
    expect(argv).toContain("-d"); // DETACHED — the server owns the PTY, outlives the worker
    expect(argv).toContain("-s");
    expect(argv).toContain("comis-abc");
    // The driven bin+argv ride at the tail (the session's command).
    expect(argv).toContain("/usr/local/bin/claude");
    expect(argv).toContain("--flag");
    // Geometry threaded so the detached session opens at the requested size.
    expect(argv).toContain("-x");
    expect(argv).toContain("120");
    expect(argv).toContain("-y");
    expect(argv).toContain("40");
  });

  it("buildTmuxHasSessionArgv probes by name (the re-attach decision input)", () => {
    const argv = buildTmuxHasSessionArgv({ tmuxPath: "/usr/bin/tmux", name: "comis-abc" });
    expect(argv).toEqual(["/usr/bin/tmux", "has-session", "-t", "comis-abc"]);
  });

  it("buildTmuxKillArgv targets the named session (the reaper evict path)", () => {
    const argv = buildTmuxKillArgv({ tmuxPath: "/usr/bin/tmux", name: "comis-abc" });
    expect(argv).toEqual(["/usr/bin/tmux", "kill-session", "-t", "comis-abc"]);
  });

  it("buildTmuxSendKeysArgv targets the named session with -l (literal, no key-name expansion)", () => {
    const argv = buildTmuxSendKeysArgv({ tmuxPath: "/usr/bin/tmux", name: "comis-abc", bytes: "y\r" });
    expect(argv[0]).toBe("/usr/bin/tmux");
    expect(argv).toContain("send-keys");
    expect(argv).toContain("-t");
    expect(argv).toContain("comis-abc");
    expect(argv).toContain("-l"); // LITERAL — the worker's encoded bytes ride verbatim, not re-parsed as key names
    expect(argv).toContain("y\r");
  });

  it("buildTmuxCaptureArgv reads the named session pane (the onData source)", () => {
    const argv = buildTmuxCaptureArgv({ tmuxPath: "/usr/bin/tmux", name: "comis-abc" });
    expect(argv[0]).toBe("/usr/bin/tmux");
    expect(argv).toContain("capture-pane");
    expect(argv).toContain("-t");
    expect(argv).toContain("comis-abc");
  });

  it("buildTmuxResizeArgv resizes the named window (TR-03 reflow on the tmux backend)", () => {
    const argv = buildTmuxResizeArgv({ tmuxPath: "/usr/bin/tmux", name: "comis-abc", cols: 100, rows: 30 });
    expect(argv[0]).toBe("/usr/bin/tmux");
    expect(argv).toContain("resize-window");
    expect(argv).toContain("-t");
    expect(argv).toContain("comis-abc");
    expect(argv).toContain("-x");
    expect(argv).toContain("100");
    expect(argv).toContain("-y");
    expect(argv).toContain("30");
  });
});

describe("terminal-tmux-backend — DUR-01 PrivateTmp survival: every command targets the stable -S socket", () => {
  const sock = "/data/x/terminal-worker/tmux.sock";
  const tmuxPath = "/usr/bin/tmux";
  const head = (argv: string[]): string[] => argv.slice(0, 3);

  it("buildTmuxSpawnArgv puts -S <socket> right after tmux (the SERVER binds the stable, non-/tmp socket)", () => {
    const argv = buildTmuxSpawnArgv({ tmuxPath, socketPath: sock, name: "comis-abc", bin: "/x", binArgv: [], cols: 80, rows: 24 });
    expect(head(argv)).toEqual([tmuxPath, "-S", sock]);
    expect(argv).toContain("new-session");
  });

  it("buildTmuxHasSessionArgv puts -S <socket> first — the re-attach probe MUST hit the same socket the server bound", () => {
    expect(buildTmuxHasSessionArgv({ tmuxPath, socketPath: sock, name: "comis-abc" })).toEqual([
      tmuxPath,
      "-S",
      sock,
      "has-session",
      "-t",
      "comis-abc",
    ]);
  });

  it("kill / send-keys / capture / resize all carry the -S <socket> prefix (one server, one socket)", () => {
    expect(head(buildTmuxKillArgv({ tmuxPath, socketPath: sock, name: "comis-abc" }))).toEqual([tmuxPath, "-S", sock]);
    expect(head(buildTmuxSendKeysArgv({ tmuxPath, socketPath: sock, name: "comis-abc", bytes: "y" }))).toEqual([tmuxPath, "-S", sock]);
    expect(head(buildTmuxCaptureArgv({ tmuxPath, socketPath: sock, name: "comis-abc" }))).toEqual([tmuxPath, "-S", sock]);
    expect(head(buildTmuxResizeArgv({ tmuxPath, socketPath: sock, name: "comis-abc", cols: 80, rows: 24 }))).toEqual([
      tmuxPath,
      "-S",
      sock,
    ]);
  });

  it("createTmuxBackend threads deps.socketPath onto BOTH the new-session and the capture commands", () => {
    const tmux = makeFakeTmux({ hasSession: false });
    createTmuxBackend(tmux.deps({ socketPath: sock }));
    const created = tmux.spawned().find((a) => a.includes("new-session"));
    const capture = tmux.spawned().find((a) => a.includes("capture-pane"));
    expect(created?.slice(0, 3)).toEqual(["/opt/homebrew/bin/tmux", "-S", sock]);
    expect(capture?.slice(0, 3)).toEqual(["/opt/homebrew/bin/tmux", "-S", sock]);
  });
});

describe("terminal-tmux-backend — createTmuxBackend spawn-vs-re-attach decision (RESEARCH Pitfall 6)", () => {
  it("CREATES (new-session -d) when hasSession is false (a fresh session)", () => {
    const tmux = makeFakeTmux({ hasSession: false });
    const handle = createTmuxBackend(tmux.deps());
    expect(handle.pid).toBeGreaterThan(0);
    // The FIRST emitted argv must be a new-session create — never under a random name.
    const created = tmux.spawned().find((a) => a.includes("new-session"));
    expect(created).toBeDefined();
    expect(created).toContain("comis-abc");
    expect(created).toContain("-d");
  });

  it("RE-ATTACHES (no new-session) when hasSession is true (survival after a restart)", () => {
    const tmux = makeFakeTmux({ hasSession: true });
    const hasSession = vi.fn(() => true);
    const handle = createTmuxBackend(tmux.deps({ hasSession }));
    expect(handle.pid).toBeGreaterThan(0);
    // It consulted has-session and, finding the session alive, did NOT re-create it.
    expect(hasSession).toHaveBeenCalledWith("comis-abc");
    const created = tmux.spawned().find((a) => a.includes("new-session"));
    expect(created).toBeUndefined(); // never re-create an existing session (would lose its state)
    // It DID attach to read the existing pane (capture/pipe), so onData is live.
    const reads = tmux.spawned().some((a) => a.includes("capture-pane") || a.includes("pipe-pane"));
    expect(reads).toBe(true);
  });
});

describe("terminal-tmux-backend — FakePtyLike seam (drops into the same backend interface)", () => {
  it("satisfies the FakePtyLike shape (onData→ring, onExit→markExited, write/resize/kill)", () => {
    const tmux = makeFakeTmux({ hasSession: false });
    const handle: FakePtyLike = createTmuxBackend(tmux.deps());
    // Structural conformance to the worker's backend handle.
    expect(typeof handle.onData).toBe("function");
    expect(typeof handle.onExit).toBe("function");
    expect(typeof handle.write).toBe("function");
    expect(typeof handle.resize).toBe("function");
    expect(typeof handle.kill).toBe("function");
  });

  it("onData receives the session's pane output (the ring feed)", () => {
    const tmux = makeFakeTmux({ hasSession: false });
    const handle = createTmuxBackend(tmux.deps());
    const chunks: string[] = [];
    handle.onData((d) => chunks.push(d));
    tmux.emit("hello from claude\n");
    expect(chunks.join("")).toContain("hello from claude");
  });

  it("onExit fires markExited when the attached read child closes (a session-gone signal)", () => {
    const tmux = makeFakeTmux({ hasSession: false });
    const handle = createTmuxBackend(tmux.deps());
    const exits: Array<{ exitCode: number }> = [];
    handle.onExit((e) => exits.push(e));
    tmux.close(0);
    expect(exits).toHaveLength(1);
  });

  it("write encodes a send-keys to the named session (-l literal) — the keystroke path", () => {
    const sendArgvs: string[][] = [];
    const tmux = makeFakeTmux({ hasSession: false });
    const handle = createTmuxBackend(
      tmux.deps({
        runTmux: (argv: string[]): TmuxChild => {
          sendArgvs.push(argv);
          return {
            pid: 1,
            stdout: { on: () => {} },
            stdin: { write: () => {} },
            on: () => {},
            kill: () => {},
          };
        },
      }),
    );
    handle.write("y\r");
    const sent = sendArgvs.find((a) => a.includes("send-keys"));
    expect(sent).toBeDefined();
    expect(sent).toContain("comis-abc");
    expect(sent).toContain("-l");
    expect(sent).toContain("y\r");
  });

  it("kill runs kill-session for the named session (the deterministic evict)", () => {
    const killArgvs: string[][] = [];
    const tmux = makeFakeTmux({ hasSession: false });
    const handle = createTmuxBackend(
      tmux.deps({
        runTmux: (argv: string[]): TmuxChild => {
          killArgvs.push(argv);
          return {
            pid: 1,
            stdout: { on: () => {} },
            stdin: { write: () => {} },
            on: () => {},
            kill: () => {},
          };
        },
      }),
    );
    handle.kill();
    const killed = killArgvs.find((a) => a.includes("kill-session"));
    expect(killed).toBeDefined();
    expect(killed).toContain("comis-abc");
  });
});
