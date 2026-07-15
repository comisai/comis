import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
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

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeWorkDir(): string {
  const work = mkdtempSync(join(tmpdir(), "comis-uninstall-integrity-"));
  cleanups.push(work);
  return work;
}

function extractFn(name: string): string {
  const lines = installerSource.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`${name}()`));
  if (start === -1) return "";
  const end = lines.findIndex((line, index) => index > start && line === "}");
  return lines.slice(start, end + 1).join("\n");
}

function extractFnAtPaths(name: string, replacements: Record<string, string>): string {
  let fn = extractFn(name);
  for (const [original, replacement] of Object.entries(replacements)) {
    fn = fn.replaceAll(original, replacement);
  }
  return fn;
}

function runHarness(body: string): { code: number; out: string } {
  const work = makeWorkDir();
  const harnessPath = join(work, "harness.sh");
  writeFileSync(harnessPath, body);
  chmodSync(harnessPath, 0o755);

  try {
    const out = execFileSync("bash", [harnessPath], {
      encoding: "utf8",
      env: { ...process.env, INSTALLER_PATH: installerPath },
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

function sha256(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function writeManagedFile(path: string, body: string, prefix = "", mode = 0o644): void {
  writeFileSync(
    path,
    `${prefix}# managed-by: comis-installer\n# checksum: ${sha256(body)}\n${body}\n`,
    { mode },
  );
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function expectBrokenLinkRemovedOrRejected(result: { code: number; out: string }, path: string): void {
  expect(
    result.code !== 0 || !pathEntryExists(path),
    `cleanup exited ${result.code} while the broken link survived:\n${result.out}`,
  ).toBe(true);
}

describe("install.sh uninstall artifact integrity", () => {
  it("accepts an intact checksummed Xvfb tmpfiles rule", () => {
    const work = makeWorkDir();
    const tmpfiles = join(work, "comis-x11.conf");
    writeManagedFile(tmpfiles, "d /run/comis-x11 0770 root comis -");

    const result = runHarness(
      sourcedHarness([`xvfb_tmpfiles_rule_is_managed ${JSON.stringify(tmpfiles)}`]),
    );

    expect(result.code, result.out).toBe(0);
  });

  it("rejects an AppArmor file with content before its ownership header", () => {
    const work = makeWorkDir();
    const profile = join(work, "bwrap");
    const body = [
      "abi <abi/4.0>,",
      "include <tunables/global>",
      "",
      "profile bwrap /usr/bin/bwrap flags=(unconfined) {",
      "  userns,",
      "}",
    ].join("\n");
    writeManagedFile(profile, body, "include <local/operator-controlled>\n");

    const result = runHarness(
      sourcedHarness([`apparmor_bwrap_profile_is_managed ${JSON.stringify(profile)}`]),
    );

    expect(result.code, result.out).not.toBe(0);
  });

  it("rejects a sudoers file with rules before its ownership header", () => {
    const work = makeWorkDir();
    const sudoers = join(work, "comis-sudoers");
    const body = [
      "# Allow the comis service user to manage its own daemon service.",
      "comis ALL=(root) NOPASSWD: /bin/systemctl restart comis.service",
    ].join("\n");
    writeManagedFile(sudoers, body, "user_a ALL=(ALL) NOPASSWD: ALL\n", 0o440);

    const result = runHarness(
      sourcedHarness([
        'stat() { echo "0:0:440"; }',
        `sudoers_rule_is_managed ${JSON.stringify(sudoers)}`,
      ]),
    );

    expect(result.code, result.out).not.toBe(0);
  });

  it("refuses to remove an altered Xvfb tmpfiles rule that retains the marker", () => {
    const work = makeWorkDir();
    const unit = join(work, "comis-xvfb.service");
    const tmpfiles = join(work, "comis-x11.conf");
    const runtime = join(work, "comis-x11");
    writeFileSync(
      tmpfiles,
      [
        "# managed-by: comis-installer",
        "d /run/comis-x11 0770 root comis -",
        "d /run/operator-controlled 0777 root root -",
        "",
      ].join("\n"),
    );

    const uninstallFn = extractFnAtPaths("uninstall_xvfb_unit", {
      "/etc/systemd/system/comis-xvfb.service": unit,
      "/etc/tmpfiles.d/comis-x11.conf": tmpfiles,
      "/run/comis-x11": runtime,
    });
    const result = runHarness(
      sourcedHarness([
        'DRY_RUN="0"',
        uninstallFn,
        'systemctl() { return 1; }',
        'maybe_sudo() { "$@"; }',
        'ui_error() { echo "ERROR:$*"; }',
        'ui_success() { echo "SUCCESS:$*"; }',
        'ui_info() { echo "INFO:$*"; }',
        "uninstall_xvfb_unit",
      ]),
    );

    expect(result.code, result.out).not.toBe(0);
    expect(pathEntryExists(tmpfiles)).toBe(true);
    expect(result.out).not.toContain("SUCCESS:Removed installer-managed Xvfb artifacts");
  });

  it("does not claim main-service removal when systemd disable fails", () => {
    const work = makeWorkDir();
    const unit = join(work, "comis.service");
    writeFileSync(unit, "installer-owned fixture\n");
    const uninstallFn = extractFnAtPaths("uninstall_systemd_unit", {
      "/etc/systemd/system/comis.service": unit,
    });
    const result = runHarness(
      sourcedHarness([
        'DRY_RUN="0"',
        uninstallFn,
        'unit_is_managed() { return 0; }',
        'systemctl() { case "$1" in is-active) return 1 ;; is-enabled) return 0 ;; disable) return 1 ;; show) case "$*" in *ActiveState*) echo inactive ;; *UnitFileState*) echo enabled ;; esac ;; *) return 0 ;; esac; }',
        'maybe_sudo() { "$@"; }',
        'ui_error() { echo "ERROR:$*"; }',
        'ui_success() { echo "SUCCESS:$*"; }',
        'ui_info() { echo "INFO:$*"; }',
        'uninstall_systemd_unit "system"',
      ]),
    );

    expect(result.code, result.out).not.toBe(0);
    expect(result.out).not.toContain("SUCCESS:Removed systemd unit");
  });

  it("preserves the main unit when post-disable systemd state queries fail", () => {
    const work = makeWorkDir();
    const unit = join(work, "comis.service");
    writeFileSync(unit, "installer-owned fixture\n");
    const uninstallFn = extractFnAtPaths("uninstall_systemd_unit", {
      "/etc/systemd/system/comis.service": unit,
    });
    const result = runHarness(
      sourcedHarness([
        'DRY_RUN="0"',
        'AFTER_DISABLE="0"',
        uninstallFn,
        'unit_is_managed() { return 0; }',
        'systemctl() { case "$1" in is-active|is-enabled) [[ "$AFTER_DISABLE" == "0" ]] && return 0 || return 4 ;; disable) AFTER_DISABLE="1"; return 0 ;; show) return 4 ;; *) return 0 ;; esac; }',
        'maybe_sudo() { "$@"; }',
        'ui_error() { echo "ERROR:$*"; }',
        'ui_success() { echo "SUCCESS:$*"; }',
        'ui_info() { echo "INFO:$*"; }',
        'uninstall_systemd_unit "system"',
      ]),
    );

    expect(result.code, result.out).not.toBe(0);
    expect(pathEntryExists(unit)).toBe(true);
    expect(result.out).not.toContain("SUCCESS:Removed systemd unit");
  });

  it("does not claim Xvfb removal while its systemd service stays enabled", () => {
    const work = makeWorkDir();
    const unit = join(work, "comis-xvfb.service");
    const tmpfiles = join(work, "comis-x11.conf");
    const runtime = join(work, "comis-x11");
    writeFileSync(unit, "installer-owned fixture\n");
    const uninstallFn = extractFnAtPaths("uninstall_xvfb_unit", {
      "/etc/systemd/system/comis-xvfb.service": unit,
      "/etc/tmpfiles.d/comis-x11.conf": tmpfiles,
      "/run/comis-x11": runtime,
    });
    const result = runHarness(
      sourcedHarness([
        'DRY_RUN="0"',
        uninstallFn,
        'unit_is_managed() { return 0; }',
        'systemctl() { case "$1" in is-active) return 1 ;; is-enabled) return 0 ;; disable) return 0 ;; show) case "$*" in *ActiveState*) echo inactive ;; *UnitFileState*) echo enabled ;; esac ;; *) return 0 ;; esac; }',
        'maybe_sudo() { "$@"; }',
        'ui_error() { echo "ERROR:$*"; }',
        'ui_success() { echo "SUCCESS:$*"; }',
        'ui_info() { echo "INFO:$*"; }',
        "uninstall_xvfb_unit",
      ]),
    );

    expect(result.code, result.out).not.toBe(0);
    expect(result.out).not.toContain("SUCCESS:Removed installer-managed Xvfb artifacts");
  });

  it("preserves the Xvfb unit when post-disable systemd state queries fail", () => {
    const work = makeWorkDir();
    const unit = join(work, "comis-xvfb.service");
    const tmpfiles = join(work, "comis-x11.conf");
    const runtime = join(work, "comis-x11");
    writeFileSync(unit, "installer-owned fixture\n");
    const uninstallFn = extractFnAtPaths("uninstall_xvfb_unit", {
      "/etc/systemd/system/comis-xvfb.service": unit,
      "/etc/tmpfiles.d/comis-x11.conf": tmpfiles,
      "/run/comis-x11": runtime,
    });
    const result = runHarness(
      sourcedHarness([
        'DRY_RUN="0"',
        'AFTER_DISABLE="0"',
        uninstallFn,
        'unit_is_managed() { return 0; }',
        'systemctl() { case "$1" in is-active|is-enabled) [[ "$AFTER_DISABLE" == "0" ]] && return 0 || return 4 ;; disable) AFTER_DISABLE="1"; return 0 ;; show) return 4 ;; *) return 0 ;; esac; }',
        'maybe_sudo() { "$@"; }',
        'ui_error() { echo "ERROR:$*"; }',
        'ui_success() { echo "SUCCESS:$*"; }',
        'ui_info() { echo "INFO:$*"; }',
        "uninstall_xvfb_unit",
      ]),
    );

    expect(result.code, result.out).not.toBe(0);
    expect(pathEntryExists(unit)).toBe(true);
    expect(result.out).not.toContain("SUCCESS:Removed installer-managed Xvfb artifacts");
  });

  it("detects a broken installer AppArmor path during full-removal preflight", () => {
    const work = makeWorkDir();
    const profile = join(work, "bwrap");
    symlinkSync(join(work, "missing-apparmor-target"), profile);
    const artifactsFn = extractFnAtPaths("full_uninstall_artifacts_present", {
      "/etc/systemd/system/comis.service": join(work, "missing-comis-unit"),
      "/etc/systemd/system/comis-xvfb.service": join(work, "missing-xvfb-unit"),
      "/etc/tmpfiles.d/comis-x11.conf": join(work, "missing-tmpfiles"),
      "/run/comis-x11": join(work, "missing-runtime"),
      "/etc/sudoers.d/comis": join(work, "missing-sudoers"),
      "/etc/comis": join(work, "missing-config"),
      "/var/log/comis": join(work, "missing-logs"),
      "/etc/apparmor.d/bwrap": profile,
    });
    const result = runHarness(
      sourcedHarness([
        'COMIS_USER="user_a"',
        artifactsFn,
        'getent() { return 1; }',
        'systemctl() { return 1; }',
        'iptables() { return 1; }',
        "full_uninstall_artifacts_present",
      ]),
    );

    expect(result.code, result.out).toBe(0);
  });

  it("purges broken configuration and log-directory symlinks", () => {
    const work = makeWorkDir();
    const config = join(work, "etc-comis");
    const logs = join(work, "log-comis");
    symlinkSync(join(work, "missing-config-target"), config);
    symlinkSync(join(work, "missing-log-target"), logs);
    const purgeFn = extractFnAtPaths("uninstall_purge_data", {
      "/etc/comis": config,
      "/var/log/comis": logs,
    });
    const result = runHarness(
      sourcedHarness([
        'PURGE="1"',
        'DRY_RUN="0"',
        `UNINSTALL_TARGET_HOME=${JSON.stringify(work)}`,
        purgeFn,
        'maybe_sudo() { "$@"; }',
        'ui_error() { echo "ERROR:$*"; }',
        'ui_success() { echo "SUCCESS:$*"; }',
        "uninstall_purge_data",
      ]),
    );

    expect(result.code, result.out).toBe(0);
    expect(pathEntryExists(config)).toBe(false);
    expect(pathEntryExists(logs)).toBe(false);
  });

  it("removes an unloaded managed AppArmor profile without invoking its parser", () => {
    const work = makeWorkDir();
    const profile = join(work, "bwrap");
    const loadedProfiles = join(work, "loaded-profiles");
    const parserLog = join(work, "parser-calls");
    const body = [
      "abi <abi/4.0>,",
      "include <tunables/global>",
      "",
      "profile bwrap /usr/bin/bwrap flags=(unconfined) {",
      "  userns,",
      "}",
    ].join("\n");
    writeManagedFile(profile, body);
    writeFileSync(loadedProfiles, "");

    const uninstallFn = extractFnAtPaths("uninstall_managed_apparmor_profile", {
      "/etc/apparmor.d/bwrap": profile,
      "/sys/kernel/security/apparmor/profiles": loadedProfiles,
    });
    const result = runHarness(
      sourcedHarness([
        'DRY_RUN="0"',
        'REMOVE_USER_FLAG="1"',
        'OS="linux"',
        `PARSER_LOG=${JSON.stringify(parserLog)}`,
        uninstallFn,
        'apparmor_parser() { echo called >> "$PARSER_LOG"; return 1; }',
        'maybe_sudo() { "$@"; }',
        'ui_error() { echo "ERROR:$*"; }',
        'ui_success() { echo "SUCCESS:$*"; }',
        "uninstall_managed_apparmor_profile",
      ]),
    );

    expect(result.code, result.out).toBe(0);
    expect(pathEntryExists(profile)).toBe(false);
    expect(pathEntryExists(parserLog)).toBe(false);
    expect(result.out).toContain("SUCCESS:Removed installer-managed AppArmor profile");
  });

  it("preserves a managed AppArmor profile when loaded-state evidence is unreadable", () => {
    const work = makeWorkDir();
    const profile = join(work, "bwrap");
    const loadedProfiles = join(work, "loaded-profiles");
    const parserLog = join(work, "parser-calls");
    const body = [
      "abi <abi/4.0>,",
      "include <tunables/global>",
      "",
      "profile bwrap /usr/bin/bwrap flags=(unconfined) {",
      "  userns,",
      "}",
    ].join("\n");
    writeManagedFile(profile, body);
    symlinkSync(join(work, "missing-loaded-profiles-target"), loadedProfiles);

    const uninstallFn = extractFnAtPaths("uninstall_managed_apparmor_profile", {
      "/etc/apparmor.d/bwrap": profile,
      "/sys/kernel/security/apparmor/profiles": loadedProfiles,
    });
    const result = runHarness(
      sourcedHarness([
        'DRY_RUN="0"',
        'REMOVE_USER_FLAG="1"',
        'OS="linux"',
        `PARSER_LOG=${JSON.stringify(parserLog)}`,
        uninstallFn,
        'apparmor_parser() { echo called >> "$PARSER_LOG"; return 0; }',
        'maybe_sudo() { "$@"; }',
        'ui_error() { echo "ERROR:$*"; }',
        'ui_success() { echo "SUCCESS:$*"; }',
        'ui_warn() { echo "WARN:$*"; }',
        "uninstall_managed_apparmor_profile",
      ]),
    );

    expect(result.code, result.out).not.toBe(0);
    expect(pathEntryExists(profile)).toBe(true);
    expect(pathEntryExists(parserLog)).toBe(false);
    expect(result.out).not.toContain("SUCCESS:Removed installer-managed AppArmor profile");
  });

  it("does not silently retain a broken main systemd unit symlink", () => {
    const work = makeWorkDir();
    const unit = join(work, "comis.service");
    symlinkSync(join(work, "missing-unit-target"), unit);
    const uninstallFn = extractFnAtPaths("uninstall_systemd_unit", {
      "/etc/systemd/system/comis.service": unit,
    });
    const result = runHarness(
      sourcedHarness([
        'DRY_RUN="0"',
        uninstallFn,
        'systemctl() { return 1; }',
        'maybe_sudo() { "$@"; }',
        'ui_error() { echo "ERROR:$*"; }',
        'ui_success() { echo "SUCCESS:$*"; }',
        'ui_info() { echo "INFO:$*"; }',
        'uninstall_systemd_unit "system"',
      ]),
    );

    expectBrokenLinkRemovedOrRejected(result, unit);
  });

  it("does not silently retain a broken Xvfb systemd unit symlink", () => {
    const work = makeWorkDir();
    const unit = join(work, "comis-xvfb.service");
    const tmpfiles = join(work, "comis-x11.conf");
    const runtime = join(work, "comis-x11");
    symlinkSync(join(work, "missing-xvfb-unit-target"), unit);
    const uninstallFn = extractFnAtPaths("uninstall_xvfb_unit", {
      "/etc/systemd/system/comis-xvfb.service": unit,
      "/etc/tmpfiles.d/comis-x11.conf": tmpfiles,
      "/run/comis-x11": runtime,
    });
    const result = runHarness(
      sourcedHarness([
        'DRY_RUN="0"',
        uninstallFn,
        'systemctl() { return 1; }',
        'maybe_sudo() { "$@"; }',
        'ui_error() { echo "ERROR:$*"; }',
        'ui_success() { echo "SUCCESS:$*"; }',
        'ui_info() { echo "INFO:$*"; }',
        "uninstall_xvfb_unit",
      ]),
    );

    expectBrokenLinkRemovedOrRejected(result, unit);
  });

  it("does not silently retain a broken Xvfb tmpfiles-rule symlink", () => {
    const work = makeWorkDir();
    const unit = join(work, "comis-xvfb.service");
    const tmpfiles = join(work, "comis-x11.conf");
    const runtime = join(work, "comis-x11");
    symlinkSync(join(work, "missing-tmpfiles-target"), tmpfiles);
    const uninstallFn = extractFnAtPaths("uninstall_xvfb_unit", {
      "/etc/systemd/system/comis-xvfb.service": unit,
      "/etc/tmpfiles.d/comis-x11.conf": tmpfiles,
      "/run/comis-x11": runtime,
    });
    const result = runHarness(
      sourcedHarness([
        'DRY_RUN="0"',
        uninstallFn,
        'systemctl() { return 1; }',
        'maybe_sudo() { "$@"; }',
        'ui_error() { echo "ERROR:$*"; }',
        'ui_success() { echo "SUCCESS:$*"; }',
        'ui_info() { echo "INFO:$*"; }',
        "uninstall_xvfb_unit",
      ]),
    );

    expectBrokenLinkRemovedOrRejected(result, tmpfiles);
  });

  it("does not silently retain a broken sudoers-rule symlink", () => {
    const work = makeWorkDir();
    const sudoers = join(work, "comis-sudoers");
    symlinkSync(join(work, "missing-sudoers-target"), sudoers);
    const uninstallFn = extractFnAtPaths("uninstall_sudoers_rule", {
      "/etc/sudoers.d/comis": sudoers,
    });
    const result = runHarness(
      sourcedHarness([
        'DRY_RUN="0"',
        uninstallFn,
        'maybe_sudo() { "$@"; }',
        'ui_error() { echo "ERROR:$*"; }',
        'ui_success() { echo "SUCCESS:$*"; }',
        "uninstall_sudoers_rule",
      ]),
    );

    expectBrokenLinkRemovedOrRejected(result, sudoers);
  });

  it("does not silently retain a broken managed AppArmor symlink", () => {
    const work = makeWorkDir();
    const profile = join(work, "bwrap");
    const loadedProfiles = join(work, "loaded-profiles");
    symlinkSync(join(work, "missing-apparmor-target"), profile);
    writeFileSync(loadedProfiles, "");
    const uninstallFn = extractFnAtPaths("uninstall_managed_apparmor_profile", {
      "/etc/apparmor.d/bwrap": profile,
      "/sys/kernel/security/apparmor/profiles": loadedProfiles,
    });
    const result = runHarness(
      sourcedHarness([
        'DRY_RUN="0"',
        'REMOVE_USER_FLAG="1"',
        'OS="linux"',
        uninstallFn,
        'maybe_sudo() { "$@"; }',
        'ui_error() { echo "ERROR:$*"; }',
        'ui_success() { echo "SUCCESS:$*"; }',
        'ui_warn() { echo "WARN:$*"; }',
        "uninstall_managed_apparmor_profile",
      ]),
    );

    expectBrokenLinkRemovedOrRejected(result, profile);
  });
});
