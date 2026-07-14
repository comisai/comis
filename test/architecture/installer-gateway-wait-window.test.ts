// Installer guard — the post-start gateway health poll must outlast a cold first boot.
//
// A fresh install's first daemon boot downloads the local embedding model (~146MB
// GGUF) into ~/.comis/models/ and loads it before the gateway binds. On a small
// instance (2 vCPU) that put "Gateway listening" ~28s after `systemctl start` —
// 8s past the old hard-coded 20s poll window — so every fresh install printed
// "⚠ Service is active but the gateway didn't respond within 20s" for a daemon
// that was perfectly healthy seconds later.
//
// The contract under test:
//   1. wait_for_daemon_ready's default window is long enough for a first boot
//      (>= 60s) and is overridable via COMIS_GATEWAY_WAIT_SECS.
//   2. While waiting it prints a first-boot progress hint (mentioning the
//      embedding-model download) so a slow boot reads as expected, not broken.
//   3. It returns promptly once the gateway responds — the longer ceiling must
//      not slow down the happy path.
//   4. No caller hardcodes the old "within 20s" text — the warn message states
//      the window that was actually used.
// These tests run the REAL bash function extracted from install.sh with a fake
// curl standing in for the gateway.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

interface WaitScenario {
  /** Seconds after which the fake gateway starts answering (-1 = never). */
  respondAfter: number;
  /** COMIS_GATEWAY_WAIT_SECS override for the run. */
  waitSecs: number;
  /** Optional config used to verify gateway-only host/port discovery. */
  configYaml?: string;
}

function runWait({ respondAfter, waitSecs, configYaml }: WaitScenario): {
  code: number;
  out: string;
  elapsedMs: number;
  requests: string[];
} {
  const work = mkdtempSync(join(tmpdir(), "comis-installer-wait-"));
  cleanups.push(work);

  // Fake curl: succeeds only once the scenario's ready-time has passed.
  const curl = [
    "#!/usr/bin/env bash",
    `start_file="${work}/t0"`,
    '[[ -f "$start_file" ]] || date +%s > "$start_file"',
    'now=$(date +%s); t0=$(cat "$start_file")',
    `ready=${respondAfter}`,
    `printf '%s\n' "$*" >> "${work}/curl-calls"`,
    '[[ "$ready" -ge 0 ]] && [[ $((now - t0)) -ge "$ready" ]] && exit 0',
    "exit 7",
    "",
  ].join("\n");
  const binDir = join(work, "bin");
  execFileSync("mkdir", ["-p", binDir]);
  writeFileSync(join(binDir, "curl"), curl);
  execFileSync("chmod", ["+x", join(binDir, "curl")]);

  const configPath = join(work, "config.yaml");
  if (configYaml !== undefined) writeFileSync(configPath, configYaml);

  const harness = [
    "#!/usr/bin/env bash",
    "set -u",
    `export PATH="${binDir}:$PATH"`,
    `export COMIS_GATEWAY_WAIT_SECS=${waitSecs}`,
    `COMIS_CONFIG_FILE="${configYaml === undefined ? "/nonexistent/config.yaml" : configPath}"`,
    'ui_info() { echo "INFO: $*"; }',
    'ui_warn() { echo "WARN: $*"; }',
    extractFn("wait_for_daemon_ready"),
    "wait_for_daemon_ready",
  ].join("\n");
  const harnessPath = join(work, "harness.sh");
  writeFileSync(harnessPath, harness);

  const startedAt = Date.now();
  try {
    const out = execFileSync("bash", [harnessPath], { stdio: "pipe" }).toString();
    const calls = join(work, "curl-calls");
    return {
      code: 0,
      out,
      elapsedMs: Date.now() - startedAt,
      requests: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [],
    };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      code: e.status ?? -1,
      out: `${e.stdout?.toString() ?? ""}${e.stderr?.toString() ?? ""}`,
      elapsedMs: Date.now() - startedAt,
      requests: existsSync(join(work, "curl-calls"))
        ? readFileSync(join(work, "curl-calls"), "utf8").trim().split("\n")
        : [],
    };
  }
}

describe("install.sh wait_for_daemon_ready window sizing", () => {
  it("defaults to a window of at least 60s so a first-boot embedding-model download fits", () => {
    const fn = extractFn("wait_for_daemon_ready");
    expect(fn).not.toBe("");
    const def = fn.match(/COMIS_GATEWAY_WAIT_SECS:-(\d+)/);
    expect(def, "wait window must be overridable via COMIS_GATEWAY_WAIT_SECS").not.toBeNull();
    expect(Number(def?.[1])).toBeGreaterThanOrEqual(60);
  });

  it("honors COMIS_GATEWAY_WAIT_SECS and gives up promptly once the override elapses", () => {
    const result = runWait({ respondAfter: -1, waitSecs: 2 });
    expect(result.code).not.toBe(0);
    // Pre-fix the loop ignored the override and always polled the hard-coded 20s.
    expect(result.elapsedMs).toBeLessThan(10_000);
  });

  it("returns success as soon as the gateway answers without waiting out the window", () => {
    const result = runWait({ respondAfter: 1, waitSecs: 30 });
    expect(result.code).toBe(0);
    expect(result.elapsedMs).toBeLessThan(10_000);
  });

  it("prints a first-boot progress hint naming the embedding-model download while still waiting", () => {
    const result = runWait({ respondAfter: -1, waitSecs: 4 });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/embedding model/i);
  });

  it("reads host and port only from the gateway section of the YAML config", () => {
    const result = runWait({
      respondAfter: 0,
      waitSecs: 2,
      configYaml: [
        "observability:",
        "  otel:",
        "    host: collector.example.com",
        "    port: 4317",
        "gateway:",
        "  host: 127.0.0.1",
        "  port: 8877",
        "",
      ].join("\n"),
    });

    expect(result.code).toBe(0);
    expect(result.requests[0]).toContain("http://127.0.0.1:8877/health");
  });

  it("normalizes a wildcard IPv6 gateway bind to a bracketed loopback probe", () => {
    const result = runWait({
      respondAfter: 0,
      waitSecs: 2,
      configYaml: "gateway:\n  host: '::'\n  port: 8878\n",
    });

    expect(result.code).toBe(0);
    expect(result.requests[0]).toContain("http://[::1]:8878/health");
  });
});

describe("install.sh gateway-wait warn messages state the real window", () => {
  it("no caller hardcodes the stale 'within 20s' text after the window became configurable", () => {
    expect(installSh).not.toContain("within 20s");
  });

  it("every started service path fails the install when the gateway never becomes ready", () => {
    const serviceFunctions = [
      ["register_service_systemd()", "register_service_systemd_user()"],
      ["register_service_systemd_user()", "ensure_pm2_installed()"],
      ["register_service_pm2()", "register_service()"],
    ] as const;

    for (const [startMarker, endMarker] of serviceFunctions) {
      const start = installSh.indexOf(startMarker);
      const end = installSh.indexOf(endMarker, start + startMarker.length);
      const body = installSh.slice(start, end);
      expect(start, `${startMarker} must exist`).toBeGreaterThanOrEqual(0);
      expect(end, `${endMarker} must follow ${startMarker}`).toBeGreaterThan(start);
      expect(body, `${startMarker} must poll gateway readiness`).toContain("if wait_for_daemon_ready; then");
      expect(body, `${startMarker} must report readiness timeout as an install error`).toMatch(
        /else[\s\S]*ui_error[^\n]*gateway[^\n]*respond[\s\S]*return 1/,
      );
    }
  });
});
