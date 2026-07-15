import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "..", "..");
const installerPath = join(repoRoot, "website", "public", "install.sh");

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeWorkDir(): string {
  const work = mkdtempSync(join(tmpdir(), "comis-installer-handoff-"));
  cleanups.push(work);
  return work;
}

function runHarness(body: string, env: Record<string, string> = {}): { code: number; out: string } {
  const work = makeWorkDir();
  const harnessPath = join(work, "harness.sh");
  writeFileSync(
    harnessPath,
    [
      "#!/usr/bin/env bash",
      "export COMIS_INSTALL_SH_NO_RUN=1",
      'source "$INSTALLER_PATH"',
      body,
      "",
    ].join("\n"),
  );

  const run = spawnSync("bash", [harnessPath], {
    encoding: "utf8",
    env: { ...process.env, INSTALLER_PATH: installerPath, ...env },
  });
  return { code: run.status ?? -1, out: `${run.stdout}${run.stderr}` };
}

describe("install.sh privileged preparation", () => {
  it("executes the verified Rust installer under its rustup-init proxy name", () => {
    const work = makeWorkDir();
    const fakeRustup = join(work, "verified-rustup-artifact");
    const marker = join(work, "rustup-ran");
    writeFileSync(
      fakeRustup,
      [
        "#!/usr/bin/env bash",
        'if [[ "${0##*/}" != "rustup-init" ]]; then',
        '  echo "error: unknown proxy name: ${0##*/}" >&2',
        "  exit 1",
        "fi",
        'touch "$RUSTUP_MARKER"',
        "",
      ].join("\n"),
    );
    chmodSync(fakeRustup, 0o755);

    const result = runHarness(
      [
        'PATH="/usr/bin:/bin"',
        'command() { if [[ "$1" == "-v" && "${2:-}" == "cargo" ]]; then return 1; fi; builtin command "$@"; }',
        'is_root() { return 0; }',
        'download_file() { cp "$FAKE_RUSTUP" "$2"; }',
        'verify_file_sha256() { return 0; }',
        'run_quiet_step() { shift; "$@"; }',
        'write_rustup_profile_d() { :; }',
        'ln() { :; }',
        'ui_success() { :; }',
        'ui_warn() { echo "WARN: $*"; }',
        "install_rust",
      ].join("\n"),
      { FAKE_RUSTUP: fakeRustup, RUSTUP_MARKER: marker, TMPDIR: work },
    );

    expect(result.code).toBe(0);
    expect(existsSync(marker), result.out).toBe(true);
    expect(result.out).not.toContain("unknown proxy name");
    expect(result.out).not.toContain("rustup install failed");
  });

  it("keeps headed-browser intent during the CLI-only user handoff", () => {
    const result = runHarness(
      [
        "COMIS_REEXEC=1",
        "DRY_RUN=1",
        "WITH_BROWSER=1",
        "WITH_XVFB=1",
        "INSTALL_METHOD=npm",
        'detect_os_or_die() { OS="linux"; }',
        'enforce_dedicated_user_default() { :; }',
        'detect_comis_checkout() { return 1; }',
        'ui_info() { echo "INFO: $*"; }',
        'ui_warn() { echo "WARN: $*"; }',
        'ui_success() { echo "SUCCESS: $*"; }',
        "main",
        'echo "WITH_XVFB=$WITH_XVFB"',
      ].join("\n"),
    );

    expect(result.code).toBe(0);
    expect(result.out).toContain("WITH_XVFB=1");
    expect(result.out).not.toContain("does not manage comis-xvfb.service");
  });

  it("reports the dedicated service user's data directory in the install plan", () => {
    const result = runHarness(
      [
        'HOME="/root"',
        'COMIS_USER="user_a"',
        'OS="linux"',
        'INSTALL_METHOD="npm"',
        'should_create_dedicated_user() { return 0; }',
        'getent() { return 2; }',
        'ui_section() { :; }',
        'ui_info() { :; }',
        'ui_kv() { printf "%s=%s\\n" "$1" "$2"; }',
        'show_install_plan ""',
      ].join("\n"),
    );

    expect(result.code).toBe(0);
    expect(result.out).toContain("Data directory=/home/user_a/.comis");
    expect(result.out).not.toContain("Data directory=/root/.comis");
  });
});
