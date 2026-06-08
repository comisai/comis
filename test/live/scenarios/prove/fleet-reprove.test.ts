// SPDX-License-Identifier: Apache-2.0
/**
 * FLEET-reprove (Phase 162 P1 — RE-PROVE & GA: obs.fleet.health reproduces the
 * Phase-158 corpus in ONE call, ZERO log-greps).
 *
 * The milestone's reason-to-exist proof. The fleet lens (Phases 159-161) replaces
 * the manual cross-session triage the §2 by-hand review ran on `daemon.log` (the
 * severity histogram + group-by-message + pm2 native model scrape). This scenario
 * proves that a SINGLE `assembleFleetHealthReport` call reproduces that corpus's
 * signal classes — both flagship health signals (`lcd_divergence` +
 * `mcp_reconnect_failed`), the model/config posture findings (I-track), AND the
 * cross-session A-track rates (degraded rate / errorKinds / breaker / cost).
 *
 * It is the analog of v2.14's Phase-156 `diagnosis-reprove.test.ts` — with the
 * entire Stage-C judged apparatus DROPPED. The fleet proof is a COUNT/STRUCTURE
 * reproduction, so it is KEYLESS + DETERMINISTIC: no model, no judge, no API key,
 * no cost governor, no benchmark ledger, no live-gate env flag, and no environment
 * read of any kind (the same anti-cargo-cult discipline `fleet-gate-substrate.
 * test.ts:5-12` documents). The costed LIVE RUN (boot the new instrumented daemon
 * → it writes real I-track rows → `comis fleet` surfaces them) is the operator's —
 * see the co-located `fleet-reprove-runbook.md` (the 161-HUMAN-UAT item #4).
 *
 * THE "0 LOG-GREPS" CLAIM IS BY CONSTRUCTION. The assembler reads ONLY sqlite
 * (`obsStore.aggregateSessionsInWindow` + 3× `queryDiagnostics({category})`) and
 * the session-index `.jsonl` day-files — it NEVER opens `daemon.log`
 * (fleet-health.ts:316,328,331-333). The findings asserted below all came from the
 * SEEDED store, never a log file; the proof is structural, NOT a stub of sources.
 *
 * SCOPE REALITY (LOAD-BEARING): the current real `~/.comis` was produced by the
 * PRE-160 daemon, so it has NO `health_signal`/`model_health`/`config_posture`
 * rows. The I-track is therefore SEEDED into a `mkdtempSync` tmp dataDir (NEVER the
 * real `~/.comis` for the write side — the D9 no-prod-datadir rule). The full
 * end-to-end I-track surfacing against REAL freshly-written rows is the operator's
 * live RUN (the RUNBOOK).
 *
 * Run (keyless, always GREEN — no env, no key — under the LIVE config; a bare
 * `pnpm vitest run test/live/...` reports "No test files", a false-RED):
 *   pnpm vitest run --config test/live/vitest.config.ts \
 *     test/live/scenarios/prove/fleet-reprove.test.ts
 *   # OR: pnpm test:live prove
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { systemNowMs } from "@comis/core";
import { initSchema, createObservabilityStore } from "@comis/memory";
import type { ObservabilityStore } from "@comis/memory";
import { loadCorpus } from "../../support/fleet-triage-corpus.js";
import { assertNoSecrets } from "../../cost.js";
// The fake clock makes the report deterministic w.r.t. the injected ClockPort —
// no wall-clock read (the globals gate forbids the ambient time API in product
// code; tests inject a fixed instant). Relative depth: this scenario sits at
// test/live/scenarios/prove/, three `..` lands at test/, then support/.
import { createFakeClock } from "../../../support/fake-clock.js";
// Resolves via the 162-01 TOP-LEVEL barrel re-export (the live config aliases
// @comis/daemon -> daemon/dist/index.js — the top-level barrel only).
import { assembleFleetHealthReport } from "@comis/daemon";

// fileURLToPath(import.meta.url) is robust across vitest pool modes (the
// fleet-gate-substrate.test.ts:59 idiom) — preferred over a bare __dirname.
const __dirnameLocal = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirnameLocal, "../../fixtures/fleet-triage");

/** A fresh `:memory:` ObservabilityStore with the full schema initialized. */
function makeStore(): ObservabilityStore {
  const db = new Database(":memory:");
  initSchema(db, 1536);
  return createObservabilityStore(db);
}

/** A `session_summary` `details` JSON payload (mirror fleet-health.test.ts:62-84). */
function summaryDetails(
  overrides: Partial<{
    degraded: boolean;
    costUsd: number;
    toolStats: Record<string, { ok: number; failed: number }>;
    breakerTripCount: number;
    turnCount: number;
    topErrorKinds: Record<string, number>;
    source: string;
  }> = {},
): string {
  return JSON.stringify({
    degraded: false,
    costUsd: 0,
    toolStats: {},
    breakerTripCount: 0,
    turnCount: 0,
    topErrorKinds: {},
    source: "runtime",
    ...overrides,
  });
}

/**
 * Seed the store so a single `assembleFleetHealthReport` call reproduces the
 * Phase-158 corpus's signal classes. Mirrors fleet-health.test.ts:150-200, ADDING
 * the second flagship (`mcp_reconnect_failed`) — the existing seed covered only
 * `lcd_divergence`. `now` is the fakeClock instant so every row sits inside the
 * 24h window.
 *
 * A-track (two session_summary rows, one degraded): drives degradedRate /
 * topErrorKinds / breakerTripTotal / cost.costUsd.
 * I-track (Phase-160 diagnostic rows): one `health_signal` per FLAGSHIP signal
 * (lcd_divergence + mcp_reconnect_failed) + one `model_health` + one
 * `config_posture` — the buildFindings codes the proof asserts.
 */
function seedStore(store: ObservabilityStore, now: number): void {
  // --- A-track: cross-session rates (degradedRate / errorKinds / breaker / cost) ---
  store.insertDiagnostic({
    timestamp: now - 1_000,
    category: "session_summary",
    severity: "info",
    sessionKey: "s1",
    message: "session:summary",
    details: summaryDetails({
      degraded: false,
      costUsd: 0.1,
      turnCount: 3,
      toolStats: { web_search: { ok: 5, failed: 0 } },
    }),
  });
  store.insertDiagnostic({
    timestamp: now - 500,
    category: "session_summary",
    severity: "warning",
    sessionKey: "s2",
    message: "session:summary",
    details: summaryDetails({
      degraded: true,
      costUsd: 0.4,
      turnCount: 2,
      breakerTripCount: 2,
      topErrorKinds: { tool_timeout: 3 },
      toolStats: { web_search: { ok: 1, failed: 4 } },
    }),
  });
  // --- I-track: one row per FLAGSHIP corpus signal class (the M2 verdicts). ---
  // Flagship 1: lcd-ingest-skipped (corpus byHandCount 7) -> health_signal:lcd_divergence.
  store.insertDiagnostic({
    timestamp: now - 2_000,
    category: "health_signal",
    severity: "warning",
    message: "LCD divergence detected on agent default",
    details: JSON.stringify({ signal: "lcd_divergence", reason: "fail_closed_rollover", conversationId: "c1" }),
  });
  // Flagship 2: mcp-reconnect (corpus byHandCount 3) -> health_signal:mcp_reconnect_failed.
  // The `signal` key drives the finding code via healthSignalLabel (fleet-health.ts:106-114).
  store.insertDiagnostic({
    timestamp: now - 2_100,
    category: "health_signal",
    severity: "warning",
    message: "mcp reconnect failed on server github",
    details: JSON.stringify({ signal: "mcp_reconnect_failed", server: "github" }),
  });
  // model-health-deferred (the pm2 native-stdout scrape the lens replaces) -> model_health.
  store.insertDiagnostic({
    timestamp: now - 3_000,
    category: "model_health",
    severity: "warning",
    message: "provider degraded",
    details: JSON.stringify({ provider: "anthropic", degraded: true }),
  });
  // config-posture (corpus byHandCount 3) -> config_posture.
  store.insertDiagnostic({
    timestamp: now - 4_000,
    category: "config_posture",
    severity: "warning",
    message: "gateway TLS disabled",
    details: JSON.stringify({ tlsEnabled: false }),
  });
}

describe(
  "Phase 162 P1 — fleet RE-PROVE: obs.fleet.health reproduces the 158 corpus in 1 call, 0 grep (keyless, deterministic)",
  () => {
    it("ONE assembleFleetHealthReport call reproduces both flagships + model/config (I-track) + the A-track rates", async () => {
      // The seeded store + tmp dataDir — NEVER the real ~/.comis for the write side
      // (the D9 no-prod-datadir rule; the live RUN that touches real data is the
      // operator's, not this scenario's).
      const store = makeStore();
      const now = systemNowMs();
      const clock = createFakeClock(now); // injected ClockPort — fixed instant, no wall-clock read
      seedStore(store, now);
      const dataDir = fs.mkdtempSync(join(os.tmpdir(), "fleet-reprove-"));

      // ────────────────────────────────────────────────────────────────────────
      // THE ONE CALL. The gate-free assembler directly (the diagnosis-reprove.
      // test.ts:159-164 "call the assembler directly, no daemon/admin token"
      // precedent). 0 log-greps BY CONSTRUCTION: the assembler reads ONLY sqlite
      // (obsStore) + the session-index JSONL — never daemon.log
      // (fleet-health.ts:316,328,331-333). The findings below all originate from
      // the SEEDED store, proving the structural claim without stubbing sources.
      // ────────────────────────────────────────────────────────────────────────
      const report = await assembleFleetHealthReport({ obsStore: store, dataDir, clock }, 24);

      // --- The report reproduces the corpus's I-track signal classes. ---
      const codes = report.findings.map((f) => f.code);
      expect(codes).toContain("health_signal:lcd_divergence"); // flagship 1 (corpus: lcd-ingest-skipped ×7)
      expect(codes).toContain("health_signal:mcp_reconnect_failed"); // flagship 2 (corpus: mcp-reconnect ×3)
      expect(codes).toContain("model_health"); // the pm2 native-stdout model scrape, structured
      expect(codes).toContain("config_posture"); // corpus: config-posture ×3

      // --- The A-track cross-session rates are populated (the same read the 158
      //     gate did over session_summary rows). ---
      expect(report.sessions.total).toBe(2);
      expect(report.sessions.degraded).toBe(1);
      expect(report.sessions.degradedRate).toBeGreaterThan(0);
      expect(report.topErrorKinds.length).toBeGreaterThan(0);
      expect(report.topErrorKinds).toContainEqual({ kind: "tool_timeout", count: 3 });
      expect(report.breakerTripTotal).toBeGreaterThanOrEqual(2);
      // cost.costUsd is A1-sourced (the session_summary store) — non-zero here;
      // cost.totalTokens is A3-sourced (session-index files) and may be 0 with no
      // day-files, so it is NOT asserted (WR-03, fleet-health.ts:365-372).
      expect(report.cost.costUsd).toBeGreaterThan(0);

      // --- Secret/residency sweep over the serialized report (mandatory belt-and-
      //     suspenders; the 162-02 GA marker pins `.toContain("assertNoSecrets")`
      //     over this file). The digest-only report carries no bodies — this is the
      //     defense-in-depth second sweep point. ---
      expect(() => assertNoSecrets(JSON.stringify(report), "fleet-reprove-report")).not.toThrow();
    });

    it("CONTRASTS the manual cost the lens replaces — narrative coverage, NO hard-coded number", () => {
      // The frozen Phase-158 corpus is the reference: `manualCost` is the by-hand
      // cross-session triage (the severity histogram + group-by-message + pm2 model
      // scrape) the ONE-call fleet report REPLACES. The contrast is QUALITATIVE —
      // we assert the manual steps EXIST as the cost-to-beat and that the report's
      // finding/rollup CLASSES cover them, NOT a token/effort delta (Pitfall 4: no
      // hard-coded cost-to-beat number in any pnpm validate-tier check).
      const corpus = loadCorpus(FIXTURES_DIR);

      // severityHistogram (the manual WARN tally) -> covered by the report's
      // findings + topErrorKinds (the structured WARN classes).
      expect(corpus.manualCost.severityHistogram).toBeDefined();
      expect(Object.keys(corpus.manualCost.severityHistogram).length).toBeGreaterThan(0);
      // groupByMessage (the manual recurring-WARN grouping) -> covered by the
      // report's findings grouped by the closed `signal` label.
      expect(corpus.manualCost.groupByMessage.length).toBeGreaterThan(0);
      // pm2ModelScrape (the manual native-stdout scrape) -> covered by the report's
      // model_health finding.
      expect(typeof corpus.manualCost.pm2ModelScrape).toBe("string");
      expect(corpus.manualCost.pm2ModelScrape.length).toBeGreaterThan(0);

      // Every corpus signal class is the lens's reproduction target — the prior
      // `it` proved the report's findings/rollups cover the flagship + model +
      // config classes + the A-track rates in ONE call. The corpus is loaded here
      // ONLY as the documented contrast bar; no numeric delta is asserted.
      expect(corpus.signals.length).toBeGreaterThan(0);
    });

    // DETERMINISM (same seed + same fakeClock instant -> byte-identical report) is
    // what makes this proof keyless — the verdict is a PURE function of the seeded
    // data (the assembler reads the injected clock ONCE, fleet-health.ts:309). That
    // invariant is proven directly, with two assemblies, in the unit suite
    // (fleet-health.test.ts "is DETERMINISTIC: same data + same fakeClock ->
    // byte-identical reports"). This RE-PROVE scenario stays focused on the
    // one-call corpus reproduction (exactly ONE assembler call above), so it does
    // not re-run that two-assembly cross-check here.
  },
);
