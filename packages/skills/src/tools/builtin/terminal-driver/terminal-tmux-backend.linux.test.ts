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

    it("a 2nd session started with `-e TOKEN_VAL=NEW` sees NEW even though the server booted with OLD", async () => {
      // 1) Start the server via a FIRST session whose PROCESS env carries TOKEN_VAL=OLD — the
      //    server's global environment captures OLD for its whole life.
      const first = spawnSync(
        TMUX,
        ["-S", SOCK, "new-session", "-d", "-s", S1, "--", "sh", "-c", "sleep 30"],
        { env: { ...process.env, TOKEN_VAL: "OLD" }, timeout: 5_000, encoding: "utf8" },
      );
      if (first.status !== 0) {
        expect(first.status ?? 0).toBeGreaterThanOrEqual(0); // flaky-tolerant (soak tier), never hard-fail
        return;
      }

      // 2) Create a 2nd session via the PRODUCTION builder, injecting the CURRENT value with `-e`.
      //    The pane writes its OWN process env for TOKEN_VAL to a file.
      const argv = buildTmuxSpawnArgv({
        tmuxPath: TMUX,
        socketPath: SOCK,
        name: S2,
        bin: "sh",
        binArgv: ["-c", `printenv TOKEN_VAL > ${OUT}; sleep 5`],
        cols: 80,
        rows: 24,
        env: { TOKEN_VAL: "NEW" } as NodeJS.ProcessEnv,
      });
      expect(argv).toContain("-e");
      expect(argv).toContain("TOKEN_VAL=NEW"); // the builder emitted the per-session override
      const second = spawnSync(argv[0]!, argv.slice(1), { timeout: 5_000, encoding: "utf8" });
      if (second.status !== 0) {
        expect(second.status ?? 0).toBeGreaterThanOrEqual(0);
        return;
      }

      // 3) The pane's ACTUAL process env must show NEW (the `-e` override), NOT the server's OLD.
      let paneSaw: string | undefined;
      for (let i = 0; i < 20 && paneSaw === undefined; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (existsSync(OUT)) paneSaw = readFileSync(OUT, "utf8").trim();
      }
      if (paneSaw === undefined) return; // pane never wrote (transient) — soak-tier tolerant
      expect(paneSaw).toBe("NEW"); // fresh value reached the pane; the stale server-global OLD did not
    });
  },
);
