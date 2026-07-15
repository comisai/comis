import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "..", "..");
const installerPath = join(repoRoot, "website", "public", "install.sh");
const installerSource = readFileSync(installerPath, "utf8");
const installerIdentityToken = "a".repeat(64);

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeWorkDir(): string {
  const work = mkdtempSync(join(tmpdir(), "comis-full-uninstall-"));
  cleanups.push(work);
  return work;
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function extractFn(name: string): string {
  const lines = installerSource.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`${name}()`));
  if (start === -1) return "";
  const end = lines.findIndex((line, index) => index > start && line === "}");
  return lines.slice(start, end + 1).join("\n");
}

function runHarness(body: string, env: Record<string, string> = {}): { code: number; out: string } {
  const work = makeWorkDir();
  const harnessPath = join(work, "harness.sh");
  writeFileSync(harnessPath, body);
  chmodSync(harnessPath, 0o755);

  try {
    const out = execFileSync("bash", [harnessPath], {
      encoding: "utf8",
      env: { ...process.env, INSTALLER_PATH: installerPath, ...env },
      stdio: "pipe",
    });
    return { code: 0, out };
  } catch (error) {
    const failure = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      code: failure.status ?? -1,
      out: `${failure.stdout?.toString() ?? ""}${failure.stderr?.toString() ?? ""}`,
    };
  }
}

function sourcedHarness(lines: string[]): string {
  return [
    "#!/usr/bin/env bash",
    "set -u",
    "export COMIS_INSTALL_SH_NO_RUN=1",
    'source "$INSTALLER_PATH"',
    ...lines,
    "",
  ].join("\n");
}

describe("install.sh full dedicated-user uninstall", () => {
  it("cleans command-substitution temp files when the installer shell exits", () => {
    const result = runHarness(
      sourcedHarness([
        'sensitive_tmp="$(mktempfile)"',
        'printf "receipt-material\\n" > "$sensitive_tmp"',
        'printf "SENSITIVE_TMP:%s\\n" "$sensitive_tmp"',
      ]),
    );
    const tempPath = result.out.match(/SENSITIVE_TMP:(.+)/)?.[1]?.trim();

    expect(result.code, result.out).toBe(0);
    expect(tempPath).toBeTruthy();
    expect(pathEntryExists(tempPath!)).toBe(false);
  });

  it("treats a repeated full removal as a no-op instead of targeting root", () => {
    const work = makeWorkDir();
    const result = runHarness(
      sourcedHarness([
        'HOME="/root"',
        'OS="linux"',
        'DRY_RUN="0"',
        'PURGE="1"',
        'REMOVE_USER_FLAG="1"',
        'ASSUME_YES="1"',
        'COMIS_USER="user_a"',
        `INSTALL_RECEIPT_FILE="${join(work, "missing-receipt")}"`,
        'detect_os_or_die() { OS="linux"; }',
        'id() { case "$1" in -un) echo root ;; -u) echo 0 ;; *) return 1 ;; esac; }',
        'getent() { return 2; }',
        'systemctl() { return 1; }',
        'ui_section() { :; }',
        'ui_kv() { :; }',
        'ui_stage() { :; }',
        'ui_info() { echo "INFO:$*"; }',
        'ui_success() { echo "SUCCESS:$*"; }',
        'ui_warn() { echo "WARN:$*"; }',
        'ui_error() { echo "ERROR:$*"; }',
        'ui_celebrate() { echo "CELEBRATE:$*"; }',
        'print_installer_banner() { :; }',
        'uninstall_systemd_unit() { echo "CALL:systemd"; }',
        'uninstall_xvfb_unit() { echo "CALL:xvfb"; }',
        'uninstall_sudoers_rule() { echo "CALL:sudoers"; }',
        'uninstall_pm2() { echo "CALL:pm2"; }',
        'uninstall_direct_daemon() { echo "CALL:direct"; }',
        'uninstall_binary() { echo "CALL:binary"; }',
        'uninstall_purge_data() { echo "CALL:data"; }',
        'uninstall_egress_chain() { echo "CALL:egress"; }',
        'uninstall_managed_apparmor_profile() { echo "CALL:apparmor"; }',
        'uninstall_remove_user() { echo "CALL:user"; }',
        'uninstall_install_receipt() { echo "CALL:receipt"; }',
        "uninstall_main",
      ]),
    );

    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("nothing to remove");
    expect(result.out).not.toContain("CALL:");
    expect(result.out).not.toContain("CELEBRATE:");
  });

  it("treats a preserved preexisting same-name group as a repeated-removal no-op", () => {
    const work = makeWorkDir();
    const result = runHarness(
      sourcedHarness([
        'HOME="/root"',
        'OS="linux"',
        'DRY_RUN="0"',
        'PURGE="1"',
        'REMOVE_USER_FLAG="1"',
        'ASSUME_YES="1"',
        'COMIS_USER="user_a"',
        `INSTALL_RECEIPT_FILE="${join(work, "missing-receipt")}"`,
        'detect_os_or_die() { OS="linux"; }',
        'id() { case "$1" in -un) echo root ;; -u) echo 0 ;; *) return 1 ;; esac; }',
        'getent() { [[ "$1" == "group" && "$2" == "user_a" ]] && echo "user_a:x:1001:"; }',
        'systemctl() { return 1; }',
        'iptables() { return 1; }',
        'ui_section() { :; }',
        'ui_kv() { :; }',
        'ui_stage() { :; }',
        'ui_info() { echo "INFO:$*"; }',
        'ui_success() { echo "SUCCESS:$*"; }',
        'ui_warn() { echo "WARN:$*"; }',
        'ui_error() { echo "ERROR:$*"; }',
        'ui_celebrate() { echo "CELEBRATE:$*"; }',
        'print_installer_banner() { :; }',
        'uninstall_systemd_unit() { echo "CALL:systemd"; }',
        'uninstall_xvfb_unit() { echo "CALL:xvfb"; }',
        'uninstall_sudoers_rule() { echo "CALL:sudoers"; }',
        'uninstall_pm2() { echo "CALL:pm2"; }',
        'uninstall_direct_daemon() { echo "CALL:direct"; }',
        'uninstall_binary() { echo "CALL:binary"; }',
        'uninstall_purge_data() { echo "CALL:data"; }',
        'uninstall_egress_chain() { echo "CALL:egress"; }',
        'uninstall_managed_apparmor_profile() { echo "CALL:apparmor"; }',
        'uninstall_remove_user() { echo "CALL:user"; }',
        'uninstall_install_receipt() { echo "CALL:receipt"; }',
        "uninstall_main",
      ]),
    );

    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("nothing to remove");
    expect(result.out).not.toContain("CALL:");
    expect(result.out).not.toContain("CELEBRATE:");
  });

  it("rejects full user removal without root authority before cleanup", () => {
    const work = makeWorkDir();
    const result = runHarness(
      sourcedHarness([
        'OS="linux"',
        'REMOVE_USER_FLAG="1"',
        'COMIS_USER="user_a"',
        `INSTALL_RECEIPT_FILE="${join(work, "missing-receipt")}"`,
        'detect_os_or_die() { OS="linux"; }',
        'is_root() { return 1; }',
        'print_installer_banner() { :; }',
        'ui_error() { echo "ERROR:$*"; }',
        'uninstall_systemd_unit() { echo "CALL:systemd"; }',
        "uninstall_main",
      ]),
    );

    expect(result.code).not.toBe(0);
    expect(result.out).toContain("requires root");
    expect(result.out).not.toContain("CALL:");
  });

  it("rejects a receipt for another dedicated user before any cleanup", () => {
    const work = makeWorkDir();
    const receipt = join(work, "receipt");
    writeFileSync(
      receipt,
      [
        "# managed-by: comis-installer",
        "target_user=user_a",
        "target_home=/home/user_a",
        "target_uid=1001",
        "target_gid=1001",
        "created_user=1",
        "created_group=1",
        "decommission_state=removed",
        `identity_token=${installerIdentityToken}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const result = runHarness(
      sourcedHarness([
        'HOME="/root"',
        'OS="linux"',
        'DRY_RUN="0"',
        'PURGE="1"',
        'REMOVE_USER_FLAG="1"',
        'ASSUME_YES="1"',
        'COMIS_USER="user_b"',
        `INSTALL_RECEIPT_FILE="${receipt}"`,
        'detect_os_or_die() { OS="linux"; }',
        'id() { case "$1" in -un) echo root ;; -u) echo 0 ;; *) return 1 ;; esac; }',
        'getent() { return 2; }',
        'ui_error() { echo "ERROR:$*"; }',
        'ui_info() { echo "INFO:$*"; }',
        'print_installer_banner() { :; }',
        'uninstall_systemd_unit() { echo "CALL:systemd"; }',
        'uninstall_xvfb_unit() { echo "CALL:xvfb"; }',
        'uninstall_sudoers_rule() { echo "CALL:sudoers"; }',
        'uninstall_pm2() { echo "CALL:pm2"; }',
        'uninstall_direct_daemon() { echo "CALL:direct"; }',
        'uninstall_binary() { echo "CALL:binary"; }',
        'uninstall_purge_data() { echo "CALL:data"; }',
        'uninstall_egress_chain() { echo "CALL:egress"; }',
        'uninstall_managed_apparmor_profile() { echo "CALL:apparmor"; }',
        'uninstall_remove_user() { echo "CALL:user"; }',
        'uninstall_install_receipt() { echo "CALL:receipt"; }',
        "uninstall_main",
      ]),
    );

    expect(result.code).not.toBe(0);
    expect(result.out).toContain("belongs to user_a");
    expect(result.out).not.toContain("CALL:");
  });

  it("rejects a broken ownership-receipt symlink before any cleanup", () => {
    const work = makeWorkDir();
    const receipt = join(work, "receipt");
    symlinkSync(join(work, "missing-target"), receipt);
    const result = runHarness(
      sourcedHarness([
        'OS="linux"',
        'REMOVE_USER_FLAG="1"',
        'COMIS_USER="user_a"',
        `INSTALL_RECEIPT_FILE="${receipt}"`,
        'detect_os_or_die() { OS="linux"; }',
        'is_root() { return 0; }',
        'print_installer_banner() { :; }',
        'ui_error() { echo "ERROR:$*"; }',
        'uninstall_systemd_unit() { echo "CALL:systemd"; }',
        "uninstall_main",
      ]),
    );

    expect(result.code).not.toBe(0);
    expect(result.out).toContain("Invalid installer ownership receipt");
    expect(result.out).not.toContain("CALL:");
  });

  it("runs every cleanup preview during a full dry run without confirmation", () => {
    const result = runHarness(
      sourcedHarness([
        'HOME="/root"',
        'OS="linux"',
        'DRY_RUN="1"',
        'PURGE="1"',
        'REMOVE_USER_FLAG="1"',
        'ASSUME_YES="0"',
        'COMIS_USER="user_a"',
        'UNINSTALL_TARGET_USER="user_a"',
        'UNINSTALL_TARGET_HOME="/home/user_a"',
        'UNINSTALL_TARGET_IS_DEDICATED="1"',
        'print_installer_banner() { :; }',
        'detect_os_or_die() { OS="linux"; }',
        'preflight_full_uninstall() { FULL_UNINSTALL_NOOP="0"; }',
        'resolve_uninstall_target() { :; }',
        'id() { return 1; }',
        'ui_section() { :; }',
        'ui_kv() { :; }',
        'ui_stage() { :; }',
        'ui_success() { echo "SUCCESS:$*"; }',
        'ui_info() { echo "INFO:$*"; }',
        'ui_warn() { echo "WARN:$*"; }',
        'ui_celebrate() { echo "CELEBRATE:$*"; }',
        'confirm_uninstall() { echo "CONFIRM_CALLED"; return 1; }',
        'bootstrap_gum_temp() { echo "GUM_CALLED"; return 1; }',
        'print_gum_status() { :; }',
        'uninstall_systemd_unit() { echo "CALL:systemd:$1"; }',
        'uninstall_xvfb_unit() { echo "CALL:xvfb"; }',
        'uninstall_sudoers_rule() { echo "CALL:sudoers"; }',
        'uninstall_pm2() { echo "CALL:pm2"; }',
        'uninstall_direct_daemon() { echo "CALL:direct"; }',
        'uninstall_binary() { echo "CALL:binary"; }',
        'uninstall_purge_data() { echo "CALL:data"; }',
        'uninstall_egress_chain() { echo "CALL:egress"; }',
        'uninstall_managed_apparmor_profile() { echo "CALL:apparmor"; }',
        'uninstall_remove_user() { echo "CALL:user"; }',
        'uninstall_install_receipt() { echo "CALL:receipt"; }',
        "uninstall_main",
      ]),
    );

    expect({ code: result.code, out: result.out }).toEqual({
      code: 0,
      out: expect.any(String),
    });
    expect(result.out).toContain("CALL:systemd:system");
    expect(result.out).toContain("CALL:xvfb");
    expect(result.out).toContain("CALL:sudoers");
    expect(result.out).toContain("CALL:pm2");
    expect(result.out).toContain("CALL:direct");
    expect(result.out).toContain("CALL:binary");
    expect(result.out).toContain("CALL:data");
    expect(result.out).toContain("CALL:egress");
    expect(result.out).toContain("CALL:apparmor");
    expect(result.out).toContain("CALL:user");
    expect(result.out).toContain("CALL:receipt");
    expect(result.out).not.toContain("CONFIRM_CALLED");
    expect(result.out).not.toContain("GUM_CALLED");
    expect(result.out).not.toContain("CELEBRATE:");
    expect(result.out).toContain("Dry run complete (no changes made)");
  });

  it("uses the authoritative dedicated receipt even when no-user is set", () => {
    const work = makeWorkDir();
    const home = join(work, "home", "user_a");
    const marker = join(home, ".comis-installer-identity");
    const receipt = join(work, "receipt");
    mkdirSync(home, { recursive: true });
    writeFileSync(marker, `${installerIdentityToken}\n`);
    writeFileSync(
      receipt,
      [
        "# managed-by: comis-installer",
        "target_user=user_a",
        `target_home=${home}`,
        "target_uid=1001",
        "target_gid=1001",
        "created_user=1",
        "created_group=1",
        "decommission_state=active",
        `identity_token=${installerIdentityToken}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    const result = runHarness(
      sourcedHarness([
        'HOME="/root"',
        'OS="linux"',
        'NO_USER="1"',
        'COMIS_USER="user_a"',
        `INSTALL_RECEIPT_FILE="${receipt}"`,
        'is_root() { return 0; }',
        'id() { case "$1" in -un) echo root ;; -u|-g) echo 1001 ;; *) return 0 ;; esac; }',
        `getent() { case "$1" in passwd) echo "user_a:x:1001:1001:Comis AI agent platform [${installerIdentityToken}]:${home}:/bin/bash" ;; group) echo "user_a:x:1001:" ;; esac; }`,
        `stat() { case "$*" in *${JSON.stringify(marker)}*) echo "0:0:400" ;; *) echo "1001:1001" ;; esac; }`,
        'dedicated_user_install_detected() { return 1; }',
        "resolve_uninstall_target",
        'printf "%s|%s|%s\\n" "$UNINSTALL_TARGET_USER" "$UNINSTALL_TARGET_HOME" "$UNINSTALL_TARGET_IS_DEDICATED"',
      ]),
    );

    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain(`user_a|${home}|1`);
    expect(result.out).not.toContain("root|/root|0");
  });

  it("keeps full-removal retries on the receipt target when no-user is set", () => {
    const work = makeWorkDir();
    const home = join(work, "removed-home", "user_a");
    const receipt = join(work, "receipt");
    writeFileSync(
      receipt,
      [
        "# managed-by: comis-installer",
        "target_user=user_a",
        `target_home=${home}`,
        "target_uid=1001",
        "target_gid=1001",
        "created_user=1",
        "created_group=1",
        "decommission_state=removed",
        `identity_token=${installerIdentityToken}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    const result = runHarness(
      sourcedHarness([
        'HOME="/root"',
        'OS="linux"',
        'NO_USER="1"',
        'REMOVE_USER_FLAG="1"',
        'COMIS_USER="user_a"',
        `INSTALL_RECEIPT_FILE="${receipt}"`,
        'is_root() { return 0; }',
        'id() { case "$1" in -un) echo root ;; *) return 1 ;; esac; }',
        'getent() { return 1; }',
        'ui_error() { echo "ERROR:$*"; }',
        'resolve_uninstall_target',
        'printf "%s|%s|%s\\n" "$UNINSTALL_TARGET_USER" "$UNINSTALL_TARGET_HOME" "$UNINSTALL_TARGET_IS_DEDICATED"',
      ]),
    );

    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain(`user_a|${home}|1`);
    expect(result.out).not.toContain("root|/root|0");
  });

  it("refuses an invalid dedicated receipt instead of retargeting a root purge", () => {
    const work = makeWorkDir();
    const receipt = join(work, "receipt");
    writeFileSync(receipt, "# managed-by: comis-installer\ntarget_user=user_a\n", { mode: 0o600 });

    const result = runHarness(
      sourcedHarness([
        'HOME="/root"',
        'OS="linux"',
        'NO_USER="0"',
        'REMOVE_USER_FLAG="0"',
        'COMIS_USER="user_a"',
        `INSTALL_RECEIPT_FILE="${receipt}"`,
        'is_root() { return 0; }',
        'id() { case "$1" in -un) echo root ;; *) return 1 ;; esac; }',
        'getent() { return 1; }',
        'ui_error() { echo "ERROR:$*"; }',
        'resolve_uninstall_target',
      ]),
    );

    expect(result.code, result.out).not.toBe(0);
    expect(result.out).toContain("Invalid installer ownership receipt");
  });

  it("refuses to target a replacement home from a decommissioned receipt", () => {
    const work = makeWorkDir();
    const home = join(work, "replacement-home");
    const receipt = join(work, "receipt");
    mkdirSync(home);
    writeFileSync(
      receipt,
      [
        "# managed-by: comis-installer",
        "target_user=user_a",
        `target_home=${home}`,
        "target_uid=1001",
        "target_gid=1001",
        "created_user=1",
        "created_group=1",
        "decommission_state=removed",
        `identity_token=${installerIdentityToken}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    const result = runHarness(
      sourcedHarness([
        'HOME="/root"',
        'OS="linux"',
        'NO_USER="0"',
        'REMOVE_USER_FLAG="0"',
        'COMIS_USER="user_a"',
        `INSTALL_RECEIPT_FILE="${receipt}"`,
        'is_root() { return 0; }',
        'id() { case "$1" in -un) echo root ;; *) return 1 ;; esac; }',
        'getent() { return 1; }',
        'ui_error() { echo "ERROR:$*"; }',
        'resolve_uninstall_target',
      ]),
    );

    expect(result.code, result.out).not.toBe(0);
    expect(result.out).toContain("decommission");
  });

  it("records the dedicated account numeric identity in the ownership receipt", () => {
    const work = makeWorkDir();
    const home = join(work, "home", "user_a");
    const marker = join(home, ".comis-installer-identity");
    const receipt = join(work, "receipt");
    mkdirSync(home, { recursive: true });
    const result = runHarness(
      sourcedHarness([
        'OS="linux"',
        `INSTALL_RECEIPT_FILE="${receipt}"`,
        'is_root() { return 0; }',
        'id() { case "$1" in -u|-g) echo 1001 ;; *) return 0 ;; esac; }',
        `getent() { case "$1" in passwd) echo "user_a:x:1001:1001:Comis AI agent platform [${installerIdentityToken}]:${home}:/bin/bash" ;; group) echo "user_a:x:1001:" ;; esac; }`,
        `generate_install_identity_token() { printf '%s\\n' "${installerIdentityToken}"; }`,
        `stat() { case "$*" in *${JSON.stringify(marker)}*) echo "0:0:400" ;; *) echo "1001:1001" ;; esac; }`,
        'install() { local previous="" arg=""; for arg in "$@"; do previous_arg="$previous"; previous="$arg"; done; if [[ "$1" == "-d" ]]; then mkdir -p "$previous"; else cp "$previous_arg" "$previous"; fi; }',
        `write_install_receipt user_a "${home}" 1 1 "${installerIdentityToken}"`,
      ]),
    );

    expect(result.code, result.out).toBe(0);
    expect(readFileSync(receipt, "utf8")).toBe(
      [
        "# managed-by: comis-installer",
        "target_user=user_a",
        `target_home=${home}`,
        "target_uid=1001",
        "target_gid=1001",
        "created_user=1",
        "created_group=1",
        "decommission_state=active",
        `identity_token=${installerIdentityToken}`,
        "",
      ].join("\n"),
    );
    expect(readFileSync(marker, "utf8")).toBe(`${installerIdentityToken}\n`);
  });

  it("never rewrites an existing active receipt during reinstall", () => {
    const work = makeWorkDir();
    const home = join(work, "home", "user_a");
    const marker = join(home, ".comis-installer-identity");
    const receipt = join(work, "receipt");
    const writeLog = join(work, "receipt-writes");
    mkdirSync(home, { recursive: true });
    writeFileSync(marker, `${installerIdentityToken}\n`);
    const receiptBody = [
      "# managed-by: comis-installer",
      "target_user=user_a",
      `target_home=${home}`,
      "target_uid=1001",
      "target_gid=1001",
      "created_user=1",
      "created_group=1",
      "decommission_state=active",
      `identity_token=${installerIdentityToken}`,
      "",
    ].join("\n");
    writeFileSync(receipt, receiptBody, { mode: 0o600 });

    const result = runHarness(
      sourcedHarness([
        'OS="linux"',
        `INSTALL_RECEIPT_FILE="${receipt}"`,
        'is_root() { return 0; }',
        'id() { case "$1" in -u|-g) echo 1001 ;; *) return 0 ;; esac; }',
        `getent() { case "$1" in passwd) echo "user_a:x:1001:1001:Comis AI agent platform [${installerIdentityToken}]:${home}:/bin/bash" ;; group) echo "user_a:x:1001:" ;; esac; }`,
        `stat() { case "$*" in *${JSON.stringify(marker)}*) echo "0:0:400" ;; *) echo "1001:1001" ;; esac; }`,
        `write_install_receipt_payload() { echo "WRITE:$*" >> "${writeLog}"; }`,
        'ui_error() { echo "ERROR:$*"; }',
        `write_install_receipt user_a "${home}" 0 0 none`,
      ]),
    );

    expect(result.code, result.out).toBe(0);
    expect(pathEntryExists(writeLog)).toBe(false);
    expect(readFileSync(receipt, "utf8")).toBe(receiptBody);
  });

  it("binds a newly created account to the receipt identity token", () => {
    const work = makeWorkDir();
    const callLog = join(work, "account-calls");
    const result = runHarness(
      sourcedHarness([
        'OS="linux"',
        'COMIS_USER="user_a"',
        'GROUP_EXISTS="0"',
        'comis_user_exists() { return 1; }',
        `generate_install_identity_token() { printf '%s\\n' "${installerIdentityToken}"; }`,
        'getent() { if [[ "$1" == "group" && "$2" == "user_a" && "$GROUP_EXISTS" == "1" ]]; then echo "user_a:x:1001:"; else return 1; fi; }',
        `useradd() { echo "USERADD:$*" >> "${callLog}"; GROUP_EXISTS="1"; }`,
        'usermod() { :; }',
        `write_install_receipt() { echo "RECEIPT:$*" >> "${callLog}"; }`,
        'touch() { :; }',
        'chown() { :; }',
        'ui_info() { :; }',
        'ui_error() { echo "ERROR:$*"; }',
        'ui_success() { :; }',
        'create_comis_user',
      ]),
    );
    const calls = readFileSync(callLog, "utf8");

    expect(result.code, result.out).toBe(0);
    expect(calls).toContain(
      `--comment Comis AI agent platform [${installerIdentityToken}] user_a`,
    );
    expect(calls).toContain(`RECEIPT:user_a ~user_a 1 1 ${installerIdentityToken}`);
  });

  it("never downgrades an orphaned installer-tagged account to preexisting", () => {
    const work = makeWorkDir();
    const home = join(work, "home", "user_a");
    const writeLog = join(work, "receipt-writes");
    mkdirSync(home, { recursive: true });
    const result = runHarness(
      sourcedHarness([
        'COMIS_USER="user_a"',
        `INSTALL_RECEIPT_FILE="${join(work, "missing-receipt")}"`,
        'comis_user_exists() { return 0; }',
        `getent() { [[ "$1" == "passwd" ]] && echo "user_a:x:1001:1001:Comis AI agent platform [${installerIdentityToken}]:${home}:/bin/bash"; }`,
        `write_install_receipt() { echo "WRITE:$*" >> "${writeLog}"; }`,
        'ui_error() { echo "ERROR:$*"; }',
        'ui_info() { echo "INFO:$*"; }',
        'ui_success() { echo "SUCCESS:$*"; }',
        'create_comis_user',
      ]),
    );

    expect(result.code, result.out).not.toBe(0);
    expect(result.out).toContain("ownership receipt");
    expect(pathEntryExists(writeLog)).toBe(false);
  });

  it("refuses to delete a dedicated account without an installer ownership receipt", () => {
    const work = makeWorkDir();
    const callLog = join(work, "calls");
    const result = runHarness(
      sourcedHarness([
        'OS="linux"',
        'DRY_RUN="0"',
        'REMOVE_USER_FLAG="1"',
        'COMIS_USER="user_a"',
        'UNINSTALL_TARGET_HOME="/home/user_a"',
        `INSTALL_RECEIPT_FILE="${join(work, "missing-receipt")}"`,
        'is_root() { return 0; }',
        'id() { return 0; }',
        'pgrep() { return 1; }',
        `userdel() { echo "USERDEL:$*" >> "${callLog}"; return 0; }`,
        `groupdel() { echo "GROUPDEL:$*" >> "${callLog}"; return 0; }`,
        'ui_error() { echo "ERROR:$*"; }',
        'ui_info() { echo "INFO:$*"; }',
        'ui_success() { echo "SUCCESS:$*"; }',
        "uninstall_remove_user",
        `[[ ! -f "${callLog}" ]] || cat "${callLog}"`,
      ]),
    );

    expect(result.code).not.toBe(0);
    expect(result.out).not.toContain("USERDEL:");
    expect(result.out).not.toContain("GROUPDEL:");
    expect(result.out).toContain("installer-created");
    expect(result.out).not.toContain("SUCCESS:Removed user");
  });

  it("reports account deletion failure instead of claiming successful removal", () => {
    const work = makeWorkDir();
    const home = join(work, "home", "user_a");
    const marker = join(home, ".comis-installer-identity");
    const receipt = join(work, "receipt");
    mkdirSync(home, { recursive: true });
    writeFileSync(marker, `${installerIdentityToken}\n`);
    writeFileSync(
      receipt,
      [
        "# managed-by: comis-installer",
        "target_user=user_a",
        `target_home=${home}`,
        "target_uid=1001",
        "target_gid=1001",
        "created_user=1",
        "created_group=1",
        "decommission_state=active",
        `identity_token=${installerIdentityToken}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const result = runHarness(
      sourcedHarness([
        'OS="linux"',
        'DRY_RUN="0"',
        'REMOVE_USER_FLAG="1"',
        'COMIS_USER="user_a"',
        `UNINSTALL_TARGET_HOME="${home}"`,
        `INSTALL_RECEIPT_FILE="${receipt}"`,
        'is_root() { return 0; }',
        'id() { case "$1" in -u|-g) echo 1001 ;; *) return 0 ;; esac; }',
        `getent() { case "$1" in passwd) echo "user_a:x:1001:1001:Comis AI agent platform [${installerIdentityToken}]:${home}:/bin/bash" ;; group) echo "user_a:x:1001:" ;; esac; }`,
        `stat() { case "$*" in *${JSON.stringify(marker)}*) echo "0:0:400" ;; *) echo "1001:1001" ;; esac; }`,
        'pgrep() { return 1; }',
        'userdel() { return 1; }',
        'groupdel() { return 1; }',
        'ui_error() { echo "ERROR:$*"; }',
        'ui_info() { echo "INFO:$*"; }',
        'ui_success() { echo "SUCCESS:$*"; }',
        "uninstall_remove_user",
      ]),
    );

    expect(result.code).not.toBe(0);
    expect(result.out).toContain("ERROR:");
    expect(result.out).not.toContain("SUCCESS:Removed user");
    expect(readFileSync(receipt, "utf8")).toContain("created_user=1");
    expect(readFileSync(receipt, "utf8")).toContain("decommission_state=removing");
  });

  it("deletes the recorded group during the same authorized account removal", () => {
    const work = makeWorkDir();
    const home = join(work, "home", "user_a");
    const marker = join(home, ".comis-installer-identity");
    const receipt = join(work, "receipt");
    const groupLog = join(work, "group-calls");
    mkdirSync(home, { recursive: true });
    writeFileSync(marker, `${installerIdentityToken}\n`);
    writeFileSync(
      receipt,
      [
        "# managed-by: comis-installer",
        "target_user=user_a",
        `target_home=${home}`,
        "target_uid=1001",
        "target_gid=1001",
        "created_user=1",
        "created_group=1",
        "decommission_state=active",
        `identity_token=${installerIdentityToken}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const result = runHarness(
      sourcedHarness([
        'OS="linux"',
        'DRY_RUN="0"',
        'REMOVE_USER_FLAG="1"',
        'COMIS_USER="user_a"',
        `UNINSTALL_TARGET_HOME="${home}"`,
        `INSTALL_RECEIPT_FILE="${receipt}"`,
        'USER_EXISTS="1"',
        'GROUP_EXISTS="1"',
        'is_root() { return 0; }',
        'id() { case "$1" in -u|-g) echo 1001 ;; *) [[ "$USER_EXISTS" == "1" ]] ;; esac; }',
        `getent() { case "$1" in passwd) [[ "$USER_EXISTS" == "1" ]] && echo "user_a:x:1001:1001:Comis AI agent platform [${installerIdentityToken}]:${home}:/bin/bash" ;; group) [[ "$GROUP_EXISTS" == "1" ]] && echo "user_a:x:1001:" ;; esac; }`,
        `stat() { case "$*" in *${JSON.stringify(marker)}*) echo "0:0:400" ;; *) echo "1001:1001" ;; esac; }`,
        'pgrep() { return 1; }',
        `userdel() { rm -rf "${home}"; USER_EXISTS="0"; }`,
        `groupdel() { echo "GROUPDEL:$*" >> "${groupLog}"; GROUP_EXISTS="0"; }`,
        'maybe_sudo() { "$@"; }',
        'ui_error() { echo "ERROR:$*"; }',
        'ui_info() { echo "INFO:$*"; }',
        'ui_success() { echo "SUCCESS:$*"; }',
        "uninstall_remove_user",
        "uninstall_install_receipt",
      ]),
    );

    expect({ code: result.code, out: result.out }).toEqual({
      code: 0,
      out: expect.any(String),
    });
    expect(readFileSync(groupLog, "utf8")).toContain("GROUPDEL:user_a");
    expect(() => readFileSync(receipt, "utf8")).toThrow();
  });

  it("rejects a malformed receipt instead of trusting its target path", () => {
    const work = makeWorkDir();
    const receipt = join(work, "receipt");
    writeFileSync(
      receipt,
      [
        "# managed-by: comis-installer",
        "target_user=user_a",
        "target_home=/home/user_a",
        "target_home=/root",
        "target_uid=1001",
        "target_gid=1001",
        "created_user=1",
        "created_group=1",
        "decommission_state=active",
        `identity_token=${installerIdentityToken}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const result = runHarness(
      sourcedHarness([
        'HOME="/root"',
        'OS="linux"',
        'NO_USER="0"',
        'COMIS_USER="user_a"',
        `INSTALL_RECEIPT_FILE="${receipt}"`,
        'id() { case "$1" in -un) echo root ;; -u) echo 0 ;; *) return 1 ;; esac; }',
        'dedicated_user_install_detected() { return 1; }',
        'ui_error() { echo "ERROR:$*"; }',
        "resolve_uninstall_target",
        'printf "%s|%s|%s\\n" "$UNINSTALL_TARGET_USER" "$UNINSTALL_TARGET_HOME" "$UNINSTALL_TARGET_IS_DEDICATED"',
      ]),
    );

    expect(result.code).not.toBe(0);
    expect(result.out).toContain("Invalid installer ownership receipt");
    expect(result.out).not.toContain("user_a|/home/user_a|1");
  });

  it("rejects receipt homes containing a terminal parent segment", () => {
    const work = makeWorkDir();
    const receipt = join(work, "receipt");
    writeFileSync(
      receipt,
      [
        "# managed-by: comis-installer",
        "target_user=user_a",
        "target_home=/home/user_a/..",
        "target_uid=1001",
        "target_gid=1001",
        "created_user=1",
        "created_group=1",
        "decommission_state=active",
        `identity_token=${installerIdentityToken}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const result = runHarness(
      sourcedHarness([
        `INSTALL_RECEIPT_FILE="${receipt}"`,
        'id() { return 1; }',
        "install_receipt_is_valid",
      ]),
    );

    expect(result.code).not.toBe(0);
  });

  it("keeps real data paths untouched during a purge dry run", () => {
    const work = makeWorkDir();
    const dataDir = join(work, ".comis");
    const sentinel = join(dataDir, "sentinel");
    mkdirSync(dataDir);
    writeFileSync(sentinel, "keep");
    const result = runHarness(
      sourcedHarness([
        'DRY_RUN="1"',
        'PURGE="1"',
        `UNINSTALL_TARGET_HOME="${work}"`,
        'ui_info() { echo "INFO:$*"; }',
        "uninstall_purge_data",
      ]),
    );

    expect(result.code, result.out).toBe(0);
    expect(readFileSync(sentinel, "utf8")).toBe("keep");
    expect(result.out).toContain(`[dry-run] would: rm -rf ${dataDir}`);
  });

  it("owns the Xvfb unit together with its tmpfiles rule and runtime directory", () => {
    const fn = extractFn("uninstall_xvfb_unit");
    expect(fn).toContain("/etc/systemd/system/comis-xvfb.service");
    expect(fn).toContain("/etc/tmpfiles.d/comis-x11.conf");
    expect(fn).toContain("/run/comis-x11");
    expect(fn).toMatch(/rm\s+-f[^\n]*comis-x11\.conf/);
    expect(fn).toMatch(/rm\s+-rf[^\n]*comis-x11/);
    expect(fn).toContain('! -e "$runtime_path"');
  });

  it("stops a loaded system service when its unit file was already removed", () => {
    const work = makeWorkDir();
    const callLog = join(work, "systemctl-calls");
    const result = runHarness(
      sourcedHarness([
        'DRY_RUN="0"',
        'SERVICE_ACTIVE="1"',
        `systemctl() { echo "$*" >> "${callLog}"; case "$1" in is-active) [[ "$SERVICE_ACTIVE" == "1" ]] ;; is-enabled) return 1 ;; disable) SERVICE_ACTIVE="0" ;; show) case "$*" in *ActiveState*) echo inactive ;; *UnitFileState*) echo disabled ;; esac ;; *) return 0 ;; esac; }`,
        'maybe_sudo() { "$@"; }',
        'ui_error() { echo "ERROR:$*"; }',
        'ui_success() { echo "SUCCESS:$*"; }',
        'ui_info() { echo "INFO:$*"; }',
        'uninstall_systemd_unit "system"',
      ]),
    );

    expect(result.code, result.out).toBe(0);
    expect(readFileSync(callLog, "utf8")).toContain("disable --now comis.service");
  });

  it("reports a PM2 deletion failure instead of claiming successful removal", () => {
    const work = makeWorkDir();
    const pm2Home = join(work, "pm2-home");
    mkdirSync(pm2Home);
    writeFileSync(join(pm2Home, "dump.pm2"), '[{"name":"comis"}]\n');
    const result = runHarness(
      sourcedHarness([
        'DRY_RUN="0"',
        'OS="linux"',
        `PM2_HOME="${pm2Home}"`,
        'pm2() { case "$1" in jlist) echo \'[{"name":"comis"}]\' ;; delete) return 1 ;; *) return 0 ;; esac; }',
        'ui_error() { echo "ERROR:$*"; }',
        'ui_success() { echo "SUCCESS:$*"; }',
        'ui_warn() { echo "WARN:$*"; }',
        'uninstall_pm2',
      ]),
    );

    expect(result.code).not.toBe(0);
    expect(result.out).toContain("ERROR:");
    expect(result.out).not.toContain("SUCCESS:Removed from pm2");
  });

  it("never signals a process whose identity does not match the Comis daemon", () => {
    const work = makeWorkDir();
    const dataDir = join(work, ".comis");
    const callLog = join(work, "signals");
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, "daemon.pid"), "4242\n");

    const result = runHarness(
      sourcedHarness([
        'DRY_RUN="0"',
        'RESOLVED_SERVICE_MANAGER="none"',
        'UNINSTALL_TARGET_USER="user_a"',
        `UNINSTALL_TARGET_HOME="${work}"`,
        'id() { case "$1" in -un) echo root ;; -u) [[ "${2:-}" == "user_a" ]] && echo 1001 || echo 0 ;; *) return 0 ;; esac; }',
        'ps() { case "$*" in *"uid="*) echo 2002 ;; *"command="*) echo "sleep 30" ;; *) return 1 ;; esac; }',
        `kill() { case "$1" in -0) return 0 ;; *) echo "SIGNAL:$*" >> "${callLog}"; return 0 ;; esac; }`,
        'sleep() { :; }',
        'ui_error() { echo "ERROR:$*"; }',
        'ui_info() { echo "INFO:$*"; }',
        'ui_warn() { echo "WARN:$*"; }',
        'ui_success() { echo "SUCCESS:$*"; }',
        'uninstall_direct_daemon',
        'rc=$?',
        `[[ ! -f "${callLog}" ]] || cat "${callLog}"`,
        'exit "$rc"',
      ]),
    );

    expect(result.code).not.toBe(0);
    expect(result.out).toContain("ERROR:");
    expect(result.out).not.toContain("SIGNAL:");
  });

  it("refuses a same-user non-Node process with a forged daemon argv", () => {
    const work = makeWorkDir();
    const dataDir = join(work, ".comis");
    const forgedArgv = "/tmp/comis-decoy/node_modules/@comis/daemon/dist/daemon.js";
    mkdirSync(dataDir);

    const pid = Number(
      execFileSync(
        "bash",
        ["-c", `exec -a "${forgedArgv}" /bin/sleep 60 >/dev/null 2>&1 & echo $!`],
        { encoding: "utf8" },
      ).trim(),
    );
    execFileSync(
      "bash",
      [
        "-c",
        'for _ in {1..100}; do ps -ww -o command= -p "$1" | grep -F -- "$2" >/dev/null && exit 0; sleep 0.02; done; exit 1',
        "_",
        String(pid),
        forgedArgv,
      ],
      { stdio: "ignore" },
    );
    writeFileSync(join(dataDir, "daemon.pid"), `${pid}\n`);

    try {
      const result = runHarness(
        sourcedHarness([
          'DRY_RUN="0"',
          'RESOLVED_SERVICE_MANAGER="none"',
          'UNINSTALL_TARGET_USER="$(id -un)"',
          `UNINSTALL_TARGET_HOME="${work}"`,
          'ui_error() { echo "ERROR:$*"; }',
          'ui_info() { echo "INFO:$*"; }',
          'ui_warn() { echo "WARN:$*"; }',
          'ui_success() { echo "SUCCESS:$*"; }',
          "uninstall_direct_daemon",
        ]),
      );
      let processSurvived = true;
      try {
        process.kill(pid, 0);
      } catch {
        processSurvived = false;
      }

      expect(result.code).not.toBe(0);
      expect(result.out).toContain("not a recognized Comis daemon");
      expect(processSurvived).toBe(true);
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The production bug kills the decoy before test cleanup can run.
      }
    }
  });

  it("rejects a stale receipt after the dedicated account identity changes", () => {
    const work = makeWorkDir();
    const home = join(work, "home", "user_a");
    const sentinel = join(home, "replacement-account-data");
    const receipt = join(work, "receipt");
    const callLog = join(work, "account-calls");
    mkdirSync(home, { recursive: true });
    writeFileSync(sentinel, "keep");
    writeFileSync(
      receipt,
      [
        "# managed-by: comis-installer",
        "target_user=user_a",
        `target_home=${home}`,
        "target_uid=1001",
        "target_gid=1001",
        "created_user=1",
        "created_group=0",
        "decommission_state=active",
        `identity_token=${installerIdentityToken}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    const result = runHarness(
      sourcedHarness([
        'OS="linux"',
        'DRY_RUN="0"',
        'REMOVE_USER_FLAG="1"',
        'COMIS_USER="user_a"',
        `UNINSTALL_TARGET_HOME="${home}"`,
        `INSTALL_RECEIPT_FILE="${receipt}"`,
        'USER_EXISTS="1"',
        'is_root() { return 0; }',
        'id() { case "$1" in -u) echo 2002 ;; *) [[ "$USER_EXISTS" == "1" ]] ;; esac; }',
        `getent() { [[ "$1" == "passwd" ]] && echo "user_a:x:2002:2002::${home}:/bin/bash"; }`,
        'pgrep() { return 1; }',
        `userdel() { echo "USERDEL:$*" >> "${callLog}"; USER_EXISTS="0"; }`,
        `groupdel() { echo "GROUPDEL:$*" >> "${callLog}"; }`,
        'ui_error() { echo "ERROR:$*"; }',
        'ui_success() { echo "SUCCESS:$*"; }',
        'uninstall_remove_user',
        'rc=$?',
        `[[ ! -f "${callLog}" ]] || cat "${callLog}"`,
        'exit "$rc"',
      ]),
    );

    expect(result.code).not.toBe(0);
    expect(result.out).not.toContain("USERDEL:");
    expect(readFileSync(sentinel, "utf8")).toBe("keep");
  });

  it("preserves a markerless replacement home after the recorded user disappears", () => {
    const work = makeWorkDir();
    const home = join(work, "home", "user_a");
    const sentinel = join(home, "replacement-account-data");
    const receipt = join(work, "receipt");
    mkdirSync(home, { recursive: true });
    writeFileSync(sentinel, "keep");
    writeFileSync(
      receipt,
      [
        "# managed-by: comis-installer",
        "target_user=user_a",
        `target_home=${home}`,
        "target_uid=1001",
        "target_gid=1001",
        "created_user=1",
        "created_group=0",
        "decommission_state=active",
        `identity_token=${installerIdentityToken}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    const result = runHarness(
      sourcedHarness([
        'HOME="/root"',
        'OS="linux"',
        'DRY_RUN="0"',
        'REMOVE_USER_FLAG="1"',
        'NO_USER="0"',
        'COMIS_USER="user_a"',
        `INSTALL_RECEIPT_FILE="${receipt}"`,
        'is_root() { return 0; }',
        'id() { case "$1" in -un) echo root ;; -u) echo 0 ;; *) return 1 ;; esac; }',
        'getent() { return 1; }',
        'ui_error() { echo "ERROR:$*"; }',
        'ui_info() { echo "INFO:$*"; }',
        'ui_success() { echo "SUCCESS:$*"; }',
        'preflight_full_uninstall',
        'preflight_rc=$?',
        '[[ "$preflight_rc" == "0" ]] || exit "$preflight_rc"',
        'resolve_uninstall_target',
        'uninstall_remove_user',
      ]),
    );

    expect(readFileSync(sentinel, "utf8")).toBe("keep");
    expect(pathEntryExists(receipt)).toBe(true);
    expect(result.code, result.out).not.toBe(0);
  });

  it("preserves a markerless replacement-home symlink after the recorded user disappears", () => {
    const work = makeWorkDir();
    const replacementHome = join(work, "replacement-home");
    const homeLink = join(work, "user_a-home");
    const sentinel = join(replacementHome, "replacement-account-data");
    const receipt = join(work, "receipt");
    mkdirSync(replacementHome);
    writeFileSync(sentinel, "keep");
    symlinkSync(replacementHome, homeLink);
    writeFileSync(
      receipt,
      [
        "# managed-by: comis-installer",
        "target_user=user_a",
        `target_home=${homeLink}`,
        "target_uid=1001",
        "target_gid=1001",
        "created_user=1",
        "created_group=0",
        "decommission_state=active",
        `identity_token=${installerIdentityToken}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    const result = runHarness(
      sourcedHarness([
        'HOME="/root"',
        'OS="linux"',
        'DRY_RUN="0"',
        'REMOVE_USER_FLAG="1"',
        'NO_USER="0"',
        'COMIS_USER="user_a"',
        `INSTALL_RECEIPT_FILE="${receipt}"`,
        'is_root() { return 0; }',
        'id() { case "$1" in -un) echo root ;; -u) echo 0 ;; *) return 1 ;; esac; }',
        'getent() { return 1; }',
        'ui_error() { echo "ERROR:$*"; }',
        'ui_info() { echo "INFO:$*"; }',
        'ui_success() { echo "SUCCESS:$*"; }',
        'preflight_full_uninstall',
        'preflight_rc=$?',
        '[[ "$preflight_rc" == "0" ]] || exit "$preflight_rc"',
        'resolve_uninstall_target',
        'uninstall_remove_user',
      ]),
    );

    expect(pathEntryExists(homeLink)).toBe(true);
    expect(readFileSync(sentinel, "utf8")).toBe("keep");
    expect(pathEntryExists(receipt)).toBe(true);
    expect(result.code, result.out).not.toBe(0);
  });

  it("preserves a same-name replacement group when its GID differs from the stale receipt", () => {
    const work = makeWorkDir();
    const home = join(work, "home", "user_a");
    const marker = join(home, ".comis-installer-identity");
    const sentinel = join(home, "replacement-account-data");
    const receipt = join(work, "receipt");
    const groupLog = join(work, "group-calls");
    mkdirSync(home, { recursive: true });
    writeFileSync(marker, `${installerIdentityToken}\n`);
    writeFileSync(sentinel, "keep");
    writeFileSync(
      receipt,
      [
        "# managed-by: comis-installer",
        "target_user=user_a",
        `target_home=${home}`,
        "target_uid=1001",
        "target_gid=1001",
        "created_user=1",
        "created_group=1",
        "decommission_state=active",
        `identity_token=${installerIdentityToken}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    const result = runHarness(
      sourcedHarness([
        'HOME="/root"',
        'OS="linux"',
        'DRY_RUN="0"',
        'REMOVE_USER_FLAG="1"',
        'NO_USER="0"',
        'COMIS_USER="user_a"',
        `INSTALL_RECEIPT_FILE="${receipt}"`,
        'GROUP_EXISTS="1"',
        'is_root() { return 0; }',
        'id() { case "$1" in -un) echo root ;; -u) echo 0 ;; *) return 1 ;; esac; }',
        'getent() { [[ "$1" == "group" && "$GROUP_EXISTS" == "1" ]] && echo "user_a:x:2002:"; }',
        'stat() { echo "0:0:400"; }',
        `groupdel() { echo "GROUPDEL:$*" >> "${groupLog}"; GROUP_EXISTS="0"; }`,
        'maybe_sudo() { "$@"; }',
        'ui_error() { echo "ERROR:$*"; }',
        'ui_info() { echo "INFO:$*"; }',
        'ui_success() { echo "SUCCESS:$*"; }',
        'preflight_full_uninstall',
        'preflight_rc=$?',
        '[[ "$preflight_rc" == "0" ]] || exit "$preflight_rc"',
        'resolve_uninstall_target',
        'uninstall_remove_user',
      ]),
    );

    expect(pathEntryExists(groupLog)).toBe(false);
    expect(readFileSync(sentinel, "utf8")).toBe("keep");
    expect(pathEntryExists(receipt)).toBe(true);
    expect(result.code, result.out).not.toBe(0);
  });

  it("rejects an exact-ID replacement account without the installer identity marker", () => {
    const work = makeWorkDir();
    const home = join(work, "home", "user_a");
    const receipt = join(work, "receipt");
    writeFileSync(
      receipt,
      [
        "# managed-by: comis-installer",
        "target_user=user_a",
        `target_home=${home}`,
        "target_uid=1001",
        "target_gid=1001",
        "created_user=1",
        "created_group=1",
        "decommission_state=active",
        `identity_token=${installerIdentityToken}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    const result = runHarness(
      sourcedHarness([
        `INSTALL_RECEIPT_FILE="${receipt}"`,
        'id() { case "$1" in -u|-g) echo 1001 ;; *) return 0 ;; esac; }',
        `getent() { case "$1" in passwd) echo "user_a:x:1001:1001:Replacement account:${home}:/bin/bash" ;; group) echo "user_a:x:1001:" ;; esac; }`,
        "install_receipt_is_valid",
      ]),
    );

    expect(result.code, result.out).not.toBe(0);
  });

  it("never deletes an exact-ID replacement account that retains only the old root marker", () => {
    const work = makeWorkDir();
    const home = join(work, "home", "user_a");
    const marker = join(home, ".comis-installer-identity");
    const receipt = join(work, "receipt");
    const userLog = join(work, "user-calls");
    mkdirSync(home, { recursive: true });
    writeFileSync(marker, `${installerIdentityToken}\n`);
    writeFileSync(
      receipt,
      [
        "# managed-by: comis-installer",
        "target_user=user_a",
        `target_home=${home}`,
        "target_uid=1001",
        "target_gid=1001",
        "created_user=1",
        "created_group=0",
        "decommission_state=active",
        `identity_token=${installerIdentityToken}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    const result = runHarness(
      sourcedHarness([
        'HOME="/root"',
        'OS="linux"',
        'DRY_RUN="0"',
        'REMOVE_USER_FLAG="1"',
        'NO_USER="0"',
        'COMIS_USER="user_a"',
        `INSTALL_RECEIPT_FILE="${receipt}"`,
        'USER_EXISTS="1"',
        'is_root() { return 0; }',
        'id() { case "$1" in -un) echo root ;; -u|-g) echo 1001 ;; *) [[ "$USER_EXISTS" == "1" ]] ;; esac; }',
        `getent() { case "$1" in passwd) [[ "$USER_EXISTS" == "1" ]] && echo "user_a:x:1001:1001:Replacement account:${home}:/bin/bash" ;; group) return 1 ;; esac; }`,
        'stat() { echo "0:0:400"; }',
        'pgrep() { return 1; }',
        `userdel() { echo "USERDEL:$*" >> "${userLog}"; USER_EXISTS="0"; }`,
        'ui_error() { echo "ERROR:$*"; }',
        'ui_info() { echo "INFO:$*"; }',
        'ui_success() { echo "SUCCESS:$*"; }',
        'preflight_full_uninstall',
        'preflight_rc=$?',
        '[[ "$preflight_rc" == "0" ]] || exit "$preflight_rc"',
        'resolve_uninstall_target',
        'uninstall_remove_user',
      ]),
    );

    expect(pathEntryExists(userLog)).toBe(false);
    expect(pathEntryExists(receipt)).toBe(true);
    expect(result.code, result.out).not.toBe(0);
  });

  it("preserves a marker-retaining stale home when its directory identity changes", () => {
    const work = makeWorkDir();
    const home = join(work, "home", "user_a");
    const marker = join(home, ".comis-installer-identity");
    const sentinel = join(home, "replacement-account-data");
    const receipt = join(work, "receipt");
    mkdirSync(home, { recursive: true });
    writeFileSync(marker, `${installerIdentityToken}\n`);
    writeFileSync(sentinel, "keep");
    writeFileSync(
      receipt,
      [
        "# managed-by: comis-installer",
        "target_user=user_a",
        `target_home=${home}`,
        "target_uid=1001",
        "target_gid=1001",
        "created_user=1",
        "created_group=0",
        "decommission_state=active",
        `identity_token=${installerIdentityToken}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    const result = runHarness(
      sourcedHarness([
        'HOME="/root"',
        'OS="linux"',
        'DRY_RUN="0"',
        'REMOVE_USER_FLAG="1"',
        'NO_USER="0"',
        'COMIS_USER="user_a"',
        `INSTALL_RECEIPT_FILE="${receipt}"`,
        'is_root() { return 0; }',
        'id() { case "$1" in -un) echo root ;; -u) echo 0 ;; *) return 1 ;; esac; }',
        'getent() { return 1; }',
        `stat() { case "$*" in *${JSON.stringify(marker)}*) echo "0:0:400" ;; *) echo "2002:2002:700" ;; esac; }`,
        'ui_error() { echo "ERROR:$*"; }',
        'ui_info() { echo "INFO:$*"; }',
        'ui_success() { echo "SUCCESS:$*"; }',
        'preflight_full_uninstall',
        'preflight_rc=$?',
        '[[ "$preflight_rc" == "0" ]] || exit "$preflight_rc"',
        'resolve_uninstall_target',
        'uninstall_remove_user',
      ]),
    );

    expect(readFileSync(sentinel, "utf8")).toBe("keep");
    expect(pathEntryExists(receipt)).toBe(true);
    expect(result.code, result.out).not.toBe(0);
  });

  it("never retries group deletion from a receipt already marked as removing", () => {
    const work = makeWorkDir();
    const home = join(work, "absent-home", "user_a");
    const receipt = join(work, "receipt");
    const groupLog = join(work, "group-calls");
    writeFileSync(
      receipt,
      [
        "# managed-by: comis-installer",
        "target_user=user_a",
        `target_home=${home}`,
        "target_uid=1001",
        "target_gid=1001",
        "created_user=1",
        "created_group=1",
        "decommission_state=removing",
        `identity_token=${installerIdentityToken}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    const result = runHarness(
      sourcedHarness([
        'OS="linux"',
        'DRY_RUN="0"',
        'REMOVE_USER_FLAG="1"',
        'COMIS_USER="user_a"',
        `UNINSTALL_TARGET_HOME="${home}"`,
        `INSTALL_RECEIPT_FILE="${receipt}"`,
        'GROUP_EXISTS="1"',
        'is_root() { return 0; }',
        'id() { return 1; }',
        'getent() { [[ "$1" == "group" && "$GROUP_EXISTS" == "1" ]] && echo "user_a:x:1001:"; }',
        `groupdel() { echo "GROUPDEL:$*" >> "${groupLog}"; GROUP_EXISTS="0"; }`,
        'maybe_sudo() { "$@"; }',
        'ui_error() { echo "ERROR:$*"; }',
        'ui_info() { echo "INFO:$*"; }',
        'ui_success() { echo "SUCCESS:$*"; }',
        'if install_receipt_is_valid; then echo "VALIDATED:removing"; uninstall_remove_user; else echo "INVALID:removing"; fi',
      ]),
    );

    expect(result.out).toContain("VALIDATED:removing");
    expect(pathEntryExists(groupLog)).toBe(false);
    expect(pathEntryExists(receipt)).toBe(true);
  });

  it("finalizes an unambiguous removing receipt idempotently after owned artifacts disappear", () => {
    const work = makeWorkDir();
    const home = join(work, "absent-home", "user_a");
    const receipt = join(work, "receipt");
    writeFileSync(
      receipt,
      [
        "# managed-by: comis-installer",
        "target_user=user_a",
        `target_home=${home}`,
        "target_uid=1001",
        "target_gid=1001",
        "created_user=1",
        "created_group=1",
        "decommission_state=removing",
        `identity_token=${installerIdentityToken}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    const result = runHarness(
      sourcedHarness([
        'DRY_RUN="0"',
        'REMOVE_USER_FLAG="1"',
        'COMIS_USER="user_a"',
        `UNINSTALL_TARGET_HOME="${home}"`,
        `INSTALL_RECEIPT_FILE="${receipt}"`,
        'id() { return 1; }',
        'getent() { return 1; }',
        'maybe_sudo() { "$@"; }',
        'ui_error() { echo "ERROR:$*"; }',
        'ui_info() { echo "INFO:$*"; }',
        'ui_success() { echo "SUCCESS:$*"; }',
        'first_rc=0; uninstall_install_receipt || first_rc=$?',
        'second_rc=0; uninstall_install_receipt || second_rc=$?',
        'printf "FINALIZE:%s|%s\\n" "$first_rc" "$second_rc"',
        '[[ "$first_rc" == "0" && "$second_rc" == "0" ]]',
      ]),
    );

    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("FINALIZE:0|0");
    expect(pathEntryExists(receipt)).toBe(false);
  });

  it("removes an empty installer-receipt directory idempotently", () => {
    const work = makeWorkDir();
    const receiptDir = join(work, "installer-receipt");
    mkdirSync(receiptDir);
    const result = runHarness(
      sourcedHarness([
        'DRY_RUN="0"',
        'ui_error() { echo "ERROR:$*"; }',
        'ui_info() { echo "INFO:$*"; }',
        'ui_success() { echo "SUCCESS:$*"; }',
        `remove_empty_install_receipt_dir "${receiptDir}" 0`,
        `remove_empty_install_receipt_dir "${receiptDir}" 0`,
      ]),
    );

    expect(result.code, result.out).toBe(0);
    expect(pathEntryExists(receiptDir)).toBe(false);
  });

  it("preserves a nonempty installer-receipt directory", () => {
    const work = makeWorkDir();
    const receiptDir = join(work, "installer-receipt");
    const sentinel = join(receiptDir, "unknown-state");
    mkdirSync(receiptDir);
    writeFileSync(sentinel, "keep");
    const result = runHarness(
      sourcedHarness([
        'DRY_RUN="0"',
        'ui_error() { echo "ERROR:$*"; }',
        'ui_info() { echo "INFO:$*"; }',
        'ui_success() { echo "SUCCESS:$*"; }',
        `remove_empty_install_receipt_dir "${receiptDir}" 0`,
      ]),
    );

    expect(result.code, result.out).not.toBe(0);
    expect(readFileSync(sentinel, "utf8")).toBe("keep");
  });

  it("keeps an interrupted-removal receipt byte-identical during dry run", () => {
    const work = makeWorkDir();
    const home = join(work, "absent-home", "user_a");
    const receipt = join(work, "receipt");
    const receiptBody = [
      "# managed-by: comis-installer",
      "target_user=user_a",
      `target_home=${home}`,
      "target_uid=1001",
      "target_gid=1001",
      "created_user=1",
      "created_group=1",
      "decommission_state=removing",
      `identity_token=${installerIdentityToken}`,
      "",
    ].join("\n");
    writeFileSync(receipt, receiptBody, { mode: 0o600 });

    const result = runHarness(
      sourcedHarness([
        'HOME="/root"',
        'OS="linux"',
        'DRY_RUN="1"',
        'REMOVE_USER_FLAG="1"',
        'NO_USER="0"',
        'COMIS_USER="user_a"',
        `INSTALL_RECEIPT_FILE="${receipt}"`,
        'is_root() { return 0; }',
        'id() { case "$1" in -un) echo root ;; *) return 1 ;; esac; }',
        'getent() { return 1; }',
        'ui_error() { echo "ERROR:$*"; }',
        'ui_info() { echo "INFO:$*"; }',
        'ui_success() { echo "SUCCESS:$*"; }',
        'preflight_full_uninstall',
        'resolve_uninstall_target',
        'uninstall_remove_user',
      ]),
    );

    expect(result.code, result.out).toBe(0);
    expect(readFileSync(receipt, "utf8")).toBe(receiptBody);
  });

  it("rejects a receipt when a preexisting-group account changes primary GID", () => {
    const work = makeWorkDir();
    const home = join(work, "home", "user_a");
    const receipt = join(work, "receipt");
    writeFileSync(
      receipt,
      [
        "# managed-by: comis-installer",
        "target_user=user_a",
        `target_home=${home}`,
        "target_uid=1001",
        "target_gid=1001",
        "created_user=0",
        "created_group=0",
        "decommission_state=active",
        "identity_token=none",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    const result = runHarness(
      sourcedHarness([
        `INSTALL_RECEIPT_FILE="${receipt}"`,
        'id() { case "$1" in -u) echo 1001 ;; -g) echo 2002 ;; *) return 0 ;; esac; }',
        `getent() { case "$1" in passwd) echo "user_a:x:1001:2002:Comis AI agent platform:${home}:/bin/bash" ;; group) return 1 ;; esac; }`,
        "install_receipt_is_valid",
      ]),
    );

    expect(result.code, result.out).not.toBe(0);
  });

  it("keeps an empty PM2 home untouched during uninstall dry-run discovery", () => {
    const work = makeWorkDir();
    const pm2Home = join(work, "pm2-home");
    const mutation = join(pm2Home, "pm2.pid");
    mkdirSync(pm2Home);

    const result = runHarness(
      sourcedHarness([
        'DRY_RUN="1"',
        'OS="linux"',
        `HOME="${work}"`,
        `PM2_HOME="${pm2Home}"`,
        `pm2() { touch "${mutation}"; echo '[]'; }`,
        'ui_info() { echo "INFO:$*"; }',
        'uninstall_pm2',
        `[[ ! -e "${mutation}" ]]`,
      ]),
    );

    expect(result.code, result.out).toBe(0);
    expect(() => readFileSync(mutation, "utf8")).toThrow();
  });

  it("wires independent host-artifact cleanup into the full removal path", () => {
    const mainFn = extractFn("uninstall_main");
    const preflightArtifactsFn = extractFn("full_uninstall_artifacts_present");
    expect(extractFn("uninstall_sudoers_rule")).not.toBe("");
    expect(extractFn("uninstall_managed_apparmor_profile")).not.toBe("");
    expect(extractFn("uninstall_install_receipt")).not.toBe("");
    expect(mainFn).toContain("uninstall_sudoers_rule");
    expect(mainFn).toContain("uninstall_managed_apparmor_profile");
    expect(mainFn).toContain("uninstall_install_receipt");
    expect(preflightArtifactsFn).toContain("/etc/apparmor.d/bwrap");
    expect(extractFn("preflight_full_uninstall")).toContain("remove_empty_install_receipt_dir");
    expect(extractFn("uninstall_install_receipt")).toContain("remove_empty_install_receipt_dir");
  });
});
