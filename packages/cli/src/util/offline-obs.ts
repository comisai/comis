// SPDX-License-Identifier: Apache-2.0
// @allow-throw: CLI entry point — errors propagate to Commander error handler.
/**
 * OFFLINE assembly for `comis explain` and `comis system-health`.
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
import {
  parseConfigPaths,
  safePath,
  systemGetEnv,
  systemNowDate,
  systemNowMs,
} from "@comis/core";
import type { ClockPort, SystemHealthReport, IncidentReport } from "@comis/core";
import type { SessionMessagesFilter, SessionMessagesResult } from "@comis/daemon";
import type { CostBucketFilter, QuarterHourBucket } from "@comis/memory";

// Re-exported so command modules consume the extractor's types from THIS seam —
// keeping `util/offline-obs.ts` the single @comis/daemon import site in cli/src.
export type {
  SessionMessagesFilter,
  SessionMessagesResult,
  ExtractedChannelMessage,
  SessionMessagesCoverage,
} from "@comis/daemon";
import { resolveTrajectoryPointerFilePath } from "@comis/observability";
import type { AuditSummary } from "../support-bundle/types.js";
import { resolveDoctorConfig } from "../doctor/config-resolve.js";
import {
  createObservabilityStore,
  openSqliteDatabase,
  type ObservabilityStore,
} from "./offline-secrets-store.js";

/**
 * The CLI's offline data dir. Honors `COMIS_DATA_DIR` (the daemon's + the wizard's
 * data-dir env, `04-oauth-helpers.ts`), falling back to `<homedir>/.comis`. Without the
 * env check, `comis explain --offline` / `comis system-health --offline` read the INVOKING user's
 * home — so running the CLI as a different user than the daemon (or against a non-default
 * `COMIS_DATA_DIR` install) silently reads an empty dir and reports a false "nothing
 * happened" for a session that succeeded.
 */
export function resolveOfflineDataDir(): string {
  return systemGetEnv("COMIS_DATA_DIR") ?? safePath(os.homedir(), ".comis");
}

/** Resolve the trajectory relocation root from the same effective config layers as startup. */
export function resolveOfflineTrajectoryDir(dataDir: string): string | undefined {
  const configuredPaths = parseConfigPaths(systemGetEnv("COMIS_CONFIG_PATHS"));
  const configPaths = configuredPaths.length > 0
    ? configuredPaths
    : [
        safePath(dataDir, "config.yaml"),
        safePath(dataDir, "config.local.yaml"),
        safePath("/etc", "comis", "config.yaml"),
        safePath("/etc", "comis", "config.local.yaml"),
      ].filter((candidate) => fs.existsSync(candidate));
  const resolution = resolveDoctorConfig(configPaths, { defaultDataDir: dataDir });
  const configuredDir = resolution.config?.diagnostics.trajectory.dir ??
    resolution.config?.observability.trajectory.dirOverride;
  if (configuredDir !== undefined && configuredDir.length > 0) return configuredDir;
  const envDir = systemGetEnv("COMIS_TRAJECTORY_DIR")?.trim();
  return envDir === undefined || envDir.length === 0 ? undefined : envDir;
}

/** Sanctioned system clock for the system window (cli has no infra edge). */
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

/** Assemble a SystemHealthReport from the local data dir without a daemon. */
export async function assembleSystemHealthReportOffline(
  dataDir: string,
  sinceHours: number,
): Promise<SystemHealthReport> {
  const { assembleSystemHealthReport } = await loadDaemonAssemblers();
  const { store, close } = openObsStoreIfPresent(dataDir);
  try {
    return await assembleSystemHealthReport(
      // The offline CLI is daemon-less — there is no
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

/**
 * Extract inbound channel messages from the LOCAL session logs without a
 * daemon — the `comis messages` data source. CONTENT-BEARING by design
 * (message bodies are the payload), so it deliberately has NO RPC surface:
 * the obs network surfaces stay digest-only/content-free, and this read adds
 * no privilege over the files the local operator already owns (the same
 * offline-only posture as `comis cost export`).
 */
export async function extractSessionMessagesOffline(
  dataDir: string,
  filter: SessionMessagesFilter,
): Promise<SessionMessagesResult> {
  const { extractSessionMessages } = await loadDaemonAssemblers();
  const trajectoryDir = resolveOfflineTrajectoryDir(dataDir);
  return extractSessionMessages(
    dataDir,
    filter,
    trajectoryDir === undefined ? {} : { trajectoryDir },
  );
}

/**
 * Resolve a formatted sessionKey to its REAL session `.jsonl` path offline,
 * through the single bounded `@comis/daemon` seam.
 *
 * The daemon owns the authoritative pointer-discipline resolver
 * (`resolveSessionFilePath` — the `sessionKeyToPath` fast path plus the on-disk
 * pointer-`sessionId` fallback for lossy webhook keys). The CLI must NOT rebuild
 * it: `sessionKeyToPath` lives in the agent package, which cli/src is forbidden
 * to import (the arch gate), and a hand-built `<dataDir>/sessions/<id>` path never
 * existed on disk (it shipped two broken readers). This thin wrapper reaches the
 * daemon export via the same LAZY seam the assemblers use and passes the miss
 * through as `undefined` — the resolver returns a path ONLY when the session
 * artifacts exist, so a caller can warn instead of stat-failing a fabricated path.
 *
 * @param dataDir - the `~/.comis` root.
 * @param sessionKey - a formatted agent-scoped SessionKey.
 * @returns the absolute session `.jsonl` path, or `undefined` on a genuine miss.
 */
export async function resolveSessionFileOffline(
  dataDir: string,
  sessionKey: string,
): Promise<string | undefined> {
  const { resolveSessionFilePath } = await loadDaemonAssemblers();
  return resolveSessionFilePath(dataDir, sessionKey);
}

/** Options for the offline cost-export read. */
export interface CostExportOptions extends CostBucketFilter {
  /** Lower time bound (inclusive), epoch ms. Absent → all time. */
  sinceMs?: number;
  /** Bucket width: hourly (the default) or quarter-hour (15-min). */
  granularity: "hourly" | "quarter-hour";
}

/**
 * Read the corrected-cost buckets (with the pricing-coverage column)
 * from the LOCAL ~/.comis observability store, WITHOUT contacting the daemon —
 * the telemetry lives on disk, so an export must not require a live gateway. This
 * is the `comis cost export` data source (there is no admin aggregate RPC for the
 * quarter-hour buckets yet; a dedicated export RPC would be a separate addition,
 * not invented here).
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

/**
 * The store's own hard row ceiling for an audit query — the read is bounded to
 * this regardless of audit volume (the store clamps `limit` to it). Kept as a
 * literal here: `@comis/memory` keeps `MAX_AUDIT_QUERY_LIMIT` internal to its
 * observability-store barrel, and a re-declared constant that tracks it is a
 * smaller surface than re-exporting store internals to the CLI.
 */
const AUDIT_SUMMARY_QUERY_LIMIT = 1_000;

/**
 * Read the window-scoped audit `{ total, byKind }` from the LOCAL observability
 * store — the offline support-bundle audit read — WITHOUT the daemon.
 *
 * The audit trail must be diagnosable when the daemon is DOWN (when it is most
 * needed), so this reads the offline store directly (`openObsStoreIfPresent`),
 * NOT the daemon-required `obs.audit.query` RPC. Aggregation is WINDOW-scoped
 * across all sessions — every in-window row is counted by its closed `kind`
 * label with NO traceId narrowing (unlike the per-session `IncidentReport.audit`,
 * which filters to one session's traceId). Content-free: only the `kind` label
 * is read, never an `action`/`actor`/`refs` value.
 *
 * `total` is bounded by the store's clamped row ceiling; when the read fills a
 * full page the count is a lower bound, surfaced via `capped`. A missing or
 * unreadable `memory.db` soft-fails to `undefined` so the caller emits an honest
 * manifest warning instead of a fabricated zero.
 *
 * @param dataDir - the `~/.comis` root.
 * @param sinceHours - the diagnostic window in hours.
 * @param nowMs - the caller-stamped generation instant (epoch ms).
 * @returns the `{ schemaVersion, total, byKind, capped? }` digest, or `undefined`
 *   when the store is absent/unreadable.
 */
export function readAuditSummaryOffline(
  dataDir: string,
  sinceHours: number,
  nowMs: number,
): AuditSummary | undefined {
  const { store, close } = openObsStoreIfPresent(dataDir);
  try {
    if (store === undefined) return undefined;
    const sinceMs = nowMs - sinceHours * 3_600_000;
    const rows = store.queryAuditEvents({ since: sinceMs, limit: AUDIT_SUMMARY_QUERY_LIMIT });
    const byKind: Record<string, number> = {};
    for (const row of rows) {
      byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
    }
    return {
      schemaVersion: 1,
      total: rows.length,
      byKind,
      ...(rows.length === AUDIT_SUMMARY_QUERY_LIMIT ? { capped: true } : {}),
    };
  } finally {
    close();
  }
}

/** The `_session-metadata.json` companion suffix the session manager writes. */
const SESSION_METADATA_SUFFIX = "_session-metadata.json";

/**
 * Runaway backstop on the worst-session scan: at most this many rollups are read.
 * A tree with more sessions than this loses only the overflow from the ranking.
 */
const MAX_SESSION_SCAN = 5_000;

/**
 * Extract the pointer's verbatim `sessionId` (the authoritative key record on
 * disk) from a `<sessionFile>.trajectory-path.json` pointer. Soft-fails to
 * `undefined` on a missing/corrupt pointer or a failed fence-check.
 */
function readPointerSessionId(pointerPath: string): string | undefined {
  let pointer: Record<string, unknown>;
  try {
    pointer = JSON.parse(fs.readFileSync(pointerPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return undefined; // Missing/corrupt pointer — soft-fail.
  }
  const sessionId = pointer["sessionId"];
  if (
    pointer["traceSchema"] === "comis-trajectory-pointer" &&
    typeof sessionId === "string" &&
    sessionId.length > 0
  ) {
    return sessionId;
  }
  return undefined;
}

/**
 * Read the `sessionEnd.{ degraded, costUsd }` rollup from a
 * `_session-metadata.json` companion. Soft-fails to `undefined` on a
 * missing/corrupt file or an absent `sessionEnd`; a missing `costUsd` reads as 0.
 */
function readSessionEndRollup(
  metadataPath: string,
): { degraded: boolean; costUsd: number } | undefined {
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return undefined; // Missing/corrupt rollup — soft-fail.
  }
  const sessionEnd = meta["sessionEnd"];
  if (sessionEnd === null || typeof sessionEnd !== "object") return undefined;
  const end = sessionEnd as Record<string, unknown>;
  const costUsd = typeof end["costUsd"] === "number" ? end["costUsd"] : 0;
  return { degraded: end["degraded"] === true, costUsd };
}

/** True when `candidate` ranks worse than `best`: degraded first, then costUsd desc. */
function rollupRanksWorse(
  candidate: { degraded: boolean; costUsd: number },
  best: { degraded: boolean; costUsd: number },
): boolean {
  if (candidate.degraded !== best.degraded) return candidate.degraded;
  return candidate.costUsd > best.costUsd;
}

/**
 * The CLI stopgap for a worst-session hint: rank the LOCAL session rollups
 * CLI-side and return the worst one's key.
 *
 * `SystemHealthReport` exposes no worst sessionKey today (only
 * `autonomy.worstRootRunId`); an authoritative `worstSessions` field is a
 * deferred daemon-side follow-on. Until then this bounded, tenant/channel-scoped
 * scan reads each session's `_session-metadata.json` rollup
 * (`sessionEnd.{ degraded, costUsd }`) and its co-located pointer's `sessionId`
 * (the verbatim key), ranking degraded sessions first and then by `costUsd`
 * descending. Every read soft-fails; the scan is hard-capped so a large tree
 * cannot unbound it. All path composition goes through `safePath`.
 *
 * @param dataDir - the `~/.comis` root.
 * @returns the worst session's formatted key, or `undefined` over an empty or
 *   unreadable sessions tree.
 */
export function suggestWorstSessionOffline(dataDir: string): string | undefined {
  const sessionsBase = safePath(dataDir, "workspace", "sessions");
  let tenants: fs.Dirent[];
  try {
    tenants = fs.readdirSync(sessionsBase, { withFileTypes: true });
  } catch {
    return undefined; // No sessions tree — soft-fail.
  }

  let best: { sessionKey: string; degraded: boolean; costUsd: number } | undefined;
  let scanned = 0;
  for (const tenant of tenants) {
    if (!tenant.isDirectory()) continue;
    const tenantDir = safePath(sessionsBase, tenant.name);
    let channels: fs.Dirent[];
    try {
      channels = fs.readdirSync(tenantDir, { withFileTypes: true });
    } catch {
      continue; // Unreadable tenant dir — skip.
    }
    for (const channel of channels) {
      if (!channel.isDirectory()) continue;
      const channelDir = safePath(tenantDir, channel.name);
      let entries: string[];
      try {
        entries = fs.readdirSync(channelDir);
      } catch {
        continue; // Unreadable channel dir — skip.
      }
      for (const name of entries) {
        if (!name.endsWith(SESSION_METADATA_SUFFIX)) continue;
        if (scanned >= MAX_SESSION_SCAN) return best?.sessionKey; // Runaway backstop.
        scanned++;
        // Session file basename: `<base>_session-metadata.json` → `<base>.jsonl`.
        const base = name.slice(0, -SESSION_METADATA_SUFFIX.length);
        const sessionFile = safePath(channelDir, `${base}.jsonl`);
        const sessionKey = readPointerSessionId(resolveTrajectoryPointerFilePath(sessionFile));
        if (sessionKey === undefined) continue; // No authoritative key on disk.
        const rollup = readSessionEndRollup(safePath(channelDir, name));
        if (rollup === undefined) continue;
        const candidate = { sessionKey, degraded: rollup.degraded, costUsd: rollup.costUsd };
        if (best === undefined || rollupRanksWorse(candidate, best)) best = candidate;
      }
    }
  }
  return best?.sessionKey;
}
