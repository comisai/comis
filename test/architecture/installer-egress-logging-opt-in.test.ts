import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "..", "..");
const installSh = readFileSync(join(repoRoot, "website", "public", "install.sh"), "utf8");
const installVpsDocs = readFileSync(join(repoRoot, "docs", "installation", "install-vps.mdx"), "utf8");

function extractFn(name: string): string {
  const lines = installSh.split("\n");
  const start = lines.findIndex((line) => line === `${name}() {`);
  if (start === -1) return "";
  const end = lines.findIndex((line, index) => index > start && /^[a-zA-Z0-9_]+\(\) \{$/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

function runEgressInstall(value: string, failLogRule = false): string[] {
  const harness = [
    "set -u",
    'CALL_LOG="${TMPDIR:-/tmp}/comis-egress-opt-in-calls-$$"',
    ': > "$CALL_LOG"',
    'iptables() { printf "%s\\n" "$*" >> "$CALL_LOG"; [[ "$1 $2" == "-L COMIS_EGRESS" ]] && return 1; [[ "${FAIL_LOG_RULE:-0}" == "1" && "$*" == *"-j LOG"* ]] && return 1; return 0; }',
    "id() { return 0; }",
    "is_root() { return 0; }",
    "ui_info() { :; }",
    "ui_warn() { :; }",
    "ui_success() { :; }",
    'COMIS_USER="comis"',
    'ENABLE_EGRESS_LOGGING="${COMIS_ENABLE_EGRESS_LOGGING:-0}"',
    extractFn("install_egress_logging"),
    "install_egress_logging",
    'cat "$CALL_LOG"',
    'rm -f "$CALL_LOG"',
  ].join("\n");

  const result = spawnSync("bash", ["-c", harness], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      COMIS_ENABLE_EGRESS_LOGGING: value,
      FAIL_LOG_RULE: failLogRule ? "1" : "0",
    },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.split("\n").filter(Boolean);
}

function runInstallPlan(enabled: boolean, dedicatedUser: boolean): string {
  const harness = [
    "set -u",
    'OS="linux"',
    'MIN_NODE_VERSION="22.19.0"',
    'INSTALL_METHOD="npm"',
    'COMIS_TARBALL=""',
    'USE_BETA="0"',
    'COMIS_VERSION="latest"',
    'GIT_DIR="/tmp/comis"',
    'GIT_UPDATE="1"',
    'COMIS_USER="comis"',
    'RESOLVED_SERVICE_MANAGER="systemd"',
    'WITH_BROWSER="0"',
    'WITH_XVFB="0"',
    'WITH_CLOAKBROWSER="0"',
    'NO_AUTOSTART="0"',
    'DRY_RUN="1"',
    'NO_INIT="1"',
    `ENABLE_EGRESS_LOGGING="${enabled ? "1" : "0"}"`,
    `DEDICATED_USER="${dedicatedUser ? "1" : "0"}"`,
    'should_create_dedicated_user() { [[ "$DEDICATED_USER" == "1" ]]; }',
    "ui_section() { :; }",
    'ui_kv() { printf "%s=%s\\n" "$1" "$2"; }',
    "ui_info() { :; }",
    extractFn("show_install_plan"),
    'show_install_plan ""',
  ].join("\n");

  const result = spawnSync("bash", ["-c", harness], { cwd: repoRoot, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe("managed installer egress logging requires explicit consent", () => {
  it("does not invoke iptables unless the positive environment flag is exactly one", () => {
    expect(runEgressInstall("")).toEqual([]);
    expect(runEgressInstall("true")).toEqual([]);

    const enabledCalls = runEgressInstall("1");
    expect(enabledCalls).toContain("-N COMIS_EGRESS");
    expect(enabledCalls).toContain(
      '-A COMIS_EGRESS -m limit --limit 10/minute --limit-burst 20 -j LOG --log-prefix comis-egress:  --log-level 6',
    );
    expect(enabledCalls).toContain("-A COMIS_EGRESS -j ACCEPT");
    expect(enabledCalls).toContain("-A OUTPUT -m owner --uid-owner comis -j COMIS_EGRESS");
  });

  it("recognizes only the positive opt-in environment flag", () => {
    expect(installSh).toContain('ENABLE_EGRESS_LOGGING="${COMIS_ENABLE_EGRESS_LOGGING:-0}"');
    expect(installSh).not.toContain("COMIS_NO_EGRESS_LOG");
  });

  it("rolls back the diagnostic chain when its rate-limited LOG rule is unavailable", () => {
    const calls = runEgressInstall("1", true);
    expect(calls).not.toContain("-A OUTPUT -m owner --uid-owner comis -j COMIS_EGRESS");
    expect(calls).toContain("-F COMIS_EGRESS");
    expect(calls).toContain("-X COMIS_EGRESS");
  });

  it("forwards the normalized opt-in through the automatic sudo handoff", () => {
    const elevate = extractFn("elevate_install_to_root");
    expect(elevate).toContain('COMIS_ENABLE_EGRESS_LOGGING="$ENABLE_EGRESS_LOGGING"');
  });
});

describe("managed installer discloses egress logging before it changes the host", () => {
  it("shows the default-off and enabled privacy posture in the install plan", () => {
    expect(runInstallPlan(false, true)).toContain(
      "Egress logging=disabled (no iptables changes; opt in with COMIS_ENABLE_EGRESS_LOGGING=1)",
    );
    expect(runInstallPlan(true, true)).toContain(
      "Egress logging=enabled (rate-limited iptables LOG+ACCEPT; outbound packet metadata enters kernel logs)",
    );
    expect(runInstallPlan(true, false)).toContain(
      "Egress logging=requested (applies only to Linux systemd with a dedicated user)",
    );
  });

  it("exposes the opt-in side effects and non-enforcing behavior in installer help", () => {
    const usage = extractFn("print_usage");
    expect(usage).toContain("COMIS_ENABLE_EGRESS_LOGGING=0|1");
    expect(usage).toMatch(/disabled by default/i);
    expect(usage).toMatch(/iptables[\s\S]*LOG\+ACCEPT/i);
    expect(usage).toMatch(/outbound packet metadata[\s\S]*kernel/i);
    expect(usage).toMatch(/10\s+entries per minute[\s\S]*burst of 20/i);
    expect(usage).toMatch(/does not (block|restrict) traffic/i);
  });

  it("exposes the opt-in and privacy impact in the managed-host guide", () => {
    expect(installVpsDocs).toContain("COMIS_ENABLE_EGRESS_LOGGING=1");
    expect(installVpsDocs).toMatch(/disabled\s+by default/i);
    expect(installVpsDocs).toMatch(/LOG\+ACCEPT/);
    expect(installVpsDocs).toMatch(/outbound packet metadata[\s\S]*kernel/i);
    expect(installVpsDocs).toMatch(/10\s+entries per minute[\s\S]*burst of 20/i);
    expect(installVpsDocs).toMatch(/does not (?:block or )?restrict traffic/i);
  });
});

describe("managed installer purge cleans up egress rules independently of current opt-in", () => {
  it("keeps cleanup unconditional so prior installer-created chains remain removable", () => {
    const cleanup = extractFn("uninstall_egress_chain");
    expect(cleanup).not.toContain("ENABLE_EGRESS_LOGGING");
    expect(cleanup).not.toContain("COMIS_ENABLE_EGRESS_LOGGING");

    const uninstall = extractFn("uninstall_main");
    expect(uninstall).toMatch(/PURGE[\s\S]*uninstall_egress_chain/);
  });
});
