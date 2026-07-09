// Installer guard — a purge uninstall must remove the COMIS_EGRESS iptables chain.
//
// install_egress_logging() wires every outbound packet from the comis uid through
// a COMIS_EGRESS LOG chain hooked into OUTPUT. The uninstall flow never touched it:
// after `--uninstall --purge --remove-user` the chain (and its uid-scoped OUTPUT
// jump) stayed behind, and a later reinstall reported "Egress logging already
// configured" against a rule referencing a recreated uid. System state created by
// the installer must be removed by its uninstaller.
//
// The contract under test (real bash extracted from install.sh, fake iptables):
//   1. uninstall_egress_chain() exists and is invoked by uninstall_main on the
//      purge path, BEFORE uninstall_remove_user (the OUTPUT rule is uid-scoped —
//      deleting the user first would strand a rule that resolves to no name).
//   2. When the chain exists it deletes the OUTPUT jump(s) by line number, then
//      flushes and deletes the chain.
//   3. When the chain does not exist it is a silent no-op that exits 0.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * Fake iptables that records every invocation and simulates a live ruleset:
 * chain existence is toggled by the scenario, OUTPUT holds one uid-scoped jump
 * into COMIS_EGRESS at line 3.
 */
function runRemoval({ chainExists }: { chainExists: boolean }): {
  code: number;
  calls: string[];
  out: string;
} {
  const work = mkdtempSync(join(tmpdir(), "comis-installer-egress-"));
  cleanups.push(work);
  const binDir = join(work, "bin");
  mkdirSync(binDir);
  const callLog = join(work, "iptables-calls");

  const fakeIptables = [
    "#!/usr/bin/env bash",
    `echo "$*" >> "${callLog}"`,
    `chain_exists=${chainExists ? 1 : 0}`,
    'case "$*" in',
    '  "-L COMIS_EGRESS -n"*) [[ "$chain_exists" == "1" ]] && exit 0 || exit 1 ;;',
    '  "-L OUTPUT --line-numbers -n"*)',
    '    echo "Chain OUTPUT (policy ACCEPT)"',
    '    echo "num  target        prot opt source     destination"',
    '    echo "1    ACCEPT        all  --  0.0.0.0/0  0.0.0.0/0"',
    '    echo "3    COMIS_EGRESS  all  --  0.0.0.0/0  0.0.0.0/0  owner UID match 999"',
    "    exit 0 ;;",
    "  *) exit 0 ;;",
    "esac",
    "",
  ].join("\n");
  writeFileSync(join(binDir, "iptables"), fakeIptables);
  execFileSync("chmod", ["+x", join(binDir, "iptables")]);

  const harness = [
    "#!/usr/bin/env bash",
    "set -u",
    `export PATH="${binDir}:$PATH"`,
    'OS="linux"',
    'DRY_RUN="0"',
    'COMIS_USER="comis"',
    "is_root() { return 0; }",
    'ui_info() { echo "INFO: $*"; }',
    'ui_warn() { echo "WARN: $*"; }',
    'ui_success() { echo "OK: $*"; }',
    extractFn("uninstall_egress_chain"),
    "uninstall_egress_chain",
  ].join("\n");
  const harnessPath = join(work, "harness.sh");
  writeFileSync(harnessPath, harness);

  let code = 0;
  let out = "";
  try {
    out = execFileSync("bash", [harnessPath], { stdio: "pipe" }).toString();
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
    code = e.status ?? -1;
    out = `${e.stdout?.toString() ?? ""}${e.stderr?.toString() ?? ""}`;
  }
  const calls = existsSync(callLog)
    ? readFileSync(callLog, "utf8").split("\n").filter(Boolean)
    : [];
  return { code, calls, out };
}

describe("install.sh uninstall_egress_chain removes the COMIS_EGRESS iptables chain", () => {
  it("install.sh: declares the uninstall_egress_chain function the purge path invokes", () => {
    expect(extractFn("uninstall_egress_chain")).not.toBe("");
  });

  it("deletes the OUTPUT jump by line number, then flushes and deletes the chain", () => {
    const result = runRemoval({ chainExists: true });
    expect(result.code).toBe(0);
    expect(result.calls).toContain("-D OUTPUT 3");
    expect(result.calls).toContain("-F COMIS_EGRESS");
    expect(result.calls).toContain("-X COMIS_EGRESS");
    // The flush/delete must come after the OUTPUT unhook or -X fails as in-use.
    expect(result.calls.indexOf("-D OUTPUT 3")).toBeLessThan(result.calls.indexOf("-X COMIS_EGRESS"));
    expect(result.calls.indexOf("-F COMIS_EGRESS")).toBeLessThan(result.calls.indexOf("-X COMIS_EGRESS"));
  });

  it("is a silent success no-op when the chain does not exist", () => {
    const result = runRemoval({ chainExists: false });
    expect(result.code).toBe(0);
    const mutating = result.calls.filter((c) => /^-[DFX] /.test(c));
    expect(mutating).toEqual([]);
  });
});

describe("install.sh uninstall_main wires the egress-chain removal", () => {
  it("invokes uninstall_egress_chain on the purge path before uninstall_remove_user", () => {
    const mainFn = extractFn("uninstall_main");
    const removalAt = mainFn.indexOf("uninstall_egress_chain");
    const userRemovalAt = mainFn.indexOf("uninstall_remove_user");
    expect(removalAt).toBeGreaterThan(-1);
    expect(userRemovalAt).toBeGreaterThan(-1);
    expect(removalAt).toBeLessThan(userRemovalAt);
  });
});
