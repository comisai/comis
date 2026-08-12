// SPDX-License-Identifier: Apache-2.0
/**
 * buildSpawnPlan — the scope-jail COMPOSITION seam (macOS-testable, pure).
 *
 * These tests prove the PRODUCTION composition (not just `buildScopeArgs` in
 * isolation): `buildSpawnPlan` threads the resolved in-jail relay-as-init SCRIPT
 * path into the bwrap argv as a `--ro-bind` for `network: listed-hosts` ONLY, so
 * the in-jail `node <relayInit>` can READ its own init script. The file exists on
 * the HOST but is not bound by default — the VPS scope-matrix egress cell died with
 * `Cannot find module …/egress-relay-init.js` because that bind was missing.
 *
 * NO bwrap spawn, NO real socket — a fixed in-memory `EgressControlPort` echoes a
 * socket path, so the full argv composition is asserted on macOS. The live relay
 * bridge is the VPS suite (`terminal-scope-matrix.linux.test.ts`).
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EgressControlPort } from "@comis/core";

import { AttachmentSandboxUnavailableError, buildSpawnPlan, JailUnavailableError, planSpawnFromCreateFrame, type CreateFrameSpawnParams, type SpawnPlanInput } from "./terminal-spawn-plan.js";
import { RELAY_INIT_SCRIPT_URL } from "./terminal-egress-relay.js";
import type { TerminalScope } from "./allowlist-matcher.js";

function makeScope(overrides: Partial<TerminalScope> = {}): TerminalScope {
  return {
    filesystem: "workspace",
    network: "none",
    credentialPaths: [],
    ephemeralWritablePaths: [],
    uid: "dedicated",
    ...overrides,
  };
}

function makeInput(overrides: Partial<SpawnPlanInput> = {}): SpawnPlanInput {
  return {
    scope: makeScope(),
    bin: "/bin/cat",
    argv: [],
    workspace: "/ws",
    cwd: "/ws",
    home: "/home/u",
    dataDir: "/home/u/.comis",
    systemRoPaths: ["/usr", "/bin"],
    env: {},
    ...overrides,
  };
}

/** A fixed EgressControlPort that echoes a socket path (no real proxy stood up). */
function fixedEgressControl(socketPath: string): EgressControlPort {
  return {
    materialize: () => Promise.resolve({ socketPath, dispose: () => Promise.resolve() }),
  };
}

/** Check that args contain a `flag src dest` triple. */
function hasBind(args: string[], flag: string, src: string, dest?: string): boolean {
  const d = dest ?? src;
  for (let i = 0; i < args.length - 2; i++) {
    if (args[i] === flag && args[i + 1] === src && args[i + 2] === d) return true;
  }
  return false;
}

const RELAY_INIT_PATH = fileURLToPath(RELAY_INIT_SCRIPT_URL);

describe("buildSpawnPlan — relay-init script bind (the VPS Cannot-find-module fix)", () => {
  it("listed-hosts ro-binds the relay-init script into the jail (so in-jail node can read it)", async () => {
    const plan = await buildSpawnPlan(
      makeInput({ scope: makeScope({ network: "listed-hosts", hosts: ["example.com"] }) }),
      { bwrapPath: "/usr/bin/bwrap", egressControl: fixedEgressControl("/tmp/egress.sock") },
    );
    // The bound path must be the SAME path node execs (relayArgv[1]) — never drift.
    expect(hasBind(plan.argv, "--ro-bind", RELAY_INIT_PATH, RELAY_INIT_PATH)).toBe(true);
    // And the relay-init is actually invoked in the argv (the path is load-bearing).
    expect(plan.argv).toContain(RELAY_INIT_PATH);
  });

  it("none does NOT ro-bind the relay-init script (no relay in the path)", async () => {
    const plan = await buildSpawnPlan(makeInput({ scope: makeScope({ network: "none" }) }), {
      bwrapPath: "/usr/bin/bwrap",
    });
    expect(plan.argv).not.toContain(RELAY_INIT_PATH);
  });

  it("full does NOT ro-bind the relay-init script (host net, no relay)", async () => {
    const plan = await buildSpawnPlan(makeInput({ scope: makeScope({ network: "full" }) }), {
      bwrapPath: "/usr/bin/bwrap",
    });
    expect(plan.argv).not.toContain(RELAY_INIT_PATH);
  });
});

describe("buildSpawnPlan — verified executable visibility", () => {
  it("threads the canonical driven executable into the read-only jail mounts", async () => {
    const executablePath = "/opt/operator-tools/bin/worker";
    const plan = await buildSpawnPlan(makeInput({ bin: executablePath }), {
      bwrapPath: "/usr/bin/bwrap",
    });

    expect(hasBind(plan.argv, "--ro-bind", executablePath, executablePath)).toBe(true);
  });
});

describe("planSpawnFromCreateFrame — managed linked-worktree Git visibility", () => {
  it("binds the real shared Git administration directory only for an authority-backed workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "managed-linked-worktree-"));
    try {
      const commonDir = join(root, "repository", ".git");
      const gitDir = join(commonDir, "worktrees", "task-a");
      const workspace = join(root, "worktrees", "task-a");
      mkdirSync(gitDir, { recursive: true });
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(workspace, ".git"), `gitdir: ${gitDir}\n`, "utf8");
      writeFileSync(join(gitDir, "commondir"), "../..\n", "utf8");

      const params = {
        bin: "/bin/cat",
        argv: [],
        scope: makeScope(),
        workspace,
        cwd: workspace,
        managedWorkspace: true,
      } as CreateFrameSpawnParams & { managedWorkspace: true };
      const plan = await planSpawnFromCreateFrame(params, {}, { bwrapPath: "/usr/bin/bwrap" });

      expect(hasBind(plan.argv, "--bind", commonDir, commonDir)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildSpawnPlan — execution attachment confinement", () => {
  const attachment = {
    executionAttachmentId: "execution-attachment_a",
    sourcePath: "/srv/runtime/worker.sock",
    targetName: `attachment-${"a".repeat(32)}.sock`,
  };

  it("fails closed when an attachment cannot be materialized by bubblewrap", async () => {
    await expect(buildSpawnPlan(makeInput({ executionAttachments: [attachment] }), {}))
      .rejects.toMatchObject({
        name: AttachmentSandboxUnavailableError.name,
        errorKind: "sandbox_unavailable",
      });
    await expect(buildSpawnPlan(
      makeInput({ executionAttachments: [attachment] }),
      { bwrapPath: "/usr/bin/bwrap", unsafeDisableSandbox: true },
    )).rejects.toMatchObject({ errorKind: "sandbox_unavailable" });
  });

  it("threads only the approved attachment record into the bubblewrap composer", async () => {
    const plan = await buildSpawnPlan(makeInput({ executionAttachments: [attachment] }), {
      bwrapPath: "/usr/bin/bwrap",
    });
    expect(hasBind(
      plan.argv,
      "--ro-bind",
      attachment.sourcePath,
      `/run/comis/attachments/${attachment.targetName}`,
    )).toBe(true);
  });
});

describe("buildSpawnPlan — sandbox signal (a driven CLI must not nest its own broken sandbox)", () => {
  it("injects CLAUDE_CODE_BUBBLEWRAP=1 so a sandbox-aware CLI trusts the outer bwrap (no nested-sandbox EROFS)", async () => {
    // Real-VPS 2026-06-16 (session a7c44a66): a driven `claude` did NOT detect our outer bwrap,
    // so its Bash tool nested its OWN bubblewrap sandbox, which remounts $HOME ro and then
    // EROFSes on `mkdir ~/.claude/session-env/<id>` — claude authored the snake-game files but
    // every Bash command was dead. We ALWAYS jail the CLI in bwrap (buildSpawnPlan throws
    // JailUnavailableError otherwise), so signal it: claude reads CLAUDE_CODE_BUBBLEWRAP →
    // "already bubblewrapped" → skips the redundant, nested-broken second sandbox and runs bash
    // directly in OUR jail (the operator-configured security boundary). Honest: we DID bwrap it.
    const plan = await buildSpawnPlan(makeInput(), { bwrapPath: "/usr/bin/bwrap" });
    expect(plan.env.CLAUDE_CODE_BUBBLEWRAP).toBe("1");
  });

  it("preserves the bubblewrap signal AFTER scrubChildEnv strips every CLAUDE_CODE_* key", async () => {
    // scrubChildEnv blanket-strips CLAUDE_CODE_* (the daemon's OWN nested-session markers, since
    // the daemon can itself run inside a Claude Code session). The bubblewrap signal shares that
    // prefix, so it MUST be injected POST-scrub or the scrubber erases it — which is precisely
    // why a jailed claude never saw it and nested its own sandbox.
    const plan = await buildSpawnPlan(
      makeInput({
        env: { CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDECODE: "1", CLAUDE_CODE_BUBBLEWRAP: "" },
      }),
      { bwrapPath: "/usr/bin/bwrap" },
    );
    expect(plan.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined(); // daemon marker scrubbed
    expect(plan.env.CLAUDECODE).toBeUndefined(); // nested-session sentinel scrubbed
    expect(plan.env.CLAUDE_CODE_BUBBLEWRAP).toBe("1"); // sandbox signal survives + honest "1"
  });
});

describe("buildSpawnPlan — backend-independent env hardening in the bwrap argv (the tmux/durable gap)", () => {
  // Real-VPS 2026-06-17: the `env` field above is applied by the PTY backend (pty.spawn({env})),
  // but the DEFAULT durable/tmux backend runs `tmux new-session -- bwrap …`, and the session
  // inherits the tmux SERVER env, BYPASSING the worker's scrubbed env entirely. Result: the
  // daemon's `NODE_OPTIONS=--permission …` leaked into a driven claude AND CLAUDE_CODE_BUBBLEWRAP
  // never reached it → its Bash/SessionStart-hook EROFS'd on the default backend. Fix: emit the env
  // hardening as bwrap FLAGS in the argv, so bwrap clears/sets its own child env on EVERY backend.
  it("emits --setenv CLAUDE_CODE_BUBBLEWRAP 1 in the argv (reaches the tmux backend, not just PTY's env field)", async () => {
    const plan = await buildSpawnPlan(makeInput(), { bwrapPath: "/usr/bin/bwrap" });
    expect(plan.argv.join(" ")).toContain("--setenv CLAUDE_CODE_BUBBLEWRAP 1");
  });

  it("emits --unsetenv NODE_OPTIONS in the argv (strips the daemon's leaked Node --permission hardening)", async () => {
    const plan = await buildSpawnPlan(makeInput(), { bwrapPath: "/usr/bin/bwrap" });
    expect(plan.argv.join(" ")).toContain("--unsetenv NODE_OPTIONS");
  });

  it("emits --unsetenv for the whole interpreter-control blocklist + the CLAUDECODE sentinel", async () => {
    const plan = await buildSpawnPlan(makeInput(), { bwrapPath: "/usr/bin/bwrap" });
    const argvStr = plan.argv.join(" ");
    for (const key of ["BASH_ENV", "PYTHONSTARTUP", "NODE_OPTIONS", "CLAUDECODE"]) {
      expect(argvStr).toContain(`--unsetenv ${key}`);
    }
  });
});

describe("buildSpawnPlan — daemon secrets MUST NOT enter the jailed CLI env (TERM-ENV-GATEWAY-TOKEN-LEAK)", () => {
  // HIGH (security): the bwrap jail masks secrets.db (--tmpfs ~/.comis), but the daemon's admin
  // gateway token leaked through the env-scrub on the `inherited` source — with network:full a
  // prompt-injected driven CLI could `curl` the loopback gateway (scope `*`) and seize the control
  // plane. Live-confirmed: a jailed claude 2.1.196's
  // /proc/<pid>/environ carried COMIS_GATEWAY_TOKEN + GWTOKEN. This proves the PRODUCTION composition
  // (buildSpawnPlan, not just scrubChildEnv) strips them on BOTH backends.
  const LEAKY_ENV: NodeJS.ProcessEnv = {
    COMIS_GATEWAY_TOKEN: "admin-bearer-scope-star",
    GWTOKEN: "ops-alias",
    GATEWAY_TOKEN_DEFAULT: "minted-default",
    SECRETS_MASTER_KEY: "store-master-key",
    COMIS_CAP_LEASE: "keep-lease", // broker/cap path must survive
    TERM: "xterm-256color", // rich TUI env must survive
  };

  it("PTY backend: plan.env carries NONE of the daemon secrets but keeps the broker/cap + TUI vars", async () => {
    const plan = await buildSpawnPlan(makeInput({ env: LEAKY_ENV }), { bwrapPath: "/usr/bin/bwrap" });
    expect(plan.env.COMIS_GATEWAY_TOKEN).toBeUndefined();
    expect(plan.env.GWTOKEN).toBeUndefined();
    expect(plan.env.GATEWAY_TOKEN_DEFAULT).toBeUndefined();
    expect(plan.env.SECRETS_MASTER_KEY).toBeUndefined();
    // No over-scrub.
    expect(plan.env.COMIS_CAP_LEASE).toBe("keep-lease");
    expect(plan.env.TERM).toBe("xterm-256color");
  });

  it("tmux/durable backend: emits --unsetenv for every leaked daemon-secret key in the bwrap argv", async () => {
    // The DEFAULT durable/tmux backend inherits the tmux SERVER env, BYPASSING plan.env — only the
    // bwrap --unsetenv flags protect it (the same gap that leaked the daemon's NODE_OPTIONS on the VPS).
    const plan = await buildSpawnPlan(makeInput({ env: LEAKY_ENV }), { bwrapPath: "/usr/bin/bwrap" });
    const argv = plan.argv.join(" ");
    for (const key of ["COMIS_GATEWAY_TOKEN", "GWTOKEN", "GATEWAY_TOKEN_DEFAULT", "SECRETS_MASTER_KEY"]) {
      expect(argv, `--unsetenv ${key} must be in the bwrap argv`).toContain(`--unsetenv ${key}`);
    }
  });
});

describe("buildSpawnPlan — operator-declared ephemeral writable paths", () => {
  it("does not inject a platform-specific writable path into an unrelated terminal jail", async () => {
    const plan = await buildSpawnPlan(makeInput(), { bwrapPath: "/usr/bin/bwrap" });
    expect(plan.argv.join(" ")).not.toContain("--tmpfs /home/u/.claude/session-env");
  });

  it("materializes an explicit ephemeral path before the data-directory mask", async () => {
    const scope = {
      ...makeScope(),
      ephemeralWritablePaths: ["~/.agent-state/runtime"],
    } as unknown as TerminalScope;
    const plan = await buildSpawnPlan(makeInput({ scope }), { bwrapPath: "/usr/bin/bwrap" });
    const s = plan.argv.join(" ");
    const ephemeralIdx = s.indexOf("--tmpfs /home/u/.agent-state/runtime");
    const comisIdx = s.indexOf("--tmpfs /home/u/.comis");
    expect(ephemeralIdx).toBeGreaterThanOrEqual(0);
    expect(comisIdx).toBeGreaterThan(ephemeralIdx);
  });
});

describe("buildSpawnPlan — unsafeDisableSandbox (the operator opt-out of the jail)", () => {
  // The terminal driver is fail-closed by design: no bwrap ⇒ no child (JailUnavailableError).
  // `skills.terminal.unsafeDisableSandbox: true` is the operator-only, immutable opt-out for
  // constrained hosts that cannot run bwrap (a container with no user-namespaces, a CI box) — the
  // exact peer of `browser.noSandbox`. It runs the driven CLI DIRECTLY (no bwrap), so it provides
  // NO filesystem/network/uid confinement — but the env-scrub is preserved, so daemon SECRETS
  // still never reach the child. It is a genuine security downgrade, surfaced in config_posture.

  it("returns an UNSANDBOXED plan (child runs directly, no bwrap) when the operator opts out", async () => {
    const plan = await buildSpawnPlan(makeInput(), { unsafeDisableSandbox: true });
    expect(plan.bin).toBe("/bin/cat"); // the driven CLI itself, NOT the bwrap binary
    expect(plan.unsandboxed).toBe(true); // the backend reads this for the direct (no-bwrap) spawn; a durable tmux drive is still allowed
    expect(plan.cwd).toBe("/ws"); // the child still runs in the session workspace (no bwrap --chdir)
    expect(plan.argv.join(" ")).not.toContain("bwrap"); // no jail wrapper anywhere in the argv
    // We did NOT bubblewrap it, so we must NOT lie to a sandbox-aware CLI (claude may nest its own).
    expect(plan.env.CLAUDE_CODE_BUBBLEWRAP).toBeUndefined();
  });

  it("SECURITY: even unsandboxed, daemon secrets are STILL scrubbed from the child env", async () => {
    // The whole point of the guarantee: "unsandboxed" must never also mean "secrets leak". The
    // env-scrub runs on the direct-spawn path exactly as on the jailed path.
    const LEAKY_ENV: NodeJS.ProcessEnv = {
      COMIS_GATEWAY_TOKEN: "admin-bearer-scope-star",
      GWTOKEN: "ops-alias",
      GATEWAY_TOKEN_DEFAULT: "minted-default",
      SECRETS_MASTER_KEY: "store-master-key",
      COMIS_CAP_LEASE: "keep-lease", // broker/cap path must survive
      TERM: "xterm-256color", // rich TUI env must survive
    };
    const plan = await buildSpawnPlan(makeInput({ env: LEAKY_ENV }), { unsafeDisableSandbox: true });
    expect(plan.env.COMIS_GATEWAY_TOKEN).toBeUndefined();
    expect(plan.env.GWTOKEN).toBeUndefined();
    expect(plan.env.GATEWAY_TOKEN_DEFAULT).toBeUndefined();
    expect(plan.env.SECRETS_MASTER_KEY).toBeUndefined();
    // No over-scrub — the child still gets the broker/cap lease + a rich TUI env.
    expect(plan.env.COMIS_CAP_LEASE).toBe("keep-lease");
    expect(plan.env.TERM).toBe("xterm-256color");
  });

  it("opts out UNCONDITIONALLY — runs unsandboxed even when bwrap IS available (the browser.noSandbox precedent)", async () => {
    const plan = await buildSpawnPlan(makeInput(), {
      unsafeDisableSandbox: true,
      bwrapPath: "/usr/bin/bwrap", // present, but the operator asked for no sandbox
    });
    expect(plan.bin).toBe("/bin/cat");
    expect(plan.unsandboxed).toBe(true);
  });

  it("runs unsandboxed with NO bwrapPath (the constrained-host case) — does NOT throw", async () => {
    const plan = await buildSpawnPlan(makeInput(), { unsafeDisableSandbox: true });
    expect(plan.unsandboxed).toBe(true);
  });

  it("FLOOR UNCHANGED: without the opt-out, no bwrapPath STILL fails closed (never an unjailed child)", async () => {
    await expect(buildSpawnPlan(makeInput(), {})).rejects.toBeInstanceOf(JailUnavailableError);
    await expect(buildSpawnPlan(makeInput(), { unsafeDisableSandbox: false })).rejects.toBeInstanceOf(
      JailUnavailableError,
    );
  });
});

describe("unsandboxed drive env — the daemon's own Node env must not reach the pane", () => {
  it("strips NODE_OPTIONS (interpreter vector) AND NODE_ENV (daemon runtime mode) from the unsandboxed plan env", async () => {
    // With `unsafeDisableSandbox` there is NO bwrap, so the `--unsetenv` half of the scrub does
    // not exist — the plan env is the ONLY thing standing between the daemon's own Node
    // permission flags and the driven CLI. Those flags are written FOR THE WORKER
    // (`--permission --allow-fs-write=<terminal-worker>`), and a driven pnpm/vitest/git
    // inheriting them fails in confusing ways: a live drive had to rediscover
    // `env -u NODE_OPTIONS -u NODE_ENV` six times in one run, including on `git commit`.
    // With one tmux server per session the pane inherits exactly this env via the server's
    // process environment, so this is the authoritative chokepoint.
    const plan = await buildSpawnPlan(
      {
        bin: "/usr/local/bin/claude",
        argv: [],
        cwd: "/w",
        dataDir: "/data",
        env: {
          PATH: "/usr/bin",
          NODE_OPTIONS: "--permission --allow-fs-write=/home/comis/.comis/terminal-worker",
          NODE_ENV: "production",
          BASH_ENV: "/tmp/evil.sh",
          LD_PRELOAD: "/tmp/evil.so",
          AZURE_DEVOPS_EXT_PAT: "keep-me",
        } as NodeJS.ProcessEnv,
        scope: { filesystem: "workspace", network: "none" } as never,
      } as never,
      { unsafeDisableSandbox: true } as never,
    );
    expect(plan.env.NODE_OPTIONS).toBeUndefined();
    expect(plan.env.NODE_ENV).toBeUndefined(); // the OTHER half of that `env -u` incantation
    expect(plan.env.BASH_ENV).toBeUndefined();
    expect(plan.env.LD_PRELOAD).toBeUndefined();
    // An operator secret the drive NEEDS must survive — this is a blocklist, not an allowlist.
    expect(plan.env.AZURE_DEVOPS_EXT_PAT).toBe("keep-me");
    expect(plan.env.PATH).toBe("/usr/bin");
  });
});
