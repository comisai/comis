// SPDX-License-Identifier: Apache-2.0
/**
 * The durable security-audit sink (row-builders + the buffer +
 * the per-event subscribers + the three sinks per event).
 *
 * Every audit-source event maps to an {@link AuditEventRow}. The `audit:event`
 * `metadata` free-map (the ONE escape hatch) is routed through
 * `sanitizeForPersistence` before it lands in `refs`. The other
 * events are structurally content-free (the truncated prefixes / closed labels)
 * but STILL re-apply the scrub uniformly — one chokepoint, defense-in-depth.
 *
 * Each event produces THREE artifacts: an `obs_audit_events` SQLite row (via the
 * dedicated audit buffer), a scrubbed 0600 `security-audit.jsonl` line (the 6th
 * stream under the shared `observability.logRotation`), and a `.audit()` (level
 * 35) log line. Tenant-less events resolve `(tenant, agent, traceId)` from the
 * AsyncLocalStorage trace context when present, else persist `tenant_id=''`
 * (system-scoped) — NEVER dropped.
 *
 * Extracted from `obs-persistence-wiring.ts` to keep that file under the
 * 800-line cap (the row-shapes extraction precedent).
 *
 * @module
 */

import { randomUUID, createHash } from "node:crypto";
import type { EventMap, AuditKind, TypedEventBus } from "@comis/core";
import { tryGetContext, safePath } from "@comis/core";
import type { AuditEventRow } from "@comis/memory";
import { appendAuditJsonl, SECURITY_AUDIT_LOG_BASENAME } from "@comis/memory";
import { sanitizeForPersistence, getDefaultConfigAuditConfinedBase } from "@comis/observability";
import type { ComisLogger } from "@comis/infra";

/**
 * Rotation fallback for the security-audit.jsonl stream when an older caller
 * omits `logRotation`. Aligned to `LogRotationConfigSchema`'s defaults
 * (`packages/core/src/config/schema-observability.ts` — 50 MB / 5 files) so the
 * two can't drift (a mismatched literal here would silently disagree with the
 * 50 MB schema default). NOT imported from the schema to
 * avoid a daemon→core schema-coupling for two scalars; the doc-comment + this
 * note are the binding.
 */
export const AUDIT_JSONL_DEFAULT_MAX_SIZE_BYTES = 50 * 1024 * 1024;
export const AUDIT_JSONL_DEFAULT_MAX_FILES = 5;

/**
 * The closed set of free-form-content keys that an emit site may place in an
 * `audit:event` `metadata` map or a tenant-less event's `refs` map. Their
 * values are arbitrary user/command CONTENT (a raw config value, a command
 * body) — NOT a closed label/count/id — so they routinely carry inline secrets
 * a no-prefix value (a 32-hex key, a DB password, `mysql -p<pass>`) that
 * neither the credential-KEYED-field drop nor the prefixed/keyworded pattern
 * redactor catches. Content-free-by-
 * construction: {@link digestFreeFormContentKeys} replaces each with a
 * non-reversible `<key>Sha256` (first 12 hex) + `<key>Length` BEFORE the row is
 * built, so the raw value can never reach the durable row/JSONL even if a
 * future emit site forgets to pre-digest. The emit sites SHOULD also stop
 * sending the raw value (cleaner payload + a correct full-value digest), but
 * this sink chokepoint is the belt to that suspenders.
 */
const FREE_FORM_CONTENT_KEYS = ["value", "commandPrefix"] as const;

/**
 * Replace any {@link FREE_FORM_CONTENT_KEYS} present in a top-level map with a
 * content-free `<key>Sha256` (first 12 hex of the SHA-256 of the stringified
 * value) + `<key>Length` (char count of the stringified value), dropping the
 * raw key. Returns a NEW map (input is not mutated); other keys pass through
 * untouched (they are still routed through `sanitizeForPersistence` downstream).
 * Absent keys are a no-op (byte-identical map shape for the healthy path).
 */
function digestFreeFormContentKeys(
  map: Record<string, unknown>,
): Record<string, unknown> {
  let out: Record<string, unknown> | undefined;
  for (const key of FREE_FORM_CONTENT_KEYS) {
    if (!(key in map)) continue;
    if (out === undefined) out = { ...map };
    const raw = out[key];
    delete out[key];
    // null/undefined carry no content — record the length sentinel only.
    if (raw === null || raw === undefined) {
      out[`${key}Length`] = 0;
      continue;
    }
    const str = typeof raw === "string" ? raw : JSON.stringify(raw);
    out[`${key}Sha256`] = createHash("sha256").update(str).digest("hex").slice(0, 12);
    out[`${key}Length`] = str.length;
  }
  return out ?? map;
}

/**
 * Minimal write-buffer surface the audit sink needs (`push` only) — declared
 * locally to avoid importing the full `ObsWriteBuffer` from
 * `obs-persistence-wiring.ts`, which would form a wiring↔sink import cycle. The
 * wiring file creates the concrete buffer (its `ObsWriteBuffer<AuditEventRow>`
 * is structurally assignable) and owns its drain in `drainAll()`.
 */
export interface AuditRowSink {
  push(row: AuditEventRow): void;
}

/**
 * Severity mapping for an audit kind. Security signals → "warning"; routine
 * audit / auth-mutation → "info". Mirrors `kindIsSecuritySignal` but kept local
 * (a string label, not a boolean) so the row carries an operator-readable
 * severity without importing the exhaustiveness guard into the wiring layer.
 */
export function kindToSeverity(kind: string): string {
  switch (kind) {
    case "audit":
    case "auth_mutation":
      return "info";
    default:
      // Every security-signal kind (secret_access/injection_*/canary_leak/
      // implied_tool_call/command_blocked/hook_blocked/sandbox_downgrade_refused)
      // and any unknown kind → warning (fail-toward-visibility).
      return "warning";
  }
}

/**
 * Derive an `AuditKind` from an `actionType` when an emit omits
 * `payload.kind` (defense-in-depth fallback — the wire shape reads
 * `payload.kind` when present, deriving from `actionType` only as a fallback).
 * Unknown actionTypes fall back to the generic `audit` family.
 */
export function deriveKindFromActionType(actionType: string): AuditKind {
  switch (actionType) {
    // Secret MUTATIONS (set/delete/rotate) are a security signal
    // too — alongside the secret READ (get). Without an explicit `kind` these
    // would emit `classification:"destructive"` and fall through to
    // the generic `audit` family (severity:"info") — invisible to a
    // kind/severity-filtered audit query. Map them all to the `secret_access`
    // security-signal kind (severity:"warning") so they surface in the
    // security-audit grep. (The emit sites ALSO set `kind` explicitly; this
    // is the defense-in-depth fallback for any future emit that omits it.)
    case "secrets.get":
    case "secrets.set":
    case "secrets.delete":
    case "secrets.rotate":
      return "secret_access";
    case "auth.set":
      return "auth_mutation";
    case "output_guard":
      return "injection_detected";
    case "injection_rate_exceeded":
      return "injection_rate_exceeded";
    case "hook_modification":
      return "hook_blocked";
    default:
      return "audit";
  }
}

/**
 * Build a content-free AuditEventRow from an `audit:event` payload.
 * The `metadata` free-map is routed through `sanitizeForPersistence` (keys +
 * scalar counts/ids/digests only) and packed into `refs` — NEVER the raw
 * metadata. `kind` comes from the wire shape (`payload.kind`) or is derived from
 * `actionType` as a fallback. `classification` is carried only when it is a
 * genuine read|mutate|destructive (else null). The caller resolves
 * `(tenant, agent, traceId)` and passes them in (audit:event carries its own
 * tenantId; tenant-less events resolve from the trace context).
 */
export function auditEventToRow(
  payload: EventMap["audit:event"],
  resolvedTenant: string,
  resolvedAgent: string | null,
  resolvedTraceId: string | undefined,
): AuditEventRow {
  const kind = payload.kind ?? deriveKindFromActionType(payload.actionType);
  const classification =
    payload.classification === "read" ||
    payload.classification === "mutate" ||
    payload.classification === "destructive"
      ? payload.classification
      : null;
  // Content-free-by-construction at the sink. First DIGEST any
  // free-form-content key (`value`/`commandPrefix` — arbitrary content that the
  // pattern redactor misses for no-prefix secrets), then
  // scrub the remaining free-map. A planted value cannot survive either step.
  const scrubbed =
    payload.metadata !== undefined
      ? sanitizeForPersistence(digestFreeFormContentKeys(payload.metadata))
      : undefined;
  return {
    id: randomUUID(),
    tenantId: resolvedTenant,
    agentId: resolvedAgent,
    ts: payload.timestamp,
    kind,
    classification,
    action: payload.actionType,
    actor: resolvedAgent ?? "system",
    outcome: payload.outcome,
    severity: kindToSeverity(kind),
    traceId: resolvedTraceId ?? null,
    refs: scrubbed !== undefined ? JSON.stringify(scrubbed) : null,
  };
}

/** Args for {@link buildAuditRow}. */
export interface BuildAuditRowArgs {
  kind: AuditKind;
  ts: number;
  tenant: string;
  agent: string | null;
  traceId: string | undefined;
  action: string | null;
  actor: string | null;
  outcome: string | null;
  refs: Record<string, unknown>;
}

/**
 * Shared content-free row factory for the tenant-less audit-source events
 * (secret:accessed / the security:* / critic.isolation.* / command:blocked).
 * The `refs` map carries CLOSED LABELS / NAMES / COUNTS only — already
 * content-free at the emit site — but is STILL routed through
 * `sanitizeForPersistence` uniformly (one chokepoint). `(tenant, agent,
 * traceId)` are resolved by the caller from the trace context (else the `''`
 * system-scope sentinel; the event is NEVER dropped).
 */
export function buildAuditRow(args: BuildAuditRowArgs): AuditEventRow {
  // Same content-free-by-construction chokepoint as auditEventToRow: DIGEST any
  // free-form-content key first (command:blocked's `commandPrefix` — the
  // first-200-of-command body, routinely carrying inline secrets), then scrub.
  const scrubbed = sanitizeForPersistence(digestFreeFormContentKeys(args.refs));
  return {
    id: randomUUID(),
    tenantId: args.tenant,
    agentId: args.agent,
    ts: args.ts,
    kind: args.kind,
    classification: null,
    action: args.action,
    actor: args.actor,
    outcome: args.outcome,
    severity: kindToSeverity(args.kind),
    traceId: args.traceId ?? null,
    refs: JSON.stringify(scrubbed),
  };
}

// ---------------------------------------------------------------------------
// Subscriber wiring
// ---------------------------------------------------------------------------

/** Dependencies for {@link wireAuditSink}. */
export interface WireAuditSinkDeps {
  eventBus: TypedEventBus;
  /** The dedicated audit buffer (the SQLite half — its flushFn calls insertAuditEvent). */
  auditBuffer: AuditRowSink;
  logger?: ComisLogger;
  /** Data directory (`~/.comis`); the JSONL lives at `<dataDir>/logs/security-audit.jsonl`. */
  dataDir?: string;
  /** The shared `observability.logRotation` bounds (the 6th stream). */
  logRotation?: { maxSizeBytes: number; maxFiles: number };
  /** The `observability.audit` policy (defaults: persist on, both sinks). */
  auditConfig?: { persist: boolean; sink: "sqlite" | "jsonl" | "both" };
}

/**
 * Subscribe the durable security-audit sink: every audit-source event →
 * an obs_audit_events row (the buffer) + a scrubbed 0600 security-audit.jsonl
 * line + a `.audit()` (level 35) log line. Returns nothing — the caller owns the
 * buffer's lifecycle (it is drained in `drainAll()`).
 */
export function wireAuditSink(deps: WireAuditSinkDeps): void {
  const { eventBus, auditBuffer, logger, dataDir, logRotation, auditConfig } = deps;

  // Defaults: persist on, both sinks. The JSONL path is the 6th stream under the
  // shared logRotation (no per-sink knob); rotation bounds come from logRotation
  // (fallback to the LogRotationConfigSchema 50 MB / 5 default — see the
  // AUDIT_JSONL_DEFAULT_* constants — when an older caller omits it).
  const auditPersist = auditConfig?.persist ?? true;
  const auditSink = auditConfig?.sink ?? "both";
  const wantsSqlite = auditPersist && (auditSink === "sqlite" || auditSink === "both");
  const wantsJsonl = auditPersist && (auditSink === "jsonl" || auditSink === "both");
  const logPath = dataDir !== undefined ? safePath(dataDir, "logs", SECURITY_AUDIT_LOG_BASENAME) : undefined;
  const confinedBase = dataDir !== undefined ? getDefaultConfigAuditConfinedBase(logPath) : undefined;
  const rotateAtBytes = logRotation?.maxSizeBytes ?? AUDIT_JSONL_DEFAULT_MAX_SIZE_BYTES;
  const keepRotated = logRotation?.maxFiles ?? AUDIT_JSONL_DEFAULT_MAX_FILES;

  /**
   * The three audit sinks per event: the SQLite buffer, the
   * 0600 security-audit.jsonl line, and the `.audit()` (level 35) log. The row
   * is ALREADY scrubbed (the metadata free-map was routed through
   * `sanitizeForPersistence` in the row-builder). The JSONL append is try/caught
   * (AGENTS §2.7): a sink failure logs ERROR with hint+errorKind and
   * NEVER throws past the subscriber — the SQLite half still drains, and a
   * tenant-less event is persisted system-scoped, never dropped.
   */
  function persistAuditRow(row: AuditEventRow): void {
    if (wantsSqlite) auditBuffer.push(row);
    if (wantsJsonl && logPath !== undefined) {
      try {
        appendAuditJsonl({
          filePath: logPath,
          record: row,
          rotateAtBytes,
          keepRotated,
          ...(confinedBase !== undefined ? { confinedBaseDir: confinedBase } : {}),
        });
      } catch (err) {
        logger?.error(
          {
            err,
            errorKind: "resource" as const,
            hint: "security-audit.jsonl append failed; the SQLite audit row still persisted. Check ~/.comis/logs permissions/space.",
            kind: row.kind,
          },
          "audit-jsonl-append-failed",
        );
      }
    }
    // The level-35 audit line (scrubbed row).
    // `.audit()` is a CUSTOM Pino level registered ONLY by the @comis/infra
    // logger factory — `logger?.audit?.(...)` (method optional-chain, not just
    // the null-guard `logger?.`) so a logger BUILT WITHOUT that factory (a test
    // capture logger, a minimal Pino) makes this SUPPLEMENTARY line a no-op
    // rather than crashing the audit subscriber with `audit is not a function`.
    // The DURABLE audit (the obs_audit_events row + security-audit.jsonl above)
    // already fired, so the audit trail stays intact; production uses the infra
    // logger (has `.audit()`) → the line still fires.
    logger?.audit?.({ kind: row.kind, outcome: row.outcome, agentId: row.agentId, traceId: row.traceId, refs: row.refs }, row.kind);
  }

  // audit:event carries its own tenantId/agentId; fall back to the trace ctx /
  // the '' sentinel when blank. traceId rides the trace ctx (the payload has none).
  eventBus.on("audit:event", (payload) => {
    const ctx = tryGetContext();
    const tenant = payload.tenantId !== "" ? payload.tenantId : (ctx?.tenantId ?? "");
    const agent = payload.agentId !== "" ? payload.agentId : (ctx?.agentId ?? null);
    persistAuditRow(auditEventToRow(payload, tenant, agent, ctx?.traceId));
  });

  // secret:accessed — already content-free (NAME + outcome, no value).
  eventBus.on("secret:accessed", (payload) => {
    const ctx = tryGetContext();
    persistAuditRow(buildAuditRow({
      kind: "secret_access",
      ts: payload.timestamp,
      tenant: ctx?.tenantId ?? "",
      agent: payload.agentId,
      traceId: ctx?.traceId,
      action: payload.secretName,
      actor: payload.agentId,
      outcome: payload.outcome,
      refs: { secretName: payload.secretName, outcome: payload.outcome },
    }));
  });

  // security:injection_detected — closed labels + a pattern COUNT (never bodies).
  eventBus.on("security:injection_detected", (payload) => {
    const ctx = tryGetContext();
    persistAuditRow(buildAuditRow({
      kind: "injection_detected",
      ts: payload.timestamp,
      tenant: ctx?.tenantId ?? "",
      agent: payload.agentId ?? ctx?.agentId ?? null,
      traceId: payload.traceId ?? ctx?.traceId,
      action: "injection_detected",
      actor: payload.agentId ?? null,
      outcome: "denied",
      refs: { source: payload.source, riskLevel: payload.riskLevel, patternCount: payload.patterns.length },
    }));
  });

  // security:ssrf_blocked — the blocked URL's
  // ORIGIN (scheme+host+port; secret-free by construction — `new URL().origin` drops the
  // path/query/fragment/userinfo) + the closed reason enum. Mirrors command:blocked; gives
  // `comis security audit-log` an SSRF-attempt trail for each SSRF block.
  eventBus.on("security:ssrf_blocked", (payload) => {
    const ctx = tryGetContext();
    persistAuditRow(buildAuditRow({
      kind: "ssrf_blocked",
      ts: payload.timestamp,
      tenant: ctx?.tenantId ?? "",
      agent: payload.agentId ?? ctx?.agentId ?? null,
      traceId: payload.traceId ?? ctx?.traceId,
      action: "ssrf_blocked",
      actor: payload.agentId ?? ctx?.agentId ?? null,
      outcome: "denied",
      refs: { origin: payload.origin, reason: payload.reason },
    }));
  });

  // security:injection_rate_exceeded — counts + the closed action label only.
  eventBus.on("security:injection_rate_exceeded", (payload) => {
    const ctx = tryGetContext();
    persistAuditRow(buildAuditRow({
      kind: "injection_rate_exceeded",
      ts: payload.timestamp,
      tenant: ctx?.tenantId ?? "",
      agent: ctx?.agentId ?? null,
      traceId: ctx?.traceId,
      action: "injection_rate_exceeded",
      actor: null,
      outcome: "denied",
      refs: { count: payload.count, threshold: payload.threshold, action: payload.action },
    }));
  });

  // security:memory_tainted — closed trust-level labels + a pattern COUNT + flag.
  eventBus.on("security:memory_tainted", (payload) => {
    const ctx = tryGetContext();
    persistAuditRow(buildAuditRow({
      kind: "injection_detected", // a memory-taint is an injection-class security signal
      ts: payload.timestamp,
      tenant: ctx?.tenantId ?? "",
      agent: payload.agentId ?? ctx?.agentId ?? null,
      traceId: ctx?.traceId,
      action: "memory_tainted",
      actor: payload.agentId,
      outcome: payload.blocked ? "denied" : "success",
      refs: {
        signal: "memory_tainted",
        originalTrustLevel: payload.originalTrustLevel,
        adjustedTrustLevel: payload.adjustedTrustLevel,
        patternCount: payload.patterns.length,
        blocked: payload.blocked,
      },
    }));
  });

  // critic.isolation.canary_leak — the canaryPrefix is ALREADY truncated.
  eventBus.on("critic.isolation.canary_leak", (payload) => {
    const ctx = tryGetContext();
    persistAuditRow(buildAuditRow({
      kind: "canary_leak",
      ts: payload.timestamp,
      tenant: ctx?.tenantId ?? "",
      agent: payload.agentId,
      traceId: payload.traceId ?? ctx?.traceId,
      action: "canary_leak",
      actor: payload.agentId,
      outcome: "denied",
      refs: { canaryPrefix: payload.canaryPrefix },
    }));
  });

  // critic.isolation.implied_tool_call — the pattern is ALREADY sanitized.
  eventBus.on("critic.isolation.implied_tool_call", (payload) => {
    const ctx = tryGetContext();
    persistAuditRow(buildAuditRow({
      kind: "implied_tool_call",
      ts: payload.timestamp,
      tenant: ctx?.tenantId ?? "",
      agent: payload.agentId,
      traceId: payload.traceId ?? ctx?.traceId,
      action: "implied_tool_call",
      actor: payload.agentId,
      outcome: "denied",
      refs: { pattern: payload.pattern },
    }));
  });

  // command:blocked — the `commandPrefix` is the first-200-of
  // the COMMAND BODY (content) and routinely carries inline secrets
  // (`mysql -p<pass>`, `psql postgres://user:pw@host`). Do NOT persist it in the
  // durable row/JSONL; emit a content-free `commandSha256` (12 hex) +
  // `commandLength` for correlation instead, plus the closed `blocker`/`reason`
  // labels. (`buildAuditRow` ALSO digests any `commandPrefix` by construction —
  // the belt — but we don't send the raw prefix here in the first place.)
  // Tenant-less → trace ctx / '' sentinel.
  eventBus.on("command:blocked", (payload) => {
    const ctx = tryGetContext();
    persistAuditRow(buildAuditRow({
      kind: "command_blocked",
      ts: payload.timestamp,
      tenant: ctx?.tenantId ?? "",
      agent: payload.agentId,
      traceId: ctx?.traceId,
      action: "command_blocked",
      actor: payload.agentId,
      outcome: "denied",
      refs: {
        commandSha256: createHash("sha256").update(payload.commandPrefix).digest("hex").slice(0, 12),
        commandLength: payload.commandPrefix.length,
        reason: payload.reason,
        blocker: payload.blocker,
      },
    }));
  });

  // security:sandbox_downgrade_refused ALSO mirrors into obs_audit_events (it is
  // a security-decision event and belongs in the audit grep surface), KEEPING
  // the existing obs_diagnostics row in the wiring file (I1′ additive — not removed).
  eventBus.on("security:sandbox_downgrade_refused", (payload) => {
    const ctx = tryGetContext();
    persistAuditRow(buildAuditRow({
      kind: "sandbox_downgrade_refused",
      ts: payload.timestamp,
      tenant: ctx?.tenantId ?? "",
      agent: payload.parentAgentId,
      traceId: ctx?.traceId,
      action: "sandbox_downgrade_refused",
      actor: payload.parentAgentId,
      outcome: "denied",
      refs: { childAgentId: payload.childAgentId, dimensions: payload.violatedDimensions },
    }));
  });
}
