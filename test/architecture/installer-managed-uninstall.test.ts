import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "..", "..");
const installSh = readFileSync(join(repoRoot, "website", "public", "install.sh"), "utf8");

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

function runHarness(body: string): { code: number; out: string } {
  const work = mkdtempSync(join(tmpdir(), "comis-managed-uninstall-"));
  cleanups.push(work);
  const path = join(work, "harness.sh");
  writeFileSync(path, body);
  try {
    return { code: 0, out: execFileSync("bash", [path], { stdio: "pipe" }).toString() };
  } catch (error) {
    const failure = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      code: failure.status ?? -1,
      out: `${failure.stdout?.toString() ?? ""}${failure.stderr?.toString() ?? ""}`,
    };
  }
}

function managedRootHarness(commands: string[]): string {
  return [
    "#!/usr/bin/env bash",
    "set -u",
    'HOME="/root"',
    'OS="linux"',
    'NO_USER="0"',
    'COMIS_USER="comis"',
    'PURGE="0"',
    'DRY_RUN="0"',
    'UNINSTALL_TARGET_USER=""',
    'UNINSTALL_TARGET_HOME=""',
    'UNINSTALL_TARGET_IS_DEDICATED="0"',
    'CALL_LOG="$(mktemp)"',
    'is_root() { return 0; }',
    'id() { case "$1" in -un) echo root ;; -u) echo 0 ;; *) [[ "$1" == "comis" ]] ;; esac; }',
    'getent() { [[ "$1" == "passwd" && "$2" == "comis" ]] && echo "comis:x:999:999::/home/comis:/bin/bash"; }',
    'dedicated_user_install_detected() { [[ "$1" == "/home/comis" ]]; }',
    'su() { echo "SU:$*" >> "$CALL_LOG"; return 0; }',
    'npm() { echo "ROOT_NPM:$*" >> "$CALL_LOG"; return 1; }',
    'ui_info() { echo "INFO:$*"; }',
    'ui_warn() { echo "WARN:$*"; }',
    'ui_success() { echo "OK:$*"; }',
    extractFn("resolve_uninstall_target"),
    extractFn("uninstall_binary"),
    extractFn("show_preserved_data_location"),
    ...commands,
  ].join("\n");
}

describe("install.sh managed-user uninstall targeting", () => {
  it("removes the dedicated user's npm package in that user's explicit prefix", () => {
    const result = runHarness(
      managedRootHarness([
        "resolve_uninstall_target",
        "uninstall_binary",
        "show_preserved_data_location",
        'cat "$CALL_LOG"',
        'command rm -f "$CALL_LOG"',
      ]),
    );

    expect(result.code).toBe(0);
    expect(result.out).toContain('SU:- comis -c npm --prefix "$HOME/.npm-global" list -g comisai');
    expect(result.out).toContain(
      'SU:- comis -c npm --prefix "$HOME/.npm-global" uninstall -g comisai',
    );
    expect(result.out).not.toContain("ROOT_NPM:");
    expect(result.out).toContain("Data preserved under /home/comis/.comis");
    expect(result.out).not.toContain("/root/.comis");
  });

  it("keeps the dedicated user's data when purge was not requested", () => {
    const purgeFn = extractFn("uninstall_purge_data");
    const result = runHarness(
      [
        "#!/usr/bin/env bash",
        "set -u",
        'PURGE="0"',
        'rm() { echo "REMOVED:$*"; }',
        purgeFn,
        "uninstall_purge_data",
      ].join("\n"),
    );

    expect(result.code).toBe(0);
    expect(result.out).not.toContain("REMOVED:");
  });
});
