// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";

import { err, ok, tryCatch, type Result } from "@comis/shared";

import {
  EVIDENCE_FACTS_BEGIN,
  EVIDENCE_FACTS_END,
  parseProductionEvidenceFacts,
  type ProductionEvidenceId,
  type ProductionEvidenceItem,
  type ProductionEvidenceReport,
} from "./production-evidence.js";
import {
  TRANSCRIPT_EVENT_KINDS,
  TRANSCRIPT_EXACT_SOURCE_KINDS,
  TRANSCRIPT_SOURCE_EVENT_PREFIXES,
  TRANSCRIPT_SOURCE_KINDS,
  classifyTranscriptCompleteness,
  type CanonicalProductionEvent,
  type CanonicalProductionTranscript,
  type TranscriptActorKind,
  type TranscriptCaptureGapReason,
  type TranscriptCompletenessReport,
  type TranscriptEventKind,
  type TranscriptOrigin,
  type TranscriptReplayPolicy,
  type TranscriptSourceKind,
  type TranscriptAuthoritySource,
  type TranscriptTrust,
} from "./production-transcript.js";

export const MAX_PRODUCTION_ACTIVITY_INPUT_BYTES = 32 * 1024 * 1024;
export const MAX_PRODUCTION_ACTIVITY_RECORDS = 100_000;
const MAX_ACTIVITY_SOURCES = 10_000;

export interface NormalizedProductionActivityRecord {
  readonly recordId: string;
  readonly sourceSeq: number;
  readonly eventKind: TranscriptEventKind;
  readonly wallTimeMs: number;
  readonly monotonicTimeNs: string;
  readonly clockId: string;
  readonly traceId: string | null;
  readonly sessionId: string | null;
  readonly runId: string | null;
  readonly jobId: string | null;
  readonly causalParent: {
    readonly sourceKind: TranscriptSourceKind;
    readonly sourceId: string;
    readonly recordId: string;
  } | null;
  readonly actor: {
    readonly kind: TranscriptActorKind;
    readonly id: string | null;
    readonly trust: TranscriptTrust;
    readonly origin: TranscriptOrigin;
  };
  readonly replay: {
    readonly policy: TranscriptReplayPolicy;
    readonly payloadDigest: string;
    readonly blobDigest: string | null;
  };
}

export interface ProductionActivitySourceBatch {
  readonly kind: TranscriptSourceKind;
  readonly sourceId: string;
  readonly status: TranscriptAuthoritySource["status"];
  readonly gapReasons: readonly TranscriptCaptureGapReason[];
  readonly records: readonly NormalizedProductionActivityRecord[];
}

export interface ProductionActivityCompileInput {
  readonly captureId: string;
  readonly createdAtMs: number;
  readonly target: "deterministic_cassette" | "live_provider";
  readonly evidence: ProductionEvidenceReport;
  readonly sources: readonly ProductionActivitySourceBatch[];
}

export interface ProductionActivityCompilation {
  readonly transcript: CanonicalProductionTranscript;
  readonly authorities: readonly TranscriptAuthoritySource[];
  readonly completeness: TranscriptCompletenessReport;
  readonly duplicateCount: number;
}

export type ProductionActivityCompilerError = {
  readonly kind: "invalid_activity";
  readonly field: "input" | "evidence" | "sources" | "records" | "causality" | "transcript";
  readonly message: string;
};

export interface TargetLocalActivityBlobVaultPlanInput {
  readonly host: string;
  readonly port?: number;
  readonly service: string;
  readonly serviceUser: string;
  readonly dataDir: string;
  readonly replayRuntimeRoot: string;
  readonly captureId: string;
  readonly expectedMachineIdSha256: string;
  readonly channel?: string;
}

export interface TargetLocalActivityBlobVaultPlan {
  readonly invocation: {
    readonly label: string;
    readonly host: string;
    readonly port?: number;
    readonly args: readonly string[];
    readonly stdin: string;
    readonly stdoutLimitBytes: number;
  };
  readonly vaultDir: string;
  readonly sourceKinds: readonly ["offline_messages", "internal_dispatch"];
  readonly stdoutDisposition: "counts_digests_and_gaps_only";
  readonly rawContentDisposition: "target_private_files_only";
  readonly fileMode: "0600";
  readonly directoryMode: "0700";
}

export interface TargetLocalActivityBlobVaultPlanError {
  readonly kind: "unsafe_input";
  readonly field:
    | "host"
    | "port"
    | "service"
    | "serviceUser"
    | "dataDir"
    | "replayRuntimeRoot"
    | "captureId"
    | "expectedMachineIdSha256"
    | "channel";
  readonly message: string;
}

interface ValidatedRecordNode {
  readonly identity: string;
  readonly sourceKind: TranscriptSourceKind;
  readonly sourceId: string;
  readonly record: NormalizedProductionActivityRecord;
}

interface SourceAuthoritySpec {
  readonly evidenceIds: readonly ProductionEvidenceId[];
  readonly intrinsicGaps: readonly TranscriptCaptureGapReason[];
}

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MONOTONIC_PATTERN = /^(?:0|[1-9][0-9]{0,29})$/u;
const SOURCE_KIND_VALUES = new Set<string>(TRANSCRIPT_SOURCE_KINDS);
const EVENT_KIND_VALUES = new Set<string>(TRANSCRIPT_EVENT_KINDS);
const STATUS_VALUES = new Set<string>([
  "available",
  "missing",
  "unreadable",
  "unsupported",
  "not_configured",
]);
const GAP_VALUES = new Set<string>([
  "missing_artifact",
  "unreadable_artifact",
  "unsupported_source",
  "partial_retention",
  "rotation_loss",
  "queue_drop",
  "scan_limit",
  "external_path_unscanned",
  "non_durable",
  "count_unknown",
  "timestamp_gap",
  "capture_error",
]);
const ACTOR_KIND_VALUES = new Set<string>([
  "user",
  "agent",
  "system",
  "service",
  "scheduler",
  "subagent",
  "provider",
  "operator",
]);
const TRUST_VALUES = new Set<string>(["guest", "user", "admin", "system", "external"]);
const ORIGIN_VALUES = new Set<string>([
  "channel",
  "orchestrator",
  "scheduler",
  "heartbeat",
  "proactive",
  "system",
  "internal",
  "subagent",
  "model",
  "tool",
  "mcp",
  "web",
  "media",
  "cache",
  "memory",
  "learning",
  "context",
  "session",
  "lcd",
  "delivery",
  "state",
  "daemon",
  "replay",
]);
const REPLAY_POLICY_VALUES = new Set<string>(["inject", "stub", "assert", "execute", "observe", "skip"]);
const GAP_ORDER = [
  "missing_artifact",
  "unreadable_artifact",
  "unsupported_source",
  "partial_retention",
  "rotation_loss",
  "queue_drop",
  "scan_limit",
  "external_path_unscanned",
  "non_durable",
  "count_unknown",
  "timestamp_gap",
  "capture_error",
] as const satisfies readonly TranscriptCaptureGapReason[];

const INPUT_KEYS = ["captureId", "createdAtMs", "target", "evidence", "sources"] as const;
const SOURCE_KEYS = ["kind", "sourceId", "status", "gapReasons", "records"] as const;
const RECORD_KEYS = [
  "recordId",
  "sourceSeq",
  "eventKind",
  "wallTimeMs",
  "monotonicTimeNs",
  "clockId",
  "traceId",
  "sessionId",
  "runId",
  "jobId",
  "causalParent",
  "actor",
  "replay",
] as const;
const PARENT_KEYS = ["sourceKind", "sourceId", "recordId"] as const;
const ACTOR_KEYS = ["kind", "id", "trust", "origin"] as const;
const REPLAY_KEYS = ["policy", "payloadDigest", "blobDigest"] as const;

/**
 * The real persisted authority matrix. A normalized extractor may join several
 * artifacts into one source batch; the evidence rows only decide how to report
 * an omitted extractor. Row counts are not treated as event counts because one
 * cron execution, session record, or delivery row can normalize to several
 * lifecycle events.
 */
export const PRODUCTION_ACTIVITY_SOURCE_AUTHORITY = {
  offline_messages: { evidenceIds: ["session_transcripts"], intrinsicGaps: [] },
  channel_native: { evidenceIds: [], intrinsicGaps: ["non_durable"] },
  channel_normalized: { evidenceIds: ["session_transcripts", "trajectory_traces"], intrinsicGaps: [] },
  orchestrator: { evidenceIds: ["trajectory_traces", "daemon_logs"], intrinsicGaps: [] },
  cron_store: { evidenceIds: ["cron_definitions"], intrinsicGaps: [] },
  cron_execution: { evidenceIds: ["cron_executions"], intrinsicGaps: [] },
  heartbeat: { evidenceIds: ["heartbeat_runs"], intrinsicGaps: ["non_durable"] },
  proactive: { evidenceIds: ["cron_executions"], intrinsicGaps: ["non_durable"] },
  system_dispatch: { evidenceIds: ["system_event_queue"], intrinsicGaps: ["non_durable"] },
  internal_dispatch: { evidenceIds: ["session_transcripts", "trajectory_traces"], intrinsicGaps: [] },
  subagent: { evidenceIds: ["subagent_results", "active_subagents", "trajectory_traces"], intrinsicGaps: ["non_durable"] },
  graph: { evidenceIds: ["named_graphs", "active_graphs", "graph_run_artifacts", "durable_runs"], intrinsicGaps: ["non_durable"] },
  durable_run: { evidenceIds: ["durable_runs"], intrinsicGaps: [] },
  daemon: { evidenceIds: ["daemon_logs"], intrinsicGaps: [] },
  model_provider: { evidenceIds: ["trajectory_traces", "token_usage"], intrinsicGaps: [] },
  tool_runtime: { evidenceIds: ["trajectory_traces", "result_ref_artifacts"], intrinsicGaps: [] },
  mcp: { evidenceIds: ["trajectory_traces"], intrinsicGaps: [] },
  web: { evidenceIds: ["trajectory_traces"], intrinsicGaps: [] },
  media: { evidenceIds: ["trajectory_traces", "media_artifacts", "video_jobs"], intrinsicGaps: [] },
  cache: { evidenceIds: ["cache_traces", "recall_traces"], intrinsicGaps: [] },
  memory: { evidenceIds: ["memories", "memory_usefulness", "memory_entities", "memory_causal_edges", "memory_triples"], intrinsicGaps: [] },
  learning: { evidenceIds: ["outcome_events", "mental_models", "learned_skill_surface"], intrinsicGaps: [] },
  context: { evidenceIds: ["lcd_context_items", "lcd_summaries", "trajectory_traces"], intrinsicGaps: [] },
  session: { evidenceIds: ["session_transcripts", "session_metadata", "session_index"], intrinsicGaps: [] },
  lcd: { evidenceIds: ["lcd_messages", "lcd_message_parts", "lcd_summaries", "lcd_ingest_cursor"], intrinsicGaps: [] },
  delivery: { evidenceIds: ["channel_delivery_events", "delivery_queue", "delivery_mirror", "outward_send_ledger"], intrinsicGaps: [] },
  state: { evidenceIds: ["memory_database", "durable_runs", "background_tasks"], intrinsicGaps: [] },
  config: { evidenceIds: ["config_files", "config_audit_logs"], intrinsicGaps: [] },
  trajectory: { evidenceIds: ["trajectory_traces", "trajectory_pointers"], intrinsicGaps: [] },
  audit: { evidenceIds: ["audit_events", "security_audit_logs", "config_audit_logs"], intrinsicGaps: [] },
  diagnostics: { evidenceIds: ["diagnostics", "system_prompt_reports"], intrinsicGaps: [] },
  background: { evidenceIds: ["background_tasks", "video_jobs"], intrinsicGaps: [] },
  runtime_artifact: { evidenceIds: [], intrinsicGaps: [] },
  replay: { evidenceIds: [], intrinsicGaps: [] },
} as const satisfies Record<TranscriptSourceKind, SourceAuthoritySpec>;

const SOURCE_AUTHORITY_MAP = new Map<TranscriptSourceKind, SourceAuthoritySpec>(
  Object.entries(PRODUCTION_ACTIVITY_SOURCE_AUTHORITY) as Array<
    [TranscriptSourceKind, SourceAuthoritySpec]
  >,
);

const SOURCE_EVENT_PREFIX_MAP = new Map<TranscriptSourceKind, readonly string[]>(
  Object.entries(TRANSCRIPT_SOURCE_EVENT_PREFIXES) as Array<
    [TranscriptSourceKind, readonly string[]]
  >,
);

function invalid(
  field: ProductionActivityCompilerError["field"],
  message: string,
): Result<never, ProductionActivityCompilerError> {
  return err({ kind: "invalid_activity", field, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID_PATTERN.test(value);
}

function isNullableSafeId(value: unknown): value is string | null {
  return value === null || isSafeId(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function sourceIdentity(kind: TranscriptSourceKind, sourceId: string, recordId: string): string {
  return `${kind}\0${sourceId}\0${recordId}`;
}

function digestIdentity(prefix: string, identity: string): string {
  return createHash("sha256").update(prefix).update("\0").update(identity).digest("hex");
}

function validateParent(raw: unknown): raw is NonNullable<NormalizedProductionActivityRecord["causalParent"]> {
  return (
    isRecord(raw) &&
    hasExactKeys(raw, PARENT_KEYS) &&
    typeof raw.sourceKind === "string" &&
    SOURCE_KIND_VALUES.has(raw.sourceKind) &&
    isSafeId(raw.sourceId) &&
    isSafeId(raw.recordId)
  );
}

function validateNormalizedRecord(raw: unknown): Result<NormalizedProductionActivityRecord, ProductionActivityCompilerError> {
  if (!isRecord(raw) || !hasExactKeys(raw, RECORD_KEYS)) {
    return invalid("records", "Normalized authority record shape is invalid or contains inline content");
  }
  if (
    !isSafeId(raw.recordId) ||
    !isPositiveSafeInteger(raw.sourceSeq) ||
    typeof raw.eventKind !== "string" ||
    !EVENT_KIND_VALUES.has(raw.eventKind) ||
    !isNonNegativeSafeInteger(raw.wallTimeMs) ||
    typeof raw.monotonicTimeNs !== "string" ||
    !MONOTONIC_PATTERN.test(raw.monotonicTimeNs) ||
    !isSafeId(raw.clockId) ||
    !isNullableSafeId(raw.traceId) ||
    !isNullableSafeId(raw.sessionId) ||
    !isNullableSafeId(raw.runId) ||
    !isNullableSafeId(raw.jobId) ||
    (raw.causalParent !== null && !validateParent(raw.causalParent))
  ) {
    return invalid("records", "Normalized authority record scalar field is invalid");
  }
  if (
    !isRecord(raw.actor) ||
    !hasExactKeys(raw.actor, ACTOR_KEYS) ||
    typeof raw.actor.kind !== "string" ||
    !ACTOR_KIND_VALUES.has(raw.actor.kind) ||
    !isNullableSafeId(raw.actor.id) ||
    typeof raw.actor.trust !== "string" ||
    !TRUST_VALUES.has(raw.actor.trust) ||
    typeof raw.actor.origin !== "string" ||
    !ORIGIN_VALUES.has(raw.actor.origin)
  ) {
    return invalid("records", "Normalized authority actor is invalid");
  }
  if (
    !isRecord(raw.replay) ||
    !hasExactKeys(raw.replay, REPLAY_KEYS) ||
    typeof raw.replay.policy !== "string" ||
    !REPLAY_POLICY_VALUES.has(raw.replay.policy) ||
    !isDigest(raw.replay.payloadDigest) ||
    (raw.replay.blobDigest !== null && !isDigest(raw.replay.blobDigest))
  ) {
    return invalid("records", "Normalized authority replay digest metadata is invalid");
  }
  const parent = raw.causalParent as Record<string, unknown> | null;
  return ok({
    recordId: raw.recordId,
    sourceSeq: raw.sourceSeq,
    eventKind: raw.eventKind as TranscriptEventKind,
    wallTimeMs: raw.wallTimeMs,
    monotonicTimeNs: raw.monotonicTimeNs,
    clockId: raw.clockId,
    traceId: raw.traceId,
    sessionId: raw.sessionId,
    runId: raw.runId,
    jobId: raw.jobId,
    causalParent: parent === null
      ? null
      : {
          sourceKind: parent.sourceKind as TranscriptSourceKind,
          sourceId: parent.sourceId as string,
          recordId: parent.recordId as string,
        },
    actor: {
      kind: raw.actor.kind as TranscriptActorKind,
      id: raw.actor.id,
      trust: raw.actor.trust as TranscriptTrust,
      origin: raw.actor.origin as TranscriptOrigin,
    },
    replay: {
      policy: raw.replay.policy as TranscriptReplayPolicy,
      payloadDigest: raw.replay.payloadDigest,
      blobDigest: raw.replay.blobDigest,
    },
  });
}

function validateEvidence(raw: unknown): Result<ProductionEvidenceReport, ProductionActivityCompilerError> {
  const encoded = tryCatch(() => JSON.stringify(raw));
  if (encoded.ok === false || typeof encoded.value !== "string") {
    return invalid("evidence", "Production evidence report cannot be serialized");
  }
  const parsed = parseProductionEvidenceFacts(
    `${EVIDENCE_FACTS_BEGIN}\n${encoded.value}\n${EVIDENCE_FACTS_END}\n`,
  );
  return parsed.ok
    ? ok(parsed.value)
    : invalid("evidence", "Production evidence report failed strict validation");
}

function validateSourceBatch(raw: unknown): Result<ProductionActivitySourceBatch, ProductionActivityCompilerError> {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, SOURCE_KEYS) ||
    typeof raw.kind !== "string" ||
    !SOURCE_KIND_VALUES.has(raw.kind) ||
    !isSafeId(raw.sourceId) ||
    typeof raw.status !== "string" ||
    !STATUS_VALUES.has(raw.status) ||
    !Array.isArray(raw.gapReasons) ||
    raw.gapReasons.length > GAP_ORDER.length ||
    raw.gapReasons.some((gap) => typeof gap !== "string" || !GAP_VALUES.has(gap)) ||
    new Set(raw.gapReasons).size !== raw.gapReasons.length ||
    !Array.isArray(raw.records)
  ) {
    return invalid("sources", "Production activity source authority is invalid");
  }
  if (
    (raw.status !== "available" && raw.records.length !== 0) ||
    (raw.status === "not_configured" && raw.gapReasons.length !== 0)
  ) {
    return invalid("sources", "Unavailable activity authority cannot contain normalized records or incompatible gaps");
  }
  const records: NormalizedProductionActivityRecord[] = [];
  for (const candidate of raw.records) {
    const parsed = validateNormalizedRecord(candidate);
    if (parsed.ok === false) return err(parsed.error);
    const allowedPrefixes = SOURCE_EVENT_PREFIX_MAP.get(raw.kind as TranscriptSourceKind) ?? [];
    if (!allowedPrefixes.some((prefix) => parsed.value.eventKind.startsWith(prefix))) {
      return invalid("records", "Normalized event kind is incompatible with its authoritative source");
    }
    if (raw.kind === "offline_messages" && parsed.value.replay.blobDigest === null) {
      return invalid("records", "Offline channel message is missing its private blob digest");
    }
    records.push(parsed.value);
  }
  return ok({
    kind: raw.kind as TranscriptSourceKind,
    sourceId: raw.sourceId,
    status: raw.status as TranscriptAuthoritySource["status"],
    gapReasons: raw.gapReasons as TranscriptCaptureGapReason[],
    records,
  });
}

const SOURCE_SEQUENCE_GAP_REASONS = new Set<TranscriptCaptureGapReason>([
  "partial_retention",
  "rotation_loss",
  "scan_limit",
]);

function validateDeclaredSourceSequence(
  source: ProductionActivitySourceBatch,
): Result<void, ProductionActivityCompilerError> {
  const owners = new Map<number, string>();
  for (const record of source.records) {
    const owner = owners.get(record.sourceSeq);
    if (owner !== undefined && owner !== record.recordId) {
      return invalid("records", "Authoritative source sequence is assigned to multiple records");
    }
    owners.set(record.sourceSeq, record.recordId);
  }
  const sequences = [...owners.keys()].sort((left, right) => left - right);
  const complete = sequences.every((sequence, index) => sequence === index + 1);
  if (
    !complete &&
    !source.gapReasons.some((reason) => SOURCE_SEQUENCE_GAP_REASONS.has(reason))
  ) {
    return invalid("records", "Authoritative source sequence has an undeclared retention gap");
  }
  return ok(undefined);
}

function compareNodes(left: ValidatedRecordNode, right: ValidatedRecordNode): number {
  if (left.record.wallTimeMs !== right.record.wallTimeMs) {
    return left.record.wallTimeMs - right.record.wallTimeMs;
  }
  const leftMono = BigInt(left.record.monotonicTimeNs);
  const rightMono = BigInt(right.record.monotonicTimeNs);
  if (leftMono !== rightMono) return leftMono < rightMono ? -1 : 1;
  const sourceOrder = TRANSCRIPT_SOURCE_KINDS.indexOf(left.sourceKind) - TRANSCRIPT_SOURCE_KINDS.indexOf(right.sourceKind);
  if (sourceOrder !== 0) return sourceOrder;
  const sourceIdOrder = left.sourceId === right.sourceId ? 0 : left.sourceId < right.sourceId ? -1 : 1;
  if (sourceIdOrder !== 0) return sourceIdOrder;
  if (left.record.sourceSeq !== right.record.sourceSeq) return left.record.sourceSeq - right.record.sourceSeq;
  return left.record.recordId === right.record.recordId
    ? 0
    : left.record.recordId < right.record.recordId
      ? -1
      : 1;
}

function heapPush(heap: ValidatedRecordNode[], node: ValidatedRecordNode): void {
  heap.push(node);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    // eslint-disable-next-line security/detect-object-injection -- binary-heap indexes are bounded by the array length and never originate from input.
    if (compareNodes(heap[parent] as ValidatedRecordNode, node) <= 0) break;
    // eslint-disable-next-line security/detect-object-injection -- binary-heap indexes are bounded by the array length and never originate from input.
    heap[index] = heap[parent] as ValidatedRecordNode;
    index = parent;
  }
  // eslint-disable-next-line security/detect-object-injection -- binary-heap indexes are bounded by the array length and never originate from input.
  heap[index] = node;
}

function heapPop(heap: ValidatedRecordNode[]): ValidatedRecordNode | undefined {
  const root = heap[0];
  const tail = heap.pop();
  if (root === undefined || tail === undefined || heap.length === 0) return root;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    let child = left;
    // eslint-disable-next-line security/detect-object-injection -- binary-heap indexes are bounded by the array length and never originate from input.
    if (right < heap.length && compareNodes(heap[right] as ValidatedRecordNode, heap[left] as ValidatedRecordNode) < 0) child = right;
    // eslint-disable-next-line security/detect-object-injection -- binary-heap indexes are bounded by the array length and never originate from input.
    if (compareNodes(tail, heap[child] as ValidatedRecordNode) <= 0) break;
    // eslint-disable-next-line security/detect-object-injection -- binary-heap indexes are bounded by the array length and never originate from input.
    heap[index] = heap[child] as ValidatedRecordNode;
    index = child;
  }
  // eslint-disable-next-line security/detect-object-injection -- binary-heap indexes are bounded by the array length and never originate from input.
  heap[index] = tail;
  return root;
}

function topologicalOrder(
  nodes: ReadonlyMap<string, ValidatedRecordNode>,
): Result<readonly ValidatedRecordNode[], ProductionActivityCompilerError> {
  const indegrees = new Map<string, number>();
  const children = new Map<string, Set<string>>();
  for (const node of nodes.values()) indegrees.set(node.identity, 0);
  const addEdge = (parentIdentity: string, childIdentity: string): void => {
    const siblings = children.get(parentIdentity) ?? new Set<string>();
    if (siblings.has(childIdentity)) return;
    siblings.add(childIdentity);
    children.set(parentIdentity, siblings);
    indegrees.set(childIdentity, (indegrees.get(childIdentity) as number) + 1);
  };
  for (const node of nodes.values()) {
    const parent = node.record.causalParent;
    if (parent === null) continue;
    const parentIdentity = sourceIdentity(parent.sourceKind, parent.sourceId, parent.recordId);
    if (!nodes.has(parentIdentity)) {
      return invalid("causality", "Causal parent is absent from normalized authority records");
    }
    addEdge(parentIdentity, node.identity);
  }
  const sourceNodes = new Map<string, ValidatedRecordNode[]>();
  for (const node of nodes.values()) {
    const key = `${node.sourceKind}\0${node.sourceId}`;
    const siblings = sourceNodes.get(key) ?? [];
    siblings.push(node);
    sourceNodes.set(key, siblings);
  }
  for (const siblings of sourceNodes.values()) {
    siblings.sort((left, right) => left.record.sourceSeq - right.record.sourceSeq);
    for (let index = 1; index < siblings.length; index += 1) {
      addEdge(
        (siblings.at(index - 1) as ValidatedRecordNode).identity,
        (siblings.at(index) as ValidatedRecordNode).identity,
      );
    }
  }
  const ready: ValidatedRecordNode[] = [];
  for (const node of nodes.values()) {
    if (indegrees.get(node.identity) === 0) heapPush(ready, node);
  }
  const ordered: ValidatedRecordNode[] = [];
  while (ready.length > 0) {
    const node = heapPop(ready) as ValidatedRecordNode;
    ordered.push(node);
    for (const childIdentity of children.get(node.identity) ?? []) {
      indegrees.set(childIdentity, (indegrees.get(childIdentity) as number) - 1);
      if (indegrees.get(childIdentity) === 0) {
        heapPush(ready, nodes.get(childIdentity) as ValidatedRecordNode);
      }
    }
  }
  return ordered.length === nodes.size
    ? ok(ordered)
    : invalid("causality", "Normalized authority records contain a causal cycle");
}

function uniqueGaps(gaps: readonly TranscriptCaptureGapReason[]): TranscriptCaptureGapReason[] {
  const present = new Set(gaps);
  return GAP_ORDER.filter((gap) => present.has(gap));
}

function evidenceGapReason(item: ProductionEvidenceItem): TranscriptCaptureGapReason {
  switch (item.gapReason) {
    case "database_unreadable":
    case "scan_failed":
      return "unreadable_artifact";
    case "not_durable":
    case "requires_runtime_api":
      return "non_durable";
    case "scan_limit_reached":
      return "scan_limit";
    case "outside_data_root_not_scanned":
      return "external_path_unscanned";
    case "compressed_records_not_counted":
      return "count_unknown";
    case "timestamp_not_recorded":
    case "no_timestamp_column":
      return "timestamp_gap";
    case "symlink_entries_skipped":
      return "partial_retention";
    case "configuration_not_evaluated":
    case "sqlite_driver_unavailable":
      return "unsupported_source";
    case "artifact_missing":
    case "database_missing":
    case "table_absent":
    case undefined:
      return "missing_artifact";
    default: {
      const _exhaustive: never = item.gapReason;
      return _exhaustive;
    }
  }
}

function inferOmittedAuthority(
  kind: TranscriptSourceKind,
  evidence: ProductionEvidenceReport,
): TranscriptAuthoritySource {
  const spec = SOURCE_AUTHORITY_MAP.get(kind) as SourceAuthoritySpec;
  const byId = new Map(evidence.items.map((item) => [item.id, item]));
  const items = spec.evidenceIds.flatMap((id) => {
    const item = byId.get(id);
    return item === undefined ? [] : [item];
  });
  if (items.length > 0 && items.every((item) => item.configured === "not_configured")) {
    return { kind, sourceId: "capture", status: "not_configured", gapReasons: [] };
  }
  if (spec.intrinsicGaps.length > 0) {
    return { kind, sourceId: "capture", status: "unsupported", gapReasons: uniqueGaps(spec.intrinsicGaps) };
  }
  if (items.length === 0) {
    return { kind, sourceId: "capture", status: "unsupported", gapReasons: ["unsupported_source"] };
  }
  if (items.some((item) => item.readability === "unreadable")) {
    return { kind, sourceId: "capture", status: "unreadable", gapReasons: ["unreadable_artifact"] };
  }
  const unsupported = items.filter((item) => item.availability === "unsupported");
  const missing = items.filter((item) => item.availability === "missing");
  if (unsupported.length > 0) {
    return {
      kind,
      sourceId: "capture",
      status: "unsupported",
      gapReasons: uniqueGaps([
        ...unsupported.map((item) =>
          item.gapReason === undefined ? "unsupported_source" : evidenceGapReason(item),
        ),
        ...missing.map(evidenceGapReason),
      ]),
    };
  }
  if (items.some((item) => item.availability === "available")) {
    return {
      kind,
      sourceId: "capture",
      status: "unsupported",
      gapReasons: uniqueGaps([...missing.map(evidenceGapReason), "unsupported_source"]),
    };
  }
  return {
    kind,
    sourceId: "capture",
    status: "missing",
    gapReasons: uniqueGaps(items.map(evidenceGapReason)),
  };
}

function buildAuthorities(
  sources: readonly ProductionActivitySourceBatch[],
  uniqueCounts: ReadonlyMap<string, number>,
  evidence: ProductionEvidenceReport,
): TranscriptAuthoritySource[] {
  const authorities: TranscriptAuthoritySource[] = sources.map((source) => {
    const spec = SOURCE_AUTHORITY_MAP.get(source.kind) as SourceAuthoritySpec;
    const gaps = source.status === "not_configured"
      ? []
      : uniqueGaps([...source.gapReasons, ...spec.intrinsicGaps]);
    return {
      kind: source.kind,
      sourceId: source.sourceId,
      status: source.status,
      ...(source.status === "available"
        ? { authoritativeCount: uniqueCounts.get(`${source.kind}\0${source.sourceId}`) ?? 0 }
        : {}),
      gapReasons: gaps,
    };
  });
  const declaredKinds = new Set(sources.map(({ kind }) => kind));
  for (const kind of TRANSCRIPT_EXACT_SOURCE_KINDS) {
    if (!declaredKinds.has(kind)) authorities.push(inferOmittedAuthority(kind, evidence));
  }
  return authorities.sort((left, right) => {
    const kindOrder = TRANSCRIPT_SOURCE_KINDS.indexOf(left.kind) - TRANSCRIPT_SOURCE_KINDS.indexOf(right.kind);
    return kindOrder !== 0
      ? kindOrder
      : left.sourceId === right.sourceId
        ? 0
        : left.sourceId < right.sourceId
          ? -1
          : 1;
  });
}

export function compileProductionActivity(
  raw: unknown,
): Result<ProductionActivityCompilation, ProductionActivityCompilerError> {
  const encoded = tryCatch(() => JSON.stringify(raw));
  if (encoded.ok === false || typeof encoded.value !== "string") return invalid("input", "Production activity input cannot be serialized");
  if (Buffer.byteLength(encoded.value, "utf8") > MAX_PRODUCTION_ACTIVITY_INPUT_BYTES) {
    return invalid("input", "Production activity input exceeds its fixed byte limit");
  }
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, INPUT_KEYS) ||
    !isSafeId(raw.captureId) ||
    !isNonNegativeSafeInteger(raw.createdAtMs) ||
    (raw.target !== "deterministic_cassette" && raw.target !== "live_provider") ||
    !Array.isArray(raw.sources) ||
    raw.sources.length > MAX_ACTIVITY_SOURCES
  ) {
    return invalid("input", "Production activity compile header is invalid");
  }
  const evidenceResult = validateEvidence(raw.evidence);
  if (evidenceResult.ok === false) return err(evidenceResult.error);

  const sources: ProductionActivitySourceBatch[] = [];
  const sourceKeys = new Set<string>();
  let rawRecordCount = 0;
  for (const candidate of raw.sources) {
    const parsed = validateSourceBatch(candidate);
    if (parsed.ok === false) return err(parsed.error);
    const sequence = validateDeclaredSourceSequence(parsed.value);
    if (sequence.ok === false) return err(sequence.error);
    const key = `${parsed.value.kind}\0${parsed.value.sourceId}`;
    if (sourceKeys.has(key)) return invalid("sources", "Production activity source authority is duplicated");
    sourceKeys.add(key);
    rawRecordCount += parsed.value.records.length;
    if (rawRecordCount > MAX_PRODUCTION_ACTIVITY_RECORDS) {
      return invalid("records", "Normalized authority record count exceeds its fixed limit");
    }
    sources.push(parsed.value);
  }

  const nodes = new Map<string, ValidatedRecordNode>();
  const fingerprints = new Map<string, string>();
  const uniqueCounts = new Map<string, number>();
  let duplicateCount = 0;
  for (const source of sources) {
    for (const record of source.records) {
      const identity = sourceIdentity(source.kind, source.sourceId, record.recordId);
      const fingerprint = JSON.stringify(record);
      const prior = fingerprints.get(identity);
      if (prior !== undefined) {
        if (prior !== fingerprint) {
          return invalid("records", "Authoritative record identity has conflicting representations");
        }
        duplicateCount += 1;
        continue;
      }
      fingerprints.set(identity, fingerprint);
      nodes.set(identity, { identity, sourceKind: source.kind, sourceId: source.sourceId, record });
      const sourceKey = `${source.kind}\0${source.sourceId}`;
      uniqueCounts.set(sourceKey, (uniqueCounts.get(sourceKey) ?? 0) + 1);
    }
  }

  const orderResult = topologicalOrder(nodes);
  if (orderResult.ok === false) return err(orderResult.error);
  const sourceSequences = new Map<string, number>();
  const events: CanonicalProductionEvent[] = orderResult.value.map((node, index) => {
    const sourceKey = `${node.sourceKind}\0${node.sourceId}`;
    const sourceSeq = (sourceSequences.get(sourceKey) ?? 0) + 1;
    sourceSequences.set(sourceKey, sourceSeq);
    const parent = node.record.causalParent;
    const parentIdentity = parent === null
      ? null
      : sourceIdentity(parent.sourceKind, parent.sourceId, parent.recordId);
    const idempotencyMaterial = `${node.identity}\0${node.record.replay.payloadDigest}\0${node.record.replay.blobDigest ?? ""}`;
    return {
      seq: index + 1,
      source: { kind: node.sourceKind, id: node.sourceId, seq: sourceSeq },
      kind: node.record.eventKind,
      eventId: digestIdentity("comis-production-event-v1", node.identity),
      traceId: node.record.traceId,
      sessionId: node.record.sessionId,
      runId: node.record.runId,
      jobId: node.record.jobId,
      clockId: node.record.clockId,
      wallTimeMs: node.record.wallTimeMs,
      monotonicTimeNs: node.record.monotonicTimeNs,
      causalParentEventId: parentIdentity === null ? null : digestIdentity("comis-production-event-v1", parentIdentity),
      actor: node.record.actor,
      replay: {
        policy: node.record.replay.policy,
        idempotencyKey: digestIdentity("comis-production-idempotency-v1", idempotencyMaterial),
        payloadDigest: node.record.replay.payloadDigest,
        blobDigest: node.record.replay.blobDigest,
      },
    };
  });
  const transcript: CanonicalProductionTranscript = {
    schema: "comis-canonical-production-transcript",
    schemaVersion: 1,
    captureId: raw.captureId,
    createdAtMs: raw.createdAtMs,
    events,
  };
  const authorities = buildAuthorities(sources, uniqueCounts, evidenceResult.value);
  const completeness = classifyTranscriptCompleteness(transcript, authorities, raw.target);
  if (completeness.ok === false) {
    return invalid(
      completeness.error.kind === "malformed_transcript" && completeness.error.field === "causality"
        ? "causality"
        : "transcript",
      "Compiled activity transcript failed canonical validation",
    );
  }
  return ok({ transcript, authorities, completeness: completeness.value, duplicateCount });
}

function unsafeVaultInput(
  field: TargetLocalActivityBlobVaultPlanError["field"],
): Result<never, TargetLocalActivityBlobVaultPlanError> {
  return err({ kind: "unsafe_input", field, message: "Target-local activity vault input is unsafe" });
}

function isCanonicalAbsolutePath(value: string): boolean {
  return (
    isAbsolute(value) &&
    normalize(value) === value &&
    value !== "/" &&
    value.length <= 4096 &&
    !/[\0\r\n]/u.test(value)
  );
}

function isRunScopedRuntimePath(value: string): boolean {
  if (!value.startsWith("/run/")) return false;
  const relative = value.endsWith("/") ? value.slice(5, -1) : value.slice(5);
  const segments = relative.split("/");
  return (
    segments.length > 0 &&
    segments.every(
      (segment) => segment.length > 0 && /^[A-Za-z0-9._-]+$/u.test(segment),
    )
  );
}

export function buildTargetLocalActivityBlobVaultScript(): string {
  return String.raw`set -eu
expected_machine="$1"
service="$2"
service_user="$3"
data_dir="$4"
runtime_root="$5"
capture_id="$6"
channel="$7"
actual_machine="$(sha256sum /etc/machine-id | awk '{print $1}')"
if [ "$actual_machine" != "$expected_machine" ]; then
  printf '%s\n' 'target machine identity mismatch' >&2
  exit 71
fi
if [ "$(cat /etc/comis/environment-role 2>/dev/null || true)" != test ]; then
  printf '%s\n' 'target role marker is missing' >&2
  exit 72
fi
case "$service" in
  *.service) unit="$service" ;;
  *) unit="$service.service" ;;
esac
if [ "$(systemctl is-active "$unit" 2>/dev/null || true)" != inactive ]; then
  printf '%s\n' 'replay target service must be inactive during private extraction' >&2
  exit 73
fi
if [ ! -d "$data_dir" ] || [ -L "$data_dir" ]; then
  printf '%s\n' 'replay target data directory is absent or unsafe' >&2
  exit 74
fi
if [ -L "$runtime_root" ]; then
  printf '%s\n' 'replay runtime root is absent or unsafe' >&2
  exit 75
fi
if [ ! -e "$runtime_root" ]; then
  install -d -o root -g root -m 0700 "$runtime_root"
elif [ ! -d "$runtime_root" ]; then
  printf '%s\n' 'replay runtime root is absent or unsafe' >&2
  exit 75
fi
user_home="$(getent passwd "$service_user" | awk -F: '{print $6}')"
case "$user_home" in
  /*) ;;
  *) printf '%s\n' 'service user home is unavailable' >&2; exit 76 ;;
esac
comis_bin=""
for candidate in "$user_home/.npm-global/bin/comis" /usr/local/bin/comis /usr/bin/comis /opt/comis/bin/comis; do
  if [ -x "$candidate" ]; then
    comis_bin="$candidate"
    break
  fi
done
if [ -z "$comis_bin" ]; then
  printf '%s\n' 'offline comis CLI is unavailable for the service user' >&2
  exit 76
fi
vault_root="$runtime_root/activity-vault"
vault_dir="$vault_root/$capture_id"
vault_stage="$vault_root/.$capture_id.staging"
if [ -e "$vault_dir" ] || [ -e "$vault_stage" ] || [ -L "$vault_root" ]; then
  printf '%s\n' 'activity vault capture already exists or has an unsafe parent' >&2
  exit 76
fi
service_group="$(id -gn "$service_user")"
install -d -o "$service_user" -g "$service_group" -m 0700 "$vault_root"
install -d -o "$service_user" -g "$service_group" -m 0700 "$vault_stage"
cleanup() {
  if [ -d "$vault_stage" ]; then
    rm -rf --one-file-system -- "$vault_stage"
  fi
}
trap cleanup EXIT
trap 'exit 82' HUP INT TERM
runuser -u "$service_user" -- env COMIS_DATA_DIR="$data_dir" COMIS_ACTIVITY_COMIS_BIN="$comis_bin" node --input-type=module - "$vault_stage" "$channel" <<'COMIS_ACTIVITY_VAULT_NODE'
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const vaultDir = process.argv[2];
const channel = process.argv[3];
const comisBin = process.env.COMIS_ACTIVITY_COMIS_BIN;
if (typeof comisBin !== "string" || !comisBin.startsWith("/")) process.exit(74);
const args = ["messages"];
if (channel !== "-") args.push("--channel", channel);
args.push("--limit", "10000", "--include-internal", "--format", "json");
const extracted = spawnSync(comisBin, args, {
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
  env: process.env,
});
if (extracted.status !== 0 || extracted.error !== undefined) {
  process.stderr.write("offline message extraction failed\n");
  process.exit(75);
}
let messages;
try {
  messages = JSON.parse(extracted.stdout);
} catch {
  process.stderr.write("offline message extraction returned malformed JSON\n");
  process.exit(76);
}
if (!Array.isArray(messages) || messages.length > 10000) {
  process.stderr.write("offline message extraction exceeded its record contract\n");
  process.exit(77);
}
const blobsDir = resolve(vaultDir, "blobs");
writeFileSync(resolve(vaultDir, ".mode-check"), "", { mode: 0o600, flag: "wx" });
mkdirSync(blobsDir, { mode: 0o700 });
const indexPath = resolve(vaultDir, "offline-messages.digest.jsonl");
const indexFd = openSync(indexPath, "wx", 0o600);
const indexHash = createHash("sha256");
const privateIndexPath = resolve(vaultDir, "offline-messages.private.jsonl");
const privateIndexFd = openSync(privateIndexPath, "wx", 0o600);
const privateIndexHash = createHash("sha256");
const uniqueBlobs = new Set();
let contentBytes = 0;
try {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message === null || typeof message !== "object" || typeof message.text !== "string") {
      process.stderr.write("offline message record shape is invalid\n");
      process.exit(79);
    }
    const routingValues = [message.channelType, message.senderId, message.chatId, message.sessionKey];
    if (
      !Number.isSafeInteger(message.epochMs) ||
      message.epochMs < 0 ||
      !routingValues.every(
        (value) => typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 4096,
      ) ||
      (message.origin !== "user" && message.origin !== "internal")
    ) {
      process.stderr.write("offline message routing metadata is invalid\n");
      process.exit(79);
    }
    const body = Buffer.from(message.text, "utf8");
    const blobDigest = createHash("sha256").update(body).digest("hex");
    const blobPath = resolve(blobsDir, blobDigest);
    if (!blobPath.startsWith(blobsDir + "/")) process.exit(80);
    if (!uniqueBlobs.has(blobDigest)) {
      if (existsSync(blobPath)) {
        const stat = lstatSync(blobPath);
        if (!stat.isFile() || stat.isSymbolicLink()) process.exit(81);
      } else {
        writeFileSync(blobPath, body, { mode: 0o600, flag: "wx" });
      }
      uniqueBlobs.add(blobDigest);
      contentBytes += body.byteLength;
    }
    const actorIdDigest = createHash("sha256").update(message.senderId).digest("hex");
    const chatIdDigest = createHash("sha256").update(message.chatId).digest("hex");
    const sessionKeyDigest = createHash("sha256").update(message.sessionKey).digest("hex");
    const recordId = createHash("sha256").update(JSON.stringify({
      epochMs: message.epochMs,
      channelType: message.channelType,
      actorIdDigest,
      chatIdDigest,
      sessionKeyDigest,
      blobDigest,
    })).digest("hex");
    const metadata = {
      schema: "comis-private-activity-blob-ref",
      schemaVersion: 1,
      sourceKind: message.origin === "internal" ? "internal_dispatch" : "offline_messages",
      sourceSeq: index + 1,
      recordId,
      epochMs: message.epochMs,
      channelType: message.channelType,
      actorIdDigest,
      chatIdDigest,
      sessionKeyDigest,
      blobDigest,
    };
    const line = JSON.stringify(metadata) + "\n";
    writeSync(indexFd, line);
    indexHash.update(line);
    const privateLine = JSON.stringify({
      schema: "comis-private-activity-routing-ref",
      schemaVersion: 1,
      recordId,
      epochMs: message.epochMs,
      channelType: message.channelType,
      senderId: message.senderId,
      chatId: message.chatId,
      sessionKey: message.sessionKey,
      origin: message.origin,
      blobDigest,
    }) + "\n";
    writeSync(privateIndexFd, privateLine);
    privateIndexHash.update(privateLine);
  }
} finally {
  closeSync(indexFd);
  closeSync(privateIndexFd);
}
process.stdout.write(JSON.stringify({
  schema: "comis-private-activity-vault-summary",
  schemaVersion: 1,
  recordCount: messages.length,
  uniqueBlobCount: uniqueBlobs.size,
  contentBytes,
  indexDigestSha256: indexHash.digest("hex"),
  privateIndexDigestSha256: privateIndexHash.digest("hex"),
  gapReasons: messages.length === 10000
    ? ["partial_retention", "count_unknown"]
    : ["count_unknown"],
}) + "\n");
COMIS_ACTIVITY_VAULT_NODE
chmod 0600 "$vault_stage"/.mode-check "$vault_stage"/offline-messages.digest.jsonl "$vault_stage"/offline-messages.private.jsonl
find "$vault_stage/blobs" -type f -exec chmod 0600 {} +
chmod 0700 "$vault_root" "$vault_stage" "$vault_stage"/blobs
mv -- "$vault_stage" "$vault_dir"
trap - EXIT HUP INT TERM
`;
}

export function buildTargetLocalActivityBlobVaultPlan(
  input: TargetLocalActivityBlobVaultPlanInput,
): Result<TargetLocalActivityBlobVaultPlan, TargetLocalActivityBlobVaultPlanError> {
  if (!/^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/u.test(input.host)) return unsafeVaultInput("host");
  if (input.port !== undefined && (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65_535)) {
    return unsafeVaultInput("port");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9@_.-]{0,127}$/u.test(input.service)) return unsafeVaultInput("service");
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u.test(input.serviceUser)) return unsafeVaultInput("serviceUser");
  if (!isCanonicalAbsolutePath(input.dataDir)) return unsafeVaultInput("dataDir");
  if (
    !isCanonicalAbsolutePath(input.replayRuntimeRoot) ||
    !isRunScopedRuntimePath(input.replayRuntimeRoot)
  ) {
    return unsafeVaultInput("replayRuntimeRoot");
  }
  if (!isSafeId(input.captureId)) return unsafeVaultInput("captureId");
  if (!isDigest(input.expectedMachineIdSha256)) return unsafeVaultInput("expectedMachineIdSha256");
  if (input.channel !== undefined && !/^[a-z][a-z0-9_-]{0,31}$/u.test(input.channel)) return unsafeVaultInput("channel");
  const runtimeRoot = input.replayRuntimeRoot.endsWith("/")
    ? input.replayRuntimeRoot.slice(0, -1)
    : input.replayRuntimeRoot;
  const vaultDir = `${runtimeRoot}/activity-vault/${input.captureId}`;
  return ok({
    invocation: {
      label: "extract-private-activity-vault",
      host: input.host,
      ...(input.port !== undefined ? { port: input.port } : {}),
      args: [
        "sudo",
        "--non-interactive",
        "--",
        "bash",
        "-s",
        "--",
        input.expectedMachineIdSha256,
        input.service,
        input.serviceUser,
        input.dataDir,
        runtimeRoot,
        input.captureId,
        input.channel ?? "-",
      ],
      stdin: buildTargetLocalActivityBlobVaultScript(),
      stdoutLimitBytes: 32_768,
    },
    vaultDir,
    sourceKinds: ["offline_messages", "internal_dispatch"],
    stdoutDisposition: "counts_digests_and_gaps_only",
    rawContentDisposition: "target_private_files_only",
    fileMode: "0600",
    directoryMode: "0700",
  });
}
