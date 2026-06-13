// SPDX-License-Identifier: Apache-2.0
/**
 * Trajectory event-type coverage test.
 *
 * Walks every `eventBus.emit("name", payload)` call site in
 * `packages/agent/src/**` and `packages/orchestrator/src/**` (the two
 * packages where EventMap producers live), confirms each captured
 * event name is EITHER:
 *
 *   1. a key in `TRAJECTORY_BRIDGE_MAPPING` (the trajectory bridge
 *      translates it into a trajectory event), OR
 *   2. listed in `EVENTS_NOT_TRAJECTORY_MAPPED` — events deliberately
 *      not on the trajectory (audit-log, internal lifecycle, etc.).
 *
 * The bidirectional check is:
 *   - Emitted event not in EventMap → caught at compile time by
 *     `TypedEventBus<EventMap>` (no test needed).
 *   - Emitted event in EventMap but neither in bridge mapping nor in
 *     allowlist → FAIL with file:line + actionable hint.
 *
 * BOTH `tool:executed` AND `tool:timeout` are present in
 * TRAJECTORY_BRIDGE_MAPPING; downstream consumers dedupe by toolCallId.
 * The architecture test enforces both have entries.
 *
 * Walker style mirrors `log-payload-checker.test.ts:79-100` (recursive
 * readdirSync with the standard exclusion set: __tests__, dist,
 * node_modules, __test-helpers, fixtures).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { TRAJECTORY_BRIDGE_MAPPING, TRAJECTORY_EVENT_TYPES, type TrajectoryEventType } from "@comis/observability";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

/**
 * EventBus events deliberately NOT on the trajectory. Updating this set
 * is shrink-friendly — adding an event acknowledges it's intentionally
 * out-of-scope for the per-session sidecar (audit-log path, internal
 * registry signals, etc.).
 *
 * Add entries with one-line rationales. Removing entries is free; the
 * test continues to pass as long as the event has a `TRAJECTORY_BRIDGE_MAPPING`
 * entry OR stays in this set.
 *
 * Dedup contract reminder:
 *   Both `tool:executed` AND `tool:timeout` are in TRAJECTORY_BRIDGE_MAPPING
 *   for the SAME physical timeout. Downstream consumers join on toolCallId
 *   to dedupe. The architecture test enforces both have bridge entries.
 */
const EVENTS_NOT_TRAJECTORY_MAPPED: ReadonlySet<string> = new Set<string>([
  // -------------------------------------------------------------------
  // Audit / governance — fed by daemon audit-log, not the trajectory.
  // -------------------------------------------------------------------
  "audit:event",

  // -------------------------------------------------------------------
  // Skill registry events — internal, not turn-scoped.
  // -------------------------------------------------------------------
  "skill:loaded",
  "skill:executed",
  "skill:rejected",
  "skill:registry_reset",
  "skill:failed",

  // -------------------------------------------------------------------
  // Security / safety — fed by separate alerting paths. The below
  // events are intentionally out of scope. Note:
  //   security:injection_detected → trajectory via TRAJECTORY_BRIDGE_MAPPING
  //   security:memory_tainted    → trajectory via TRAJECTORY_BRIDGE_MAPPING
  //   security:warn              → trajectory via TRAJECTORY_BRIDGE_MAPPING
  // -------------------------------------------------------------------
  "security:injection_rate_exceeded",
  "sender:trust_resolved",
  "tool:install_detour_detected",
  // Critic isolation events (Phase 154 S2): security incidents fed to alerting,
  // not trajectory steps. 100% capture via structured Pino log (AI-SPEC §7).
  "critic.isolation.canary_leak",
  "critic.isolation.implied_tool_call",

  // -------------------------------------------------------------------
  // Provider-level aggregates — daemon-level rollup, not per-session.
  // -------------------------------------------------------------------
  "provider:degraded",
  "provider:recovered",

  // -------------------------------------------------------------------
  // Model catalog + observability metadata not tied to a single turn.
  // -------------------------------------------------------------------
  "model:catalog_loaded",
  "observability:cache_break",
  "observability:latency",

  // -------------------------------------------------------------------
  // Graph / SEP — separate observability artifact owns these.
  // -------------------------------------------------------------------
  "graph:started",
  "graph:node_updated",
  "graph:completed",
  "graph:driver_lifecycle",
  "sep:plan_extracted",
  "cache:graph_prefix_written",

  // -------------------------------------------------------------------
  // Command + memory-maintenance lifecycle — internal handlers / background
  // jobs, not turn-level trajectory events.
  // -------------------------------------------------------------------
  "command:blocked",
  "memory:review_completed",
  // Background consolidation job metrics (clustersProcessed/observationsCreated/
  // dedupHits) — a maintenance job, not part of an agent turn. Same class as
  // memory:review_completed above.
  "memory:consolidated",
  // Recall-pipeline diagnostic counters — counts-only observability
  // events fed into the recall-trace sidecar + recall-counters store, NOT
  // turn-level trajectory steps. Same class as memory:consolidated above:
  //   memory:entities_linked — entity resolveAndLink counts (newEntities).
  //   memory:recall_used     — recall-usage attribution: used/ignored
  //     memory ids + counts, consumed by the daemon write-back subscriber
  //     (setup-memory-usefulness-wiring.ts → MemoryUsefulnessStore.recordUsage),
  //     NOT a turn-level trajectory step.
  // NB: memory:recalled / memory:reranked are now BRIDGED to the trajectory
  // (RECALL-01 — the #1 troubleshooting blind spot), so they are NOT listed here.
  "memory:entities_linked",
  "memory:recall_used",

  // -------------------------------------------------------------------
  // Session-store lifecycle (distinct from session:started/ended which
  // ARE on the trajectory).
  // -------------------------------------------------------------------
  "session:created",
  "session:expired",

  // -------------------------------------------------------------------
  // Delivery low-level events — only delivery:enqueued and
  // delivery:complete are on the trajectory; intermediates stay
  // internal.
  // -------------------------------------------------------------------
  "delivery:acked",
  "delivery:dropped",
  "delivery:failed",
  "delivery:retry",

  // -------------------------------------------------------------------
  // Channel lifecycle — internal to orchestrator.
  // -------------------------------------------------------------------
  "channel:connected",
  "channel:disconnected",
  "channel:degraded",
  "channel:recovered",

  // -------------------------------------------------------------------
  // Infra events — system metrics, not turn-scoped.
  // -------------------------------------------------------------------
  "infra:heartbeat",
  "infra:resource_pressure",

  // -------------------------------------------------------------------
  // Acknowledgement events — channel-level reaction signals; observed
  // via the delivery path, not the trajectory.
  // -------------------------------------------------------------------
  "ack:reaction_sent",

  // -------------------------------------------------------------------
  // Announcement / dead-letter delivery — separate observability path.
  // -------------------------------------------------------------------
  "announcement:dead_letter_delivered",
  "announcement:dead_lettered",

  // -------------------------------------------------------------------
  // Auth provider lifecycle — fed through auth-audit, not trajectory.
  // -------------------------------------------------------------------
  "auth:profile_added",
  "auth:profile_bootstrapped",
  "auth:refresh_failed",
  "auth:token_rotated",

  // -------------------------------------------------------------------
  // Auto-reply system - daemon-level policy, not turn-scoped.
  // -------------------------------------------------------------------
  "autoreply:activated",
  "autoreply:suppressed",

  // -------------------------------------------------------------------
  // Background task manager — long-running task lifecycle outside the
  // single execute() boundary.
  // -------------------------------------------------------------------
  "background_task:cancelled",
  "background_task:completed",
  "background_task:failed",
  "background_task:promoted",
  "background_task:reentered",

  // -------------------------------------------------------------------
  // Coalescing + buffering at the orchestrator queue level (debounce
  // signals only — queue:* events are now in TRAJECTORY_BRIDGE_MAPPING).
  // -------------------------------------------------------------------
  "coalesce:flushed",
  "debounce:buffered",
  "debounce:flushed",

  // -------------------------------------------------------------------
  // Context-engine internals — only context:compacted and
  // context:pipeline:cache remain allowlisted here.
  //
  // Removed (now bridge-mapped → TRAJECTORY_BRIDGE_MAPPING):
  //   context:evicted, context:masked, context:overflow,
  //   context:rehydrated, context:reread
  //
  // context:integrity is NOT here — it was never in this set (emitted
  // via optional chaining `?.emit`, which the arch-test regex misses).
  //
  // context:compacted: LLM compaction summary (distinct from the
  //   per-event granular eviction/mask/reread signals — kept internal).
  // context:pipeline:cache: post-LLM cache-patch event whose fields
  //   are folded into the pre-LLM context:pipeline trajectory snapshot.
  // context:dag_degraded: LCD robustness/integrity signal (Phase 132 R1 + R3) —
  //   a fail-closed rollover / serialized-wait / summarizer breaker-open /
  //   spend-cap degrade, carrying ids + a closed reason + durationMs ONLY (never
  //   content). A health/safety signal fed to observability snapshots, NOT a
  //   turn-level trajectory step (same class as provider:degraded above).
  // context:compaction_routed: capability-routing health signal (Phase 152
  //   C4/S4) — records which compaction strategy (eviction / strong-summarizer
  //   / llm) was selected per capabilityClass, ids + counts only. Same
  //   internal-health class as context:compacted above.
  // -------------------------------------------------------------------
  "context:compacted",
  "context:compaction_routed",
  "context:pipeline:cache",
  "context:dag_degraded",
  // context:arbitrated: RETR-02 margin-arbiter allocation signal (Phase 173) —
  //   per-tier kept counts + discretionary-pool tokens + relevanceFirst boolean,
  //   ids/counts only, content-free. A counts-only internal-health signal (same
  //   class as context:compaction_routed above), NOT a turn-level trajectory step.
  "context:arbitrated",

  // -------------------------------------------------------------------
  // Diagnostic counters — internal aggregation, not user-visible.
  // -------------------------------------------------------------------
  "diagnostic:message_processed",

  // -------------------------------------------------------------------
  // Elevated-model routing - daemon decision before the turn starts.
  // -------------------------------------------------------------------
  "elevated:model_routed",

  // -------------------------------------------------------------------
  // Follow-up handler events - internal scheduler.
  // -------------------------------------------------------------------
  "followup:depth_exceeded",
  "followup:enqueued",

  // -------------------------------------------------------------------
  // Group history injection - internal to the prompt assembler; the
  // observable surface is captured by prompt.submitted (digest deltas).
  // -------------------------------------------------------------------
  "grouphistory:injected",

  // -------------------------------------------------------------------
  // Message lifecycle - orchestrator-level, not turn-scoped (the
  // trajectory captures the model-visible turn boundary instead).
  // -------------------------------------------------------------------
  "message:received",
  "message:sent",

  // -------------------------------------------------------------------
  // Response filtering - safety pipeline at the output guard layer.
  // -------------------------------------------------------------------
  "response:filtered",

  // -------------------------------------------------------------------
  // Sender / send-policy events - access control, not observability.
  // sender:blocked is now in TRAJECTORY_BRIDGE_MAPPING (channelType only).
  // -------------------------------------------------------------------
  "sendpolicy:allowed",
  "sendpolicy:denied",
  "sendpolicy:override_changed",

  // -------------------------------------------------------------------
  // Cross-session messaging + sub-agent spawn lifecycle - separate
  // observability artifact; the trajectory writer is per-session and
  // does not span the sub-agent tree.
  // -------------------------------------------------------------------
  "session:cross_send",
  "session:ping_pong_turn",
  "session:sub_agent_archived",
  "session:sub_agent_completed",
  "session:sub_agent_lifecycle_ended",
  "session:sub_agent_result_condensed",
  "session:sub_agent_spawn_prepared",
  "session:sub_agent_spawn_queued",
  "session:sub_agent_spawn_rejected",
  "session:sub_agent_spawned",

  // -------------------------------------------------------------------
  // Steering injection - orchestrator-driven mid-execution control.
  // -------------------------------------------------------------------
  "steer:followup_queued",
  "steer:injected",
  "steer:rejected",

  // -------------------------------------------------------------------
  // Streaming block + typing-indicator events - presentation-layer.
  // -------------------------------------------------------------------
  "streaming:block_sent",
  "typing:proxy_stop",
  "typing:started",
  "typing:stopped",
]);

/**
 * Closed set of trajectory event types emitted DIRECTLY by the
 * runtime recorder (not via the EventBus → bridge → recordEvent
 * path). These are lifecycle envelopes and the control-plane
 * sentinels emitted inside flushAndClose. Adding to this set is a
 * closed-set design decision, NOT an allowlist for missing bridge
 * mappings.
 *
 * Shrink-only: the set may only shrink (types can move to the bus
 * bridge path, reducing the direct-emit surface), never grow beyond
 * the explicitly listed lifecycle envelopes + control-plane sentinels.
 */
const DIRECT_EMIT_TRAJECTORY_TYPES: ReadonlySet<TrajectoryEventType> = new Set<TrajectoryEventType>([
  "trace.metadata",
  "trace.artifacts",
  "trace.truncated",
  "trace.write_failures",
]);

const SCANNED_PACKAGES = ["agent", "orchestrator"] as const;
const EMIT_REGEX = /eventBus\.emit\(\s*"([^"]+)"/g;

interface EmitSite {
  readonly file: string;
  readonly line: number;
  readonly eventName: string;
}

function walkProductionFiles(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = resolve(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (
        [
          "__tests__",
          "__snapshots__",
          "dist",
          "node_modules",
          "__test-helpers",
          "fixtures",
        ].includes(entry.name)
      ) {
        continue;
      }
      walkProductionFiles(full, out);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".generated.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
}

function collectEmitSites(files: string[]): EmitSite[] {
  const sites: EmitSite[] = [];
  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      // Reset lastIndex per-line so the global flag plays nice.
      EMIT_REGEX.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = EMIT_REGEX.exec(line)) !== null) {
        const eventName = match[1] ?? "";
        if (eventName.length === 0) continue;
        sites.push({ file, line: i + 1, eventName });
      }
    }
  }
  return sites;
}

function repoRelative(absPath: string): string {
  return absPath.startsWith(REPO_ROOT)
    ? absPath.slice(REPO_ROOT.length + 1)
    : absPath;
}

describe("trajectory-event-types-known -- bridge mapping coverage from emit sites", () => {
  // Pre-compute mapping keys + walker output once for the whole describe.
  const mapped = new Set<string>(Object.keys(TRAJECTORY_BRIDGE_MAPPING));

  const allFiles: string[] = [];
  for (const pkg of SCANNED_PACKAGES) {
    walkProductionFiles(resolve(REPO_ROOT, "packages", pkg, "src"), allFiles);
  }
  const allSites = collectEmitSites(allFiles);

  it("every eventBus.emit name is either trajectory-mapped or explicitly allowlisted", () => {
    const violations = allSites.filter(
      (s) => !mapped.has(s.eventName) && !EVENTS_NOT_TRAJECTORY_MAPPED.has(s.eventName),
    );

    expect(
      violations,
      formatViolations({
        description:
          "Trajectory event coverage: every eventBus.emit(...) site in packages/agent + packages/orchestrator must reference an event name that is EITHER in TRAJECTORY_BRIDGE_MAPPING (trajectory writer records it) OR in EVENTS_NOT_TRAJECTORY_MAPPED (deliberately out of scope).",
        violations: violations.map((v) => ({
          file: `${repoRelative(v.file)}:${v.line}`,
          line: v.line,
          snippet: `eventBus.emit("${v.eventName}", …) — neither mapped nor allowlisted`,
        })),
        suggestedFix:
          "Add the event name to TRAJECTORY_BRIDGE_MAPPING (packages/observability/src/trajectory/event-bus-bridge.ts) with the appropriate translator branch, OR add it to EVENTS_NOT_TRAJECTORY_MAPPED in this test with a one-line rationale.",
        designRef:
          "TRAJECTORY_BRIDGE_MAPPING in packages/observability/src/trajectory/event-bus-bridge.ts",
        allowlistRef:
          "EVENTS_NOT_TRAJECTORY_MAPPED in test/architecture/trajectory-event-types-known.test.ts",
      }),
    ).toEqual([]);
  });

  it("walker found at least one emit site (sanity check)", () => {
    expect(allSites.length).toBeGreaterThan(0);
  });

  // Dedup contract reminder: both tool:executed AND tool:timeout must be
  // in TRAJECTORY_BRIDGE_MAPPING. Downstream trajectory consumers dedupe
  // by toolCallId.
  it("tool:executed AND tool:timeout are both trajectory-mapped (dedup contract)", () => {
    expect(mapped.has("tool:executed")).toBe(true);
    expect(mapped.has("tool:timeout")).toBe(true);
  });

  it("core trajectory events are all trajectory-mapped", () => {
    expect(mapped.has("prompt:submitted")).toBe(true);
    expect(mapped.has("session:started")).toBe(true);
    expect(mapped.has("session:ended")).toBe(true);
    expect(mapped.has("memory:injected")).toBe(true);
    expect(mapped.has("tool:timeout")).toBe(true);
  });

  it("EVENTS_NOT_TRAJECTORY_MAPPED is disjoint from TRAJECTORY_BRIDGE_MAPPING (no double-coverage)", () => {
    const intersection = [...EVENTS_NOT_TRAJECTORY_MAPPED].filter((e) => mapped.has(e));
    expect(intersection, "events in BOTH sets — pick one").toEqual([]);
  });

  it("DIRECT_EMIT_TRAJECTORY_TYPES is disjoint from TRAJECTORY_BRIDGE_MAPPING values + EVENTS_NOT_TRAJECTORY_MAPPED", () => {
    const bridgedValues = new Set<string>(Object.values(TRAJECTORY_BRIDGE_MAPPING));
    const overlapsBridge = [...DIRECT_EMIT_TRAJECTORY_TYPES].filter((t) => bridgedValues.has(t));
    expect(
      overlapsBridge,
      "direct-emit types must NOT be in TRAJECTORY_BRIDGE_MAPPING values (direct-emit lifecycle envelopes are not bus-bridged)",
    ).toEqual([]);
    const overlapsAllowlist = [...DIRECT_EMIT_TRAJECTORY_TYPES].filter((t) =>
      EVENTS_NOT_TRAJECTORY_MAPPED.has(t),
    );
    expect(
      overlapsAllowlist,
      "direct-emit types must NOT be in EVENTS_NOT_TRAJECTORY_MAPPED (different semantic — direct-emit != not-mapped)",
    ).toEqual([]);
  });

  it("every DIRECT_EMIT_TRAJECTORY_TYPES member is a valid TrajectoryEventType", () => {
    const allTypes = new Set<string>(TRAJECTORY_EVENT_TYPES as readonly string[]);
    const invalid = [...DIRECT_EMIT_TRAJECTORY_TYPES].filter((t) => !allTypes.has(t));
    expect(
      invalid,
      "DIRECT_EMIT_TRAJECTORY_TYPES references unknown TrajectoryEventType — add the type to TRAJECTORY_EVENT_TYPES first",
    ).toEqual([]);
  });

  it("bridge mapping has at least 45 entries (final gate)", () => {
    // The mapping currently has 53 entries.
    // This assertion confirms the ≥45 lower bound is satisfied with margin.
    expect(Object.keys(TRAJECTORY_BRIDGE_MAPPING).length).toBeGreaterThanOrEqual(45);
  });
});
