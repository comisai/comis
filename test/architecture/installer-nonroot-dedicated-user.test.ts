// Installer guard — the dedicated `comis` user must be the DEFAULT on Linux, not a
// root-only side effect.
//
// The installer used to fork on privilege silently: root → isolated `comis` system user;
// non-root → the daemon runs as the login user, and with the sandbox's `--allow-fs-read=*`
// it can read that user's ~/.ssh and ~/.aws. The less-privileged invocation quietly produced
// the less-secure install (live EC2 example: `curl | bash` as `ubuntu` → daemon as `ubuntu`).
// The fix makes the dedicated-user layout the default for non-root Linux installs:
//   - interactive → ask once, then re-run itself under sudo (root flow takes over);
//   - non-interactive → refuse with the two explicit ways out (sudo, or --no-user);
//   - --no-user / COMIS_NO_USER=1 / an explicit --service choice → current-user install.
//
// These tests run the REAL bash decision + enforcement functions extracted from install.sh,
// with the environment probes (is_root, has_working_systemd, has_sudo, is_promptable) stubbed.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "..", "..");
const installSh = readFileSync(join(repoRoot, "website", "public", "install.sh"), "utf8");

/** Extract one top-level `name() { … }` bash function from install.sh (empty if absent). */
function extractFn(name: string): string {
  const lines = installSh.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`${name}()`));
  if (start === -1) return "";
  const end = lines.findIndex((l, i) => i > start && l === "}");
  return lines.slice(start, end + 1).join("\n");
}

interface Env {
  os?: string;
  root?: boolean;
  reexec?: boolean;
  noUser?: boolean;
  serviceManager?: string;
  systemd?: boolean;
  sudo?: boolean;
  promptable?: boolean;
  dryRun?: boolean;
}

function harnessPreamble(env: Env): string {
  return [
    "#!/usr/bin/env bash",
    "set -u",
    `OS=${env.os ?? "linux"}`,
    "COMIS_USER=comis",
    `COMIS_REEXEC=${env.reexec ? 1 : 0}`,
    `NO_USER=${env.noUser ? 1 : 0}`,
    `SERVICE_MANAGER=${env.serviceManager ?? "auto"}`,
    `DRY_RUN=${env.dryRun ? 1 : 0}`,
    "ui_info() { echo \"INFO: $*\"; }",
    "ui_error() { echo \"ERROR: $*\"; }",
    "ui_warn() { echo \"WARN: $*\"; }",
    `is_root() { return ${env.root ? 0 : 1}; }`,
    `has_working_systemd() { return ${env.systemd === false ? 1 : 0}; }`,
    `has_sudo() { return ${env.sudo === false ? 1 : 0}; }`,
    `is_promptable() { return ${env.promptable === false ? 1 : 0}; }`,
    extractFn("nonroot_install_strategy"),
    extractFn("enforce_dedicated_user_default"),
  ].join("\n");
}

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runHarness(script: string): { code: number; out: string } {
  const work = mkdtempSync(join(tmpdir(), "comis-installer-user-"));
  cleanups.push(work);
  const harnessPath = join(work, "harness.sh");
  writeFileSync(harnessPath, script);
  try {
    const out = execFileSync("bash", [harnessPath], { stdio: "pipe" }).toString();
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      code: e.status ?? -1,
      out: `${e.stdout?.toString() ?? ""}${e.stderr?.toString() ?? ""}`,
    };
  }
}

function strategy(env: Env): string {
  const run = runHarness(`${harnessPreamble(env)}\nnonroot_install_strategy`);
  expect(run.code).toBe(0);
  return run.out.trim();
}

describe("install.sh nonroot_install_strategy", () => {
  it("non-root Linux with systemd, sudo, and a TTY → offer the dedicated user", () => {
    expect(strategy({})).toBe("dedicated-prompt");
  });

  it("non-root without a TTY (or --no-prompt) → refuse: explicit choice required", () => {
    expect(strategy({ promptable: false })).toBe("refuse-no-prompt");
  });

  it("non-root without sudo available → refuse: cannot elevate", () => {
    expect(strategy({ sudo: false })).toBe("refuse-no-sudo");
  });

  it("--no-user / COMIS_NO_USER=1 opts out to a current-user install", () => {
    expect(strategy({ noUser: true })).toBe("current-user");
  });

  it("an explicit --service choice is respected (no hijack of systemd-user/pm2/none)", () => {
    expect(strategy({ serviceManager: "systemd-user" })).toBe("current-user");
    expect(strategy({ serviceManager: "none" })).toBe("current-user");
  });

  it("root installs are untouched (the existing root flow owns the dedicated user)", () => {
    expect(strategy({ root: true })).toBe("current-user");
  });

  it("macOS is untouched (no system-user concept in the pm2 flow)", () => {
    expect(strategy({ os: "macos" })).toBe("current-user");
  });

  it("no systemd (WSL/container) keeps today's fallback", () => {
    expect(strategy({ systemd: false })).toBe("current-user");
  });

  it("the re-exec'd child never loops back into the gate", () => {
    expect(strategy({ reexec: true })).toBe("current-user");
  });
});

describe("install.sh enforce_dedicated_user_default", () => {
  it("non-interactive refusal exits 2 and names both ways out (sudo and --no-user)", () => {
    const run = runHarness(
      `${harnessPreamble({ promptable: false })}\nenforce_dedicated_user_default`,
    );
    expect(run.code).toBe(2);
    expect(run.out).toContain("sudo");
    expect(run.out).toContain("--no-user");
  });

  it("no-sudo refusal exits 2 and names both ways out (root and --no-user)", () => {
    const run = runHarness(`${harnessPreamble({ sudo: false })}\nenforce_dedicated_user_default`);
    expect(run.code).toBe(2);
    expect(run.out).toContain("root");
    expect(run.out).toContain("--no-user");
  });

  it("declining the prompt falls back to a current-user install (NO_USER=1, rc 0)", () => {
    const run = runHarness(
      [
        harnessPreamble({}),
        "prompt_dedicated_user_consent() { return 1; }",
        "enforce_dedicated_user_default",
        'echo "NO_USER=$NO_USER"',
      ].join("\n"),
    );
    expect(run.code).toBe(0);
    expect(run.out).toContain("NO_USER=1");
  });

  it("accepting the prompt hands the install to the sudo re-exec", () => {
    const run = runHarness(
      [
        harnessPreamble({}),
        "prompt_dedicated_user_consent() { return 0; }",
        'elevate_install_to_root() { echo "ELEVATED"; exit 42; }',
        "enforce_dedicated_user_default",
      ].join("\n"),
    );
    expect(run.code).toBe(42);
    expect(run.out).toContain("ELEVATED");
  });

  it("dry runs describe the posture without sudo-ing or failing", () => {
    for (const env of [{ dryRun: true }, { dryRun: true, promptable: false }] as Env[]) {
      const run = runHarness(`${harnessPreamble(env)}\nenforce_dedicated_user_default`);
      expect(run.code).toBe(0);
      expect(run.out).toContain("comis");
    }
  });
});

describe("install.sh dedicated-user wiring", () => {
  it("main() runs the gate before any other interactive step", () => {
    expect(installSh).toMatch(/\n\s+enforce_dedicated_user_default\n/);
  });

  it("--no-user sets NO_USER (a real opt-out, not the re-exec sentinel)", () => {
    expect(installSh).toMatch(/--no-user\)\s*\n\s*NO_USER=1/);
  });

  it("COMIS_NO_USER env var backs the flag", () => {
    expect(installSh).toContain('NO_USER="${COMIS_NO_USER:-0}"');
  });

  it("the root flow honors the opt-out too", () => {
    const fn = extractFn("should_create_dedicated_user");
    expect(fn).toContain("NO_USER");
  });
});
