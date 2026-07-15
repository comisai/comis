import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "..", "..");
const installSh = readFileSync(join(repoRoot, "website", "public", "install.sh"), "utf8");
const daemonPackage = JSON.parse(
  readFileSync(join(repoRoot, "packages", "daemon", "package.json"), "utf8"),
) as { bin?: Record<string, string> };

function extractFn(name: string): string {
  const lines = installSh.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`${name}()`));
  if (start === -1) return "";
  const end = lines.findIndex((line, index) => index > start && line === "}");
  return lines.slice(start, end + 1).join("\n");
}

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("install.sh daemon service entry resolution", () => {
  it("resolves the daemon file shipped inside the installed npm package", () => {
    const work = mkdtempSync(join(tmpdir(), "comis-daemon-entry-"));
    cleanups.push(work);
    const npmRoot = join(work, "npm-root");
    const packagedEntry = daemonPackage.bin?.["comis-daemon"];
    expect(packagedEntry, "the daemon package must declare its service entrypoint").toMatch(
      /^\.\/dist\/[a-z0-9-]+\.js$/,
    );
    const daemonPath = join(
      npmRoot,
      "comisai",
      "node_modules",
      "@comis",
      "daemon",
      packagedEntry?.replace(/^\.\//, "") ?? "missing-entrypoint",
    );
    mkdirSync(resolve(daemonPath, ".."), { recursive: true });
    writeFileSync(daemonPath, "export {};\n");

    const harness = join(work, "harness.sh");
    writeFileSync(
      harness,
      [
        "#!/usr/bin/env bash",
        "set -eu",
        `HOME=${JSON.stringify(join(work, "home"))}`,
        `FAKE_NPM_ROOT=${JSON.stringify(npmRoot)}`,
        `SELECTED_NODE_BIN=${JSON.stringify(process.execPath)}`,
        'RESOLVED_SERVICE_MANAGER="systemd"',
        'INSTALL_METHOD="npm"',
        'COMIS_SVC_USER="$(id -un)"',
        'COMIS_USER="comis"',
        'NO_USER="0"',
        'GIT_DIR=""',
        'final_git_dir=""',
        'node_is_version_manager_managed() { return 1; }',
        'is_root() { return 1; }',
        'comis_user_exists() { return 1; }',
        'npm() { [[ "$*" == "root -g" ]] && printf "%s\\n" "$FAKE_NPM_ROOT"; }',
        'ui_error() { printf "ERROR:%s\\n" "$*"; }',
        extractFn("resolve_service_template_vars"),
        "resolve_service_template_vars",
        'printf "%s\\n" "$COMIS_DAEMON_JS"',
      ].join("\n"),
    );

    let code = 0;
    let output = "";
    try {
      output = execFileSync("bash", [harness], { encoding: "utf8", stdio: "pipe" });
    } catch (error) {
      const failure = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
      code = failure.status ?? -1;
      output = `${failure.stdout?.toString() ?? ""}${failure.stderr?.toString() ?? ""}`;
    }

    expect(code, output).toBe(0);
    expect(output.trim()).toBe(daemonPath);
  });
});
