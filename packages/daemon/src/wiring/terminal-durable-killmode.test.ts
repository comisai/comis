// SPDX-License-Identifier: Apache-2.0
/**
 * Survival contract — the deployed systemd unit MUST set `KillMode=process`.
 *
 * A durable terminal drive (`drive.durable:true`) runs its child inside a DETACHED
 * `tmux new-session -d -s comis-<id>` server so the session OUTLIVES a daemon restart
 * (so it can be re-attached by name after a restart). The tmux server
 * daemonizes (reparented to init) BUT remains a member of the daemon's systemd cgroup —
 * cgroup membership is inherited at fork and a daemonize/`setsid` does NOT change it, and
 * the daemon can't move it out (`ProtectControlGroups=yes`, non-root `comis` user, no
 * user bus for `systemd-run --user --scope`).
 *
 * So with systemd's DEFAULT `KillMode=control-group`, every `systemctl restart` (and the
 * failure-cleanup after a crash) SIGKILLs the ENTIRE cgroup — including the daemonized
 * tmux server. The durable session dies. Observed on a live host:
 * `systemctl show comis -p KillMode` → `control-group`, and the
 * `comis-<id>` tmux server was gone after a `systemctl restart comis`.
 *
 * The fix is `KillMode=process`: systemd signals ONLY the main daemon process on stop,
 * leaving the rest of the cgroup alone. The durable tmux server (daemonized, independent
 * of the worker) then survives; non-durable sessions are still reaped because (a) graceful
 * shutdown runs the registry cleanup and (b) the Terminal Worker self-exits on its stdin
 * EOF when the daemon dies (terminal-worker-main.ts), and its non-durable bwrap children
 * carry `--die-with-parent` (terminal-scope-args.ts). This test pins `KillMode=process`
 * on EVERY deployed unit definition so the survival contract cannot silently regress
 * (the install.sh heredoc is what actually reaches a VPS; the template is the canonical
 * unit-of-record).
 *
 * This is the macOS-runnable half of the survival proof; the live half is the
 * VPS reproduction (durable session → `systemctl restart` → `tmux has-session` still 0).
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

describe("durable terminal sessions survive a daemon restart (KillMode=process)", () => {
  it("the canonical comis.service.template sets KillMode=process", () => {
    const content = readFileSync(resolve(repoRoot(), "packages/daemon/systemd/comis.service.template"), "utf8");
    expect(content).toMatch(KILLMODE_PROCESS);
  });

  it("the deployed install.sh daemon unit sets KillMode=process", () => {
    const installSh = readFileSync(resolve(repoRoot(), "website/public/install.sh"), "utf8");
    // install.sh emits TWO units (an Xvfb helper + the daemon). Scope the assertion to the
    // DAEMON unit block so an unrelated KillMode elsewhere can't falsely satisfy it.
    const start = installSh.indexOf("Description=Comis AI Agent Daemon");
    expect(start).toBeGreaterThanOrEqual(0);
    const installIdx = installSh.indexOf("[Install]", start);
    const daemonUnit = installSh.slice(start, installIdx >= 0 ? installIdx : undefined);
    expect(daemonUnit).toMatch(KILLMODE_PROCESS);
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
  it("the canonical comis.service.template ReadWritePaths includes the whole service home", () => {
    const content = readFileSync(resolve(repoRoot(), "packages/daemon/systemd/comis.service.template"), "utf8");
    expect(content).toMatch(/ReadWritePaths=[^\n]*@SVC_HOME@(?!\/)/);
  });

  it("the deployed install.sh daemon unit ReadWritePaths includes the whole service home", () => {
    const installSh = readFileSync(resolve(repoRoot(), "website/public/install.sh"), "utf8");
    const start = installSh.indexOf("Description=Comis AI Agent Daemon");
    const installIdx = installSh.indexOf("[Install]", start);
    const daemonUnit = installSh.slice(start, installIdx >= 0 ? installIdx : undefined);
    expect(daemonUnit).toMatch(/ReadWritePaths=[^\n]*\$\{COMIS_SVC_HOME\}(?!\/)/);
  });
});
