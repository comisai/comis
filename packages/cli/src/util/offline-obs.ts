// SPDX-License-Identifier: Apache-2.0
// @allow-throw: CLI entry point — errors propagate to Commander error handler.
/**
 * W14 (obs-llm-troubleshooting): OFFLINE assembly for `comis explain` and
 * `comis fleet`.
 *
 * The session telemetry these commands read lives on LOCAL disk
 * (`<dataDir>/workspace/sessions/...`, `<dataDir>/logs/...`, `memory.db`), so a
 * post-mortem must not require a live gateway. When the daemon is unreachable
 * (or `--offline` is passed) the commands assemble the report directly from
 * disk by reusing the daemon's exported PURE assemblers — the same code the
 * RPC handlers run, so offline output matches the RPC output byte-for-byte
 * for the same inputs.
 *
 * This file is the single bounded `@comis/cli → @comis/daemon` import site
 * (mirror of the L11 `offline-secrets-store.ts` seam for `@comis/memory`); the
 * architecture-graph test documents the edge.
 *
 * `memory.db` is opened in WAL mode (concurrent with a live daemon) and ONLY
 * when the file already exists — the offline read path never creates it. A
 * missing/unreadable store soft-fails to `undefined`: the assemblers' coverage
 * blocks then report the gap honestly instead of pretending a clean zero.
 *
 * @module
 */

import * as fs from "node:fs";
import * as os from "node:os";
import { safePath, systemGetEnv, systemNowDate, systemNowMs } from "@comis/core";
import type { ClockPort, FleetHealthReport, IncidentReport } from "@comis/core";
import type { CostBucketFilter, QuarterHourBucket } from "@comis/memory";
import {
  createObservabilityStore,
  openSqliteDatabase,
  type ObservabilityStore,
} from "./offline-secrets-store.js";

/**
 * The CLI's offline data dir. Honors `COMIS_DATA_DIR` (the daemon's + the wizard's
 * data-dir env, `04-oauth-helpers.ts`), falling back to `<homedir>/.comis`. Without the
 * env check, `comis explain --offline` / `comis fleet --offline` read the INVOKING user's
 * home — so running the CLI as a different user than the daemon (or against a non-default
 * `COMIS_DATA_DIR` install) silently reads an empty dir and reports a false "nothing
 * happened" for a session that succeeded (webhook-claude-cli-tdd-20260630-rerun).
 */
export function resolveOfflineDataDir(): string {
  return systemGetEnv("COMIS_DATA_DIR") ?? safePath(os.homedir(), ".comis");
}

/** Sanctioned system clock for the fleet window (cli has no infra edge). */
const systemClock: ClockPort = { now: () => systemNowMs(), nowDate: () => systemNowDate() };

/**
 * Open the local observability store when `memory.db` already exists.
 * Soft-fails to an absent store — the assemblers degrade with honest coverage.
 */
function openObsStoreIfPresent(dataDir: string): {
  store: ObservabilityStore | undefined;
  close: () => void;
} {
  const dbPath = safePath(dataDir, "memory.db");
  if (!fs.existsSync(dbPath)) return { store: undefined, close: () => undefined };
  // No-op initSchema: the offline path only ever opens an EXISTING db; the
  // daemon owns schema creation. A db whose obs tables are missing (observed
  // live after an operator reset recreated memory.db) throws at
  // createObservabilityStore's eager statement-prepare — close the handle and
  // degrade to file-only sources (the report's coverage block says so honestly).
  let db: ReturnType<typeof openSqliteDatabase> | undefined;
  try {
    db = openSqliteDatabase({ dbPath, initSchema: () => undefined });
    const store = createObservabilityStore(db);
    const opened = db;
    return {
      store,
      close: () => {
        try {
          opened.close();
        } catch {
          // close() after the assembler finished — a double-close is harmless.
        }
      },
    };
  } catch {
    try {
      db?.close();
    } catch {
      // The open itself failed — nothing to release.
    }
    return { store: undefined, close: () => undefined };
  }
}

/**
 * LAZY daemon import: @comis/daemon's index pulls the whole runtime graph
 * (channels, skills, orchestrator, …). A static import would load it on EVERY
 * CLI start just to register the commands — the offline path pays the cost
 * only when it actually runs. (Still the single L18 import site; the arch
 * test scans dynamic import specifiers too.)
 */
async function loadDaemonAssemblers(): Promise<typeof import("@comis/daemon")> {
  return import("@comis/daemon");
}

/** Assemble an IncidentReport from the local data dir without a daemon. */
export async function assembleIncidentReportOffline(
  dataDir: string,
  params: { sessionKey?: string; traceId?: string; rootRunId?: string; depth?: "summary" | "full" },
): Promise<IncidentReport> {
  const { assembleIncidentReportFromSources, makeRealReader } = await loadDaemonAssemblers();
  const { store, close } = openObsStoreIfPresent(dataDir);
  try {
    return await assembleIncidentReportFromSources(makeRealReader(dataDir, store), dataDir, params);
  } finally {
    close();
  }
}

/** Assemble a FleetHealthReport from the local data dir without a daemon. */
export async function assembleFleetHealthReportOffline(
  dataDir: string,
  sinceHours: number,
): Promise<FleetHealthReport> {
  const { assembleFleetHealthReport } = await loadDaemonAssemblers();
  const { store, close } = openObsStoreIfPresent(dataDir);
  try {
    return await assembleFleetHealthReport(
      // FLEET-01/02/04 (Phase 220-03): the offline CLI is daemon-less — there is no
      // durable-run store edge here, so pass `durableRuns: undefined` explicitly. The
      // assembler soft-fails and the autonomy block is honestly OMITTED (the documented
      // coverage degradation, NOT a divergence from the RPC/MCP surfaces, which DO wire it).
      { obsStore: store, dataDir, clock: systemClock, durableRuns: undefined },
      sinceHours,
    );
  } finally {
    close();
  }
}

/** Options for the offline cost-export read (COST-03). */
export interface CostExportOptions extends CostBucketFilter {
  /** Lower time bound (inclusive), epoch ms. Absent → all time. */
  sinceMs?: number;
  /** Bucket width: hourly (the default) or quarter-hour (15-min). */
  granularity: "hourly" | "quarter-hour";
}

/**
 * COST-03: read the corrected-cost buckets (with the E1 pricing-coverage column)
 * from the LOCAL ~/.comis observability store, WITHOUT contacting the daemon —
 * the telemetry lives on disk, so an export must not require a live gateway. This
 * is the `comis cost export` data source (there is no admin aggregate RPC for the
 * quarter-hour buckets yet; a dedicated export RPC is 179-04's, not invented here).
 *
 * The filter (agent/provider/model) + `sinceMs` are passed straight to the store's
 * `aggregateHourlyCost`/`aggregateQuarterHourly`, which bind them as parameters.
 * A missing/unreadable store soft-fails to `[]` (honest degradation — an empty
 * export, never a crash or a fabricated zero-cost bucket).
 */
export async function readCostExportOffline(
  dataDir: string,
  options: CostExportOptions,
): Promise<QuarterHourBucket[]> {
  const { store, close } = openObsStoreIfPresent(dataDir);
  try {
    if (store === undefined) return [];
    const filter: CostBucketFilter = {
      agent: options.agent,
      provider: options.provider,
      model: options.model,
    };
    return options.granularity === "quarter-hour"
      ? store.aggregateQuarterHourly(options.sinceMs, filter)
      : store.aggregateHourlyCost(options.sinceMs, filter);
  } finally {
    close();
  }
}
