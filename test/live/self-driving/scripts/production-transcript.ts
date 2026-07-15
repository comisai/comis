// SPDX-License-Identifier: Apache-2.0
import { err, ok, tryCatch, type Result } from "@comis/shared";

export const CANONICAL_TRANSCRIPT_BEGIN = "COMIS_CANONICAL_PRODUCTION_TRANSCRIPT_V1_BEGIN";
export const CANONICAL_TRANSCRIPT_END = "COMIS_CANONICAL_PRODUCTION_TRANSCRIPT_V1_END";
export const MAX_CANONICAL_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const MAX_TRANSCRIPT_EVENTS = 100_000;

export const TRANSCRIPT_EVENT_KINDS = [
  "channel.native.text_received",
  "channel.native.media_received",
  "channel.native.reply_received",
  "channel.native.edit_received",
  "channel.native.reaction_received",
  "channel.native.callback_received",
  "channel.native.location_received",
  "channel.native.webhook_received",
  "channel.normalized.text_received",
  "channel.normalized.media_received",
  "channel.normalized.reply_received",
  "channel.normalized.edit_received",
  "channel.normalized.reaction_received",
  "channel.normalized.callback_received",
  "channel.normalized.location_received",
  "channel.normalized.webhook_received",
  "ingress.gate.admitted",
  "ingress.gate.rejected",
  "ingress.dedupe.accepted",
  "ingress.dedupe.dropped",
  "ingress.coalesce.buffered",
  "ingress.coalesce.flushed",
  "ingress.queue.enqueued",
  "ingress.queue.dequeued",
  "ingress.queue.dropped",
  "cron.revision.created",
  "cron.revision.updated",
  "cron.revision.deleted",
  "cron.fire.started",
  "cron.fire.skipped",
  "cron.fire.completed",
  "cron.result.succeeded",
  "cron.result.failed",
  "heartbeat.requested",
  "heartbeat.started",
  "heartbeat.skipped",
  "heartbeat.completed",
  "heartbeat.failed",
  "proactive.triggered",
  "proactive.dispatched",
  "proactive.dropped",
  "system.dispatch.enqueued",
  "system.dispatch.started",
  "system.dispatch.completed",
  "system.dispatch.failed",
  "internal.dispatch.enqueued",
  "internal.dispatch.started",
  "internal.dispatch.completed",
  "internal.dispatch.failed",
  "subagent.spawn.requested",
  "subagent.started",
  "subagent.completed",
  "subagent.failed",
  "subagent.cancelled",
  "subagent.result.persisted",
  "subagent.delivery.attempted",
  "subagent.delivery.retried",
  "subagent.delivery.acknowledged",
  "subagent.delivery.failed",
  "graph.started",
  "graph.node.started",
  "graph.node.completed",
  "graph.node.failed",
  "graph.checkpointed",
  "graph.completed",
  "graph.failed",
  "graph.cancelled",
  "durable.run.created",
  "durable.run.checkpointed",
  "durable.run.resumed",
  "durable.run.completed",
  "durable.run.orphaned",
  "durable.run.revoked",
  "daemon.restart.detected",
  "daemon.shutdown.started",
  "daemon.shutdown.completed",
  "daemon.recovery.started",
  "daemon.recovery.completed",
  "model.request.started",
  "model.request.completed",
  "model.request.failed",
  "model.response.started",
  "model.response.completed",
  "model.response.failed",
  "model.retry.scheduled",
  "tool.call.started",
  "tool.call.completed",
  "tool.call.failed",
  "mcp.call.started",
  "mcp.call.completed",
  "mcp.call.failed",
  "web.fetch.started",
  "web.fetch.completed",
  "web.fetch.failed",
  "media.resolve.started",
  "media.resolve.completed",
  "media.resolve.failed",
  "media.transcription.started",
  "media.transcription.completed",
  "media.transcription.failed",
  "media.analysis.started",
  "media.analysis.completed",
  "media.analysis.failed",
  "media.generation.started",
  "media.generation.completed",
  "media.generation.failed",
  "cache.read.hit",
  "cache.read.miss",
  "cache.write.started",
  "cache.write.completed",
  "cache.write.failed",
  "cache.break.detected",
  "cache.invalidated",
  "memory.recall.started",
  "memory.recall.completed",
  "memory.recall.failed",
  "memory.write.accepted",
  "memory.write.blocked",
  "memory.updated",
  "memory.deleted",
  "memory.usefulness.recorded",
  "learning.observation.recorded",
  "learning.admission.accepted",
  "learning.admission.rejected",
  "learning.consolidation.completed",
  "learning.consolidation.failed",
  "learning.outcome.recorded",
  "context.assembled",
  "context.compacted",
  "context.truncated",
  "session.started",
  "session.turn.started",
  "session.turn.completed",
  "session.turn.failed",
  "session.ended",
  "session.reset",
  "lcd.message.appended",
  "lcd.part.appended",
  "lcd.summary.created",
  "lcd.context.rewritten",
  "lcd.memory.distilled",
  "lcd.reset",
  "outbound.attempt.started",
  "outbound.retry.scheduled",
  "outbound.retry.started",
  "outbound.delivered",
  "outbound.acknowledged",
  "outbound.failed",
  "outbound.mirror.persisted",
  "outbound.mirror.acknowledged",
  "state.mutation.requested",
  "state.mutation.committed",
  "state.mutation.failed",
  "config.read.started",
  "config.read.completed",
  "config.read.failed",
  "config.write.requested",
  "config.write.committed",
  "config.write.rejected",
  "config.write.failed",
  "config.reload.started",
  "config.reload.completed",
  "config.reload.failed",
  "trajectory.append.started",
  "trajectory.append.completed",
  "trajectory.append.failed",
  "trajectory.offload.started",
  "trajectory.offload.completed",
  "trajectory.offload.failed",
  "trajectory.pointer.resolved",
  "trajectory.pointer.updated",
  "trajectory.pointer.rejected",
  "trajectory.checkpoint.started",
  "trajectory.checkpoint.created",
  "trajectory.checkpoint.failed",
  "audit.secret.access.granted",
  "audit.secret.access.denied",
  "audit.authentication.accepted",
  "audit.authentication.rejected",
  "audit.injection.allowed",
  "audit.injection.blocked",
  "audit.capability.granted",
  "audit.capability.denied",
  "audit.command.allowed",
  "audit.command.blocked",
  "diagnostics.snapshot.started",
  "diagnostics.snapshot.created",
  "diagnostics.snapshot.failed",
  "diagnostics.event.persisted",
  "diagnostics.event.dropped",
  "background.task.enqueued",
  "background.task.started",
  "background.task.completed",
  "background.task.failed",
  "background.task.cancelled",
  "background.timer.scheduled",
  "background.timer.fired",
  "background.timer.cancelled",
  "runtime.artifact.discovered",
  "runtime.artifact.verification.started",
  "runtime.artifact.verified",
  "runtime.artifact.promoted",
  "runtime.artifact.rejected",
  "runtime.artifact.promotion.failed",
  "operator.action.requested",
  "operator.action.completed",
  "operator.action.rejected",
  "operator.action.failed",
  "rpc.request.received",
  "rpc.request.completed",
  "rpc.request.rejected",
  "rpc.request.failed",
  "admin.action.requested",
  "admin.action.authorized",
  "admin.action.rejected",
  "admin.action.completed",
  "admin.action.failed",
  "determinism.clock.consumed",
  "determinism.clock.exhausted",
  "determinism.random.consumed",
  "determinism.random.exhausted",
  "determinism.identifier.consumed",
  "determinism.identifier.exhausted",
  "dependency.request.started",
  "dependency.request.completed",
  "dependency.request.failed",
  "dependency.request.cancelled",
  "channel.outbound.request.started",
  "channel.outbound.request.completed",
  "channel.outbound.request.failed",
  "channel.outbound.request.cancelled",
  "filesystem.read.started",
  "filesystem.read.completed",
  "filesystem.read.failed",
  "filesystem.write.started",
  "filesystem.write.completed",
  "filesystem.write.failed",
  "filesystem.list.started",
  "filesystem.list.completed",
  "filesystem.list.failed",
  "filesystem.metadata.started",
  "filesystem.metadata.completed",
  "filesystem.metadata.failed",
  "filesystem.rename.started",
  "filesystem.rename.completed",
  "filesystem.rename.failed",
  "filesystem.remove.started",
  "filesystem.remove.completed",
  "filesystem.remove.failed",
  "environment.read.started",
  "environment.read.completed",
  "environment.read.rejected",
  "external.io.network.started",
  "external.io.network.completed",
  "external.io.network.failed",
  "external.io.process.started",
  "external.io.process.completed",
  "external.io.process.failed",
  "external.io.stream.started",
  "external.io.stream.completed",
  "external.io.stream.failed",
  "external.io.ipc.started",
  "external.io.ipc.completed",
  "external.io.ipc.failed",
] as const;

export const TRANSCRIPT_SOURCE_KINDS = [
  "offline_messages",
  "channel_native",
  "channel_normalized",
  "orchestrator",
  "cron_store",
  "cron_execution",
  "heartbeat",
  "proactive",
  "system_dispatch",
  "internal_dispatch",
  "subagent",
  "graph",
  "durable_run",
  "daemon",
  "model_provider",
  "tool_runtime",
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
  "config",
  "trajectory",
  "audit",
  "diagnostics",
  "background",
  "runtime_artifact",
  "operator",
  "rpc",
  "admin",
  "deterministic_clock",
  "deterministic_random",
  "deterministic_identifier",
  "dependency",
  "channel_outbound",
  "filesystem",
  "environment",
  "external_io",
  "replay",
] as const;

export type TranscriptEventKind = (typeof TRANSCRIPT_EVENT_KINDS)[number];
export type TranscriptSourceKind = (typeof TRANSCRIPT_SOURCE_KINDS)[number];
export type TranscriptReplayPolicy = "inject" | "stub" | "assert" | "execute" | "observe" | "skip";
export type TranscriptActorKind =
  | "user"
  | "agent"
  | "system"
  | "service"
  | "scheduler"
  | "subagent"
  | "provider"
  | "operator";
export type TranscriptTrust = "guest" | "user" | "admin" | "system" | "external";
export const TRANSCRIPT_ORIGINS = [
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
  "config",
  "trajectory",
  "audit",
  "diagnostics",
  "background",
  "runtime_artifact",
  "operator",
  "rpc",
  "admin",
  "determinism",
  "dependency",
  "channel_outbound",
  "filesystem",
  "environment",
  "external_io",
  "daemon",
  "replay",
] as const;
export type TranscriptOrigin = (typeof TRANSCRIPT_ORIGINS)[number];

export const TRANSCRIPT_SOURCE_EVENT_PREFIXES = {
  offline_messages: ["channel.normalized."],
  channel_native: ["channel.native."],
  channel_normalized: ["channel.normalized."],
  orchestrator: ["ingress."],
  cron_store: ["cron.revision."],
  cron_execution: ["cron.fire.", "cron.result."],
  heartbeat: ["heartbeat."],
  proactive: ["proactive."],
  system_dispatch: ["system.dispatch."],
  internal_dispatch: ["internal.dispatch."],
  subagent: ["subagent."],
  graph: ["graph."],
  durable_run: ["durable.run."],
  daemon: ["daemon."],
  model_provider: ["model."],
  tool_runtime: ["tool.call."],
  mcp: ["mcp.call."],
  web: ["web.fetch."],
  media: ["media."],
  cache: ["cache."],
  memory: ["memory."],
  learning: ["learning."],
  context: ["context."],
  session: ["session."],
  lcd: ["lcd."],
  delivery: ["outbound."],
  state: ["state."],
  config: ["config."],
  trajectory: ["trajectory."],
  audit: ["audit."],
  diagnostics: ["diagnostics."],
  background: ["background."],
  runtime_artifact: ["runtime.artifact."],
  operator: ["operator."],
  rpc: ["rpc."],
  admin: ["admin."],
  deterministic_clock: ["determinism.clock."],
  deterministic_random: ["determinism.random."],
  deterministic_identifier: ["determinism.identifier."],
  dependency: ["dependency."],
  channel_outbound: ["channel.outbound."],
  filesystem: ["filesystem."],
  environment: ["environment."],
  external_io: ["external.io."],
  replay: ["replay."],
} as const satisfies Record<TranscriptSourceKind, readonly string[]>;

export interface CanonicalProductionEvent {
  readonly seq: number;
  readonly source: {
    readonly kind: TranscriptSourceKind;
    readonly id: string;
    readonly seq: number;
  };
  readonly kind: TranscriptEventKind;
  readonly eventId: string;
  readonly traceId: string | null;
  readonly sessionId: string | null;
  readonly runId: string | null;
  readonly jobId: string | null;
  readonly clockId: string;
  readonly wallTimeMs: number;
  readonly monotonicTimeNs: string;
  readonly causalParentEventId: string | null;
  readonly actor: {
    readonly kind: TranscriptActorKind;
    readonly id: string | null;
    readonly trust: TranscriptTrust;
    readonly origin: TranscriptOrigin;
  };
  readonly replay: {
    readonly policy: TranscriptReplayPolicy;
    readonly idempotencyKey: string;
    readonly payloadDigest: string;
    readonly blobDigest: string | null;
  };
}

export interface CanonicalProductionTranscript {
  readonly schema: "comis-canonical-production-transcript";
  readonly schemaVersion: 1;
  readonly captureId: string;
  readonly createdAtMs: number;
  readonly events: readonly CanonicalProductionEvent[];
}

export type CanonicalTranscriptError =
  | {
      readonly kind: "malformed_transcript";
      readonly field: "envelope" | "header" | "events" | "sequence" | "causality";
      readonly message: string;
    }
  | {
      readonly kind: "invalid_authority";
      readonly field: "authorities";
      readonly message: string;
    };

export type TranscriptCaptureGapReason =
  | "missing_artifact"
  | "unreadable_artifact"
  | "unsupported_source"
  | "partial_retention"
  | "rotation_loss"
  | "queue_drop"
  | "scan_limit"
  | "external_path_unscanned"
  | "non_durable"
  | "count_unknown"
  | "timestamp_gap"
  | "capture_error";

export interface TranscriptAuthoritySource {
  readonly kind: TranscriptSourceKind;
  readonly sourceId: string;
  readonly status: "available" | "missing" | "unreadable" | "unsupported" | "not_configured";
  readonly authoritativeCount?: number;
  readonly gapReasons: readonly TranscriptCaptureGapReason[];
}

export type TranscriptFidelity =
  | "historical_best_effort"
  | "complete_input"
  | "state_equivalent"
  | "deterministic_cassette_exact"
  | "live_provider_semantic";

export interface TranscriptCompletenessGap {
  readonly sourceKind: TranscriptSourceKind;
  readonly sourceId?: string;
  readonly reason:
    | "required_source_omitted"
    | "source_missing"
    | "source_unreadable"
    | "source_unsupported"
    | "count_mismatch"
    | "declared_gap";
  readonly captureGap?: TranscriptCaptureGapReason;
  readonly authoritativeCount?: number;
  readonly transcriptCount?: number;
}

export interface TranscriptCompletenessReport {
  readonly fidelity: TranscriptFidelity;
  readonly target: "deterministic_cassette" | "live_provider";
  readonly exactEligible: boolean;
  readonly inputComplete: boolean;
  readonly stateComplete: boolean;
  readonly exactSourcesComplete: boolean;
  readonly authoritativeCount: number;
  readonly transcriptCount: number;
  readonly gaps: readonly TranscriptCompletenessGap[];
}

export interface OfflineMessagesSourcePlanInput {
  readonly host: string;
  readonly port?: number;
  readonly serviceUser: string;
  readonly channel: string;
}

export interface OfflineMessagesSourcePlan {
  readonly required: true;
  readonly host: string;
  readonly port?: number;
  readonly runAsUser: string;
  readonly command: readonly string[];
  readonly sourceKind: "offline_messages";
  readonly stdoutDisposition: "private_blob_store_only";
  readonly renderPolicy: "counts_digests_and_gaps_only";
}

export interface OfflineMessagesSourcePlanError {
  readonly kind: "unsafe_input";
  readonly field: "host" | "port" | "serviceUser" | "channel";
  readonly message: string;
}

const INPUT_SOURCE_KINDS = [
  "offline_messages",
  "cron_store",
  "cron_execution",
  "heartbeat",
  "proactive",
  "system_dispatch",
] as const satisfies readonly TranscriptSourceKind[];

const STATE_SOURCE_KINDS = [
  ...INPUT_SOURCE_KINDS,
  "session",
  "lcd",
  "delivery",
  "memory",
  "durable_run",
  "state",
  "config",
] as const satisfies readonly TranscriptSourceKind[];

export const TRANSCRIPT_EXACT_SOURCE_KINDS = [
  ...STATE_SOURCE_KINDS,
  "channel_native",
  "channel_normalized",
  "orchestrator",
  "internal_dispatch",
  "subagent",
  "graph",
  "daemon",
  "model_provider",
  "tool_runtime",
  "mcp",
  "web",
  "media",
  "cache",
  "learning",
  "context",
  "trajectory",
  "audit",
  "diagnostics",
  "background",
  "runtime_artifact",
  "operator",
  "rpc",
  "admin",
  "deterministic_clock",
  "deterministic_random",
  "deterministic_identifier",
  "dependency",
  "channel_outbound",
  "filesystem",
  "environment",
  "external_io",
] as const satisfies readonly TranscriptSourceKind[];

const EVENT_KIND_VALUES = new Set<string>(TRANSCRIPT_EVENT_KINDS);
const SOURCE_KIND_VALUES = new Set<string>(TRANSCRIPT_SOURCE_KINDS);
const SOURCE_EVENT_PREFIXES = new Map<TranscriptSourceKind, readonly string[]>(
  Object.entries(TRANSCRIPT_SOURCE_EVENT_PREFIXES) as Array<
    [TranscriptSourceKind, readonly string[]]
  >,
);
const REPLAY_POLICY_VALUES = new Set<string>(["inject", "stub", "assert", "execute", "observe", "skip"]);
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
const ORIGIN_VALUES = new Set<string>(TRANSCRIPT_ORIGINS);
const AUTHORITY_STATUS_VALUES = new Set<string>([
  "available",
  "missing",
  "unreadable",
  "unsupported",
  "not_configured",
]);
const CAPTURE_GAP_VALUES = new Set<string>([
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

const HEADER_KEYS = ["schema", "schemaVersion", "captureId", "createdAtMs", "events"] as const;
const EVENT_KEYS = [
  "seq",
  "source",
  "kind",
  "eventId",
  "traceId",
  "sessionId",
  "runId",
  "jobId",
  "clockId",
  "wallTimeMs",
  "monotonicTimeNs",
  "causalParentEventId",
  "actor",
  "replay",
] as const;
const SOURCE_KEYS = ["kind", "id", "seq"] as const;
const ACTOR_KEYS = ["kind", "id", "trust", "origin"] as const;
const REPLAY_KEYS = ["policy", "idempotencyKey", "payloadDigest", "blobDigest"] as const;
const AUTHORITY_KEYS = ["kind", "sourceId", "status", "authoritativeCount", "gapReasons"] as const;
const AUTHORITY_REQUIRED_KEYS = ["kind", "sourceId", "status", "gapReasons"] as const;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MONOTONIC_PATTERN = /^(?:0|[1-9][0-9]{0,29})$/u;

function malformed(
  field: "envelope" | "header" | "events" | "sequence" | "causality",
  message: string,
): Result<never, CanonicalTranscriptError> {
  return err({ kind: "malformed_transcript", field, message });
}

function invalidAuthority(): Result<never, CanonicalTranscriptError> {
  return err({
    kind: "invalid_authority",
    field: "authorities",
    message: "Transcript authority declaration is invalid",
  });
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

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
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

function requiresTraceAndSession(kind: TranscriptEventKind): boolean {
  return /^(?:channel\.|ingress\.|heartbeat\.|proactive\.|system\.dispatch\.|internal\.dispatch\.|subagent\.|graph\.|model\.|tool\.|mcp\.|web\.|media\.|cache\.|memory\.|learning\.|context\.|session\.|lcd\.|outbound\.)/u.test(
    kind,
  );
}

function requiresRun(kind: TranscriptEventKind): boolean {
  return /^(?:subagent\.|graph\.|model\.|tool\.|mcp\.|web\.|media\.|cache\.|memory\.|learning\.|context\.|session\.turn\.|lcd\.|outbound\.)/u.test(
    kind,
  );
}

function validateEvent(raw: unknown): Result<CanonicalProductionEvent, CanonicalTranscriptError> {
  if (!isRecord(raw) || !hasExactKeys(raw, EVENT_KEYS, EVENT_KEYS)) {
    return malformed("events", "Transcript event shape is invalid");
  }
  if (
    !isPositiveSafeInteger(raw.seq) ||
    typeof raw.kind !== "string" ||
    !EVENT_KIND_VALUES.has(raw.kind) ||
    !isSafeId(raw.eventId) ||
    !isNullableSafeId(raw.traceId) ||
    !isNullableSafeId(raw.sessionId) ||
    !isNullableSafeId(raw.runId) ||
    !isNullableSafeId(raw.jobId) ||
    !isSafeId(raw.clockId) ||
    !isNonNegativeSafeInteger(raw.wallTimeMs) ||
    typeof raw.monotonicTimeNs !== "string" ||
    !MONOTONIC_PATTERN.test(raw.monotonicTimeNs) ||
    !isNullableSafeId(raw.causalParentEventId)
  ) {
    return malformed("events", "Transcript event scalar field is invalid");
  }
  if (
    !isRecord(raw.source) ||
    !hasExactKeys(raw.source, SOURCE_KEYS, SOURCE_KEYS) ||
    typeof raw.source.kind !== "string" ||
    !SOURCE_KIND_VALUES.has(raw.source.kind) ||
    !isSafeId(raw.source.id) ||
    !isPositiveSafeInteger(raw.source.seq)
  ) {
    return malformed("events", "Transcript event source is invalid");
  }
  if (
    !isRecord(raw.actor) ||
    !hasExactKeys(raw.actor, ACTOR_KEYS, ACTOR_KEYS) ||
    typeof raw.actor.kind !== "string" ||
    !ACTOR_KIND_VALUES.has(raw.actor.kind) ||
    !isNullableSafeId(raw.actor.id) ||
    typeof raw.actor.trust !== "string" ||
    !TRUST_VALUES.has(raw.actor.trust) ||
    typeof raw.actor.origin !== "string" ||
    !ORIGIN_VALUES.has(raw.actor.origin)
  ) {
    return malformed("events", "Transcript event actor is invalid");
  }
  const sourceKind = raw.source.kind as TranscriptSourceKind;
  const eventKind = raw.kind as TranscriptEventKind;
  if (!(SOURCE_EVENT_PREFIXES.get(sourceKind) ?? []).some((prefix) => eventKind.startsWith(prefix))) {
    return malformed("events", "Transcript event kind is incompatible with its authority source");
  }
  if (
    !isRecord(raw.replay) ||
    !hasExactKeys(raw.replay, REPLAY_KEYS, REPLAY_KEYS) ||
    typeof raw.replay.policy !== "string" ||
    !REPLAY_POLICY_VALUES.has(raw.replay.policy) ||
    !isDigest(raw.replay.idempotencyKey) ||
    !isDigest(raw.replay.payloadDigest) ||
    (raw.replay.blobDigest !== null && !isDigest(raw.replay.blobDigest))
  ) {
    return malformed("events", "Transcript event replay metadata is invalid");
  }

  const kind = raw.kind as TranscriptEventKind;
  if (requiresTraceAndSession(kind) && (raw.traceId === null || raw.sessionId === null)) {
    return malformed("events", "Transcript event is missing applicable trace or session identifiers");
  }
  if (requiresRun(kind) && raw.runId === null) {
    return malformed("events", "Transcript event is missing an applicable run identifier");
  }
  if (kind.startsWith("cron.") && raw.jobId === null) {
    return malformed("events", "Cron transcript event is missing its job identifier");
  }
  if (/^channel\.(?:native|normalized)\.media_received$/u.test(kind) && raw.replay.blobDigest === null) {
    return malformed("events", "Channel media transcript event is missing its blob digest");
  }
  return ok(raw as unknown as CanonicalProductionEvent);
}

function validateSequenceAndCausality(
  events: readonly CanonicalProductionEvent[],
): Result<void, CanonicalTranscriptError> {
  const eventIds = new Set<string>();
  const sourceSequences = new Map<string, number>();
  const clockTimes = new Map<string, bigint>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events.at(index) as CanonicalProductionEvent;
    if (event.seq !== index + 1 || eventIds.has(event.eventId)) {
      return malformed("sequence", "Transcript global sequence or event identity is invalid");
    }
    const sourceKey = `${event.source.kind}\0${event.source.id}`;
    const priorSourceSequence = sourceSequences.get(sourceKey) ?? 0;
    if (event.source.seq !== priorSourceSequence + 1) {
      return malformed("sequence", "Transcript source sequence is not contiguous");
    }
    if (event.causalParentEventId !== null && !eventIds.has(event.causalParentEventId)) {
      return malformed("causality", "Transcript causal parent must precede its child");
    }
    const monotonicTime = BigInt(event.monotonicTimeNs);
    const priorClockTime = clockTimes.get(event.clockId);
    if (priorClockTime !== undefined && monotonicTime < priorClockTime) {
      return malformed("sequence", "Transcript monotonic time regresses within a clock epoch");
    }
    eventIds.add(event.eventId);
    sourceSequences.set(sourceKey, event.source.seq);
    clockTimes.set(event.clockId, monotonicTime);
  }
  return ok(undefined);
}

export function parseCanonicalProductionTranscript(
  raw: string,
): Result<CanonicalProductionTranscript, CanonicalTranscriptError> {
  if (Buffer.byteLength(raw, "utf8") > MAX_CANONICAL_TRANSCRIPT_BYTES) {
    return malformed("envelope", "Canonical transcript exceeds its fixed byte limit");
  }
  if (raw.includes("\r") || raw.includes("\0")) {
    return malformed("envelope", "Canonical transcript contains unsupported control bytes");
  }
  const normalized = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  const lines = normalized.split("\n");
  if (
    lines.length !== 3 ||
    lines.at(0) !== CANONICAL_TRANSCRIPT_BEGIN ||
    lines.at(2) !== CANONICAL_TRANSCRIPT_END
  ) {
    return malformed("envelope", "Canonical transcript is missing its exact versioned envelope");
  }
  const decoded = tryCatch(() => JSON.parse(lines.at(1) as string) as unknown);
  if (!decoded.ok || !isRecord(decoded.value) || !hasExactKeys(decoded.value, HEADER_KEYS, HEADER_KEYS)) {
    return malformed("header", "Canonical transcript header is not strict JSON");
  }
  const value = decoded.value;
  if (
    value.schema !== "comis-canonical-production-transcript" ||
    value.schemaVersion !== 1 ||
    !isSafeId(value.captureId) ||
    !isNonNegativeSafeInteger(value.createdAtMs) ||
    !Array.isArray(value.events) ||
    value.events.length > MAX_TRANSCRIPT_EVENTS
  ) {
    return malformed("header", "Canonical transcript header is invalid");
  }

  const events: CanonicalProductionEvent[] = [];
  for (const rawEvent of value.events) {
    const parsed = validateEvent(rawEvent);
    if (!parsed.ok) return parsed;
    events.push(parsed.value);
  }
  const sequence = validateSequenceAndCausality(events);
  if (!sequence.ok) return sequence;
  return ok({
    schema: "comis-canonical-production-transcript",
    schemaVersion: 1,
    captureId: value.captureId,
    createdAtMs: value.createdAtMs,
    events,
  });
}

function transcriptSourceKey(kind: TranscriptSourceKind, sourceId: string): string {
  return `${kind}\0${sourceId}`;
}

function validateAuthoritySources(
  authorities: readonly TranscriptAuthoritySource[],
): Result<readonly TranscriptAuthoritySource[], CanonicalTranscriptError> {
  if (authorities.length > MAX_TRANSCRIPT_EVENTS) return invalidAuthority();
  const keys = new Set<string>();
  const validated: TranscriptAuthoritySource[] = [];
  for (const raw of authorities as readonly unknown[]) {
    if (
      !isRecord(raw) ||
      !hasExactKeys(raw, AUTHORITY_KEYS, AUTHORITY_REQUIRED_KEYS) ||
      typeof raw.kind !== "string" ||
      !SOURCE_KIND_VALUES.has(raw.kind) ||
      !isSafeId(raw.sourceId) ||
      typeof raw.status !== "string" ||
      !AUTHORITY_STATUS_VALUES.has(raw.status) ||
      !Array.isArray(raw.gapReasons) ||
      raw.gapReasons.length > 32 ||
      raw.gapReasons.some(
        (reason) => typeof reason !== "string" || !CAPTURE_GAP_VALUES.has(reason),
      )
    ) {
      return invalidAuthority();
    }
    const status = raw.status as TranscriptAuthoritySource["status"];
    if (
      (status === "available" && !isNonNegativeSafeInteger(raw.authoritativeCount)) ||
      (status !== "available" && raw.authoritativeCount !== undefined) ||
      new Set(raw.gapReasons).size !== raw.gapReasons.length ||
      (status === "not_configured" && raw.gapReasons.length !== 0)
    ) {
      return invalidAuthority();
    }
    const kind = raw.kind as TranscriptSourceKind;
    const key = transcriptSourceKey(kind, raw.sourceId);
    if (keys.has(key)) return invalidAuthority();
    keys.add(key);
    validated.push(raw as unknown as TranscriptAuthoritySource);
  }
  return ok(validated);
}

function validateTypedTranscript(
  transcript: CanonicalProductionTranscript,
): Result<CanonicalProductionTranscript, CanonicalTranscriptError> {
  const encoded = tryCatch(() => JSON.stringify(transcript));
  if (!encoded.ok || typeof encoded.value !== "string") {
    return malformed("header", "Canonical transcript cannot be serialized");
  }
  return parseCanonicalProductionTranscript(
    `${CANONICAL_TRANSCRIPT_BEGIN}\n${encoded.value}\n${CANONICAL_TRANSCRIPT_END}\n`,
  );
}

function sourceTierComplete(
  required: readonly TranscriptSourceKind[],
  declaredKinds: ReadonlySet<TranscriptSourceKind>,
  gaps: readonly TranscriptCompletenessGap[],
): boolean {
  return required.every(
    (kind) => declaredKinds.has(kind) && !gaps.some((gap) => gap.sourceKind === kind),
  );
}

export function classifyTranscriptCompleteness(
  captured: CanonicalProductionTranscript,
  authorities: readonly TranscriptAuthoritySource[],
  target: "deterministic_cassette" | "live_provider",
): Result<TranscriptCompletenessReport, CanonicalTranscriptError> {
  const transcriptResult = validateTypedTranscript(captured);
  if (!transcriptResult.ok) return transcriptResult;
  const authorityResult = validateAuthoritySources(authorities);
  if (!authorityResult.ok) return authorityResult;

  const transcriptCounts = new Map<string, number>();
  const transcriptSources = new Map<
    string,
    { readonly kind: TranscriptSourceKind; readonly sourceId: string }
  >();
  for (const event of transcriptResult.value.events) {
    const key = transcriptSourceKey(event.source.kind, event.source.id);
    transcriptCounts.set(key, (transcriptCounts.get(key) ?? 0) + 1);
    transcriptSources.set(key, { kind: event.source.kind, sourceId: event.source.id });
  }

  const declaredKinds = new Set<TranscriptSourceKind>();
  const declaredSourceKeys = new Set<string>();
  const gaps: TranscriptCompletenessGap[] = [];
  for (const source of authorityResult.value) {
    declaredKinds.add(source.kind);
    const sourceKey = transcriptSourceKey(source.kind, source.sourceId);
    declaredSourceKeys.add(sourceKey);
    const transcriptCount = transcriptCounts.get(sourceKey) ?? 0;
    if (source.status === "available") {
      const expected = source.authoritativeCount as number;
      if (expected !== transcriptCount) {
        gaps.push({
          sourceKind: source.kind,
          sourceId: source.sourceId,
          reason: "count_mismatch",
          authoritativeCount: expected,
          transcriptCount,
        });
      }
    } else if (source.status === "missing") {
      gaps.push({ sourceKind: source.kind, sourceId: source.sourceId, reason: "source_missing" });
    } else if (source.status === "unreadable") {
      gaps.push({ sourceKind: source.kind, sourceId: source.sourceId, reason: "source_unreadable" });
    } else if (source.status === "unsupported") {
      gaps.push({ sourceKind: source.kind, sourceId: source.sourceId, reason: "source_unsupported" });
    } else if (transcriptCount !== 0 || source.kind === "offline_messages") {
      gaps.push({
        sourceKind: source.kind,
        sourceId: source.sourceId,
        reason: transcriptCount === 0 ? "source_missing" : "count_mismatch",
        ...(transcriptCount === 0
          ? {}
          : { authoritativeCount: 0, transcriptCount }),
      });
    }
    for (const captureGap of source.gapReasons) {
      gaps.push({
        sourceKind: source.kind,
        sourceId: source.sourceId,
        reason: "declared_gap",
        captureGap,
      });
    }
  }

  for (const [sourceKey, source] of transcriptSources) {
    if (!declaredSourceKeys.has(sourceKey)) {
      gaps.push({
        sourceKind: source.kind,
        sourceId: source.sourceId,
        reason: "required_source_omitted",
      });
    }
  }

  for (const requiredKind of TRANSCRIPT_EXACT_SOURCE_KINDS) {
    if (!declaredKinds.has(requiredKind)) {
      gaps.push({ sourceKind: requiredKind, reason: "required_source_omitted" });
    }
  }

  const inputComplete = sourceTierComplete(INPUT_SOURCE_KINDS, declaredKinds, gaps);
  const stateComplete = inputComplete && sourceTierComplete(STATE_SOURCE_KINDS, declaredKinds, gaps);
  const exactSourcesComplete =
    stateComplete && sourceTierComplete(TRANSCRIPT_EXACT_SOURCE_KINDS, declaredKinds, gaps);
  const exactEligible = exactSourcesComplete && gaps.length === 0;

  let fidelity: TranscriptFidelity;
  if (!inputComplete) fidelity = "historical_best_effort";
  else if (!stateComplete) fidelity = "complete_input";
  else if (target === "live_provider") fidelity = "live_provider_semantic";
  else if (exactEligible) fidelity = "deterministic_cassette_exact";
  else fidelity = "state_equivalent";

  return ok({
    fidelity,
    target,
    exactEligible,
    inputComplete,
    stateComplete,
    exactSourcesComplete,
    authoritativeCount: authorityResult.value.length,
    transcriptCount: transcriptResult.value.events.length,
    gaps,
  });
}

function unsafeMessagesInput(
  field: OfflineMessagesSourcePlanError["field"],
): Result<never, OfflineMessagesSourcePlanError> {
  return err({
    kind: "unsafe_input",
    field,
    message: "Offline channel message source input is unsafe",
  });
}

export function buildOfflineMessagesSourcePlan(
  input: OfflineMessagesSourcePlanInput,
): Result<OfflineMessagesSourcePlan, OfflineMessagesSourcePlanError> {
  if (!/^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/u.test(input.host)) {
    return unsafeMessagesInput("host");
  }
  if (
    input.port !== undefined &&
    (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65_535)
  ) {
    return unsafeMessagesInput("port");
  }
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u.test(input.serviceUser)) {
    return unsafeMessagesInput("serviceUser");
  }
  if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(input.channel)) {
    return unsafeMessagesInput("channel");
  }
  return ok({
    required: true,
    host: input.host,
    ...(input.port !== undefined ? { port: input.port } : {}),
    runAsUser: input.serviceUser,
    command: [
      "comis",
      "messages",
      "--channel",
      input.channel,
      "--limit",
      "10000",
      "--format",
      "json",
    ],
    sourceKind: "offline_messages",
    stdoutDisposition: "private_blob_store_only",
    renderPolicy: "counts_digests_and_gaps_only",
  });
}
