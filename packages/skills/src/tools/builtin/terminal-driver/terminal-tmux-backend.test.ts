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

import { resolve } from "node:path";

import {
  tmuxSessionName,
  buildTmuxSpawnArgv,
  buildTmuxHasSessionArgv,
  buildTmuxKillArgv,
  buildTmuxAttachArgv,
  buildTmuxSetOptionArgv,
  createTmuxBackend,
  tmuxSocketPathForSession,
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
    queryRootPid: () => 9191,
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
    // SECURITY: an env VALUE must never reach argv. `/proc/<pid>/cmdline` is WORLD-READABLE,
    // while `/proc/<pid>/environ` is owner-only 0400 — so putting env on the command line
    // publishes every secret the drive needs to any local account. Proven on the live VPS:
    // a `-e AZURE_DEVOPS_EXT_PAT=<pat>` tmux argv was read by an unrelated `ubuntu` user via
    // `ps`, while that same process's `environ` returned EACCES. Freshness is achieved
    // structurally instead — one tmux SERVER PER SESSION, born with the scrubbed env in its
    // own process environment (see tmuxSocketPathForSession), so there is nothing stale to
    // override and nothing to leak.
    const secret = "pat-super-secret-value";
    const argv = buildTmuxSpawnArgv({
      tmuxPath,
      socketPath: SOCK,
      name: "comis-abc",
      bin: "/usr/local/bin/claude",
      binArgv: ["--flag"],
      cols: 120,
      rows: 40,
    });
    expect(argv).not.toContain("-e");
    expect(argv.join(" ")).not.toContain(secret);
    expect(argv.join(" ")).not.toContain("AZURE_DEVOPS_EXT_PAT");
    // The driven command still trails the `--` verbatim.
    const sep = argv.indexOf("--");
    expect(argv.slice(sep)).toEqual(["--", "/usr/local/bin/claude", "--flag"]);
  });

  it("buildTmuxSpawnArgv: accepts no env at all — the type itself forbids putting env on argv", () => {
    const argv = buildTmuxSpawnArgv({ tmuxPath, socketPath: SOCK, name: "comis-abc", bin: "/bin/sh", binArgv: [], cols: 80, rows: 24 });
    expect(argv).not.toContain("-e");
    // Nothing resembling KEY=VALUE may appear before the command separator.
    const sep = argv.indexOf("--");
    expect(argv.slice(0, sep).filter((a) => /^[A-Z_][A-Z0-9_]*=/.test(a))).toEqual([]);
  });

  it("tmuxSocketPathForSession: one server PER SESSION, under the data dir, never /tmp", () => {
    // Per-SESSION socket ⇒ per-session tmux SERVER. That is what lets the server be started
    // with this drive's scrubbed env in its own (private) process environment: fresh by
    // construction, no `-e`, no argv exposure. It also makes the socket a pure function of the
    // session id — stable across daemon restarts, unlike the previous per-BOOT
    // `tmux-<daemonPid>.sock` whose name changed on every restart and needed a dual-socket
    // fallback. And it isolates faults: killing one drive's server cannot take down another's.
    const a = tmuxSocketPathForSession("/data/x/terminal-worker", "sess-aaa");
    const b = tmuxSocketPathForSession("/data/x/terminal-worker", "sess-bbb");
    expect(a).toMatch(/^\/data\/x\/terminal-worker\/t-[A-Za-z0-9_-]{22}\.sock$/u);
    expect(a).toBe(tmuxSocketPathForSession("/data/x/terminal-worker", "sess-aaa"));
    expect(a).not.toBe(b);
    expect(a).not.toContain("sess-aaa");
    expect(a.startsWith("/tmp")).toBe(false);
    // Must stay well under the ~108-char AF_UNIX sun_path limit for a real uuid session id.
    const real = tmuxSocketPathForSession("/home/comis/.comis/terminal-worker", "551429eb-ddb9-4666-b800-8b6a17e1324a");
    expect(real.length).toBeLessThan(108);
  });

  it("keeps isolated deployment socket paths below the Linux AF_UNIX limit", () => {
    const socket = tmuxSocketPathForSession(
      "/home/service-user/campaigns/capability-validation/comis-data/terminal-worker",
      "551429eb-ddb9-4666-b800-8b6a17e1324a",
    );

    expect(Buffer.byteLength(socket, "utf8")).toBeLessThan(108);
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
    expect(handle?.rootPid).toBe(9191); // the detached pane's process, not the attach client
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

  it("CREATE never puts an env VALUE on the new-session command line (argv is world-readable)", () => {
    // The drive's env legitimately carries operator secrets it needs — an ADO PAT, registry
    // creds. Those MUST travel in the tmux server's own process environment (owner-only 0400),
    // never in argv: `/proc/<pid>/cmdline` is world-readable, so a `-e KEY=VALUE` publishes
    // every one of them to any local account. Verified live: an unrelated `ubuntu` user read a
    // real ADO PAT out of the comis daemon's tmux argv via `ps`, while `environ` gave EACCES.
    // Env freshness — the reason `-e` existed — now comes from one tmux SERVER PER SESSION,
    // started with this env in its process environment, so there is no stale server-global
    // value to override in the first place.
    const f = makeFake({ hasSession: false });
    const secret = "pat-rotated-today-super-secret";
    createTmuxBackend(f.deps({ env: { PATH: "/usr/bin", AZURE_DEVOPS_EXT_PAT: secret } as NodeJS.ProcessEnv }));
    const created = f.oneShot.find((a) => a.includes("new-session"))!;
    expect(created).not.toContain("-e");
    expect(created.join(" ")).not.toContain(secret);
    expect(created.join(" ")).not.toContain("AZURE_DEVOPS_EXT_PAT");
    // No tmux invocation of ANY kind may carry the secret (set-option, has-session, attach…).
    for (const argv of f.oneShot) expect(argv.join(" ")).not.toContain(secret);
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
