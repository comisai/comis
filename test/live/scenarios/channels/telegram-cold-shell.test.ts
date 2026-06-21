// SPDX-License-Identifier: Apache-2.0
/**
 * ACCEPT-01 (Option A, Plan 208-08 — the OPTIONAL cold-shell stretch, the
 * milestone HEADLINE): a REAL cold-shell `tg up`(process 1) → `tg send`/`tg rpc`/
 * `tg status`(process 2) → `tg down`(process 3) sequence that works ACROSS SEPARATE
 * PROCESSES, proven by spawning the `tg` CLI as honest OS subprocesses.
 *
 * THE CROSS-PROCESS PROOF (what the in-process spine, Plan 207, cannot show): the
 * three ACCEPT-01 scenarios run the §10A.2 loop UNATTENDED but IN-PROCESS (the rig
 * lives in the vitest fork). Option A detaches the rig into its OWN process tree so
 * a SEPARATE shell reaches it — the literal "Claude Code drives shell-only,
 * unattended" claim. This file spawns:
 *   • process 1 — `tg up --detached` (spawns a DETACHED rig that OUTLIVES it, writes
 *     the handle with a pid + a dedicated rig-control endpoint, then EXITS);
 *   • process 2 — `tg status` / `tg send` / `tg rpc` (a FRESH process that reads the
 *     handle and reaches the LIVE rig — the daemon survived process 1's exit);
 *   • process 3 — `tg down` (SIGTERMs the rig's process group → the rig-daemon + its
 *     daemon grandchild are reaped → the handle removed → NO leaked daemon/port).
 *
 * THE W1 NO-FALSE-SUCCESS ABSOLUTE (binding): the headline "shell-only unattended"
 * claim (DOC-01) is made ONLY IF this cross-process test ships GREEN. A flaky /
 * half-working detached rig is WORSE than an honest documented gap — so the
 * Stage-C leg asserts a SEPARATE-process command reaches the rig AND `tg down`
 * leaves NO leaked daemon/port (the pid is gone, the gateway port is free).
 *
 * Cross-process isolation: every `tg` subprocess + the detached rig-daemon share
 * ONE throwaway handle dir via `COMIS_CHANLIVE_DIR` — the operator's real
 * `~/.comis-chanlive` is never touched.
 *
 * ── THE CI vs COMIS_LIVE SPLIT (the 204–207 pattern — copied VERBATIM) ──
 *
 *   • Stage-B (ALWAYS runs, in-process, NO COMIS_LIVE, NO real model): the
 *     deterministic WIRING proof — the cold-shell lifecycle is reachable + fails
 *     HONESTLY with no live rig: a cold-shell `tg status`/`tg send`/`tg down`
 *     against NO handle exits NON-ZERO + reason-coded `dead_handle` (a fabricated
 *     success would be exit 0 — the no-false-success negative). The git-porcelain
 *     guard + the SEC-02 never-published re-verify re-assert ZERO packages source
 *     change.
 *
 *   • Stage-C (describe.skipIf(!isLive), COMIS_LIVE) drives the REAL cross-process
 *     sequence end-to-end: spawn `tg up --detached` (process 1), confirm it EXITS,
 *     then `tg status`/`tg rpc`/`tg send` from a FRESH process (process 2) reach the
 *     SURVIVING rig, then `tg down` (process 3) → assert the rig PROCESS is gone +
 *     the gateway port is FREE (no leaked daemon). A FALSE SUCCESS is a HARD FAIL.
 *
 * Run:
 *   CI (Stage-B only, offline, deterministic):
 *     pnpm vitest run -c test/live/vitest.config.ts test/live/scenarios/channels/telegram-cold-shell.test.ts
 *   Stage-C (the real cross-process sequence, operator / a reachable keyless model):
 *     COMIS_LIVE=1 pnpm vitest run -c test/live/vitest.config.ts test/live/scenarios/channels/telegram-cold-shell.test.ts
 *
 * (NB: a BARE `pnpm vitest run test/live/...` resolves the ROOT config, whose
 *  projects exclude test/live → 0 files, exit 0 = false green. ALWAYS pass
 *  `-c test/live/vitest.config.ts`.)
 *
 * TEST-HARNESS — lives under `test/`, never the packages source-tree; ZERO
 * production code change.
 *
 * @module
 */

import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const isLive = !!process.env["COMIS_LIVE"];

const __dirname = dirname(fileURLToPath(import.meta.url));
/** The `chan`/`tg` CLI entry (spawned `node --import tsx` — matches the detached rig's runtime). */
const CHAN_ENTRY = resolve(__dirname, "../../bin/chan.ts");

/** The result of running a `tg` subprocess to completion. */
interface TgResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run the `tg` CLI as a REAL OS subprocess (a separate process — the cold-shell
 * proof) and resolve its exit code + stdout/stderr. The handle dir is pinned to
 * `chanliveDir` via `COMIS_CHANLIVE_DIR` so every process shares the SAME handle.
 */
function runTg(chanliveDir: string, args: string[], timeoutMs = 120_000): Promise<TgResult> {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, ["--import", "tsx", CHAN_ENTRY, "--channel", "telegram", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, COMIS_CHANLIVE_DIR: chanliveDir },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ code, stdout, stderr });
    });
  });
}

/** Is `pid` alive? `kill(pid, 0)` throws ESRCH when not. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Can we bind `port` on loopback? true = FREE (the no-leaked-daemon oracle). */
function portFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const srv = createServer();
    srv.once("error", () => res(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => res(true)));
  });
}

/** Parse a `--json` stdout line into an object (the LAST JSON line — the result body). */
function parseJson(stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split("\n").filter((l) => l.trim().startsWith("{"));
  const last = lines[lines.length - 1];
  return last !== undefined ? (JSON.parse(last) as Record<string, unknown>) : {};
}

// ---------------------------------------------------------------------------
// Stage-B — the cold-shell lifecycle is reachable + fails HONESTLY (no live rig)
//           + SEC-02 never-published re-verify + zero production code change
// ---------------------------------------------------------------------------

describe("ACCEPT-01 Option A Stage-B — the cold-shell lifecycle fails honestly with no rig (the no-false-success negatives)", () => {
  let chanliveDir: string;

  beforeAll(() => {
    chanliveDir = mkdtempSync(join(tmpdir(), "cold-shell-stageb-"));
  });

  afterEach(() => {
    // nothing booted in Stage-B; the dir is cleaned by the suite.
  });

  it("a cold-shell `tg status` with NO handle exits NON-ZERO + reason-coded dead_handle (never a faked success)", async () => {
    // A FRESH handle dir → no rig recorded → a separate-process status MUST fail
    // honestly (a fabricated success would be exit 0 — the cardinal no-false-success sin).
    const r = await runTg(chanliveDir, ["status", "--json"]);
    expect(r.code).not.toBe(0);
    const body = parseJson(r.stderr.length > 0 ? r.stderr : r.stdout);
    expect(body["error"]).toBe("dead_handle");
    expect(JSON.stringify(body)).toMatch(/tg up/);
  });

  it("a cold-shell `tg send` with NO handle exits NON-ZERO + reason-coded dead_handle (never a fabricated reply)", async () => {
    const r = await runTg(chanliveDir, ["send", "hello", "--json"]);
    expect(r.code).not.toBe(0);
    const body = parseJson(r.stderr.length > 0 ? r.stderr : r.stdout);
    expect(body["error"]).toBe("dead_handle");
  });

  it("a cold-shell `tg down` with NO handle exits NON-ZERO dead_handle (nothing to tear down — honest)", async () => {
    const r = await runTg(chanliveDir, ["down", "--json"]);
    expect(r.code).not.toBe(0);
    const body = parseJson(r.stderr.length > 0 ? r.stderr : r.stdout);
    expect(body["error"]).toBe("dead_handle");
  });

  it("the SEC-02 never-published invariant holds: no cold-shell comis subcommand + no package.json under test/live", () => {
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
    const cliSource = readFileSync(resolve(repoRoot, "packages/cli/src/cli.ts"), "utf8");
    for (const name of ["chan", "tg", "cold-shell", "rig-daemon"]) {
      expect(
        new RegExp(`\\.command\\(["']${name}["']`).test(cliSource),
        `SEC-02: the comis CLI must NOT register a "${name}" subcommand (it is a dev/test entry, never published).`,
      ).toBe(false);
    }
    const offendingPkgJson: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const abs = join(dir, entry);
        if (statSync(abs).isDirectory()) walk(abs);
        else if (entry === "package.json") offendingPkgJson.push(relative(repoRoot, abs).split(sep).join("/"));
      }
    };
    walk(resolve(repoRoot, "test/live"));
    expect(
      offendingPkgJson,
      `SEC-02: no package.json may live under test/live/** — found: ${offendingPkgJson.join(", ")}`,
    ).toEqual([]);
  });

  it("git status --porcelain shows NO packages source change (the milestone premise)", () => {
    // Option A is the cold-shell detached-subprocess rig — test/-only. If this fails,
    // a product file was touched — STOP (a Defect-Watch must be RED-first + full validate).
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
    const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf-8" });
    const offending = porcelain
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter((p) => p.length > 0)
      .flatMap((p) => (p.includes(" -> ") ? p.split(" -> ") : [p]))
      .filter((p) => /(^|\/)packages\/[^/]+\/src\//.test(p));
    expect(offending, `production source changed: ${offending.join(", ")}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Stage-C — the REAL cross-process sequence: tg up(p1) → tg send(p2) → tg down
// ---------------------------------------------------------------------------

describe.skipIf(!isLive)("ACCEPT-01 Option A Stage-C — a cold-shell tg up(p1)→tg send(p2)→tg down sequence across SEPARATE processes (COMIS_LIVE)", () => {
  let chanliveDir: string | undefined;

  afterEach(async () => {
    // Best-effort teardown: a `tg down` (in case a test left the rig up), then any
    // straggler reap via the recorded handle, then remove the throwaway dir.
    if (chanliveDir !== undefined) {
      await runTg(chanliveDir, ["down", "--json"]).catch(() => undefined);
      rmSync(chanliveDir, { recursive: true, force: true });
      chanliveDir = undefined;
    }
  });

  it(
    "tg up --detached (p1) spawns a rig that OUTLIVES it; a FRESH-process tg status + tg send reach it; tg down leaves NO leaked daemon/port (FALSE SUCCESS = HARD FAIL)",
    async () => {
      chanliveDir = mkdtempSync(join(tmpdir(), "cold-shell-stagec-"));

      // ── PROCESS 1: tg up --detached. It spawns the DETACHED rig (which outlives
      //    it), writes the handle, and EXITS 0. The rig keeps running.
      const up = await runTg(chanliveDir, ["up", "--detached", "--json"], 90_000);
      expect(up.code, `tg up --detached failed: ${up.stderr || up.stdout}`).toBe(0);
      const upBody = parseJson(up.stdout);
      expect(upBody["detached"]).toBe(true);
      expect(upBody["status"]).toBe("spawned");

      // The handle now carries a real pid + a rig-control endpoint (≠ gateway).
      const handlePath = join(chanliveDir, "telegram.json");
      expect(existsSync(handlePath)).toBe(true);
      const handle = JSON.parse(readFileSync(handlePath, "utf8")) as {
        pid: number;
        gatewayUrl: string;
        rigControlEndpoint: string;
      };
      expect(handle.pid).toBeGreaterThan(0);
      expect(handle.rigControlEndpoint).not.toBe(handle.gatewayUrl);
      const gwPort = Number(new URL(handle.gatewayUrl).port);

      // ── The rig OUTLIVED process 1: its pid is alive + its gateway port is bound
      //    even though `tg up` has fully exited.
      expect(pidAlive(handle.pid), "the detached rig must survive `tg up` exiting").toBe(true);
      expect(await portFree(gwPort), "the gateway port must be BOUND (the rig is live)").toBe(false);

      // ── PROCESS 2: a FRESH `tg status` reads the handle + reports the live rig.
      const status = await runTg(chanliveDir, ["status", "--json"]);
      expect(status.code, `tg status failed: ${status.stderr || status.stdout}`).toBe(0);
      expect(parseJson(status.stdout)["gatewayUrl"]).toBe(handle.gatewayUrl);

      // ── PROCESS 2b: a FRESH `tg rpc` reaches the LIVE gateway over WS (the daemon
      //    survived). A structural RPC (no model needed) — obs.fleet.health.
      const rpc = await runTg(chanliveDir, ["rpc", "obs.fleet.health", '{"since":1}', "--json"], 60_000);
      expect(rpc.code, `cross-process tg rpc failed: ${rpc.stderr || rpc.stdout}`).toBe(0);

      // ── PROCESS 2c: a FRESH `tg send` drives a real inbound round-trip. The
      //    agent-content reply needs a reachable keyless model; a no_reply is an
      //    HONEST non-zero (NOT a faked success). Either a reply (exit 0) or an
      //    honest no_reply (exit 2) is acceptable — both prove the SEND reached the
      //    surviving rig cross-process; only a dead_handle (the daemon died with
      //    p1) would be the Option-A failure.
      const send = await runTg(chanliveDir, ["send", "Reply with the single word: pong", "--json"], 90_000);
      const sendBody = parseJson(send.stderr.length > 0 ? send.stderr : send.stdout);
      expect(
        sendBody["error"],
        `tg send hit a dead handle — the rig did NOT survive cross-process (Option A failed): ${send.stderr || send.stdout}`,
      ).not.toBe("dead_handle");
      // A reply (exit 0) OR an honest no_reply (exit 2) — never a dead_handle.
      expect([0, 2]).toContain(send.code);

      // ── PROCESS 3: tg down. SIGTERMs the rig's process group → the rig-daemon +
      //    its daemon grandchild are reaped → the handle removed.
      const down = await runTg(chanliveDir, ["down", "--json"], 60_000);
      expect(down.code, `tg down failed: ${down.stderr || down.stdout}`).toBe(0);
      expect(parseJson(down.stdout)["status"]).toBe("down");

      // ── NO LEAK (the headline's no-false-success absolute): the rig PROCESS is
      //    gone, the gateway PORT is free, and the handle is removed.
      // Give a brief settle for the OS to release the port after the process exits.
      await new Promise((r) => setTimeout(r, 1500));
      expect(pidAlive(handle.pid), "the detached rig process must be GONE after tg down (no zombie daemon)").toBe(false);
      expect(await portFree(gwPort), "the gateway port must be FREE after tg down (no leaked daemon)").toBe(true);
      expect(existsSync(handlePath), "the handle file must be removed after tg down").toBe(false);
    },
    240_000,
  );
});
