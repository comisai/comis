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
import { safePath, systemNowDate, systemNowMs } from "@comis/core";
import type { ClockPort, FleetHealthReport, IncidentReport } from "@comis/core";
import {
  assembleFleetHealthReport,
  assembleIncidentReportFromSources,
  makeRealReader,
} from "@comis/daemon";
import {
  createObservabilityStore,
  openSqliteDatabase,
  type ObservabilityStore,
} from "./offline-secrets-store.js";

/** The CLI's offline data dir — same resolution the offline secrets path uses. */
export function resolveOfflineDataDir(): string {
  return safePath(os.homedir(), ".comis");
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
  try {
    // No-op initSchema: the offline path only ever opens an EXISTING db; the
    // daemon owns schema creation. Missing obs tables surface as query errors
    // inside the assembler's soft-fail reads, not as a write here.
    const db = openSqliteDatabase({ dbPath, initSchema: () => undefined });
    return {
      store: createObservabilityStore(db),
      close: () => {
        try {
          db.close();
        } catch {
          // close() after the assembler finished — a double-close is harmless.
        }
      },
    };
  } catch {
    // Unreadable store (permissions, corruption) — degrade to file-only sources.
    return { store: undefined, close: () => undefined };
  }
}

/** Assemble an IncidentReport from the local data dir without a daemon. */
export async function assembleIncidentReportOffline(
  dataDir: string,
  params: { sessionKey?: string; traceId?: string; depth?: "summary" | "full" },
): Promise<IncidentReport> {
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
  const { store, close } = openObsStoreIfPresent(dataDir);
  try {
    return await assembleFleetHealthReport(
      { obsStore: store, dataDir, clock: systemClock },
      sinceHours,
    );
  } finally {
    close();
  }
}
