// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the standalone worker process entry's PURE helpers. The module's
 * `main()` is guarded by `isEntryScript()`, so importing it here runs no side
 * effects (no fork, no stdin listeners) — we exercise the config/wiring helpers
 * the forked process uses.
 *
 * @module
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

import {
  parseStuckMs,
  durableDir,
  resolveTmuxSocketPath,
  buildLoadTmux,
  createFileLogger,
  warnIfDurableTmuxUnavailable,
} from "./terminal-worker-main.js";

// Mock the sync child-process runner so we can assert WHICH env each tmux invocation runs with,
// without a live tmux server. Only execFileSync is replaced; the rest of node:child_process is real.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn() };
});

const origData = process.env.COMIS_TERMINAL_DATA_DIR;
const origStuck = process.env.COMIS_TERMINAL_STUCK_MS;

describe("terminal-worker-main helpers", () => {
  afterEach(() => {
    if (origData === undefined) delete process.env.COMIS_TERMINAL_DATA_DIR;
    else process.env.COMIS_TERMINAL_DATA_DIR = origData;
    if (origStuck === undefined) delete process.env.COMIS_TERMINAL_STUCK_MS;
    else process.env.COMIS_TERMINAL_STUCK_MS = origStuck;
  });

  it("parseStuckMs reads COMIS_TERMINAL_STUCK_MS; absent/invalid/non-positive → undefined", () => {
    delete process.env.COMIS_TERMINAL_STUCK_MS;
    expect(parseStuckMs()).toBeUndefined();
    process.env.COMIS_TERMINAL_STUCK_MS = "45000";
    expect(parseStuckMs()).toBe(45000);
    process.env.COMIS_TERMINAL_STUCK_MS = "-5";
    expect(parseStuckMs()).toBeUndefined();
    process.env.COMIS_TERMINAL_STUCK_MS = "notanumber";
    expect(parseStuckMs()).toBeUndefined();
  });

  it("durableDir = <COMIS_TERMINAL_DATA_DIR>/terminal-worker (matches the --allow-fs-write scope)", () => {
    process.env.COMIS_TERMINAL_DATA_DIR = "/data/x";
    expect(durableDir()).toBe(resolve("/data/x", "terminal-worker"));
  });

  it("resolveTmuxSocketPath = <durableDir>/tmux.sock — a STABLE socket under the data dir, NEVER /tmp (PrivateTmp survival)", () => {
    // The tmux server's socket MUST live on the persistent, shared data dir — NOT the
    // default /tmp. systemd `PrivateTmp=yes` gives every daemon start a FRESH private
    // /tmp, so a /tmp socket is unreachable from the restarted daemon and re-attach
    // fails even when KillMode=process keeps the tmux server process alive (proven live
    // on the VPS 2026-06-16). The data-dir socket is reachable by both generations.
    const sock = resolveTmuxSocketPath("/data/x/terminal-worker");
    expect(sock).toBe(resolve("/data/x/terminal-worker", "tmux.sock"));
    expect(sock.startsWith("/tmp")).toBe(false);
    expect(sock).not.toContain("/tmp/");
  });

  it("createFileLogger appends JSONL with level+msg and is best-effort (never throws on a bad path)", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "twm-test-"));
    const logPath = resolve(dir, "worker.log");
    const logger = createFileLogger(logPath);
    logger.info({ pid: 7 }, "started");
    logger.warn({ x: 1 }, "warned");
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0])).toMatchObject({ level: "info", msg: "started", pid: 7 });
    expect(JSON.parse(lines[1])).toMatchObject({ level: "warn", msg: "warned", x: 1 });
    // A write to a non-existent dir must NOT throw out of the worker.
    const bad = createFileLogger("/nonexistent-dir-twm-xyz/worker.log");
    expect(() => bad.error({}, "boom")).not.toThrow();
  });

  it("buildLoadTmux returns a TmuxBackendLike (spawn + reattach) wiring the injected node-pty attach loader", () => {
    const fakeLoadPty = () => ({ spawn: vi.fn() });
    const loadTmux = buildLoadTmux("/usr/bin/tmux", fakeLoadPty);
    expect(typeof loadTmux.spawn).toBe("function");
    expect(typeof loadTmux.reattach).toBe("function");
    // Not invoked here: spawn() would run tmux has-session / new-session against a real
    // server. The 2-arg seam (tmuxPath + the node-pty loader the attach client reuses) is
    // what's under test — drivability comes from attaching a pty, not a capture-pane.
  });

  it("runs the has-session probe with the SCRUBBED session env (no daemon env can seed the tmux server via any invocation)", () => {
    // The tmux SERVER captures its global env from whatever command first starts it. `new-session`
    // already runs scrubbed, and `has-session` does not start a server on tmux 3.4 — but that leans
    // on a tmux behavioral invariant. Passing the scrubbed env to the probe too makes the guarantee
    // hold BY CONSTRUCTION: no tmux invocation that could conceivably start a server ever inherits
    // the worker's (unscrubbed) daemon env. Defense-in-depth, not a load-bearing fix.
    const mock = vi.mocked(execFileSync);
    mock.mockClear();
    mock.mockReturnValue(Buffer.from("")); // has-session "succeeds" (no throw) → treated as existing
    const fakePty = { pid: 1, onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {}, kill: () => {} };
    const loadTmux = buildLoadTmux("/usr/bin/tmux", () => ({ spawn: () => fakePty }));

    const scrubbedEnv = { PATH: "/usr/bin", AZURE_DEVOPS_EXT_PAT: "pat-marker" } as NodeJS.ProcessEnv;
    loadTmux.spawn({ sessionId: "s1", bin: "/bin/claude", argv: [], cols: 80, rows: 24, env: scrubbedEnv });

    const probe = mock.mock.calls.find((c) => Array.isArray(c[1]) && (c[1] as string[]).includes("has-session"));
    expect(probe).toBeDefined();
    const opts = probe?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
    expect(opts?.env).toBeDefined(); // pre-patch: the probe passed NO env (inherited the worker's) → RED
    expect(opts?.env).toMatchObject(scrubbedEnv);
  });
});

// ---------------------------------------------------------------------------
// The durable-vs-fallback WARN. tmux availability is a
// RUNTIME property (not a config-validation hard-require): a
// `drive.durable:true` drive on a host with no tmux DEGRADES to a non-durable drive +
// a logged WARN, and a restart then ends the session `lost` (with the journal
// preserved — the user-facing `failed` outcome is derived downstream). The worker logs this
// at boot when tmux cannot be resolved, so an operator sees WHY a durable drive will
// not survive a restart.
// ---------------------------------------------------------------------------
describe("warnIfDurableTmuxUnavailable — the durable-vs-fallback WARN", () => {
  function makeSpyLogger() {
    return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  }

  it("logs ONE WARN (errorKind:'precondition', step:'tmux_resolve') when tmux is unavailable (tmuxPath undefined)", () => {
    const logger = makeSpyLogger();
    warnIfDurableTmuxUnavailable(undefined, logger);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [obj] = logger.warn.mock.calls[0]!;
    expect((obj as { errorKind?: string }).errorKind).toBe("precondition");
    expect((obj as { step?: string }).step).toBe("tmux_resolve");
    // The hint names the degradation: durable→non-durable fallback + a restart ends it `lost`.
    expect((obj as { hint?: string }).hint, "the hint must explain the fallback").toMatch(
      /durable|tmux|fallback|lost/i,
    );
  });

  it("is SILENT when tmux IS available (a resolved tmuxPath) — no spurious WARN", () => {
    const logger = makeSpyLogger();
    warnIfDurableTmuxUnavailable("/usr/bin/tmux", logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("is content-free + never throws on a degenerate logger", () => {
    // Best-effort: the WARN must never crash the worker boot.
    expect(() => warnIfDurableTmuxUnavailable(undefined, { warn: () => { throw new Error("x"); } } as never)).not.toThrow();
  });
});
