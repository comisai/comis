// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the tmux worker backend — the pure command builders + the
 * `FakePtyLike`-shaped factory.
 *
 * Pure-JS / fully-injected → runs green on macOS WITHOUT a live tmux server (the one-shot tmux
 * runner + the attach-pty spawner are injected fakes; the LIVE drive/survival across a worker
 * re-spawn is the Linux-gated sibling `terminal-tmux-backend.linux.test.ts`). Proves:
 *   - the session name is DETERMINISTIC from the sessionId (`comis-<id>`) — a restart re-attaches
 *     by name, never re-creates under a random name;
 *   - every command targets the STABLE `-S` data-dir socket (PrivateTmp survival);
 *   - the backend CREATES (`new-session -d`) when `hasSession` is false and RE-ATTACHES (no
 *     `new-session`) when true — never an unconditional create;
 *   - it DRIVES via a node-pty `tmux attach` (the injected `spawnAttachPty`) — onData/onExit/
 *     write/resize delegate to that pty, so the session streams + is driveable + exits on real
 *     death (NOT the prior one-shot capture-pane whose close mis-fired onExit → the F-A/F-B bug);
 *   - the session is configured `status off` + `prefix None` for transparent driving;
 *   - `kill` evicts the SERVER-side session (`kill-session`) AND drops the local attach pty.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";

import {
  tmuxSessionName,
  buildTmuxSpawnArgv,
  buildTmuxHasSessionArgv,
  buildTmuxKillArgv,
  buildTmuxAttachArgv,
  buildTmuxSetOptionArgv,
  createTmuxBackend,
  type TmuxBackendDeps,
} from "./terminal-tmux-backend.js";
import type { FakePtyLike } from "./terminal-worker-types.js";

const SOCK = "/data/x/terminal-worker/tmux.sock";

/**
 * A capturing fake: records the one-shot tmux argvs (new-session/set-option/kill) AND the
 * injected attach pty (a controllable {@link FakePtyLike}). The test drives the session's
 * stream via `emitData` and its exit via `emitExit`.
 */
function makeFake(over: { hasSession?: boolean } = {}) {
  const oneShot: string[][] = [];
  let dataCb: ((d: string) => void) | undefined;
  let exitCb: ((e: { exitCode: number; signal?: number }) => void) | undefined;
  const writes: string[] = [];
  const resizes: Array<[number, number]> = [];
  let ptyKills = 0;
  let attachName: string | undefined;

  const pty: FakePtyLike = {
    pid: 4242,
    onData: (cb) => {
      dataCb = cb;
    },
    onExit: (cb) => {
      exitCb = cb;
    },
    write: (d) => writes.push(d),
    resize: (c, r) => resizes.push([c, r]),
    kill: () => {
      ptyKills += 1;
    },
  };

  const deps = (extra: Partial<TmuxBackendDeps> = {}): TmuxBackendDeps => ({
    sessionId: "abc",
    bin: "/usr/local/bin/claude",
    argv: ["--dangerously-skip-permissions"],
    cols: 120,
    rows: 40,
    env: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
    tmuxPath: "/usr/bin/tmux",
    socketPath: SOCK,
    hasSession: () => over.hasSession ?? false,
    runOneShot: (argv) => oneShot.push(argv),
    spawnAttachPty: (name) => {
      attachName = name;
      return pty;
    },
    ...extra,
  });

  return {
    deps,
    oneShot,
    writes,
    resizes,
    emitData: (s: string) => dataCb?.(s),
    emitExit: (code = 0) => exitCb?.({ exitCode: code }),
    get ptyKills() {
      return ptyKills;
    },
    get attachName() {
      return attachName;
    },
  };
}

describe("terminal-tmux-backend — deterministic session name (restart survival)", () => {
  it("derives a STABLE, recoverable session name comis-<sessionId> (never a random/UUID name)", () => {
    expect(tmuxSessionName("abc")).toBe("comis-abc");
    expect(tmuxSessionName("s-42")).toBe("comis-s-42");
    expect(tmuxSessionName("abc")).toBe(tmuxSessionName("abc"));
  });
});

describe("terminal-tmux-backend — pure command builders (every command -S the stable socket)", () => {
  const tmuxPath = "/usr/bin/tmux";
  const head = (argv: string[]): string[] => argv.slice(0, 3);

  it("buildTmuxSpawnArgv: DETACHED named session running the driven bin+argv, -S socket first", () => {
    const argv = buildTmuxSpawnArgv({
      tmuxPath,
      socketPath: SOCK,
      name: "comis-abc",
      bin: "/usr/local/bin/claude",
      binArgv: ["--flag"],
      cols: 120,
      rows: 40,
    });
    expect(head(argv)).toEqual([tmuxPath, "-S", SOCK]);
    expect(argv).toContain("new-session");
    expect(argv).toContain("-d"); // detached — the server owns the PTY, outlives the worker
    expect(argv).toContain("comis-abc");
    expect(argv).toContain("/usr/local/bin/claude");
    expect(argv).toContain("--flag");
    expect(argv).toContain("120");
    expect(argv).toContain("40");
  });

  it("buildTmuxSpawnArgv: injects the CURRENT env as `-e KEY=VALUE` (freshness — pane env decoupled from the stale server-global env)", () => {
    // A tmux pane inherits the server's GLOBAL environment, which is captured ONCE when the
    // server first starts and never refreshed (proven live: a 2nd session's pane sees the value
    // the server booted with, not the daemon's current one). So a rotated secret (e.g. the ADO
    // PAT) would never reach a new drive on a long-lived server. Injecting the current (already
    // scrubbed) env per session with `-e` overrides the stale global per-pane — the freshness fix.
    const argv = buildTmuxSpawnArgv({
      tmuxPath,
      socketPath: SOCK,
      name: "comis-abc",
      bin: "/usr/local/bin/claude",
      binArgv: ["--flag"],
      cols: 120,
      rows: 40,
      env: { PATH: "/usr/bin", AZURE_DEVOPS_EXT_PAT: "current-pat", TERM: "xterm-256color" },
    });
    // Each entry rides as a distinct `-e` `KEY=VALUE` pair, BEFORE the `--` command separator.
    const sep = argv.indexOf("--");
    const ePairs: string[] = [];
    for (let i = 0; i < sep; i++) {
      if (argv[i] === "-e") ePairs.push(argv[i + 1]!);
    }
    expect(ePairs).toEqual(
      expect.arrayContaining(["PATH=/usr/bin", "AZURE_DEVOPS_EXT_PAT=current-pat", "TERM=xterm-256color"]),
    );
    // The driven command still trails the `--` verbatim (env injection never displaces it).
    expect(argv.slice(sep)).toEqual(["--", "/usr/local/bin/claude", "--flag"]);
  });

  it("buildTmuxSpawnArgv: emits NO `-e` when env is absent (optional — the pure builder stays minimal)", () => {
    const argv = buildTmuxSpawnArgv({ tmuxPath, socketPath: SOCK, name: "comis-abc", bin: "/bin/sh", binArgv: [], cols: 80, rows: 24 });
    expect(argv).not.toContain("-e");
  });

  it("buildTmuxHasSessionArgv probes by name on the same socket (the re-attach decision)", () => {
    expect(buildTmuxHasSessionArgv({ tmuxPath, socketPath: SOCK, name: "comis-abc" })).toEqual([
      tmuxPath,
      "-S",
      SOCK,
      "has-session",
      "-t",
      "comis-abc",
    ]);
  });

  it("buildTmuxKillArgv targets the named session on the same socket (the reaper evict)", () => {
    expect(buildTmuxKillArgv({ tmuxPath, socketPath: SOCK, name: "comis-abc" })).toEqual([
      tmuxPath,
      "-S",
      SOCK,
      "kill-session",
      "-t",
      "comis-abc",
    ]);
  });

  it("buildTmuxAttachArgv: the DRIVING client `attach -t <name>` (node-pty spawns this — streams + drives)", () => {
    expect(buildTmuxAttachArgv({ tmuxPath, socketPath: SOCK, name: "comis-abc" })).toEqual([
      tmuxPath,
      "-S",
      SOCK,
      "attach",
      "-t",
      "comis-abc",
    ]);
  });

  it("buildTmuxSetOptionArgv: per-session driving config (status off / prefix None)", () => {
    expect(buildTmuxSetOptionArgv({ tmuxPath, socketPath: SOCK, name: "comis-abc", option: "status", value: "off" })).toEqual(
      [tmuxPath, "-S", SOCK, "set-option", "-t", "comis-abc", "status", "off"],
    );
  });
});

describe("terminal-tmux-backend — createTmuxBackend create-vs-re-attach decision", () => {
  it("CREATES (new-session -d) + configures driving + attaches a pty when hasSession is false", () => {
    const f = makeFake({ hasSession: false });
    const handle = createTmuxBackend(f.deps());
    expect(handle?.pid).toBe(4242); // the attach pty's pid
    // It created the detached session under the deterministic name, on the -S socket.
    const created = f.oneShot.find((a) => a.includes("new-session"));
    expect(created).toBeDefined();
    expect(created?.slice(0, 3)).toEqual(["/usr/bin/tmux", "-S", SOCK]);
    expect(created).toContain("comis-abc");
    // It configured the session for transparent driving (status off + prefix None).
    const opts = f.oneShot.filter((a) => a.includes("set-option")).map((a) => a.slice(-2).join("="));
    expect(opts).toEqual(expect.arrayContaining(["status=off", "prefix=None"]));
    // It attached the DRIVING pty to the named session.
    expect(f.attachName).toBe("comis-abc");
  });

  it("CREATE threads the CURRENT env onto new-session as `-e` (each fresh drive gets today's env, not the server's boot-time env)", () => {
    const f = makeFake({ hasSession: false });
    createTmuxBackend(f.deps({ env: { PATH: "/usr/bin", AZURE_DEVOPS_EXT_PAT: "rotated-today" } as NodeJS.ProcessEnv }));
    const created = f.oneShot.find((a) => a.includes("new-session"))!;
    const sep = created.indexOf("--");
    const ePairs: string[] = [];
    for (let i = 0; i < sep; i++) if (created[i] === "-e") ePairs.push(created[i + 1]!);
    expect(ePairs).toEqual(expect.arrayContaining(["PATH=/usr/bin", "AZURE_DEVOPS_EXT_PAT=rotated-today"]));
  });

  it("RE-ATTACHES (NO new-session) when hasSession is true (survival after a restart)", () => {
    const f = makeFake({ hasSession: true });
    const hasSession = vi.fn(() => true);
    const handle = createTmuxBackend(f.deps({ hasSession }));
    expect(handle).toBeDefined();
    expect(hasSession).toHaveBeenCalledWith("comis-abc");
    // Never re-create an existing session (would lose its state) — but DO attach to drive it.
    expect(f.oneShot.find((a) => a.includes("new-session"))).toBeUndefined();
    expect(f.attachName).toBe("comis-abc");
  });

  it("forceAttachOnly + gone session ⇒ undefined (recover-on-boot honest death) — NEVER a fresh new-session", () => {
    const f = makeFake({ hasSession: false });
    const handle = createTmuxBackend(f.deps({ forceAttachOnly: true }));
    expect(handle).toBeUndefined();
    expect(f.oneShot.find((a) => a.includes("new-session"))).toBeUndefined();
    expect(f.attachName).toBeUndefined(); // nothing attached
  });
});

describe("terminal-tmux-backend — FakePtyLike seam delegates to the attach pty (streams + drives + exits)", () => {
  it("onData receives the attach pty's pane stream (the ring feed)", () => {
    const f = makeFake({ hasSession: false });
    const handle = createTmuxBackend(f.deps())!;
    const chunks: string[] = [];
    handle.onData((d) => chunks.push(d));
    f.emitData("hello from claude\n");
    expect(chunks.join("")).toContain("hello from claude");
  });

  it("onExit fires markExited ONLY when the attach pty exits (genuine session death, not a capture close)", () => {
    const f = makeFake({ hasSession: false });
    const handle = createTmuxBackend(f.deps())!;
    const exits: Array<{ exitCode: number }> = [];
    handle.onExit((e) => exits.push(e));
    expect(exits).toHaveLength(0); // creating the backend does NOT mark it exited (the F-A bug)
    f.emitExit(0);
    expect(exits).toHaveLength(1);
  });

  it("write forwards keystrokes to the attach pty (drives the pane — NOT a one-shot send-keys)", () => {
    const f = makeFake({ hasSession: false });
    const handle = createTmuxBackend(f.deps())!;
    handle.write("echo hi\r");
    expect(f.writes).toEqual(["echo hi\r"]);
  });

  it("resize forwards to the attach pty (the tmux window follows the client size)", () => {
    const f = makeFake({ hasSession: false });
    const handle = createTmuxBackend(f.deps())!;
    handle.resize(100, 30);
    expect(f.resizes).toEqual([[100, 30]]);
  });

  it("kill evicts the SERVER-side session (kill-session) AND drops the local attach pty", () => {
    const f = makeFake({ hasSession: false });
    const handle = createTmuxBackend(f.deps())!;
    handle.kill();
    const killed = f.oneShot.find((a) => a.includes("kill-session"));
    expect(killed).toBeDefined();
    expect(killed).toContain("comis-abc");
    expect(killed?.slice(0, 3)).toEqual(["/usr/bin/tmux", "-S", SOCK]);
    expect(f.ptyKills).toBe(1);
  });
});
