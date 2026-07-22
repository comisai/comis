// SPDX-License-Identifier: Apache-2.0
/**
 * Survival contract — the deployed systemd unit MUST set `KillMode=process`.
 *
 * A durable terminal drive (`drive.durable:true`) runs its child inside a DETACHED
 * `tmux new-session -d -s comis-<id>` server so the session OUTLIVES a daemon restart
 * and can be re-attached by name. The tmux server daemonizes but remains a member of
 * the daemon's systemd cgroup because cgroup membership is inherited at fork.
 *
 * systemd's default `KillMode=control-group` would kill that detached server during
 * restart. `KillMode=process` signals only the daemon; graceful shutdown and the
 * terminal worker's stdin lifecycle still reap non-durable children. The public
 * installer is the sole deployed systemd-unit renderer, so this test reads it directly.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** Walk up from this test file to the monorepo root (the dir holding pnpm-workspace.yaml). */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repo root (pnpm-workspace.yaml) not found from the test file");
}

const KILLMODE_PROCESS = /^KillMode=process\s*$/m;

function readDeployedDaemonUnit(): string {
  const installSh = readFileSync(resolve(repoRoot(), "website/public/install.sh"), "utf8");
  const start = installSh.indexOf("Description=Comis AI Agent Daemon");
  expect(start).toBeGreaterThanOrEqual(0);
  const installIndex = installSh.indexOf("[Install]", start);
  return installSh.slice(start, installIndex >= 0 ? installIndex : undefined);
}

describe("durable terminal sessions survive a daemon restart (KillMode=process)", () => {
  it("the deployed install.sh daemon unit sets KillMode=process", () => {
    expect(readDeployedDaemonUnit()).toMatch(KILLMODE_PROCESS);
  });

  it("the deployed daemon unit uses Type=exec without a systemd watchdog", () => {
    const daemonUnit = readDeployedDaemonUnit();
    expect(daemonUnit).toMatch(/^Type=exec\s*$/m);
    expect(daemonUnit).not.toMatch(/^Type=notify\s*$/m);
    expect(daemonUnit).not.toMatch(/^WatchdogSec=/m);
    expect(daemonUnit).not.toMatch(/^NotifyAccess=/m);
  });

  it("applies an owner-only mode to new private artifacts in the deployed daemon unit", () => {
    expect(readDeployedDaemonUnit()).toMatch(/^UMask=0077\s*$/m);
  });
});

// The terminal driver's `filesystem: home` scope gives a driven
// CLI its home READ-WRITE — its binary in `~/.local`, its state/creds in `~/.claude` / `~/.codex`.
// But the bwrap jail binds the DAEMON's view of `~/`, so the unit's `ProtectHome=read-only` leaked
// in and read-onlyed exactly those dirs → claude/codex couldn't write their state at launch and
// EXITED instantly (observed: read-only `~/.claude` → ~2s exit; `ReadWritePaths=<home>` → claude
// builds+commits a project). The unit MUST grant the service home read-write (the bwrap jail + the
// `~/.comis` mask are the real isolation; ProtectHome still hides /root + other users' homes).
describe("the unit grants the service HOME read-write so driven CLIs persist state", () => {
  // The home as a STANDALONE ReadWritePaths entry (not just `<home>/.npm` subdirs) — so a driven
  // CLI's own state dirs (`~/.claude`, `~/.codex`, …) are writable. The negative lookahead `(?!/)`
  // rejects the old subdir-only form (`@SVC_HOME@/.npm`), which left `~/.claude` read-only.
  it("the deployed install.sh daemon unit ReadWritePaths includes the whole service home", () => {
    expect(readDeployedDaemonUnit()).toMatch(
      /ReadWritePaths=[^\n]*\$\{COMIS_SVC_HOME\}(?!\/)/,
    );
  });
});
