// SPDX-License-Identifier: Apache-2.0
import { isAbsolute } from "node:path";

import { err, ok, tryCatch, type Result } from "@comis/shared";

import type {
  ProductionRemoteExecutor,
  ProductionRemoteInvocation,
} from "./production-bootstrap.js";

export const EVIDENCE_FACTS_BEGIN = "COMIS_PRODUCTION_EVIDENCE_V1_BEGIN";
export const EVIDENCE_FACTS_END = "COMIS_PRODUCTION_EVIDENCE_V1_END";
export const MAX_EVIDENCE_REPORT_BYTES = 32_768;

export const PRODUCTION_EVIDENCE_IDS = [
  "memory_database",
  "legacy_sessions",
  "lcd_messages",
  "lcd_message_parts",
  "lcd_summary_messages",
  "lcd_summary_parents",
  "lcd_summaries",
  "lcd_context_items",
  "lcd_ingest_cursor",
  "lcd_memory_provenance",
  "channel_delivery_events",
  "channel_snapshots",
  "session_transcripts",
  "session_metadata",
  "trajectory_traces",
  "trajectory_pointers",
  "daemon_logs",
  "security_audit_logs",
  "config_audit_logs",
  "cache_traces",
  "recall_traces",
  "session_index",
  "audit_events",
  "diagnostics",
  "token_usage",
  "embedding_cache",
  "embedding_provider_metadata",
  "system_prompt_reports",
  "cron_definitions",
  "cron_executions",
  "heartbeat_runs",
  "system_event_queue",
  "delivery_queue",
  "delivery_mirror",
  "outward_send_ledger",
  "memories",
  "memory_usefulness",
  "memory_entities",
  "memory_causal_edges",
  "mental_models",
  "outcome_events",
  "memory_triples",
  "durable_runs",
  "named_graphs",
  "active_graphs",
  "graph_run_artifacts",
  "subagent_results",
  "active_subagents",
  "background_tasks",
  "video_jobs",
  "media_artifacts",
  "result_ref_artifacts",
  "skill_artifacts",
  "learned_skill_surface",
  "config_files",
  "plugin_configuration",
  "plugin_runtime",
  "external_configured_paths",
] as const;

export type ProductionEvidenceId = (typeof PRODUCTION_EVIDENCE_IDS)[number];
export type ProductionEvidenceConfigured = "configured" | "not_configured" | "unknown";
export type ProductionEvidenceAvailability = "available" | "missing" | "unsupported";
export type ProductionEvidenceReadability = "readable" | "unreadable" | "not_applicable";
export type ProductionEvidenceTimeBasis = "row_timestamp" | "file_mtime";
export type ProductionEvidenceGapReason =
  | "artifact_missing"
  | "configuration_not_evaluated"
  | "database_missing"
  | "database_unreadable"
  | "table_absent"
  | "sqlite_driver_unavailable"
  | "not_durable"
  | "requires_runtime_api"
  | "timestamp_not_recorded"
  | "no_timestamp_column"
  | "symlink_entries_skipped"
  | "compressed_records_not_counted"
  | "scan_limit_reached"
  | "scan_failed"
  | "outside_data_root_not_scanned";

export interface ProductionEvidenceItem {
  readonly id: ProductionEvidenceId;
  readonly configured: ProductionEvidenceConfigured;
  readonly availability: ProductionEvidenceAvailability;
  readonly readability: ProductionEvidenceReadability;
  readonly contentDigestSha256?: string;
  readonly rows?: number;
  readonly files?: number;
  readonly records?: number;
  readonly bytes?: number;
  readonly earliestMs?: number;
  readonly latestMs?: number;
  readonly timeBasis?: ProductionEvidenceTimeBasis;
  readonly gapReason?: ProductionEvidenceGapReason;
}

export interface ProductionEvidenceReport {
  readonly schema: "comis-production-evidence";
  readonly schemaVersion: 1;
  readonly consistency: "live_non_atomic";
  readonly observedAtMs: number;
  readonly items: readonly ProductionEvidenceItem[];
}

export interface ProductionEvidenceParityReport {
  readonly exact: true;
  readonly itemCount: number;
  readonly gapCount: number;
}

export type ProductionEvidenceMismatchField =
  | "items"
  | Exclude<keyof ProductionEvidenceItem, "id">;

export interface ProductionEvidenceMismatchError {
  readonly kind: "evidence_mismatch";
  readonly evidenceId?: ProductionEvidenceId;
  readonly field: ProductionEvidenceMismatchField;
  readonly message: string;
}

export interface ProductionEvidenceProbeInput {
  readonly host: string;
  readonly port?: number;
  readonly dataDir: string;
  readonly packageRoot: string;
  readonly serviceUser: string;
}

export type ProductionEvidenceError =
  | {
      readonly kind: "unsafe_input";
      readonly field: "host" | "port" | "dataDir" | "packageRoot" | "serviceUser";
      readonly message: string;
    }
  | {
      readonly kind: "malformed_evidence";
      readonly field: "envelope" | "report" | "items";
      readonly message: string;
    }
  | {
      readonly kind: "remote_failure";
      readonly message: string;
    };

const EVIDENCE_PARITY_FIELDS = [
  "configured",
  "availability",
  "readability",
  "contentDigestSha256",
  "rows",
  "files",
  "records",
  "bytes",
  "earliestMs",
  "latestMs",
  "timeBasis",
  "gapReason",
] as const satisfies readonly Exclude<keyof ProductionEvidenceItem, "id">[];

const CONFIGURED_VALUES = new Set<string>(["configured", "not_configured", "unknown"]);
const AVAILABILITY_VALUES = new Set<string>(["available", "missing", "unsupported"]);
const READABILITY_VALUES = new Set<string>(["readable", "unreadable", "not_applicable"]);
const TIME_BASIS_VALUES = new Set<string>(["row_timestamp", "file_mtime"]);
const GAP_REASON_VALUES = new Set<string>([
  "artifact_missing",
  "configuration_not_evaluated",
  "database_missing",
  "database_unreadable",
  "table_absent",
  "sqlite_driver_unavailable",
  "not_durable",
  "requires_runtime_api",
  "timestamp_not_recorded",
  "no_timestamp_column",
  "symlink_entries_skipped",
  "compressed_records_not_counted",
  "scan_limit_reached",
  "scan_failed",
  "outside_data_root_not_scanned",
]);
const EVIDENCE_ID_VALUES = new Set<string>(PRODUCTION_EVIDENCE_IDS);
const SHA256_RE = /^[a-f0-9]{64}$/u;
const REPORT_KEYS = ["schema", "schemaVersion", "consistency", "observedAtMs", "items"] as const;
const ITEM_KEYS = [
  "id",
  "configured",
  "availability",
  "readability",
  "contentDigestSha256",
  "rows",
  "files",
  "records",
  "bytes",
  "earliestMs",
  "latestMs",
  "timeBasis",
  "gapReason",
] as const;

function malformed(
  field: "envelope" | "report" | "items",
  message: string,
): Result<never, ProductionEvidenceError> {
  return err({ kind: "malformed_evidence", field, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key));
}

function isNonNegativeSafeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateEvidenceItem(
  raw: unknown,
  expectedId: ProductionEvidenceId,
): Result<ProductionEvidenceItem, ProductionEvidenceError> {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ITEM_KEYS, ["id", "configured", "availability", "readability"])
  ) {
    return malformed("items", "Evidence item shape is invalid");
  }
  if (raw.id !== expectedId || !EVIDENCE_ID_VALUES.has(expectedId)) {
    return malformed("items", "Evidence item identifiers are incomplete or out of order");
  }
  if (
    typeof raw.configured !== "string" ||
    !CONFIGURED_VALUES.has(raw.configured) ||
    typeof raw.availability !== "string" ||
    !AVAILABILITY_VALUES.has(raw.availability) ||
    typeof raw.readability !== "string" ||
    !READABILITY_VALUES.has(raw.readability)
  ) {
    return malformed("items", "Evidence item state is invalid");
  }

  if (
    (raw.contentDigestSha256 !== undefined &&
      (typeof raw.contentDigestSha256 !== "string" ||
        !SHA256_RE.test(raw.contentDigestSha256))) ||
    (raw.rows !== undefined && !isNonNegativeSafeNumber(raw.rows)) ||
    (raw.files !== undefined && !isNonNegativeSafeNumber(raw.files)) ||
    (raw.records !== undefined && !isNonNegativeSafeNumber(raw.records)) ||
    (raw.bytes !== undefined && !isNonNegativeSafeNumber(raw.bytes))
  ) {
    return malformed("items", "Evidence item count is invalid");
  }
  const hasEarliest = raw.earliestMs !== undefined;
  const hasLatest = raw.latestMs !== undefined;
  if (
    hasEarliest !== hasLatest ||
    (hasEarliest && !isNonNegativeSafeNumber(raw.earliestMs)) ||
    (hasLatest && !isNonNegativeSafeNumber(raw.latestMs)) ||
    (hasEarliest && hasLatest && (raw.earliestMs as number) > (raw.latestMs as number))
  ) {
    return malformed("items", "Evidence item time range is invalid");
  }
  if (
    (hasEarliest && (typeof raw.timeBasis !== "string" || !TIME_BASIS_VALUES.has(raw.timeBasis))) ||
    (!hasEarliest && raw.timeBasis !== undefined)
  ) {
    return malformed("items", "Evidence item time basis is invalid");
  }
  if (
    raw.gapReason !== undefined &&
    (typeof raw.gapReason !== "string" || !GAP_REASON_VALUES.has(raw.gapReason))
  ) {
    return malformed("items", "Evidence item gap reason is invalid");
  }

  const readable = raw.availability === "available" && raw.readability === "readable";
  const hasMetric = [raw.rows, raw.files, raw.records, raw.bytes].some((value) => value !== undefined);
  if (readable && (!hasMetric || raw.contentDigestSha256 === undefined)) {
    return malformed("items", "Readable evidence item has no aggregate metric or content identity");
  }
  if (
    !readable &&
    (hasMetric || hasEarliest || raw.contentDigestSha256 !== undefined || raw.gapReason === undefined)
  ) {
    return malformed("items", "Unavailable evidence item must carry only a gap reason");
  }
  return ok(raw as unknown as ProductionEvidenceItem);
}

export function parseProductionEvidenceFacts(
  raw: string,
): Result<ProductionEvidenceReport, ProductionEvidenceError> {
  if (Buffer.byteLength(raw, "utf8") > MAX_EVIDENCE_REPORT_BYTES) {
    return malformed("envelope", "Production evidence facts exceed the 32768-byte limit");
  }
  if (raw.includes("\r") || raw.includes("\0")) {
    return malformed("envelope", "Production evidence facts contain unsupported control bytes");
  }
  const normalized = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  const lines = normalized.split("\n");
  if (
    lines.length !== 3 ||
    lines[0] !== EVIDENCE_FACTS_BEGIN ||
    lines[2] !== EVIDENCE_FACTS_END
  ) {
    return malformed("envelope", "Production evidence facts are missing their exact envelope");
  }
  const decoded = tryCatch(() => JSON.parse(lines[1] as string) as unknown);
  if (
    !decoded.ok ||
    !isRecord(decoded.value) ||
    !hasExactKeys(decoded.value, REPORT_KEYS, REPORT_KEYS)
  ) {
    return malformed("report", "Production evidence report is not strict JSON");
  }
  const report = decoded.value;
  if (
    report.schema !== "comis-production-evidence" ||
    report.schemaVersion !== 1 ||
    report.consistency !== "live_non_atomic" ||
    !isNonNegativeSafeNumber(report.observedAtMs) ||
    !Array.isArray(report.items) ||
    report.items.length !== PRODUCTION_EVIDENCE_IDS.length
  ) {
    return malformed("report", "Production evidence report header is invalid");
  }

  const items: ProductionEvidenceItem[] = [];
  for (let index = 0; index < PRODUCTION_EVIDENCE_IDS.length; index += 1) {
    const expectedId = PRODUCTION_EVIDENCE_IDS.at(index) as ProductionEvidenceId;
    const parsed = validateEvidenceItem(report.items.at(index), expectedId);
    if (!parsed.ok) return parsed;
    items.push(parsed.value);
  }
  return ok({
    schema: "comis-production-evidence",
    schemaVersion: 1,
    consistency: "live_non_atomic",
    observedAtMs: report.observedAtMs,
    items,
  });
}

export function compareProductionEvidenceReports(
  source: ProductionEvidenceReport,
  target: ProductionEvidenceReport,
): Result<ProductionEvidenceParityReport, ProductionEvidenceMismatchError> {
  function mismatch(
    field: ProductionEvidenceMismatchField,
    evidenceId?: ProductionEvidenceId,
  ): Result<never, ProductionEvidenceMismatchError> {
    return err({
      kind: "evidence_mismatch",
      ...(evidenceId !== undefined ? { evidenceId } : {}),
      field,
      message: "Target evidence does not match the production source",
    });
  }

  if (source.items.length !== target.items.length) return mismatch("items");
  for (let index = 0; index < source.items.length; index += 1) {
    const sourceItem = source.items.at(index);
    const targetItem = target.items.at(index);
    if (sourceItem === undefined || targetItem === undefined || sourceItem.id !== targetItem.id) {
      return mismatch("items", sourceItem?.id);
    }
    for (const field of EVIDENCE_PARITY_FIELDS) {
      if (sourceItem[field] !== targetItem[field]) return mismatch(field, sourceItem.id);
    }
  }

  return ok({
    exact: true,
    itemCount: source.items.length,
    gapCount: source.items.filter((item) => item.gapReason !== undefined).length,
  });
}

function unsafeInput(
  field: "host" | "port" | "dataDir" | "packageRoot" | "serviceUser",
): Result<never, ProductionEvidenceError> {
  return err({ kind: "unsafe_input", field, message: `Production evidence ${field} is unsafe` });
}

export function buildProductionEvidenceProbePlan(
  input: ProductionEvidenceProbeInput,
): Result<ProductionRemoteInvocation, ProductionEvidenceError> {
  if (!/^[^\s\0\r\n]+$/u.test(input.host)) return unsafeInput("host");
  if (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535)) {
    return unsafeInput("port");
  }
  if (!isAbsolute(input.dataDir) || /[\0\r\n]/u.test(input.dataDir)) return unsafeInput("dataDir");
  if (!isAbsolute(input.packageRoot) || /[\0\r\n]/u.test(input.packageRoot)) {
    return unsafeInput("packageRoot");
  }
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(input.serviceUser)) return unsafeInput("serviceUser");
  return ok({
    label: "production-evidence-inventory",
    host: input.host,
    ...(input.port !== undefined ? { port: input.port } : {}),
    args: ["bash", "-s", "--", input.dataDir, input.packageRoot, input.serviceUser],
    stdin: buildProductionEvidenceProbeScript(),
  });
}

export async function executeProductionEvidenceProbe(
  input: ProductionEvidenceProbeInput,
  executor: ProductionRemoteExecutor,
): Promise<Result<ProductionEvidenceReport, ProductionEvidenceError>> {
  const plan = buildProductionEvidenceProbePlan(input);
  if (!plan.ok) return plan;
  const remote = await executor.run(plan.value);
  if (!remote.ok || remote.value.exitCode !== 0) {
    return err({ kind: "remote_failure", message: "Production evidence inventory probe failed" });
  }
  const parsed = parseProductionEvidenceFacts(remote.value.stdout);
  if (!parsed.ok) {
    const field = parsed.error.kind === "malformed_evidence" ? parsed.error.field : "report";
    return malformed(field, "Production evidence inventory facts failed validation");
  }
  return parsed;
}

const NODE_SCANNER = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");

const dataDir = process.argv[2];
const packageRoot = process.argv[3];
const MAX_WALK_ENTRIES = 100000;
const MAX_RECORD_SCAN_BYTES = 536870912;
const MAX_REPORT_BYTES = 32768;
const ids = ${JSON.stringify(PRODUCTION_EVIDENCE_IDS)};
const inventory = new Map();

function gap(id, configured, availability, readability, gapReason) {
  inventory.set(id, { id, configured, availability, readability, gapReason });
}

function safeNumber(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function fileMtime(stat) {
  const value = Math.trunc(stat.mtimeMs);
  return safeNumber(value) ? value : 0;
}

function addFramed(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  hash.update(String(bytes.length), "utf8");
  hash.update(":", "utf8");
  hash.update(bytes);
}

function addFileBytes(hash, filePath) {
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(65536);
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
}

function fileDigest(filePath) {
  const hash = createHash("sha256");
  addFileBytes(hash, filePath);
  return hash.digest("hex");
}

function quoteSqlIdentifier(value) {
  return '"' + String(value).replaceAll('"', '""') + '"';
}

function encodeSqlValue(value) {
  if (value === null) return Buffer.from("null", "utf8");
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from("blob:", "utf8"), value]);
  if (typeof value === "bigint") return Buffer.from("bigint:" + String(value), "utf8");
  if (typeof value === "number") {
    if (Number.isNaN(value)) return Buffer.from("number:nan", "utf8");
    if (value === Infinity) return Buffer.from("number:infinity", "utf8");
    if (value === -Infinity) return Buffer.from("number:-infinity", "utf8");
    if (Object.is(value, -0)) return Buffer.from("number:-0", "utf8");
    return Buffer.from("number:" + String(value), "utf8");
  }
  if (typeof value === "string") return Buffer.from("string:" + value, "utf8");
  return Buffer.from("unsupported:" + typeof value, "utf8");
}

function tableDigest(db, table) {
  const columns = db.prepare("PRAGMA table_info(" + quoteSqlIdentifier(table) + ")").all();
  if (columns.length === 0) throw new Error("Table has no inspectable columns");
  const columnNames = columns.map((column) => String(column.name));
  const orderBy = columnNames.map(quoteSqlIdentifier).join(", ");
  const query = "SELECT * FROM " + quoteSqlIdentifier(table) + " ORDER BY " + orderBy;
  const hash = createHash("sha256");
  for (const column of columns) {
    addFramed(hash, column.name);
    addFramed(hash, column.type ?? "");
  }
  for (const row of db.prepare(query).iterate()) {
    addFramed(hash, "row");
    for (const columnName of columnNames) addFramed(hash, encodeSqlValue(row[columnName]));
  }
  return hash.digest("hex");
}

function databaseFileState(dbPath) {
  let stat;
  try {
    stat = fs.lstatSync(dbPath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      gap("memory_database", "configured", "missing", "not_applicable", "database_missing");
      return "missing";
    }
    gap("memory_database", "configured", "missing", "unreadable", "database_unreadable");
    return "unreadable";
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    gap("memory_database", "configured", "unsupported", "not_applicable", "symlink_entries_skipped");
    return "unreadable";
  }
  try {
    fs.accessSync(dbPath, fs.constants.R_OK);
  } catch {
    gap("memory_database", "configured", "available", "unreadable", "database_unreadable");
    return "unreadable";
  }
  inventory.set("memory_database", {
    id: "memory_database",
    configured: "configured",
    availability: "available",
    readability: "readable",
    contentDigestSha256: fileDigest(dbPath),
    files: 1,
    bytes: stat.size,
    earliestMs: fileMtime(stat),
    latestMs: fileMtime(stat),
    timeBasis: "file_mtime",
  });
  return "available";
}

const tableSpecs = [
  ["legacy_sessions", "sessions", "created_at", "updated_at"],
  ["lcd_messages", "lcd_messages", "created_at", "created_at"],
  ["lcd_message_parts", "lcd_message_parts", null, null],
  ["lcd_summary_messages", "lcd_summary_messages", null, null],
  ["lcd_summary_parents", "lcd_summary_parents", null, null],
  ["lcd_summaries", "lcd_summaries", "earliest_at", "latest_at"],
  ["lcd_context_items", "lcd_context_items", null, null],
  ["lcd_ingest_cursor", "lcd_ingest_cursor", "updated_at", "updated_at"],
  ["lcd_memory_provenance", "lcd_memory_provenance", "created_at", "created_at"],
  ["channel_delivery_events", "obs_delivery", "timestamp", "timestamp"],
  ["channel_snapshots", "obs_channel_snapshots", "timestamp", "timestamp"],
  ["audit_events", "obs_audit_events", "ts", "ts"],
  ["diagnostics", "obs_diagnostics", "timestamp", "timestamp"],
  ["token_usage", "obs_token_usage", "timestamp", "timestamp"],
  ["embedding_cache", "embedding_cache", "created_at", "accessed_at"],
  ["embedding_provider_metadata", "embedding_provider_meta", null, null],
  ["system_prompt_reports", "system_prompt_reports", "generated_at", "generated_at"],
  ["delivery_queue", "delivery_queue", "created_at", "created_at"],
  ["delivery_mirror", "delivery_mirror", "created_at", "created_at"],
  ["outward_send_ledger", "outward_send_ledger", "created_at_ms", "updated_at_ms"],
  ["memories", "memories", "created_at", "created_at"],
  ["memory_usefulness", "memory_usefulness", "last_useful_at", "last_useful_at"],
  ["memory_entities", "memory_entities", "first_seen", "last_seen"],
  ["memory_causal_edges", "memory_causal_edges", "created_at", "created_at"],
  ["mental_models", "mental_models", "created_at", "created_at"],
  ["outcome_events", "outcome_events", "observed_at", "observed_at"],
  ["memory_triples", "memory_triples", "t_ingested", "t_ingested"],
  ["durable_runs", "durable_runs", "created_at_ms", "updated_at_ms"],
  ["named_graphs", "named_graphs", "created_at", "updated_at"],
  ["video_jobs", "video_jobs", "submitted_at_ms", "updated_at_ms"],
];

function markTables(reason, availability) {
  for (const spec of tableSpecs) {
    gap(spec[0], "configured", availability, "not_applicable", reason);
  }
}

function inspectDatabase() {
  const dbPath = path.join(dataDir, "memory.db");
  const fileState = databaseFileState(dbPath);
  if (fileState === "missing") {
    markTables("database_missing", "missing");
    return;
  }
  if (fileState !== "available") {
    markTables("database_unreadable", "unsupported");
    return;
  }

  let Database;
  try {
    Database = createRequire(path.join(packageRoot, "package.json"))("better-sqlite3");
  } catch {
    markTables("sqlite_driver_unavailable", "unsupported");
    return;
  }
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma("query_only = ON");
  } catch {
    inventory.delete("memory_database");
    gap("memory_database", "configured", "available", "unreadable", "database_unreadable");
    markTables("database_unreadable", "unsupported");
    return;
  }
  try {
    const tableExists = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1");
    for (const spec of tableSpecs) {
      const id = spec[0];
      const table = spec[1];
      const startColumn = spec[2];
      const endColumn = spec[3];
      if (tableExists.get(table) === undefined) {
        gap(id, "configured", "missing", "not_applicable", "table_absent");
        continue;
      }
      let row;
      try {
        if (startColumn === null) {
          row = db.prepare("SELECT COUNT(*) AS row_count FROM \"" + table + "\"").get();
        } else {
          row = db.prepare(
            "SELECT COUNT(*) AS row_count, MIN(\"" + startColumn + "\") AS earliest_ms, MAX(\"" + endColumn + "\") AS latest_ms FROM \"" + table + "\"",
          ).get();
        }
      } catch {
        gap(id, "configured", "available", "unreadable", "scan_failed");
        continue;
      }
      const rows = Number(row.row_count);
      const item = {
        id,
        configured: "configured",
        availability: "available",
        readability: "readable",
        contentDigestSha256: tableDigest(db, table),
        rows,
      };
      if (startColumn === null) {
        item.gapReason = "no_timestamp_column";
      } else if (rows > 0 && row.earliest_ms !== null && row.latest_ms !== null) {
        item.earliestMs = Number(row.earliest_ms);
        item.latestMs = Number(row.latest_ms);
        item.timeBasis = "row_timestamp";
      } else if (rows > 0) {
        item.gapReason = "timestamp_not_recorded";
      }
      inventory.set(id, item);
    }
  } finally {
    db.close();
  }
}

function workspaceDirs() {
  let entries;
  try {
    entries = fs.readdirSync(dataDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && (entry.name === "workspace" || entry.name.startsWith("workspace-")))
    .map((entry) => path.join(dataDir, entry.name));
}

function existingRoots(candidates) {
  const roots = [];
  let symlink = false;
  let failed = false;
  for (const candidate of candidates) {
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) {
        symlink = true;
      } else if (stat.isDirectory()) {
        roots.push(candidate);
      }
    } catch (error) {
      if (!error || error.code !== "ENOENT") failed = true;
    }
  }
  return { roots, symlink, failed };
}

function walkFiles(root, matcher, maxDepth) {
  const files = [];
  const stack = [[root, 0]];
  let entriesSeen = 0;
  let symlink = false;
  while (stack.length > 0) {
    const current = stack.pop();
    const dir = current[0];
    const depth = current[1];
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return { failed: true, limited: false, symlink, files: [] };
    }
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > MAX_WALK_ENTRIES) return { failed: false, limited: true, symlink, files: [] };
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        symlink = true;
      } else if (entry.isDirectory() && depth < maxDepth) {
        stack.push([absolute, depth + 1]);
      } else if (entry.isFile() && matcher(entry.name, absolute)) {
        files.push(absolute);
      }
    }
  }
  return { failed: false, limited: false, symlink, files };
}

function lineCount(filePath, maxBytesRemaining) {
  const stat = fs.statSync(filePath);
  if (filePath.endsWith(".gz")) return { compressed: true, limited: false, records: 0, bytesRead: 0 };
  if (stat.size > maxBytesRemaining) return { compressed: false, limited: true, records: 0, bytesRead: 0 };
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(65536);
  let position = 0;
  let records = 0;
  let lastByte = -1;
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (read === 0) break;
      position += read;
      lastByte = buffer[read - 1];
      for (let index = 0; index < read; index += 1) {
        if (buffer[index] === 10) records += 1;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  if (position > 0 && lastByte !== 10) records += 1;
  return { compressed: false, limited: false, records, bytesRead: position };
}

function inspectFileSet(spec) {
  const rootState = existingRoots(spec.roots);
  if (rootState.failed) {
    gap(spec.id, spec.configured, "available", "unreadable", "scan_failed");
    return;
  }
  if (rootState.roots.length === 0) {
    gap(
      spec.id,
      spec.configured,
      rootState.symlink ? "unsupported" : "missing",
      "not_applicable",
      rootState.symlink ? "symlink_entries_skipped" : spec.missingReason,
    );
    return;
  }
  const matched = [];
  let symlink = rootState.symlink;
  for (const root of rootState.roots) {
    const walked = walkFiles(root, spec.matcher, spec.maxDepth === undefined ? 12 : spec.maxDepth);
    if (walked.failed) {
      gap(spec.id, spec.configured, "available", "unreadable", "scan_failed");
      return;
    }
    if (walked.limited) {
      gap(spec.id, spec.configured, "unsupported", "not_applicable", "scan_limit_reached");
      return;
    }
    symlink = symlink || walked.symlink;
    matched.push(...walked.files);
  }
  if (matched.length === 0 && spec.emptyMeansMissing) {
    gap(spec.id, spec.configured, "missing", "not_applicable", spec.missingReason);
    return;
  }

  let bytes = 0;
  let earliestMs;
  let latestMs;
  let records = 0;
  let recordBytes = 0;
  let compressed = false;
  let limited = false;
  const contentHash = createHash("sha256");
  try {
    matched.sort((left, right) => left.localeCompare(right, "en"));
    for (const filePath of matched) {
      const stat = fs.statSync(filePath);
      addFramed(contentHash, path.relative(dataDir, filePath).split(path.sep).join("/"));
      addFramed(contentHash, stat.size);
      addFileBytes(contentHash, filePath);
      bytes += stat.size;
      const mtime = fileMtime(stat);
      earliestMs = earliestMs === undefined ? mtime : Math.min(earliestMs, mtime);
      latestMs = latestMs === undefined ? mtime : Math.max(latestMs, mtime);
      if (spec.countRecords) {
        const counted = lineCount(filePath, MAX_RECORD_SCAN_BYTES - recordBytes);
        compressed = compressed || counted.compressed;
        limited = limited || counted.limited;
        records += counted.records;
        recordBytes += counted.bytesRead;
      }
    }
  } catch {
    gap(spec.id, spec.configured, "available", "unreadable", "scan_failed");
    return;
  }
  if (!Number.isSafeInteger(bytes)) {
    gap(spec.id, spec.configured, "unsupported", "not_applicable", "scan_limit_reached");
    return;
  }
  const item = {
    id: spec.id,
    configured: spec.configured,
    availability: "available",
    readability: "readable",
    contentDigestSha256: contentHash.digest("hex"),
    files: matched.length,
    bytes,
  };
  if (spec.countRecords && !compressed && !limited) item.records = records;
  if (matched.length > 0) {
    item.earliestMs = earliestMs;
    item.latestMs = latestMs;
    item.timeBasis = "file_mtime";
  }
  if (limited) item.gapReason = "scan_limit_reached";
  else if (compressed) item.gapReason = "compressed_records_not_counted";
  else if (symlink) item.gapReason = "symlink_entries_skipped";
  inventory.set(spec.id, item);
}

function inspectFiles() {
  const workspaces = workspaceDirs();
  const roots = (suffix) => workspaces.map((workspace) => path.join(workspace, suffix));
  const logs = [path.join(dataDir, "logs")];
  const specs = [
    { id: "session_transcripts", configured: "configured", roots: roots("sessions"), matcher: (name) => name.endsWith(".jsonl") && !name.endsWith(".trajectory.jsonl"), countRecords: true, emptyMeansMissing: false, missingReason: "artifact_missing" },
    { id: "session_metadata", configured: "configured", roots: roots("sessions"), matcher: (name) => name.endsWith("_session-metadata.json"), countRecords: false, emptyMeansMissing: false, missingReason: "artifact_missing" },
    { id: "trajectory_traces", configured: "unknown", roots: roots("sessions").concat([path.join(dataDir, "trajectories")]), matcher: (name) => name.endsWith(".trajectory.jsonl"), countRecords: true, emptyMeansMissing: true, missingReason: "configuration_not_evaluated" },
    { id: "trajectory_pointers", configured: "unknown", roots: roots("sessions"), matcher: (name) => name.endsWith(".trajectory-path.json"), countRecords: false, emptyMeansMissing: true, missingReason: "configuration_not_evaluated" },
    { id: "daemon_logs", configured: "configured", roots: logs, matcher: (name) => /^daemon(?:\.\d+)?\.log(?:\.gz)?$/u.test(name), countRecords: true, emptyMeansMissing: true, missingReason: "artifact_missing" },
    { id: "security_audit_logs", configured: "configured", roots: logs, matcher: (name) => /^security-audit\.jsonl(?:\.\d+)?(?:\.gz)?$/u.test(name), countRecords: true, emptyMeansMissing: true, missingReason: "artifact_missing" },
    { id: "config_audit_logs", configured: "configured", roots: logs, matcher: (name) => /^config-audit\.jsonl(?:\.\d+)?(?:\.gz)?$/u.test(name), countRecords: true, emptyMeansMissing: true, missingReason: "artifact_missing" },
    { id: "cache_traces", configured: "unknown", roots: logs, matcher: (name) => /^cache-trace(?:\.\d+)?\.jsonl(?:\.gz)?$/u.test(name), countRecords: true, emptyMeansMissing: true, missingReason: "configuration_not_evaluated" },
    { id: "recall_traces", configured: "unknown", roots: logs, matcher: (name) => /^recall-trace(?:\.\d+)?\.jsonl(?:\.gz)?$/u.test(name), countRecords: true, emptyMeansMissing: true, missingReason: "configuration_not_evaluated" },
    { id: "session_index", configured: "configured", roots: logs, matcher: (name) => /^session-index\.\d{4}-\d{2}-\d{2}\.jsonl(?:\.gz)?$/u.test(name), countRecords: true, emptyMeansMissing: true, missingReason: "artifact_missing" },
    { id: "cron_definitions", configured: "unknown", roots: roots(".scheduler"), matcher: (name) => name === "cron-jobs.json", countRecords: false, emptyMeansMissing: true, missingReason: "configuration_not_evaluated" },
    { id: "cron_executions", configured: "unknown", roots: roots(".scheduler"), matcher: (name) => name === "execution.jsonl", countRecords: true, emptyMeansMissing: true, missingReason: "configuration_not_evaluated" },
    { id: "graph_run_artifacts", configured: "unknown", roots: [path.join(dataDir, "graph-runs")], matcher: () => true, countRecords: false, emptyMeansMissing: false, missingReason: "artifact_missing" },
    { id: "subagent_results", configured: "configured", roots: [path.join(dataDir, "subagent-results")], matcher: (name) => name.endsWith(".json"), countRecords: false, emptyMeansMissing: false, missingReason: "artifact_missing" },
    { id: "background_tasks", configured: "configured", roots: [path.join(dataDir, "background-tasks")], matcher: (name) => name.endsWith(".json"), countRecords: false, emptyMeansMissing: false, missingReason: "artifact_missing" },
    { id: "media_artifacts", configured: "configured", roots: roots("media"), matcher: () => true, countRecords: false, emptyMeansMissing: false, missingReason: "artifact_missing" },
    { id: "result_ref_artifacts", configured: "unknown", roots: roots("results"), matcher: () => true, countRecords: false, emptyMeansMissing: false, missingReason: "artifact_missing" },
    { id: "skill_artifacts", configured: "configured", roots: [path.join(dataDir, "skills")].concat(roots("skills")), matcher: () => true, countRecords: false, emptyMeansMissing: false, missingReason: "artifact_missing" },
    { id: "learned_skill_surface", configured: "unknown", roots: roots(".learned-skills"), matcher: () => true, countRecords: false, emptyMeansMissing: false, missingReason: "artifact_missing" },
    { id: "config_files", configured: "configured", roots: [dataDir], matcher: (name, absolute) => path.dirname(absolute) === dataDir && /^(?:config|config\.local|config\.last-good|config\.bak)\.ya?ml$/u.test(name), countRecords: false, emptyMeansMissing: true, missingReason: "artifact_missing", maxDepth: 0 },
  ];
  for (const spec of specs) inspectFileSet(spec);
}

function addRuntimeGaps() {
  gap("heartbeat_runs", "unknown", "unsupported", "not_applicable", "requires_runtime_api");
  gap("system_event_queue", "configured", "unsupported", "not_applicable", "not_durable");
  gap("active_graphs", "unknown", "unsupported", "not_applicable", "not_durable");
  gap("active_subagents", "unknown", "unsupported", "not_applicable", "not_durable");
  gap("plugin_configuration", "unknown", "unsupported", "not_applicable", "configuration_not_evaluated");
  gap("plugin_runtime", "unknown", "unsupported", "not_applicable", "requires_runtime_api");
  gap("external_configured_paths", "unknown", "unsupported", "not_applicable", "outside_data_root_not_scanned");
}

function main() {
  inspectDatabase();
  inspectFiles();
  addRuntimeGaps();
  const items = ids.map((id) => inventory.get(id));
  if (items.some((item) => item === undefined)) process.exit(72);
  const report = {
    schema: "comis-production-evidence",
    schemaVersion: 1,
    consistency: "live_non_atomic",
    observedAtMs: Date.now(),
    items,
  };
  const output = "COMIS_PRODUCTION_EVIDENCE_V1_BEGIN\n" + JSON.stringify(report) + "\nCOMIS_PRODUCTION_EVIDENCE_V1_END\n";
  if (Buffer.byteLength(output, "utf8") > MAX_REPORT_BYTES) process.exit(73);
  process.stdout.write(output);
}

try {
  main();
} catch {
  process.exit(74);
}
`;

export function buildProductionEvidenceProbeScript(): string {
  return String.raw`set -euo pipefail
data_dir="$1"
package_root="$2"
service_user="$3"

case "$data_dir" in /*) ;; *) exit 64 ;; esac
case "$package_root" in /*) ;; *) exit 64 ;; esac
case "$service_user" in *[!A-Za-z0-9_-]*|'') exit 64 ;; esac

node_bin="$(command -v node || true)"
if [ -z "$node_bin" ]; then exit 69; fi
run_node() {
  if [ "$(id -un)" = "$service_user" ]; then
    "$node_bin" "$@"
  else
    if ! command -v sudo >/dev/null 2>&1; then exit 69; fi
    sudo -n -u "$service_user" -- "$node_bin" "$@"
  fi
}

run_node - "$data_dir" "$package_root" <<'COMIS_PRODUCTION_EVIDENCE_NODE'
` + NODE_SCANNER + String.raw`
COMIS_PRODUCTION_EVIDENCE_NODE
`;
}
