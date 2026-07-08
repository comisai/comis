// Installer guard — a spinner step's ✓ must mean the wrapped command actually ran and
// succeeded, never that gum merely exited 0.
//
// Two independent defects both collapse failed steps into a ✓ on the gum path:
//
// 1. run_with_spinner captured `local gum_status=$?` AFTER an `if <gum>; then return 0; fi`
//    with no else — and bash defines a body-less if-statement's exit status as ZERO. So
//    gum_status was ALWAYS 0 and every wrapped-command failure was reported as success,
//    even under a perfectly well-behaved gum.
// 2. On a degenerate terminal (winsize-less pty; seen live over an SSM-tunneled session)
//    gum prints "inappropriate ioctl for device" to stderr and exits 0 WITHOUT running
//    the command at all — so even a correct exit-code capture can't be trusted alone.
//
// Live consequence of the pair: "Configuring NodeSource repository" and "Installing
// Node.js" both got a green ✓ (`✓ Node.js v22 installed`) while apt history shows apt
// never ran and the box ended with no node binary — service registration then failed
// with "Could not locate the node binary" three steps later.
//
// The fix makes the wrapper the authority: the wrapped command writes its own exit code
// to a sentinel file; a present sentinel is the step's result regardless of gum, and an
// absent sentinel means gum never ran the command → disable gum and run spinner-less.
// These tests run the REAL bash functions extracted from install.sh against fake gum
// binaries (one that lies, one that faithfully runs the command).
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// A gum that cannot drive the terminal: reports the live failure shape and exits 0
// without ever running the command after `--`.
const LYING_GUM = '#!/usr/bin/env bash\necho "inappropriate ioctl for device" >&2\nexit 0\n';

// A gum that behaves: skips its own flags and faithfully execs the command after `--`.
const HONEST_GUM = [
  "#!/usr/bin/env bash",
  'while [[ $# -gt 0 && "$1" != "--" ]]; do shift; done',
  "shift",
  'exec "$@"',
  "",
].join("\n");

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Scenario {
  gum: string;
  /** Exit code the wrapped command finishes with (it always drops a marker file). */
  commandExit: number;
}

function runStep({ gum, commandExit }: Scenario): { code: number; ran: boolean; out: string } {
  const work = mkdtempSync(join(tmpdir(), "comis-installer-spinner-"));
  cleanups.push(work);
  const gumPath = join(work, "gum");
  writeFileSync(gumPath, gum);
  chmodSync(gumPath, 0o755);
  const marker = join(work, "command-ran");

  const harness = [
    "#!/usr/bin/env bash",
    "set -u",
    `GUM="${gumPath}"`,
    'GUM_STATUS="ok"',
    'GUM_REASON=""',
    "VERBOSE=0",
    `mktempfile() { mktemp "${work}/tmp.XXXXXX"; }`,
    "gum_is_tty() { return 0; }",
    "is_shell_function() { return 1; }",
    "ui_info() { :; }",
    "ui_success() { :; }",
    "ui_warn() { echo \"WARN: $*\"; }",
    "ui_error() { echo \"ERROR: $*\"; }",
    "start_spinner() { :; }",
    "stop_spinner() { :; }",
    extractFn("run_with_spinner"),
    extractFn("run_quiet_step"),
    `run_quiet_step "Installing Node.js" bash -c "touch '${marker}'; exit ${commandExit}"`,
  ].join("\n");
  const harnessPath = join(work, "harness.sh");
  writeFileSync(harnessPath, harness);

  try {
    const out = execFileSync("bash", [harnessPath], { stdio: "pipe" }).toString();
    return { code: 0, ran: existsSync(marker), out };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      code: e.status ?? -1,
      ran: existsSync(marker),
      out: `${e.stdout?.toString() ?? ""}${e.stderr?.toString() ?? ""}`,
    };
  }
}

describe("install.sh run_quiet_step under a gum that exits 0 without running the command", () => {
  it("still actually runs the command (the live NodeSource no-op shape)", () => {
    const result = runStep({ gum: LYING_GUM, commandExit: 0 });
    expect(result.ran).toBe(true);
    expect(result.code).toBe(0);
  });

  it("reports a failing command as failed — never a ✓ for a step that didn't happen", () => {
    const result = runStep({ gum: LYING_GUM, commandExit: 7 });
    expect(result.ran).toBe(true);
    expect(result.code).not.toBe(0);
  });
});

describe("install.sh run_quiet_step under a well-behaved gum", () => {
  it("propagates a succeeding command's exit code 0 through the spinner", () => {
    const result = runStep({ gum: HONEST_GUM, commandExit: 0 });
    expect(result.ran).toBe(true);
    expect(result.code).toBe(0);
  });

  it("propagates the command's failure", () => {
    const result = runStep({ gum: HONEST_GUM, commandExit: 7 });
    expect(result.ran).toBe(true);
    expect(result.code).not.toBe(0);
  });
});
