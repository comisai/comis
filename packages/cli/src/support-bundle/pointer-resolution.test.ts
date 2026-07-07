// SPDX-License-Identifier: Apache-2.0
/**
 * Real-layout pointer-resolution gate for the support bundle's `--session` and
 * `--deep` paths — the load-bearing correctness test.
 *
 * Per AGENTS.md §2.10 the on-disk layout IS the contract: any `~/.comis` session
 * path the bundle resolves MUST go through the `<file>.jsonl.trajectory-path.json`
 * pointer → `runtimeFile`, never a hand-built `<dataDir>/sessions/<id>` guess.
 * That flat path never existed on disk and once shipped two broken obs readers,
 * so a fixture-only test that stubs the resolution cannot prove the property.
 * This suite instead builds the ACTUAL nested `workspace/sessions/<tenant>/
 * <channel>/<file>.jsonl` tree in a temp dir and drives the REAL offline
 * assembler + the REAL trajectory-bundle exporter end-to-end with no daemon.
 *
 * The load-bearing discriminator: the pointer's `runtimeFile` targets a
 * NON-co-located sibling that holds the REAL records, while a co-located
 * `<sessionFile>.trajectory.jsonl` DECOY holds a DISTINCT marker. Correct pointer
 * resolution reads the pointer target and ignores the decoy; a co-location
 * fallback — the bug class — would read the decoy. Every assertion below keys on
 * a value derivable ONLY from the pointer target, so a regression to co-location
 * (or to a flat `sessions/<id>` guess) fails here loudly.
 *
 * Only `assembleFleet` and daemon-liveness are stubbed (so a unit run never
 * loads the fleet graph); the session/deep resolution runs the real seams.
 *
 * Temp dirs ONLY — never `~/.comis` (AGENTS.md §6). `path.join` is test-only-legal
 * (the no-path.join rule scopes to non-test src); the SUT resolves via the
 * production helpers.
 *
 * @module
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { safePath } from "@comis/core";
import type { FleetHealthReport } from "@comis/core";
import { writeTrajectoryPointerFileBestEffort } from "@comis/observability";

import { generateSupportBundle } from "./generate.js";

// A production-shaped key → tenant "default", channel "678314278", file
// "678314278~peer~678314278.jsonl" (the layout verified against a real install).
const SESSION_KEY = "default:678314278:678314278:peer:678314278";

// The REAL budget marker lives ONLY in the pointer-target runtime; the DECOY
// budget marker lives ONLY in the co-located decoy. The report/trace can carry
// exactly one of them — that is the resolution discriminator.
const REAL_ASSEMBLED_TOKENS = 31_572;
const DECOY_ASSEMBLED_TOKENS = 99_999;

// A string that exists ONLY in the co-located decoy runtime. It must never reach
// any produced artifact — its presence would prove a co-location fallback fired.
const DECOY_MARKER = "DECOY-RUNTIME-MUST-NOT-APPEAR";

/** A fixed generation instant so the run is deterministic. */
const NOW_MS = Date.UTC(2026, 6, 3, 10, 15, 0);

/** The eight files the trajectory exporter writes per session bundle. */
const EXPECTED_TRACE_FILES = [
  "manifest.json",
  "events.jsonl",
  "session-branch.json",
  "metadata.json",
  "artifacts.json",
  "prompts.json",
  "system-prompt.txt",
  "tools.json",
];

/**
 * A hermetic empty-window fleet report, injected so the run never loads the
 * daemon fleet graph. The session/deep paths still exercise the REAL assembler +
 * exporter — only the cross-session fleet digest is stubbed.
 */
function emptyFleet(): FleetHealthReport {
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
  };
}

const tmpDirs: string[] = [];

function makeDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pointer-resolution-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir === undefined) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort teardown; a leaked temp dir must never fail the suite.
    }
  }
});

interface NonColocatedFixture {
  readonly sessionKey: string;
  readonly sessionFile: string;
  /** The pointer target — a sibling OUTSIDE the session dir holding the REAL records. */
  readonly realRuntimeFile: string;
  /** The co-located `<sessionFile>.trajectory.jsonl` decoy holding a distinct marker. */
  readonly decoyRuntimeFile: string;
}

function record(type: string, seq: number, data: Record<string, unknown>): string {
  return JSON.stringify({
    traceSchema: "comis-trajectory",
    schemaVersion: 1,
    type,
    seq,
    agentId: "default",
    sessionId: SESSION_KEY,
    data,
  });
}

/**
 * Build the production nested layout with a NON-co-located pointer target and a
 * co-located decoy. The pointer's `runtimeFile` points at `runtime-store/` (a
 * sibling of `workspace/`, never the co-located `.trajectory.jsonl`), so reading
 * the REAL records requires following the pointer — not a co-location guess.
 */
function buildNonColocatedSession(dataDir: string): NonColocatedFixture {
  const sessionDir = path.join(dataDir, "workspace", "sessions", "default", "678314278");
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionFile = path.join(sessionDir, "678314278~peer~678314278.jsonl");
  fs.writeFileSync(sessionFile, "", "utf-8");

  // REAL records — the pointer target, seeded with the exhausted budget marker.
  const runtimeStore = path.join(dataDir, "runtime-store");
  fs.mkdirSync(runtimeStore, { recursive: true });
  const realRuntimeFile = path.join(runtimeStore, "real-runtime.trajectory.jsonl");
  const realRecords = [
    record("session.started", 1, { channelType: "telegram", channelId: "678314278" }),
    record("tool.result", 2, { toolName: "ctx_search", toolCallId: "call_real", success: true }),
    record("context.budget", 3, {
      windowTokens: 32_000,
      rawContextWindowTokens: 131_072,
      windowCapSource: "effectiveContextCapSmall",
      systemTokens: 25_694,
      freshTailTokens: 5_272,
      budgetedHistoryTokens: 0,
      keptCount: 0,
      assembledInputTokens: REAL_ASSEMBLED_TOKENS,
      outputHeadroom: 768,
      verdict: "exhausted",
    }),
  ];
  fs.writeFileSync(realRuntimeFile, realRecords.join("\n") + "\n", "utf-8");

  // DECOY records — co-located, seeded with a DISTINCT non-exhausted marker and a
  // tool name that must never surface. A co-location fallback would read THIS.
  const decoyRuntimeFile = `${sessionFile}.trajectory.jsonl`;
  const decoyRecords = [
    record("tool.result", 2, { toolName: DECOY_MARKER, toolCallId: "call_decoy", success: true }),
    record("context.budget", 3, {
      windowTokens: 1,
      rawContextWindowTokens: 1,
      windowCapSource: DECOY_MARKER,
      systemTokens: 1,
      freshTailTokens: 1,
      budgetedHistoryTokens: 0,
      keptCount: 0,
      assembledInputTokens: DECOY_ASSEMBLED_TOKENS,
      outputHeadroom: 1,
      verdict: "ok",
    }),
  ];
  fs.writeFileSync(decoyRuntimeFile, decoyRecords.join("\n") + "\n", "utf-8");

  // The pointer that makes the REAL (non-co-located) file authoritative.
  writeTrajectoryPointerFileBestEffort({
    sessionFile,
    sessionId: SESSION_KEY,
    runtimeFile: realRuntimeFile,
  });

  // The rollup companion so the assembler resolves an outcome from disk.
  fs.writeFileSync(
    sessionFile.replace(/\.jsonl$/, "_session-metadata.json"),
    JSON.stringify({
      traceId: "ea72ef66-9497-46c2-a7bb-46f5ba92732e",
      sessionEnd: {
        type: "session_end",
        endReason: "context_exhausted",
        degraded: true,
        costUsd: 0,
        totalTokens: 51_145,
        toolStats: { ctx_search: { ok: 1, failed: 0 } },
      },
    }),
    "utf-8",
  );

  return { sessionKey: SESSION_KEY, sessionFile, realRuntimeFile, decoyRuntimeFile };
}

/** Recursively enumerate every file under `dir`, returned as paths relative to it. */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out.map((f) => path.relative(dir, f));
}

describe("support bundle --session — resolves the incident via the on-disk pointer, not a flat guess", () => {
  // Generous timeout: the first offline call lazy-loads the whole daemon graph
  // (~10s cold under vitest's transform); the session path pays it once.
  it(
    "assembles explain.json from the pointer target and never the co-located decoy",
    { timeout: 120_000 },
    async () => {
      const dataDir = makeDataDir();
      const fx = buildNonColocatedSession(dataDir);

      const result = await generateSupportBundle({
        dataDir,
        configPaths: [],
        sinceHours: 24,
        nowMs: NOW_MS,
        session: fx.sessionKey,
        deep: false,
        isDaemonRunning: async () => false,
        assembleFleet: async () => emptyFleet(),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const explainPath = safePath(result.value.bundleDir, "explain.json");
      expect(fs.existsSync(explainPath)).toBe(true);
      const explainRaw = fs.readFileSync(explainPath, "utf-8");
      const explain = JSON.parse(explainRaw) as {
        sessionKey: string;
        traceId?: string;
        contextBudget?: { assembledInputTokens?: number; verdict?: string };
        likelyRootCause?: { code?: string };
        toolStats?: Record<string, unknown>;
      };

      // The report is the resolved incident for the requested key. explain.json
      // rides the untrusted value-shape leaf, which masks the 9+ digit numeric ids
      // in the key, so the raw key does not round-trip verbatim; the non-numeric
      // skeleton (tenant + `peer` + colon structure) does, and the UUID traceId —
      // the primary correlation id — round-trips untouched.
      expect(explain.sessionKey.startsWith("default:")).toBe(true);
      expect(explain.sessionKey.includes(":peer:")).toBe(true);
      expect(explain.traceId).toBe("ea72ef66-9497-46c2-a7bb-46f5ba92732e");

      // The budget equation rode the POINTER-TARGET trajectory onto the report —
      // the exhausted marker, never the decoy's non-exhausted one. Five-digit
      // token counts survive the value-shape pass (only 9+ digit runs are masked),
      // so the marker is a reliable resolution discriminator.
      expect(explain.contextBudget?.assembledInputTokens).toBe(REAL_ASSEMBLED_TOKENS);
      expect(explain.contextBudget?.assembledInputTokens).not.toBe(DECOY_ASSEMBLED_TOKENS);
      expect(explain.contextBudget?.verdict).toBe("exhausted");
      // The root-cause code embeds the "text" payload keyword, so the untrusted
      // leaf masks that substring; the surviving `exhausted` suffix still proves
      // the exhausted (pointer-target) budget drove the verdict — the decoy's
      // non-exhausted budget would yield no exhausted root cause.
      expect(explain.likelyRootCause?.code).toContain("exhausted");
      expect(Object.keys(explain.toolStats ?? {})).toContain("ctx_search");

      // The decoy marker never reached the artifact — a co-location fallback would
      // have surfaced it (as the tool name or the cap source).
      expect(explainRaw).not.toContain(DECOY_MARKER);

      // No hand-built flat `<dataDir>/sessions/<id>` path was ever fabricated or
      // used — the whole `sessions/` dir does not exist under the data dir.
      expect(fs.existsSync(path.join(dataDir, "sessions"))).toBe(false);
    },
  );
});

describe("support bundle --deep — exports the trace bundle from the pointer target, in place", () => {
  it(
    "writes the eight-file trace bundle whose runtime source is the pointer target, not the decoy",
    { timeout: 120_000 },
    async () => {
      const dataDir = makeDataDir();
      const fx = buildNonColocatedSession(dataDir);

      const result = await generateSupportBundle({
        dataDir,
        configPaths: [],
        sinceHours: 24,
        nowMs: NOW_MS,
        session: fx.sessionKey,
        deep: true,
        isDaemonRunning: async () => false,
        assembleFleet: async () => emptyFleet(),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const bundleDir = result.value.bundleDir;

      // The exporter's output lands in-place under `trace-exports/` (plural, no
      // `.comis/` sub-prefix), with no copy step.
      const traceExportsDir = safePath(bundleDir, "trace-exports");
      expect(fs.existsSync(traceExportsDir)).toBe(true);
      const traceBundles = fs.readdirSync(traceExportsDir).filter((n) => n.startsWith("comis-trace-"));
      expect(traceBundles).toHaveLength(1);
      const traceDir = safePath(traceExportsDir, traceBundles[0]!);

      // All eight files are present.
      const written = new Set(fs.readdirSync(traceDir));
      for (const name of EXPECTED_TRACE_FILES) {
        expect(written.has(name), `trace bundle must contain ${name}`).toBe(true);
      }
      expect(written.size).toBe(EXPECTED_TRACE_FILES.length);

      // The manifest names the pointer target as the runtime source — proving the
      // exporter, too, resolved via the pointer and not the co-located decoy. The
      // exporter path-substitutes its OWN manifest before writing, so the raw
      // bundle path never lands in the shareable artifact and the source fields
      // are matched by basename (pointer target, never the decoy).
      const manifestRaw = fs.readFileSync(safePath(traceDir, "manifest.json"), "utf-8");
      const manifest = JSON.parse(manifestRaw) as {
        workspaceDir?: string;
        sourceFiles?: { session?: string; runtime?: string };
      };
      // The manifest's workspace field is the placeholder and the raw bundle path
      // is absent — the host-path substitution the support bundle guarantees now
      // reaches the embedded trace manifest (no OS-username disclosure).
      expect(manifest.workspaceDir).toBe("$WORKSPACE_DIR");
      expect(manifestRaw).not.toContain(bundleDir);
      // Pointer precedence: the runtime source is the pointer-target file, not the
      // co-located decoy (keyed on basename so the assertion survives substitution).
      expect(manifest.sourceFiles?.runtime?.endsWith(path.basename(fx.realRuntimeFile))).toBe(true);
      expect(manifest.sourceFiles?.runtime?.endsWith(path.basename(fx.decoyRuntimeFile))).toBe(false);
      expect(manifest.sourceFiles?.session?.endsWith(path.basename(fx.sessionFile))).toBe(true);

      // The exported events reflect the REAL records (the exhausted budget marker)
      // and carry NONE of the decoy content.
      const events = fs.readFileSync(safePath(traceDir, "events.jsonl"), "utf-8");
      expect(events).toContain(String(REAL_ASSEMBLED_TOKENS));
      expect(events).not.toContain(String(DECOY_ASSEMBLED_TOKENS));
      expect(events).not.toContain(DECOY_MARKER);
    },
  );
});

describe("support bundle — dead daemon (no audit store) degrades honestly", () => {
  it(
    "records an audit-store warning, still produces the bundle, and is never healthy",
    { timeout: 120_000 },
    async () => {
      const dataDir = makeDataDir();
      // No memory.db is written — the offline audit store is absent, exactly as on
      // a host whose daemon never came up (when the bundle is most needed).
      const fx = buildNonColocatedSession(dataDir);

      const result = await generateSupportBundle({
        dataDir,
        configPaths: [],
        sinceHours: 24,
        nowMs: NOW_MS,
        session: fx.sessionKey,
        deep: false,
        isDaemonRunning: async () => false,
        assembleFleet: async () => emptyFleet(),
      });

      // Partial output, not a crash: the bundle is still produced.
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // The audit read soft-failed to an honest manifest warning.
      const auditWarning = result.value.warnings.find((w) => w.source === "audit");
      expect(auditWarning).toBeDefined();

      // An absent store never masquerades as a clean install.
      expect(result.value.status).not.toBe("healthy");

      // The core artifacts were still written despite the missing store.
      expect(fs.existsSync(safePath(result.value.bundleDir, "explain.json"))).toBe(true);
      expect(walkFiles(result.value.bundleDir).length).toBeGreaterThan(0);
    },
  );
});
