import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
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
  it("rejects a missing local tarball before privileged host preparation", () => {
    const work = makeWorkDir();
    const missingTarball = join(work, "missing-comisai.tgz");
    const mutationMarker = join(work, "host-preparation-ran");
    const result = runHarness(
      [
        "COMIS_REEXEC=0",
        "DRY_RUN=0",
        "NO_PROMPT=1",
        'INSTALL_METHOD="npm"',
        'SERVICE_MANAGER="systemd"',
        'COMIS_TARBALL="$MISSING_TARBALL"',
        'detect_os_or_die() { OS="linux"; }',
        'print_installer_banner() { :; }',
        'enforce_dedicated_user_default() { :; }',
        'detect_comis_checkout() { return 1; }',
        'resolve_service_manager() { RESOLVED_SERVICE_MANAGER="systemd"; }',
        'downshift_xvfb_for_service_manager() { :; }',
        'show_install_plan() { :; }',
        'bootstrap_gum_temp() { :; }',
        'print_gum_status() { :; }',
        'should_create_dedicated_user() { return 0; }',
        'install_system_deps_as_root() { touch "$MUTATION_MARKER"; return 77; }',
        "main",
      ].join("\n"),
      { MISSING_TARBALL: missingTarball, MUTATION_MARKER: mutationMarker },
    );

    expect(result.code).not.toBe(0);
    expect(result.out).toContain("--tarball path does not exist");
    expect(existsSync(mutationMarker), result.out).toBe(false);
  });

  it("reports an existing tarball directory as a non-regular file", () => {
    const tarballDirectory = makeWorkDir();
    const mutationMarker = join(tarballDirectory, "host-preparation-ran");
    const result = runHarness(
      [
        "COMIS_REEXEC=0",
        "DRY_RUN=0",
        "NO_PROMPT=1",
        'INSTALL_METHOD="npm"',
        'SERVICE_MANAGER="systemd"',
        'COMIS_TARBALL="$TARBALL_DIRECTORY"',
        'detect_os_or_die() { OS="linux"; }',
        'print_installer_banner() { :; }',
        'enforce_dedicated_user_default() { :; }',
        'detect_comis_checkout() { return 1; }',
        'resolve_service_manager() { RESOLVED_SERVICE_MANAGER="systemd"; }',
        'downshift_xvfb_for_service_manager() { :; }',
        'show_install_plan() { :; }',
        'bootstrap_gum_temp() { :; }',
        'print_gum_status() { :; }',
        'should_create_dedicated_user() { return 0; }',
        'install_system_deps_as_root() { touch "$MUTATION_MARKER"; return 77; }',
        "main",
      ].join("\n"),
      { MUTATION_MARKER: mutationMarker, TARBALL_DIRECTORY: tarballDirectory },
    );

    expect(result.code).not.toBe(0);
    expect(result.out).toContain("--tarball must be a regular file");
    expect(existsSync(mutationMarker), result.out).toBe(false);
  });

  it("rejects a symbolic-link tarball before privileged host preparation", () => {
    const work = makeWorkDir();
    const payload = join(work, "package.txt");
    const actualTarball = join(work, "actual-comisai.tgz");
    const linkedTarball = join(work, "linked-comisai.tgz");
    const mutationMarker = join(work, "host-preparation-ran");
    writeFileSync(payload, "fixture package");
    const archive = spawnSync("tar", ["-czf", actualTarball, "-C", work, "package.txt"]);
    expect(archive.status).toBe(0);
    symlinkSync(actualTarball, linkedTarball);

    const result = runHarness(
      [
        "COMIS_REEXEC=0",
        "DRY_RUN=0",
        "NO_PROMPT=1",
        'INSTALL_METHOD="npm"',
        'SERVICE_MANAGER="systemd"',
        'COMIS_TARBALL="$LINKED_TARBALL"',
        'detect_os_or_die() { OS="linux"; }',
        'print_installer_banner() { :; }',
        'enforce_dedicated_user_default() { :; }',
        'detect_comis_checkout() { return 1; }',
        'resolve_service_manager() { RESOLVED_SERVICE_MANAGER="systemd"; }',
        'downshift_xvfb_for_service_manager() { :; }',
        'show_install_plan() { :; }',
        'bootstrap_gum_temp() { :; }',
        'print_gum_status() { :; }',
        'should_create_dedicated_user() { return 0; }',
        'install_system_deps_as_root() { touch "$MUTATION_MARKER"; return 77; }',
        "main",
      ].join("\n"),
      { LINKED_TARBALL: linkedTarball, MUTATION_MARKER: mutationMarker },
    );

    expect(result.code).not.toBe(0);
    expect(result.out).toContain("--tarball must not be a symbolic link");
    expect(existsSync(mutationMarker), result.out).toBe(false);
  });

  it("rejects a corrupt tarball before privileged host preparation", () => {
    const work = makeWorkDir();
    const corruptTarball = join(work, "corrupt-comisai.tgz");
    const mutationMarker = join(work, "host-preparation-ran");
    writeFileSync(corruptTarball, "not a gzip tar archive");
    const result = runHarness(
      [
        "COMIS_REEXEC=0",
        "DRY_RUN=0",
        "NO_PROMPT=1",
        'INSTALL_METHOD="npm"',
        'SERVICE_MANAGER="systemd"',
        'COMIS_TARBALL="$CORRUPT_TARBALL"',
        'detect_os_or_die() { OS="linux"; }',
        'print_installer_banner() { :; }',
        'enforce_dedicated_user_default() { :; }',
        'detect_comis_checkout() { return 1; }',
        'resolve_service_manager() { RESOLVED_SERVICE_MANAGER="systemd"; }',
        'downshift_xvfb_for_service_manager() { :; }',
        'show_install_plan() { :; }',
        'bootstrap_gum_temp() { :; }',
        'print_gum_status() { :; }',
        'should_create_dedicated_user() { return 0; }',
        'install_system_deps_as_root() { touch "$MUTATION_MARKER"; return 77; }',
        "main",
      ].join("\n"),
      { CORRUPT_TARBALL: corruptTarball, MUTATION_MARKER: mutationMarker },
    );

    expect(result.code).not.toBe(0);
    expect(result.out).toContain("--tarball is not a readable gzip archive");
    expect(existsSync(mutationMarker), result.out).toBe(false);
  });

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

  it("exports system Rust homes into the daemon service environment", () => {
    const work = makeWorkDir();
    const unitPath = join(work, "comis.service");
    const result = runHarness(
      [
        "WITH_BROWSER=0",
        "WITH_XVFB=0",
        "WITH_CLOAKBROWSER=0",
        'COMIS_SVC_USER="comis"',
        'COMIS_SVC_GROUP="comis"',
        'COMIS_SVC_HOME="/home/comis"',
        'COMIS_WORKING_DIR="/home/comis"',
        'COMIS_NODE_BIN="/usr/bin/node"',
        'COMIS_DATA_DIR="/home/comis/.comis"',
        'COMIS_DAEMON_JS="/home/comis/daemon-entrypoint.js"',
        'COMIS_ENV_FILE="/etc/comis/env"',
        'maybe_sudo() { "$@"; }',
        'render_systemd_unit "$UNIT_PATH" system',
      ].join("\n"),
      { UNIT_PATH: unitPath },
    );

    expect(result.code, result.out).toBe(0);
    const unit = readFileSync(unitPath, "utf8");
    expect(unit).toContain("Environment=RUSTUP_HOME=/usr/local/rustup");
    expect(unit).toContain("Environment=CARGO_HOME=/usr/local/cargo");
  });

  it("skips upgrade doctor inside the pre-service user handoff", () => {
    const source = readFileSync(installerPath, "utf8");
    const mainStart = source.indexOf("\nmain() {");
    const mainEnd = source.indexOf('\nif [[ "${COMIS_INSTALL_SH_NO_RUN:-0}"', mainStart);
    const main = source.slice(mainStart, mainEnd);
    const doctorComment = main.indexOf("# Run doctor on upgrades and git installs");
    const cloakComment = main.indexOf("# CloakBrowser binary provisioning", doctorComment);
    const doctorBlock = main.slice(doctorComment, cloakComment);

    expect(doctorComment).toBeGreaterThanOrEqual(0);
    expect(doctorBlock).toContain('[[ "$COMIS_REEXEC" != "1" ]]');
    expect(doctorBlock).toContain("run_doctor");
  });

  it("does not follow a pre-existing script staging symlink", () => {
    const work = makeWorkDir();
    const sentinel = join(work, "external-sentinel");
    const scriptStage = join(work, ".comis-install.sh");
    const localTarball = join(work, "comisai.tgz");
    const handoffDir = join(work, "secure-handoff");
    writeFileSync(sentinel, "sentinel must remain unchanged");
    writeFileSync(localTarball, "fixture tarball");
    symlinkSync(sentinel, scriptStage);

    const result = runHarness(
      [
        'COMIS_USER="$(id -un)"',
        'COMIS_TARBALL="$LOCAL_TARBALL"',
        'INSTALL_METHOD="npm"',
        'COMIS_VERSION="latest"',
        'eval() { printf "%s\\n" "$COMIS_HOME"; }',
        'mktemp() { command mkdir "$HANDOFF_DIR"; printf "%s\\n" "$HANDOFF_DIR"; }',
        'chown() { :; }',
        'su() { return 0; }',
        'ui_info() { :; }',
        "reexec_as_comis_user",
      ].join("\n"),
      {
        COMIS_HOME: work,
        HANDOFF_DIR: handoffDir,
        LOCAL_TARBALL: localTarball,
      },
    );

    expect(result.code, result.out).toBe(0);
    expect(readFileSync(sentinel, "utf8")).toBe("sentinel must remain unchanged");
    expect(existsSync(scriptStage)).toBe(true);
  });

  it("removes secure handoff artifacts when the child fails", () => {
    const work = makeWorkDir();
    const localTarball = join(work, "comisai.tgz");
    const handoffDir = join(work, "secure-handoff");
    writeFileSync(localTarball, "fixture tarball");

    const result = runHarness(
      [
        'COMIS_USER="$(id -un)"',
        'COMIS_TARBALL="$LOCAL_TARBALL"',
        'INSTALL_METHOD="npm"',
        'COMIS_VERSION="latest"',
        'eval() { printf "%s\\n" "$COMIS_HOME"; }',
        'mktemp() { command mkdir "$HANDOFF_DIR"; printf "%s\\n" "$HANDOFF_DIR"; }',
        'chown() { :; }',
        'su() { return 37; }',
        'ui_info() { :; }',
        "reexec_as_comis_user",
      ].join("\n"),
      {
        COMIS_HOME: work,
        HANDOFF_DIR: handoffDir,
        LOCAL_TARBALL: localTarball,
      },
    );

    expect(result.code, result.out).toBe(37);
    expect(existsSync(handoffDir), result.out).toBe(false);
  });

  it("preserves forwarded argument boundaries across the user handoff", () => {
    const work = makeWorkDir();
    const localTarball = join(work, "comisai.tgz");
    const handoffDir = join(work, "secure-handoff");
    const captureScript = join(work, "capture.sh");
    const captureFile = join(work, "captured-argv");
    const marker = join(work, "injection-marker");
    const maliciousVersion = `edge value; touch -- ${marker} #`;
    writeFileSync(localTarball, "fixture tarball");
    writeFileSync(
      captureScript,
      "#!/usr/bin/env bash\nprintf '%s\\0' \"$@\" > \"$CAPTURE_FILE\"\n",
    );
    chmodSync(captureScript, 0o755);

    const result = runHarness(
      [
        'COMIS_USER="$(id -un)"',
        'COMIS_TARBALL="$LOCAL_TARBALL"',
        'COMIS_VERSION="$MALICIOUS_VERSION"',
        'INSTALL_METHOD="npm"',
        'eval() { printf "%s\\n" "$COMIS_HOME"; }',
        'mktemp() { command mkdir "$HANDOFF_DIR"; printf "%s\\n" "$HANDOFF_DIR"; }',
        'stage_install_script() { cp "$CAPTURE_SCRIPT" "$1"; chmod +x "$1"; }',
        'chown() { :; }',
        'su() { bash -c "$4"; }',
        'ui_info() { :; }',
        "reexec_as_comis_user",
      ].join("\n"),
      {
        CAPTURE_FILE: captureFile,
        CAPTURE_SCRIPT: captureScript,
        COMIS_HOME: work,
        HANDOFF_DIR: handoffDir,
        LOCAL_TARBALL: localTarball,
        MALICIOUS_VERSION: maliciousVersion,
      },
    );

    expect(result.code, result.out).toBe(0);
    const capturedArgs = readFileSync(captureFile, "utf8").split("\0").filter(Boolean);
    const versionIndex = capturedArgs.indexOf("--version");
    expect(versionIndex).toBeGreaterThanOrEqual(0);
    expect(capturedArgs.slice(versionIndex, versionIndex + 2)).toEqual([
      "--version",
      maliciousVersion,
    ]);
    expect(existsSync(marker), result.out).toBe(false);
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
