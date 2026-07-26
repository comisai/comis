// Installer guard — a failed `npm install -g` must leave the operator with evidence.
//
// The installer captured npm with `--silent` into a temp log, then parsed that log for
// everything it reports: the npm error code, the syscall, the errno, the path to npm's
// own debug log, the first error line, and the "showing last log lines" tail. `--silent`
// suppresses npm's error block too, so the log was EMPTY and every one of those fields
// resolved to nothing. Live shape (v1.0.55 global install, 2026-07-25):
//
//     ✗ Comis package install failed
//     ⚠ npm install failed for comisai@latest
//       Command: env SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm --loglevel error --silent … install -g …
//       Installer log: /tmp/tmp.nGHPS1XlXH/file.Wh47UJ
//     ⚠ npm install failed; showing last log lines
//     <nothing>
//
// The temp log is deleted at exit, so the real cause (`spawn sh ENOENT` from an unpacked
// bundled metadep) survived only in `~/.npm/_logs/*-debug-0.log` — a path the operator was
// never told about, because extracting it required the log that `--silent` had emptied.
//
// Two independent guards, matching the two halves of the fix:
//   1. The install command carries no `--silent` (verified against the real argv the
//      installer builds, via a fake npm that records what it was called with).
//   2. `print_npm_failure_diagnostics` still names somewhere to look when the log is empty.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "comis-npm-evidence-"));
  cleanups.push(dir);
  return dir;
}

function runBash(script: string, cwd: string, env: Record<string, string> = {}): string {
  const file = join(cwd, "script.sh");
  writeFileSync(file, script);
  return execFileSync("bash", [file], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("installer npm failure evidence", () => {
  it("does not silence the npm output it later parses for diagnostics", () => {
    const dir = workdir();

    // A fake npm that records its argv and fails, standing in for the real one.
    const bin = join(dir, "bin");
    writeFileSync(
      join(dir, "argv-recorder"),
      ['#!/usr/bin/env bash', `printf '%s\\n' "$@" > "${join(dir, "argv.txt")}"`, "exit 1", ""].join("\n"),
    );
    execFileSync("mkdir", ["-p", bin]);
    execFileSync("cp", [join(dir, "argv-recorder"), join(bin, "npm")]);
    chmodSync(join(bin, "npm"), 0o755);

    const script = [
      "set -uo pipefail",
      `export PATH="${bin}:$PATH"`,
      'VERBOSE=0',
      'GUM=""',
      'NPM_LOGLEVEL="error"',
      'SHARP_IGNORE_GLOBAL_LIBVIPS=1',
      'LAST_NPM_INSTALL_CMD=""',
      "gum_is_tty() { return 1; }",
      "start_spinner() { :; }",
      "stop_spinner() { :; }",
      extractFn("run_npm_global_install"),
      `run_npm_global_install comisai@latest "${join(dir, "npm.log")}" || true`,
      'echo "CMD=${LAST_NPM_INSTALL_CMD}"',
      "",
    ].join("\n");

    const stdout = runBash(script, dir);
    const argv = readFileSync(join(dir, "argv.txt"), "utf8").split("\n").filter(Boolean);

    expect(
      argv,
      "npm must not be invoked with --silent: it suppresses the error block the installer parses for the code, syscall, errno, debug-log path and tail",
    ).not.toContain("--silent");
    expect(argv, "the install must still run at a bounded log level").toContain("--loglevel");
    // The reported command must match what actually ran, or the operator cannot
    // reproduce the failure by hand.
    expect(stdout).toContain("CMD=");
    expect(stdout).not.toContain("--silent");
  });

  it("names a place to look when npm wrote no output at all", () => {
    const dir = workdir();
    const emptyLog = join(dir, "empty.log");
    writeFileSync(emptyLog, "");

    const script = [
      "set -uo pipefail",
      'LAST_NPM_INSTALL_CMD="npm install -g comisai@latest"',
      "ui_warn() { echo \"WARN: $*\"; }",
      extractFn("extract_npm_debug_log_path"),
      extractFn("extract_first_npm_error_line"),
      extractFn("extract_npm_error_code"),
      extractFn("extract_npm_error_syscall"),
      extractFn("extract_npm_error_errno"),
      extractFn("print_npm_failure_diagnostics"),
      `print_npm_failure_diagnostics comisai@latest "${emptyLog}"`,
      "",
    ].join("\n");

    const stdout = runBash(script, dir);

    expect(
      stdout,
      "an empty installer log must still point at npm's own debug log directory — otherwise the failure leaves no evidence anywhere",
    ).toMatch(/_logs/);
    expect(stdout, "and must offer the flag that streams npm's output instead").toContain(
      "--verbose",
    );
  });
});
