// SPDX-License-Identifier: Apache-2.0
/**
 * Offline-orchestrator tests for the support bundle.
 *
 * These drive the REAL nine doctor checks against a temp `~/.comis`-shaped
 * layout (never the machine's real data dir), so they pin the ground-truth
 * offline behavior rather than a hand-shaped `DoctorResult`:
 *  - a dead daemon (no daemon.pid) still produces the five-file bundle, surfaces
 *    the `daemon_down` signal, and is NEVER reported `healthy`;
 *  - a corrupt config yields `misconfigured` + `config_corrupt` and still
 *    generates (a section failure is a warning, never a crash);
 *  - `doctor.json` carries the real `buildDoctorJson` shape from a genuine run
 *    (nine checks), and `triage.json` round-trips through its parser;
 *  - a write that cannot land folds into the manifest warnings.
 *
 * The local doctor-context builder's gateway-URL remap (wildcard bind address →
 * loopback, tls → https) is unit-asserted directly.
 *
 * Temp dirs ONLY. The daemon-liveness probe is stubbed down so the host
 * snapshot opens no socket.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";

import { safePath } from "@comis/core";

import { generateSupportBundle, buildSupportDoctorContext } from "./generate.js";
import { parseSupportTriage } from "./types.js";

/** A fixed generation instant so the bundle dir name is deterministic. */
const NOW_MS = Date.UTC(2026, 6, 3, 9, 30, 0);

/**
 * A daemon-liveness stub reporting the daemon as down, so the host snapshot's
 * best-effort version probe short-circuits with no socket.
 */
const daemonDown = { isDaemonRunning: async (): Promise<boolean> => false };

const tmpDirs: string[] = [];

function makeDataDir(): string {
  const dir = mkdtempSync(safePath(tmpdir(), "comis-generate-test-"));
  tmpDirs.push(dir);
  return dir;
}

/** Write a config file into the temp data dir and return its path. */
function writeConfig(dataDir: string, body: string): string {
  const path = safePath(dataDir, "config.yaml");
  writeFileSync(path, body, "utf8");
  return path;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir === undefined) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort teardown; a leaked temp dir must never fail the suite.
    }
  }
});

/**
 * Base deps for the orchestrator: a temp data dir, the config path under it, and
 * the daemon-down stub. `configBody` defaults to a valid config whose gateway
 * points at an unused loopback port so the connectivity probe fails fast and
 * deterministically instead of touching a real daemon.
 */
function makeDeps(overrides: { dataDir?: string; configBody?: string } = {}) {
  const dataDir = overrides.dataDir ?? makeDataDir();
  const configBody =
    overrides.configBody ?? "gateway:\n  host: 127.0.0.1\n  port: 59237\n";
  const configPath = writeConfig(dataDir, configBody);
  return {
    dataDir,
    configPaths: [configPath],
    sinceHours: 24,
    nowMs: NOW_MS,
    isDaemonRunning: daemonDown.isDaemonRunning,
  };
}

/** Recompute the bundle dir the way the writer names it from an instant. */
function expectedBundleDir(dataDir: string): string {
  const tsIso = new Date(NOW_MS).toISOString().replace(/[:.]/g, "-");
  return safePath(safePath(dataDir, "support-bundles"), `comis-support-${tsIso}`);
}

describe("generateSupportBundle offline against a dead daemon", () => {
  it("produces the five-file bundle and surfaces daemon_down without reporting healthy", async () => {
    const result = await generateSupportBundle(makeDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const files = readdirSync(result.value.bundleDir).sort();
    expect(files).toEqual([
      "ai-issue-draft.md",
      "doctor.json",
      "issue-summary.md",
      "manifest.json",
      "triage.json",
    ]);
    expect(result.value.activeSignals).toContain("daemon_down");
    expect(result.value.status).not.toBe("healthy");
  });

  it("writes a triage.json that round-trips through parseSupportTriage with the returned verdict", async () => {
    const result = await generateSupportBundle(makeDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const raw = JSON.parse(
      readFileSync(safePath(result.value.bundleDir, "triage.json"), "utf8"),
    ) as unknown;
    const parsed = parseSupportTriage(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.status).toBe(result.value.status);
    expect(parsed.value.activeSignals).toEqual(result.value.activeSignals);
  });

  it("writes a doctor.json with the buildDoctorJson shape from a real run of at least nine checks", async () => {
    const result = await generateSupportBundle(makeDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const doctor = JSON.parse(
      readFileSync(safePath(result.value.bundleDir, "doctor.json"), "utf8"),
    ) as { checksRun: number; summary: Record<string, number>; findings: unknown[] };

    expect(doctor.checksRun).toBeGreaterThanOrEqual(9);
    expect(Object.keys(doctor.summary).sort()).toEqual([
      "fail",
      "pass",
      "repairable",
      "skip",
      "warn",
    ]);
    expect(Array.isArray(doctor.findings)).toBe(true);
  });
});

describe("generateSupportBundle honest degradation", () => {
  it("reports misconfigured with config_corrupt on a corrupt config and still generates the bundle", async () => {
    // An unterminated flow sequence is unparseable YAML → the resolver reports a
    // corrupt config, config-health fails "parseable", and the reducer ranks a
    // config failure as misconfigured.
    const result = await generateSupportBundle(makeDeps({ configBody: "gateway: [1, 2" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.status).toBe("misconfigured");
    expect(result.value.activeSignals).toContain("config_corrupt");
    const files = readdirSync(result.value.bundleDir).sort();
    expect(files).toEqual([
      "ai-issue-draft.md",
      "doctor.json",
      "issue-summary.md",
      "manifest.json",
      "triage.json",
    ]);
  });

  it("folds an unwritable section into the manifest warnings without crashing the run", async () => {
    const dataDir = makeDataDir();
    // Plant a directory where triage.json must be written → its write fails while
    // the other files still land (partial output, recorded as a warning).
    const bundleDir = expectedBundleDir(dataDir);
    mkdirSync(safePath(bundleDir, "triage.json"), { recursive: true });

    const result = await generateSupportBundle(makeDeps({ dataDir }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.warnings.some((w) => w.source === "writer")).toBe(true);
    // The manifest on disk records the same warning so a partial bundle is honest.
    const manifest = JSON.parse(
      readFileSync(safePath(result.value.bundleDir, "manifest.json"), "utf8"),
    ) as { warnings?: Array<{ source: string }> };
    expect(manifest.warnings?.some((w) => w.source === "writer")).toBe(true);
    expect(existsSync(safePath(result.value.bundleDir, "doctor.json"))).toBe(true);
  });
});

describe("buildSupportDoctorContext gateway URL derivation", () => {
  /** Build a context from an injected config body, isolated from the real fs. */
  function contextFrom(configBody: string) {
    return buildSupportDoctorContext(["/does/not/matter.yaml"], {
      dataDir: "/tmp/does-not-matter",
      readFile: () => configBody,
    });
  }

  it("remaps the 0.0.0.0 wildcard bind address to loopback for the probe", () => {
    const ctx = contextFrom("gateway:\n  host: 0.0.0.0\n  port: 4766\n");
    expect(ctx.gatewayUrl).toBe("http://127.0.0.1:4766");
  });

  it("remaps the :: wildcard bind address to the loopback IPv6 address", () => {
    const ctx = contextFrom("gateway:\n  host: '::'\n  port: 4766\n");
    expect(ctx.gatewayUrl).toBe("http://::1:4766");
  });

  it("selects the https scheme when a tls block is present on the gateway", () => {
    const ctx = contextFrom(
      "gateway:\n" +
        "  host: 127.0.0.1\n" +
        "  port: 8443\n" +
        "  tls:\n" +
        "    certPath: /etc/comis/cert.pem\n" +
        "    keyPath: /etc/comis/key.pem\n" +
        "    caPath: /etc/comis/ca.pem\n",
    );
    expect(ctx.gatewayUrl).toBe("https://127.0.0.1:8443");
  });
});

describe("generateSupportBundle keeps the reducer's trusted strings intact on disk", () => {
  // Ground-truth end-to-end: the reducer ALWAYS emits the five privacy excludes
  // and the maintainer hints, both content-free. They must reach triage.json
  // un-masked, or the on-disk verdict desyncs from the manifest's verbatim
  // privacy copy and the maintainer hint (`comis explain "<sessionKey>"`) is
  // mangled into an un-runnable command.
  it("writes a triage.json privacy block matching the manifest and un-masked maintainer hints", async () => {
    const result = await generateSupportBundle(makeDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const triage = JSON.parse(
      readFileSync(safePath(result.value.bundleDir, "triage.json"), "utf8"),
    ) as { privacy: unknown; maintainerNextSteps: string[] };
    const manifest = JSON.parse(
      readFileSync(safePath(result.value.bundleDir, "manifest.json"), "utf8"),
    ) as { privacy: unknown };

    expect(triage.privacy).toEqual(manifest.privacy);
    expect(triage.privacy).toEqual({
      redaction: "platform-aware-v1",
      excludes: ["secrets", "raw-config-values", "message-bodies", "file-contents", ".env"],
    });
    expect(triage.maintainerNextSteps).toContain('comis explain "<sessionKey>"');
  });
});
