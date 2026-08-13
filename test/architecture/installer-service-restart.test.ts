import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "..", "..");
const installerPath = join(repoRoot, "website", "public", "install.sh");
const cleanups: string[] = [];

afterEach(() => {
  for (const directory of cleanups.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runRestartHarness(serviceManager: string, noServiceStart: string): {
  code: number;
  markerCreated: boolean;
  output: string;
} {
  const work = mkdtempSync(join(tmpdir(), "comis-installer-restart-"));
  cleanups.push(work);
  const marker = join(work, "systemctl-restart-ran");
  const harness = join(work, "harness.sh");
  writeFileSync(
    harness,
    [
      "#!/usr/bin/env bash",
      "export COMIS_INSTALL_SH_NO_RUN=1",
      'source "$INSTALLER_PATH"',
      "COMIS_REEXEC=0",
      `RESOLVED_SERVICE_MANAGER=${JSON.stringify(serviceManager)}`,
      `NO_SERVICE_START=${JSON.stringify(noServiceStart)}`,
      'detect_active_service_manager() { echo "systemd"; }',
      'maybe_sudo() { touch "$RESTART_MARKER"; }',
      'ui_info() { :; }',
      'ui_warn() { :; }',
      "restart_service_if_running",
      "",
    ].join("\n"),
  );
  const result = spawnSync("bash", [harness], {
    encoding: "utf8",
    env: { ...process.env, INSTALLER_PATH: installerPath, RESTART_MARKER: marker },
  });
  return {
    code: result.status ?? -1,
    markerCreated: existsSync(marker),
    output: `${result.stdout}${result.stderr}`,
  };
}

describe("install.sh service restart ownership", () => {
  it("does not restart an unrelated system service when service management is disabled", () => {
    const result = runRestartHarness("none", "0");

    expect(result.code, result.output).toBe(0);
    expect(result.markerCreated, result.output).toBe(false);
  });

  it("does not restart a running service when service start is explicitly disabled", () => {
    const result = runRestartHarness("systemd", "1");

    expect(result.code, result.output).toBe(0);
    expect(result.markerCreated, result.output).toBe(false);
  });

  it("still restarts the selected running system service during a managed upgrade", () => {
    const result = runRestartHarness("systemd", "0");

    expect(result.code, result.output).toBe(0);
    expect(result.markerCreated, result.output).toBe(true);
  });
});
