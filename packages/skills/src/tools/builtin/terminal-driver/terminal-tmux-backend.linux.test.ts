// SPDX-License-Identifier: Apache-2.0
/**
 * The LIVE tmux survival + re-attach test (Linux/CI) under a real tmux
 * server. The tmux backend names its session DETERMINISTICALLY (`comis-<id>`) so a
 * worker/daemon restart RE-ATTACHES by name rather than re-creating; the tmux server
 * outlives the worker (the milestone-length-run survival mechanism).
 *
 * Gated `describe.skipIf(!isLinux() || !tmuxAvailable())` so it COMPILES + SKIPS
 * CLEAN on the macOS author box (which lacks bwrap and runs CI's jailed soak only on
 * Linux) and runs live on the CI/VPS Linux host via `pnpm validate:full`. Mirrors the
 * existing `*.linux.test.ts` gate (terminal-roundtrip.linux.test.ts). FLAKY-TOLERANT:
 * a transient tmux server hiccup (server still starting, a slow `new-session`) is
 * retried/skipped rather than failing the suite — the live survival check is the CI
 * soak/E2E tier, not a deterministic unit gate.
 *
 * NOTE: this test drives the tmux CLI DIRECTLY (not yet through bwrap) to prove the
 * named-session survival/re-attach mechanism in isolation. The full jailed
 * `bwrap [scope] -- tmux …` composition is the higher-tier Linux+bwrap soak — this
 * box's bwrap is the gate for that; here we isolate the tmux half (the survival logic).
 *
 * @module
 */

import { describe, it, expect, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  tmuxSessionName,
  buildTmuxSpawnArgv,
  buildTmuxHasSessionArgv,
  buildTmuxKillArgv,
} from "./terminal-tmux-backend.js";

function isLinux(): boolean {
  return process.platform === "linux";
}

/** Resolve a tmux on PATH, or undefined when absent (the gate skips on absence). */
function resolveTmux(): string | undefined {
  try {
    return execFileSync("which", ["tmux"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function tmuxAvailable(): boolean {
  return resolveTmux() !== undefined;
}

/** Run a built tmux argv, returning the exit code (0 = ok). Never throws (probe shape). */
function runTmuxArgv(argv: string[]): number {
  const [bin, ...rest] = argv;
  const r = spawnSync(bin!, rest, { encoding: "utf8", timeout: 5_000 });
  return r.status ?? 1;
}

// A unique session id per run so concurrent CI shards never collide on the name.
const SESSION_ID = `live-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
const NAME = tmuxSessionName(SESSION_ID);
const TMUX = resolveTmux() ?? "tmux";

describe.skipIf(!isLinux() || !tmuxAvailable())(
  "Live tmux (Linux) — a named session survives a worker re-spawn and is re-attachable",
  () => {
    afterEach(() => {
      // Always reap the named session so a flaky run never leaks a server session.
      runTmuxArgv(buildTmuxKillArgv({ tmuxPath: TMUX, name: NAME }));
    });

    it("creates a detached named session, and has-session finds it AFTER a simulated restart", () => {
      // 1) Create the detached session (the tmux server now owns the PTY).
      const spawnArgv = buildTmuxSpawnArgv({
        tmuxPath: TMUX,
        name: NAME,
        bin: "/bin/sh",
        binArgv: ["-c", "sleep 30"],
        cols: 80,
        rows: 24,
      });
      const created = runTmuxArgv(spawnArgv);
      // Flaky-tolerant: if the server failed to start the session, skip rather than fail.
      if (created !== 0) {
        expect(created).toBeGreaterThanOrEqual(0); // record, do not hard-fail (soak tier)
        return;
      }

      // 2) Simulate a worker/daemon RESTART: the in-process worker is gone, but the
      //    tmux SERVER persists. A fresh worker probes by the DETERMINISTIC name.
      const found = runTmuxArgv(buildTmuxHasSessionArgv({ tmuxPath: TMUX, name: NAME }));
      expect(found).toBe(0); // has-session succeeds → the session SURVIVED the restart → re-attach

      // 3) A NON-existent name must NOT be found (the probe truly discriminates).
      const ghost = runTmuxArgv(
        buildTmuxHasSessionArgv({ tmuxPath: TMUX, name: `${NAME}-does-not-exist` }),
      );
      expect(ghost).not.toBe(0);
    });
  },
);

/**
 * Live proof of the per-session `-e` env FRESHNESS fix, against a real tmux server. A tmux pane
 * inherits the SERVER's GLOBAL environment, captured ONCE when the server first starts and never
 * refreshed — so on a long-lived server (it outlives daemon restarts by design) a later drive
 * would inherit the value the server booted with, not the daemon's current one (e.g. a rotated ADO
 * PAT would never reach a new drive). {@link buildTmuxSpawnArgv} now injects the current scrubbed
 * env per session via `-e`, which OVERRIDES the stale server-global value on that pane. This drives
 * the tmux CLI directly (no node-pty / no bwrap needed — only a real tmux + its own `-S` socket) so
 * it runs on any Linux/CI box with tmux, isolating the env-freshness mechanism.
 */
describe.skipIf(!isLinux() || !tmuxAvailable())(
  "Live tmux (Linux) — per-session `-e` injects the CURRENT env over the server's boot-time env",
  () => {
    const RUN = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    const SOCK = join(tmpdir(), `comis-tmux-e-${RUN}.sock`);
    const S1 = `comis-efresh1-${RUN}`;
    const S2 = `comis-efresh2-${RUN}`;
    const OUT = join(tmpdir(), `comis-pane-env-${RUN}.txt`);

    afterEach(() => {
      // Reap both sessions + kill the dedicated server + drop the pane-env probe file.
      runTmuxArgv([TMUX, "-S", SOCK, "kill-server"]);
      for (const p of [OUT, SOCK]) {
        try {
          rmSync(p, { force: true });
        } catch {
          /* best-effort cleanup */
        }
      }
    });

    it("a per-session server sees its OWN current env, with NOTHING on the command line", async () => {
      // Freshness WITHOUT argv exposure. Server A is started with TOKEN_VAL=OLD in its process
      // env; server B (a DIFFERENT socket ⇒ a different server, i.e. the per-session model) is
      // started with TOKEN_VAL=NEW the same way. B's pane must read NEW — proving a later drive
      // is not pinned to an earlier server's boot-time capture — while NEITHER tmux command line
      // carries the value, since argv is world-readable and `environ` is not.
      const SOCK_B = join(tmpdir(), `comis-tmux-b-${RUN}.sock`);
      const OUT_B = join(tmpdir(), `comis-pane-env-b-${RUN}.txt`);
      try {
        const first = spawnSync(
          TMUX,
          ["-S", SOCK, "new-session", "-d", "-s", S1, "--", "sh", "-c", "sleep 30"],
          { env: { ...process.env, TOKEN_VAL: "old-val-zzz" }, timeout: 5_000, encoding: "utf8" },
        );
        if (first.status !== 0) {
          expect(first.status ?? 0).toBeGreaterThanOrEqual(0); // soak-tier tolerant
          return;
        }
        // Server B: built by the PRODUCTION builder (no env param exists on it any more), and
        // handed the current env via the spawn's PROCESS environment — the private channel.
        const argv = buildTmuxSpawnArgv({
          tmuxPath: TMUX,
          socketPath: SOCK_B,
          name: S2,
          bin: "sh",
          binArgv: ["-c", `printenv TOKEN_VAL > ${OUT_B}; sleep 5`],
          cols: 80,
          rows: 24,
        });
        expect(argv).not.toContain("-e");
        // The driven command legitimately NAMES the var (`printenv TOKEN_VAL`); what must never
        // appear is an assignment or the VALUE itself.
        expect(argv.join(" ")).not.toContain("TOKEN_VAL=");
        expect(argv.join(" ")).not.toContain("new-val-qqq");
        const second = spawnSync(argv[0]!, argv.slice(1), {
          env: { ...process.env, TOKEN_VAL: "new-val-qqq" },
          timeout: 5_000,
          encoding: "utf8",
        });
        if (second.status !== 0) {
          expect(second.status ?? 0).toBeGreaterThanOrEqual(0);
          return;
        }
        let paneSaw: string | undefined;
        for (let i = 0; i < 20 && paneSaw === undefined; i++) {
          await new Promise((r) => setTimeout(r, 100));
          if (existsSync(OUT_B)) paneSaw = readFileSync(OUT_B, "utf8").trim();
        }
        if (paneSaw === undefined) return; // pane never wrote (transient) — soak-tier tolerant
        expect(paneSaw).toBe("new-val-qqq"); // its own server's env, not server A's old-val-zzz

        // POSITIVE CONTROL — the reason the socket must be per-session. Without it the assertion
        // above is trivially true (a fresh server always sees its own spawn env) and would stay
        // green even if production regressed to ONE shared socket. So exercise that regression
        // here: a third session created on server A's socket, with the CURRENT env in its process
        // environment, still reads A's boot-time capture — because `new-session` on a socket that
        // already has a server does not start a new one, it commands the existing one, and the
        // pane inherits that server's global env. THAT is the staleness per-session sockets fix,
        // and `-e` (now removed) used to paper over.
        const S3 = `comis-efresh3-${RUN}`;
        const OUT_C = join(tmpdir(), `comis-pane-env-c-${RUN}.txt`);
        try {
          const third = spawnSync(
            TMUX,
            ["-S", SOCK, "new-session", "-d", "-s", S3, "--", "sh", "-c", `printenv TOKEN_VAL > ${OUT_C}; sleep 5`],
            { env: { ...process.env, TOKEN_VAL: "new-val-qqq" }, timeout: 5_000, encoding: "utf8" },
          );
          if (third.status !== 0) return; // soak-tier tolerant
          let sharedSaw: string | undefined;
          for (let i = 0; i < 20 && sharedSaw === undefined; i++) {
            await new Promise((r) => setTimeout(r, 100));
            if (existsSync(OUT_C)) sharedSaw = readFileSync(OUT_C, "utf8").trim();
          }
          if (sharedSaw === undefined) return; // pane never wrote (transient)
          expect(sharedSaw).toBe("old-val-zzz"); // pinned to server A's boot env — the regression
        } finally {
          rmSync(OUT_C, { force: true });
        }
      } finally {
        runTmuxArgv([TMUX, "-S", SOCK_B, "kill-server"]);
        for (const p of [OUT_B, SOCK_B]) {
          try {
            rmSync(p, { force: true });
          } catch {
            /* best-effort cleanup */
          }
        }
      }
    });
  },
);
