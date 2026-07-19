// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts.
/**
 * `IncidentSourceReader` — the four bounded source readers behind one DI seam.
 *
 * `obs.explain` assembles an IncidentReport from four telemetry sources. They
 * sit behind ONE interface so production reads real files while tests inject
 * fixture records (the fixture-injection seam):
 *
 *   1. readSessionRecords    — the per-session trajectory JSONL. The session
 *      lives in the REAL production layout the pi-agent session manager writes:
 *      `<workspaceDir>/sessions/<tenantId>/<channelId>/<file>.jsonl` (resolved
 *      by `sessionKeyToPath`, the authoritative SessionKey→path mapper). The
 *      trajectory is then located the canonical way — read the
 *      `<sessionFile>.trajectory-path.json` pointer and use its `runtimeFile`,
 *      else fall back to the co-located `<sessionFile>.trajectory.jsonl` (the
 *      same resolution `bundle-exporter.ts:readRuntimeTrajectory` performs).
 *      Returns ALL parsed lines — log shape AND event shape — WITHOUT the
 *      production bundle reader's `traceSchema === "comis-trajectory"` envelope
 *      filter, so the frozen log-shape fixtures pass through to
 *      `toIncidentSignals`.
 *   2. readCacheTraceRecords — `<dataDir>/logs/cache-trace.jsonl`, filtered to
 *      the resolved session.
 *   3. readSessionMetadata   — the `<sessionFile>`-with-`.jsonl`→`_session-metadata.json`
 *      companion next to the session JSONL (the F1 PRIMARY rollup source, the
 *      same naming `comis-session-manager.ts` writes).
 *   4. readDiagnosticsRollup — `obsStore.queryDiagnostics({category, limit:1000})`
 *      then a SESSION-SCOPED filter by `row.sessionKey` (the F2 fallback).
 *      `DiagnosticQueryParams` has NO sessionKey filter, so `{limit:1}` would
 *      return the most-recent row across ALL sessions — the reader queries a
 *      window and filters AFTER. The window is a recency horizon: see
 *      `DIAGNOSTICS_QUERY_LIMIT` for why 1000 and the residual bound.
 *
 * Why the workspace base (not `<dataDir>/sessions`): the writer's source of
 * truth is `<workspaceDir>/sessions/...` (`setup-agents-runtime.ts`:
 * `sessionBaseDir = safePath(workspaceDir, "sessions")`, with the default-agent
 * workspace = `<dataDir>/workspace` per `resolveWorkspaceDir`). The earlier flat
 * `<dataDir>/sessions/<sessionId>.*` convention NEVER existed on disk, so the
 * reader returned nothing for every real session — fixed here to match the
 * writer. `sessionKeyToPath` runs every SessionKey field through `safePath`, so
 * a traversal-bearing key cannot escape `<workspaceDir>/sessions`. All reads
 * soft-fail (missing/corrupt file → `[]` / `null`, never throws).
 *
 * @module
 */

import * as fs from "node:fs";
import * as os from "node:os";
import { parseFormattedSessionKey, safePath } from "@comis/core";
import { resolveTrajectoryPointerFilePath } from "@comis/observability";
import type { ObservabilityStore } from "@comis/memory";

/** Per-read line cap (mirrors observability's MAX_TRAJECTORY_RUNTIME_EVENTS
 * intent at a report-appropriate scale — a post-mortem never needs more). */
const MAX_RECORDS = 5_000;

/**
 * Window queried from obs_diagnostics before the session-scoped filter.
 *
 * `DiagnosticQueryParams` has NO sessionKey predicate, so the reader queries a
 * window (ordered `timestamp DESC`) and filters by `row.sessionKey` AFTER. The
 * window is therefore a RECENCY HORIZON: a target session whose `session_summary`
 * row sits behind more than this many NEWER session-summary rows falls outside
 * the window and the F2 fallback returns null (the report then loses the
 * cost/tokens/degraded fields only F2 supplies, when F1 metadata is also absent).
 *
 * 50 was too small — on a busy daemon a target ~an hour old could already be
 * behind 50 newer session ends. Widened to 1000 (well under the reader's
 * MAX_RECORDS=5000) so the post-mortem reaches realistically-old sessions while
 * keeping the post-filter cheap. The residual horizon is documented, not hidden:
 * the true fix is a SQL sessionKey predicate on DiagnosticQueryParams (out of
 * scope here — it lives in @comis/memory); until then this is the bound.
 */
const DIAGNOSTICS_QUERY_LIMIT = 1000;

/**
 * Bounded window queried from `obs_audit_events` (tenant-scoped) before the
 * caller's traceId filter. `AuditQueryParams` has no traceId predicate,
 * so the reader scopes by tenant + this cap and the assembler narrows to the
 * session's traceId AFTER — the same recency-horizon pattern as the diagnostics
 * rollup. The store ALSO clamps `limit` to its own hard ceiling, so this
 * is the read-side bound (reports stay bounded).
 */
const AUDIT_QUERY_LIMIT = 1000;

/**
 * The four bounded source readers `obs.explain` consumes. One DI seam: the
 * real implementation reads files; tests inject fixture records.
 */
export interface IncidentSourceReader {
  readSessionRecords(sessionKey: string): Promise<Array<Record<string, unknown>>>;
  readCacheTraceRecords(sessionKey: string): Promise<Array<Record<string, unknown>>>;
  readSessionMetadata(sessionKey: string): Promise<Record<string, unknown> | null>;
  readDiagnosticsRollup(sessionKey: string): Promise<Record<string, unknown> | null>;
  /**
   * The `obs_audit_events` rows for this session's tenant
   * (the audit persists via SQLite, NOT a trajectory record — so the
   * `audit?` IncidentReport section is sourced HERE, not from the trajectory
   * stream). Tenant-scoped via `AuditQueryParams.tenant` + a bounded window; the
   * caller (`assembleIncidentReportFromSources`) filters by the resolved
   * `traceId` AFTER (AuditQueryParams has no traceId predicate). Returns the
   * content-free rows (already scrubbed at write); soft-fails to `[]`.
   *
   * OPTIONAL: the production `makeRealReader` always implements it; a fixture
   * reader that omits it simply produces no `audit?` section (the section is
   * additive + presence-conditional — the same posture as a session with no
   * audit events). Existing audit-less fixture readers therefore need no change.
   */
  readAuditEvents?(sessionKey: string): Promise<Array<Record<string, unknown>>>;
  /**
   * The closest REAL session keys to `requestedKey`, for the "did you mean …?"
   * breadcrumb the assembler attaches when the request resolved ZERO records (a
   * lossy/partial key). Scans the on-disk trajectory pointers + ranks. OPTIONAL:
   * the production `makeRealReader` implements it; a fixture reader that omits it
   * simply produces no `candidateSessionKeys` (additive — the same posture as a
   * key that resolved records). Soft-fails to `[]`.
   */
  listCandidateSessionKeys?(requestedKey: string): Promise<string[]>;
}

/** Default data directory (lazy). Mirrors obs-trace.ts. */
function defaultDataDir(): string {
  return safePath(os.homedir(), ".comis");
}

/**
 * The `<sessionFile>.trajectory-path.json` pointer suffix the trajectory recorder
 * writes (`pointer-file.ts`). The pointer's `sessionId` is the VERBATIM formatted
 * SessionKey the writer used — the only authoritative key→file record on disk, and
 * the basis of the lossy-key fallback below.
 */
const TRAJECTORY_POINTER_SUFFIX = ".trajectory-path.json";

/**
 * Runaway backstop on the pointer-`sessionId` fallback scan: at most this many
 * pointer files are read per resolution. A tenant with more sessions than this
 * loses only the fallback for the overflow — never the fast path (the common
 * case), which never enters the scan.
 */
const MAX_POINTER_SCAN = 5_000;

/**
 * True when the fast-path session file resolves to a real session on disk — the
 * `.jsonl` itself, its trajectory pointer, or its `_session-metadata.json`
 * companion exists. A clean round-trip (telegram + any single-colon-field key)
 * hits this and skips the fallback scan entirely.
 */
function sessionArtifactsExist(sessionFile: string): boolean {
  return (
    fs.existsSync(sessionFile) ||
    fs.existsSync(`${sessionFile}${TRAJECTORY_POINTER_SUFFIX}`) ||
    fs.existsSync(resolveMetadataFile(sessionFile))
  );
}

/**
 * Fallback resolution for a display session label whose canonical parser
 * round-trip is LOSSY. A colon-bearing userId — webhook sessions are created with
 * `userId:"hook:devtask:<id>"`, `channelId:"webhook"` — is greedily mis-split into
 * channelId by the parser (the inverse of the writer's intent), so `sessionKeyToPath`
 * computes a path that does not exist and the readers report a false "nothing
 * happened" for a session that succeeded.
 *
 * The authoritative key→file mapping lives ONLY on disk: each session's
 * `<file>.jsonl.trajectory-path.json` pointer carries the verbatim formatted key in
 * `sessionId`. Scan the tenant's session dirs for the pointer whose `sessionId`
 * EXACTLY equals the requested key and return its session `.jsonl` (the pointer path
 * minus the suffix). Bounded: tenant-scoped (the tenant dir is the first colon
 * segment — never mis-split), depth 2 (tenant/channel/<pointer>), capped at
 * MAX_POINTER_SCAN. The untrusted sessionKey is used ONLY for the `===` comparison,
 * never for path construction (the scanned names come from `readdirSync` of the
 * contained tenant dir). Returns `undefined` on no match → the caller keeps the
 * fast-path miss behavior (soft-fail to `[]`/`null`).
 */
function findSessionFileByPointerSessionId(
  sessionKey: string,
  sessionsBase: string,
): string | undefined {
  let tenants: fs.Dirent[];
  try {
    tenants = fs.readdirSync(sessionsBase, { withFileTypes: true });
  } catch {
    return undefined;
  }
  let scanned = 0;
  for (const tenant of tenants) {
    if (!tenant.isDirectory()) continue;
    const tenantDir = safePath(sessionsBase, tenant.name);
    let channels: fs.Dirent[];
    try {
      channels = fs.readdirSync(tenantDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const channel of channels) {
      if (!channel.isDirectory()) continue;
      const channelDir = safePath(tenantDir, channel.name);
      let entries: string[];
      try {
        entries = fs.readdirSync(channelDir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!name.endsWith(TRAJECTORY_POINTER_SUFFIX)) continue;
        if (scanned >= MAX_POINTER_SCAN) return undefined;
        scanned++;
        const pointerPath = safePath(channelDir, name);
        let pointer: Record<string, unknown>;
        try {
          pointer = JSON.parse(fs.readFileSync(pointerPath, "utf-8")) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (
          pointer["traceSchema"] === "comis-trajectory-pointer"
          && pointer["sessionId"] === sessionKey
        ) {
          return pointerPath.slice(0, -TRAJECTORY_POINTER_SUFFIX.length);
        }
      }
    }
  }
  return undefined;
}

/**
 * Resolve the absolute `.jsonl` session-file path for a formatted sessionKey
 * under the workspace sessions base, via the on-disk pointer scan
 * ({@link findSessionFileByPointerSessionId}): each session's
 * `<file>.jsonl.trajectory-path.json` pointer carries the verbatim formatted
 * key in `sessionId`, and the scan returns the session `.jsonl` whose pointer
 * matches EXACTLY. No display-label parsing happens here — the on-disk pointer
 * is the authoritative key→file mapping.
 *
 * Returns `undefined` on a scan miss (the reader then soft-fails to
 * `[]`/`null`). Traversal-safe: the untrusted key is used only for the `===`
 * comparison, never for path construction.
 */
function resolveSessionFile(sessionKey: string, sessionsBase: string): string | undefined {
  return findSessionFileByPointerSessionId(sessionKey, sessionsBase);
}

/**
 * Public sessionKey → real session `.jsonl` resolver — the authoritative
 * pointer-discipline mapping, shared by the daemon `/export-trajectory` closure
 * and the CLI support-bundle seam.
 *
 * Mirrors `makeRealReader`'s workspace base
 * (`<dataDir>/workspace/sessions`, NOT a flat `<dataDir>/sessions`) and
 * delegates to the private `resolveSessionFile` (fast path via
 * `sessionKeyToPath`, then the on-disk pointer-`sessionId` fallback for
 * lossy keys). Every path component runs through `safePath`, so a
 * traversal-bearing key cannot escape the sessions base.
 *
 * The private resolver soft-fails to the fast path even on a miss (so
 * `makeRealReader` can read an empty `[]`); this wrapper converts that into an
 * HONEST `undefined` — it returns a path ONLY when the session artifacts (the
 * `.jsonl`, its pointer, or its `_session-metadata.json`) exist on disk. A
 * caller (the export closure) can then warn instead of stat-failing on a
 * fabricated path.
 *
 * @param dataDir - the `~/.comis` root (empty → the default `~/.comis`).
 * @param sessionKey - a formatted SessionKey (`tenant:user:channel[:peer:...]`).
 * @returns the absolute session `.jsonl` path, or `undefined` on a genuine miss
 *   (no artifacts) or an unparseable key.
 */
export function resolveSessionFilePath(dataDir: string, sessionKey: string): string | undefined {
  const base = dataDir.length > 0 ? dataDir : defaultDataDir();
  const sessionsBase = safePath(base, "workspace", "sessions");
  const resolved = resolveSessionFile(sessionKey, sessionsBase);
  // Convert the private resolver's soft-fail (fast path returned even on a miss)
  // into an honest undefined — a path is returned ONLY when it exists on disk.
  if (resolved === undefined || !sessionArtifactsExist(resolved)) return undefined;
  return resolved;
}

/** Cap on suggested candidate keys (a "did you mean …?" list, not a dump). */
const MAX_CANDIDATE_KEYS = 8;

/**
 * PURE ranker: given a requested (possibly lossy/partial) session key and the set
 * of REAL formatted keys on disk, return the closest matches most-relevant-first.
 * Score = how many request segments appear (case-insensitive substring) in the
 * candidate; ties break toward the shorter (closer) key then lexicographic.
 * Zero-overlap candidates are dropped (never a false suggestion), and an
 * empty/separators-only request yields `[]`. The request is split on every
 * separator an operator or the kit actually types — `:` (the formatted key),
 * `~` (the trajectory-filename form `<user>~peer~<peer>` that `drive.mjs` and the
 * ground-truth read-order surface), and `/` — so a tilde-form or chatId ref
 * tokenizes into matchable segments instead of one no-overlap blob (the recurring
 * live friction the candidate list exists to end). No I/O, no globals — same
 * inputs, same order forever.
 */
export function rankCandidateSessionKeys(
  requested: string,
  realKeys: readonly string[],
  limit: number = MAX_CANDIDATE_KEYS,
): string[] {
  const reqTokens = requested.split(/[:~/]/).map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0);
  if (reqTokens.length === 0) return [];
  const seen = new Set<string>();
  return realKeys
    .map((key) => {
      const lower = key.toLowerCase();
      const score = reqTokens.reduce((n, t) => n + (lower.includes(t) ? 1 : 0), 0);
      return { key, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.key.length - b.key.length || a.key.localeCompare(b.key))
    .filter((s) => (seen.has(s.key) ? false : (seen.add(s.key), true)))
    .slice(0, limit)
    .map((s) => s.key);
}

/**
 * Scan the workspace sessions base for the formatted keys of every real session
 * (from the `<file>.jsonl.trajectory-path.json` pointers, the authoritative
 * key→file record) and rank them against `requested`. Scans ALL tenant dirs (a
 * lossy `channel:chatId` key's first segment is NOT a real tenant, so the
 * tenant-scoped fast path can't be used), bounded by `MAX_POINTER_SCAN` total.
 * Soft-fails to `[]` (a missing base / unreadable dir never throws). Content-free.
 */
function scanCandidateSessionKeys(dataDir: string, requested: string): string[] {
  const base = dataDir.length > 0 ? dataDir : defaultDataDir();
  const sessionsBase = safePath(base, "workspace", "sessions");
  let tenants: fs.Dirent[];
  try {
    tenants = fs.readdirSync(sessionsBase, { withFileTypes: true });
  } catch {
    return []; // sessions base absent/unreadable — soft-fail.
  }
  const keys: string[] = [];
  let scanned = 0;
  outer: for (const tenant of tenants) {
    if (!tenant.isDirectory()) continue;
    const tenantDir = safePath(sessionsBase, tenant.name);
    let channels: fs.Dirent[];
    try {
      channels = fs.readdirSync(tenantDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const channel of channels) {
      if (!channel.isDirectory()) continue;
      const channelDir = safePath(tenantDir, channel.name);
      let entries: string[];
      try {
        entries = fs.readdirSync(channelDir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!name.endsWith(TRAJECTORY_POINTER_SUFFIX)) continue;
        if (scanned >= MAX_POINTER_SCAN) break outer; // Runaway backstop.
        scanned++;
        try {
          const pointer = JSON.parse(fs.readFileSync(safePath(channelDir, name), "utf-8")) as Record<string, unknown>;
          const sid = pointer["sessionId"];
          if (pointer["traceSchema"] === "comis-trajectory-pointer" && typeof sid === "string" && sid.length > 0) {
            keys.push(sid);
          }
        } catch {
          continue; // Corrupt/unreadable pointer — skip.
        }
      }
    }
  }
  return rankCandidateSessionKeys(requested, keys);
}

/**
 * Resolve the trajectory JSONL path for a session file, the canonical way:
 *   1. Read `<sessionFile>.trajectory-path.json` (pointer); if it fence-checks
 *      (`traceSchema === "comis-trajectory-pointer"`, `schemaVersion === 1`,
 *      non-empty string `runtimeFile`) use `runtimeFile`.
 *   2. Else fall back to the co-located `<sessionFile>.trajectory.jsonl`.
 *
 * Mirrors `bundle-exporter.ts:readRuntimeTrajectory`'s pointer resolution.
 * Soft-fail: a missing/corrupt pointer falls through to the co-located path.
 */
function resolveTrajectoryFile(sessionFile: string): string {
  const pointerPath = resolveTrajectoryPointerFilePath(sessionFile);
  try {
    const pointer = JSON.parse(fs.readFileSync(pointerPath, "utf-8")) as Record<string, unknown>;
    if (
      pointer["traceSchema"] === "comis-trajectory-pointer" &&
      pointer["schemaVersion"] === 1 &&
      typeof pointer["runtimeFile"] === "string" &&
      pointer["runtimeFile"].length > 0
    ) {
      return pointer["runtimeFile"];
    }
  } catch {
    // Pointer absent or invalid — fall back to the co-located convention.
  }
  return `${sessionFile}.trajectory.jsonl`;
}

/**
 * The `_session-metadata.json` companion path for a session file (the same
 * `.jsonl` → `_session-metadata.json` rename `comis-session-manager.ts` writes).
 */
function resolveMetadataFile(sessionFile: string): string {
  return sessionFile.replace(/\.jsonl$/, "_session-metadata.json");
}

/**
 * Bounded soft-fail JSONL read: every parsed line is returned (NO envelope
 * filtering), malformed lines are skipped, a missing/unreadable file yields
 * `[]`, and at most MAX_RECORDS lines are accepted.
 */
function readJsonlBounded(file: string): Array<Record<string, unknown>> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return []; // Missing/unreadable — soft-fail.
  }
  const out: Array<Record<string, unknown>> = [];
  for (const line of raw.split("\n")) {
    if (out.length >= MAX_RECORDS) break;
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // Skip malformed JSONL lines per standard convention.
    }
  }
  return out;
}

/**
 * Build the production reader. `dataDir` is the file-system root (defaults to
 * `~/.comis`); `obsStore` (optional) backs the diagnostics-rollup fallback.
 */
export function makeRealReader(
  dataDir: string,
  obsStore?: ObservabilityStore,
): IncidentSourceReader {
  const base = dataDir.length > 0 ? dataDir : defaultDataDir();
  // The writer's source of truth: sessions live under <workspaceDir>/sessions/,
  // and the default-agent workspace is <dataDir>/workspace (resolveWorkspaceDir).
  // Mirror that here (daemon.ts:570 uses the same default workspace base).
  const sessionsBase = safePath(base, "workspace", "sessions");
  const logsDir = safePath(base, "logs");

  return {
    async readSessionRecords(sessionKey: string): Promise<Array<Record<string, unknown>>> {
      const sessionFile = resolveSessionFile(sessionKey, sessionsBase);
      if (sessionFile === undefined) return []; // Unparseable key — soft-fail.
      const trajectoryFile = resolveTrajectoryFile(sessionFile);
      return readJsonlBounded(trajectoryFile);
    },

    async readCacheTraceRecords(sessionKey: string): Promise<Array<Record<string, unknown>>> {
      const file = safePath(logsDir, "cache-trace.jsonl");
      const all = readJsonlBounded(file);
      // Session-scoped: keep only this session's cache-trace lines.
      return all.filter((r) => r.sessionKey === sessionKey);
    },

    async readSessionMetadata(sessionKey: string): Promise<Record<string, unknown> | null> {
      const sessionFile = resolveSessionFile(sessionKey, sessionsBase);
      if (sessionFile === undefined) return null; // Unparseable key — soft-fail.
      const file = resolveMetadataFile(sessionFile);
      let raw: string;
      try {
        raw = fs.readFileSync(file, "utf-8");
      } catch {
        return null; // Companion absent — F2 rollup is the fallback.
      }
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return null; // Corrupt companion — soft-fail.
      }
    },

    async readDiagnosticsRollup(sessionKey: string): Promise<Record<string, unknown> | null> {
      if (obsStore === undefined) return null; // F1 metadata is the primary source.
      // DiagnosticQueryParams has NO sessionKey filter — query a window and
      // filter by row.sessionKey AFTER (a {limit:1} would return the most-recent
      // row across ALL sessions, not this one). The window (DIAGNOSTICS_QUERY_LIMIT)
      // is a recency horizon — 1000 wide so older sessions are found.
      const rows = obsStore.queryDiagnostics({
        category: "session_summary",
        limit: DIAGNOSTICS_QUERY_LIMIT,
      });
      const match = rows.find((r) => r.sessionKey === sessionKey);
      return match === undefined ? null : (match as unknown as Record<string, unknown>);
    },

    async readAuditEvents(sessionKey: string): Promise<Array<Record<string, unknown>>> {
      if (obsStore === undefined) return []; // No store — the audit? section is omitted.
      // AuditQueryParams has NO traceId predicate, so scope by the session's
      // TENANT + a bounded limit, and let the caller filter by the resolved
      // traceId AFTER. The display label is parsed here ONLY to NARROW this
      // diagnostic read (multi-tenant isolation floor) — never to recover
      // authority. An unparseable key yields no tenant scope — query the
      // bounded window unfiltered (the caller's traceId filter still narrows
      // it to this session).
      const key = parseFormattedSessionKey(sessionKey);
      const rows = obsStore.queryAuditEvents({
        ...(key === undefined ? {} : { tenant: key.tenantId }),
        limit: AUDIT_QUERY_LIMIT,
      });
      return rows as unknown as Array<Record<string, unknown>>;
    },
    async listCandidateSessionKeys(requestedKey: string): Promise<string[]> {
      return scanCandidateSessionKeys(base, requestedKey);
    },
  };
}
