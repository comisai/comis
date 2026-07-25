// SPDX-License-Identifier: Apache-2.0
/**
 * Offline-orchestrator tests for the support bundle.
 *
 * These drive the REAL nine doctor checks against a temp `~/.comis`-shaped
 * layout (never the machine's real data dir), so they pin the ground-truth
 * offline behavior rather than a hand-shaped `DoctorResult`:
 *  - a dead daemon (no daemon.pid) still produces the seven-file bundle, surfaces
 *    the `daemon_down` signal, and is NEVER reported `healthy`;
 *  - a corrupt config yields `misconfigured` + `config_corrupt` and still
 *    generates (a section failure is a warning, never a crash);
 *  - `doctor.json` carries the real `buildDoctorJson` shape from a genuine run
 *    (nine checks), and `triage.json` round-trips through its parser;
 *  - the injected system assembler's report is written verbatim as `system-health.json`
 *    and its finding + root-cause codes reach `triage.json`'s active signals; a
 *    thrown or coverage-empty system folds into a `{source:"system"}` manifest
 *    warning without crashing;
 *  - `config-posture.json` lists the present config sections when the config
 *    parsed, and is omitted with a `{source:"config-posture"}` warning when it
 *    did not (while `config_corrupt` still surfaces from the doctor run);
 *  - a write that cannot land folds into the manifest warnings.
 *
 * The local doctor-context builder's gateway-URL remap (wildcard bind address →
 * loopback, tls → https) is unit-asserted directly.
 *
 * Temp dirs ONLY. The daemon-liveness probe is stubbed down so the host
 * snapshot opens no socket, and the system assembler is injected with a hermetic
 * fixture so no case loads the @comis/daemon runtime graph.
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
import type { SystemHealthReport, IncidentReport } from "@comis/core";

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
 * Minimal valid SystemHealthReport fixture — an empty, coverage-empty window
 * (the shape the offline assembler returns against a data dir with no
 * `memory.db`). Overrides shallow-merge the base, so a case replaces only the
 * sub-object it exercises (`findings`, `coverage`, `likelyRootCause`, …).
 */
function makeSystem(over: Partial<SystemHealthReport> = {}): SystemHealthReport {
  return {
    schemaVersion: 1,
    windowHours: 24,
    sessions: { total: 0, degraded: 0, degradedRate: 0 },
    topErrorKinds: [],
    degradedByCause: {},
    breakerTripTotal: 0,
    toolStats: {},
    cost: { costUsd: 0, totalTokens: 0 },
    activity: {
      activeAgents: [],
      activeChannels: [],
      exitReasons: {},
      turnTotal: 0,
      tokenTotal: 0,
    },
    findings: [],
    likelyRootCause: null,
    suggestedNextSteps: [],
    truncations: [],
    coverage: {
      sessionSummary: { found: false, rows: 0 },
      sessionIndex: { daysRead: 0, daysMissing: 0 },
      billing: { present: false },
    },
    ...over,
  };
}

/**
 * Base deps for the orchestrator: a temp data dir, the config path under it, the
 * daemon-down stub, and an injected system assembler. `configBody` defaults to a
 * valid config whose gateway points at an unused loopback port so the
 * connectivity probe fails fast and deterministically instead of touching a real
 * daemon. `assembleSystem` defaults to a hermetic empty-window fixture so no case
 * loads the @comis/daemon runtime graph; individual cases override it to
 * exercise the write, the signal flow, or the degradation branches.
 */
function makeDeps(
  overrides: {
    dataDir?: string;
    configBody?: string;
    assembleSystem?: (dataDir: string, sinceHours: number) => Promise<SystemHealthReport>;
  } = {},
) {
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
    assembleSystem:
      overrides.assembleSystem ?? (async (): Promise<SystemHealthReport> => makeSystem()),
  };
}

/** Recompute the bundle dir the way the writer names it from an instant. */
function expectedBundleDir(dataDir: string): string {
  const tsIso = new Date(NOW_MS).toISOString().replace(/[:.]/g, "-");
  return safePath(safePath(dataDir, "support-bundles"), `comis-support-${tsIso}`);
}

describe("generateSupportBundle offline against a dead daemon", () => {
  it("produces the seven-file bundle and surfaces daemon_down without reporting healthy", async () => {
    const result = await generateSupportBundle(makeDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const files = readdirSync(result.value.bundleDir).sort();
    expect(files).toEqual([
      "ai-issue-draft.md",
      "config-posture.json",
      "doctor.json",
      "issue-summary.md",
      "manifest.json",
      "system-health.json",
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
    // config-posture.json is OMITTED on an unparseable config (no raw keys), so
    // the corrupt-config bundle is six files — system-health.json is still written.
    const files = readdirSync(result.value.bundleDir).sort();
    expect(files).toEqual([
      "ai-issue-draft.md",
      "doctor.json",
      "issue-summary.md",
      "manifest.json",
      "system-health.json",
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
    expect(ctx.gatewayUrl).toBe("http://[::1]:4766");
  });

  it("does not probe a gateway that is explicitly disabled", () => {
    const ctx = contextFrom("gateway:\n  enabled: false\n");
    expect(ctx.gatewayUrl).toBeUndefined();
  });

  it("resolves the memory database beneath the support bundle data dir", () => {
    const ctx = contextFrom("memory:\n  dbPath: stores/support.db\n");
    expect(ctx.memoryDbPath).toBe("/tmp/does-not-matter/stores/support.db");
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

describe("generateSupportBundle system composition", () => {
  it("writes a system-health.json that round-trips the injected report's schemaVersion and finding codes", async () => {
    const system = makeSystem({
      sessions: { total: 3, degraded: 1, degradedRate: 0.33 },
      findings: [
        { code: "config_posture", detail: "gateway.tls (off)", count: 1, hint: "Enable TLS" },
      ],
      coverage: {
        sessionSummary: { found: true, rows: 3 },
        sessionIndex: { daysRead: 1, daysMissing: 0 },
        billing: { present: true },
      },
    });
    const result = await generateSupportBundle(makeDeps({ assembleSystem: async () => system }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const written = JSON.parse(
      readFileSync(safePath(result.value.bundleDir, "system-health.json"), "utf8"),
    ) as { schemaVersion: number; findings: Array<{ code: string }> };
    expect(written.schemaVersion).toBe(1);
    expect(written.findings.map((f) => f.code)).toContain("config_posture");
  });

  it("surfaces the injected system finding and root-cause codes in the triage.json active signals", async () => {
    const system = makeSystem({
      sessions: { total: 5, degraded: 3, degradedRate: 0.6 },
      findings: [{ code: "model_health:embedder_not_multilingual", detail: "", count: 1, hint: "" }],
      likelyRootCause: { code: "system_high_degraded_rate", detail: "", suggestedNextSteps: [] },
      coverage: {
        sessionSummary: { found: true, rows: 5 },
        sessionIndex: { daysRead: 1, daysMissing: 0 },
        billing: { present: true },
      },
    });
    const result = await generateSupportBundle(makeDeps({ assembleSystem: async () => system }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const triage = JSON.parse(
      readFileSync(safePath(result.value.bundleDir, "triage.json"), "utf8"),
    ) as { activeSignals: string[] };
    expect(triage.activeSignals).toContain("model_health:embedder_not_multilingual");
    expect(triage.activeSignals).toContain("system_high_degraded_rate");
  });

  it("folds a coverage-empty system read into a manifest system warning while still writing system-health.json", async () => {
    // The default fixture is the coverage-empty window the offline assembler
    // returns against a data dir with no memory.db — a valid empty report that
    // is still written, with an honest {source:"system"} warning.
    const result = await generateSupportBundle(makeDeps({ assembleSystem: async () => makeSystem() }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.warnings.some((w) => w.source === "system")).toBe(true);
    expect(existsSync(safePath(result.value.bundleDir, "system-health.json"))).toBe(true);
    const manifest = JSON.parse(
      readFileSync(safePath(result.value.bundleDir, "manifest.json"), "utf8"),
    ) as { warnings?: Array<{ source: string }> };
    expect(manifest.warnings?.some((w) => w.source === "system")).toBe(true);
  });

  it("folds a thrown system assembler into a manifest system warning and omits system-health.json without crashing", async () => {
    const result = await generateSupportBundle(
      makeDeps({
        assembleSystem: async () => {
          throw new Error("memory.db unreadable");
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.warnings.some((w) => w.source === "system")).toBe(true);
    // A thrown assembler leaves system undefined, so system-health.json is omitted.
    expect(existsSync(safePath(result.value.bundleDir, "system-health.json"))).toBe(false);
  });
});

describe("generateSupportBundle config-posture composition", () => {
  it("writes a config-posture.json naming the present sections with no config value", async () => {
    const configBody =
      "gateway:\n  host: 127.0.0.1\n  port: 59237\nchannels: {}\n";
    const result = await generateSupportBundle(makeDeps({ configBody }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const raw = readFileSync(safePath(result.value.bundleDir, "config-posture.json"), "utf8");
    const posture = JSON.parse(raw) as { sections: string[] };
    expect(posture.sections).toContain("gateway");
    expect(posture.sections).toContain("channels");
    // Membership is NAMES only — the configured port value never leaks.
    expect(raw).not.toContain("59237");
  });

  it("omits config-posture.json and warns while config_corrupt still surfaces on an unparseable config", async () => {
    const result = await generateSupportBundle(makeDeps({ configBody: "gateway: [1, 2" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(existsSync(safePath(result.value.bundleDir, "config-posture.json"))).toBe(false);
    expect(result.value.warnings.some((w) => w.source === "config-posture")).toBe(true);
    // The doctor run still emits config_corrupt from the config-health check.
    expect(result.value.activeSignals).toContain("config_corrupt");
    expect(result.value.status).toBe("misconfigured");
  });
});

/**
 * A minimal IncidentReport fixture — the content-free ids the embed stub returns.
 * Only the fields the reducer/writer read matter (sessionKey/traceId/agentId,
 * outcome, likelyRootCause); the rest are plausible defaults, cast to the type.
 */
function makeIncident(over: Partial<IncidentReport> = {}): IncidentReport {
  return {
    schemaVersion: 1,
    sessionKey: "acme:alice:general",
    traceId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    agentId: "default",
    channel: { type: "discord", id: "general" },
    outcome: { endReason: "completed", degraded: true, severity: "degraded" },
    cost: { costUsd: 0, totalTokens: 0, cacheReadRatio: 0 },
    timing: { durationMs: 0, turnCount: 0 },
    toolStats: {},
    failures: [],
    breakerTimeline: [],
    offloads: [],
    likelyRootCause: { code: "spend_exceeded", detail: "", suggestedNextSteps: [] },
    ...over,
  } as IncidentReport;
}

describe("generateSupportBundle --session / audit / --deep orchestration", () => {
  it("embeds explain.json and populates triage.explainSummary + active signals on --session", async () => {
    const deps = makeDeps();
    const result = await generateSupportBundle({
      ...deps,
      session: "acme:alice:general",
      embedSessionFn: async () => ({ explain: makeIncident(), warnings: [] }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // explain.json is the embedded report verbatim — the UUID traceId round-trips.
    const explain = JSON.parse(
      readFileSync(safePath(result.value.bundleDir, "explain.json"), "utf8"),
    ) as { traceId: string; sessionKey: string };
    expect(explain.traceId).toBe("3f2504e0-4f89-41d3-9a0c-0305e82c3301");
    expect(explain.sessionKey).toBe("acme:alice:general");

    // The reducer surfaces the embedded root cause into the triage enrichment.
    const triage = JSON.parse(
      readFileSync(safePath(result.value.bundleDir, "triage.json"), "utf8"),
    ) as { explainSummary?: { degraded: boolean; likelyRootCause: string | null } };
    expect(triage.explainSummary?.likelyRootCause).toBe("spend_exceeded");
    expect(triage.explainSummary?.degraded).toBe(true);
    expect(result.value.activeSignals).toContain("spend_exceeded");
  });

  it("writes audit-summary.json from an injected offline audit read", async () => {
    const deps = makeDeps();
    const result = await generateSupportBundle({
      ...deps,
      readAudit: () => ({ schemaVersion: 1, total: 5, byKind: { secret_access: 5 } }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const audit = JSON.parse(
      readFileSync(safePath(result.value.bundleDir, "audit-summary.json"), "utf8"),
    ) as { total: number; byKind: Record<string, number> };
    expect(audit.total).toBe(5);
    expect(audit.byKind["secret_access"]).toBe(5);
  });

  it("folds an absent audit store into a source:audit warning without writing audit-summary.json", async () => {
    const deps = makeDeps();
    const result = await generateSupportBundle({ ...deps, readAudit: () => undefined });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(existsSync(safePath(result.value.bundleDir, "audit-summary.json"))).toBe(false);
    expect(result.value.warnings.some((w) => w.source === "audit")).toBe(true);
    const manifest = JSON.parse(
      readFileSync(safePath(result.value.bundleDir, "manifest.json"), "utf8"),
    ) as { warnings?: Array<{ source: string }> };
    expect(manifest.warnings?.some((w) => w.source === "audit")).toBe(true);
  });

  it("exports trace-exports/ INTO the bundle dir on --deep, stamping workspaceDir + clock before the manifest", async () => {
    const deps = makeDeps();
    let captured: { workspaceDir: string; clockVal: number; sessionFile: string } | undefined;
    const result = await generateSupportBundle({
      ...deps,
      session: "acme:alice:general",
      deep: true,
      embedSessionFn: async () => ({
        explain: makeIncident(),
        deepSessionFile: "/tmp/resolved-session.jsonl",
        warnings: [],
      }),
      exportTrace: async (params: {
        workspaceDir: string;
        clock?: () => number;
        sessionFile: string;
      }) => {
        captured = {
          workspaceDir: params.workspaceDir,
          clockVal: params.clock?.() ?? -1,
          sessionFile: params.sessionFile,
        };
        // Simulate the real exporter writing its 8-file dir INTO workspaceDir.
        const traceDir = safePath(safePath(params.workspaceDir, "trace-exports"), "comis-trace-abc-1");
        mkdirSync(traceDir, { recursive: true });
        return { ok: true, value: { bundleDir: traceDir, manifest: {} } };
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The exporter was pointed at the SAME bundle dir the writer used (no copy).
    expect(captured?.workspaceDir).toBe(result.value.bundleDir);
    expect(captured?.workspaceDir).toBe(expectedBundleDir(deps.dataDir));
    // The clock was stamped from the caller's nowMs (determinism).
    expect(captured?.clockVal).toBe(NOW_MS);
    // The pointer-resolved deep session file flowed through.
    expect(captured?.sessionFile).toBe("/tmp/resolved-session.jsonl");
    // The trace dir landed inside the bundle (ordering: before the manifest write).
    expect(
      existsSync(safePath(safePath(result.value.bundleDir, "trace-exports"), "comis-trace-abc-1")),
    ).toBe(true);
  });

  it("folds a failed trace export into a source:trace-export manifest warning without crashing", async () => {
    const deps = makeDeps();
    const result = await generateSupportBundle({
      ...deps,
      session: "acme:alice:general",
      deep: true,
      embedSessionFn: async () => ({
        explain: makeIncident(),
        deepSessionFile: "/tmp/resolved-session.jsonl",
        warnings: [],
      }),
      exportTrace: async () => ({
        ok: false,
        error: { kind: "session-file-not-readable", reason: "gone" },
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.warnings.some((w) => w.source === "trace-export")).toBe(true);
    const manifest = JSON.parse(
      readFileSync(safePath(result.value.bundleDir, "manifest.json"), "utf8"),
    ) as { warnings?: Array<{ source: string }> };
    expect(manifest.warnings?.some((w) => w.source === "trace-export")).toBe(true);
    // A failed section is partial, not fatal — the core files still land.
    expect(existsSync(safePath(result.value.bundleDir, "triage.json"))).toBe(true);
  });

  it("surfaces the worst-session hint when no --session is given, writing no explain/trace files", async () => {
    const deps = makeDeps();
    const result = await generateSupportBundle({
      ...deps,
      suggestWorst: () => "acme:bob:incidents",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.worstSessionKey).toBe("acme:bob:incidents");
    expect(existsSync(safePath(result.value.bundleDir, "explain.json"))).toBe(false);
    expect(existsSync(safePath(result.value.bundleDir, "trace-exports"))).toBe(false);
  });

  it("folds an embed explain warning into the result and still writes the core files", async () => {
    const deps = makeDeps();
    const result = await generateSupportBundle({
      ...deps,
      session: "acme:alice:general",
      embedSessionFn: async () => ({
        warnings: [
          { source: "explain", code: "explain_assembly_failed", count: 1, message: "boom" },
        ],
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.warnings.some((w) => w.source === "explain")).toBe(true);
    expect(existsSync(safePath(result.value.bundleDir, "explain.json"))).toBe(false);
    expect(existsSync(safePath(result.value.bundleDir, "triage.json"))).toBe(true);
  });
});
