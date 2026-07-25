// SPDX-License-Identifier: Apache-2.0
/**
 * activity-stream — the canonical, redacted `ActivityEvent` source.
 *
 * Subscribes to the typed EventBus (consume only — `core/event-bus/bus.ts` is
 * frozen) and maps each real `tool:*` / `model:*` / `approval:*` event to
 * an `ActivityEvent` via the core helpers (`resolveLabel`/`applyTemplate`/
 * `classifySemanticPhase` + `redactValue` defense-in-depth), validates the
 * output with `parseActivityEvent`, and delivers it to per-turn subscribers
 * scoped to `{agentId, sessionKey, traceId}`. Mirrors the
 * `cache-trace/event-bus-bridge.ts` subscription-bag + single-`unsubscribe()`
 * idiom (the canonical EventBus-subscriber pattern).
 *
 * Canonical + UNFILTERED: zero verbosity / coalescing / maxLines
 * here — projections (in `core/activity/projections`) apply consumer policy.
 *
 * Correlation index: an in-memory `requestId → { activityId, … }`
 * map populated from `approval:requested` lets `approval:resolved` (which
 * carries only `requestId`) close the matching activity. A resolved event with
 * no matching index entry is ignored for live activity (the durable approval
 * audit event is untouched). The same `toolCallId → activityId` mapping keeps a
 * stable `activityId` across `tool:started` → `tool:executed`.
 *
 * Subagent lifecycle events (`session:sub_agent_spawned`/`completed`) map to
 * `kind:"subagent"` ActivityEvents. The spawn payload carries
 * `{runId, parentSessionKey, agentId, task}` — NO `traceId` and NO parent
 * `activityId` — so subagent events are delivered to every turn subscriber whose
 * `{agentId, sessionKey}` match `{agentId, parentSessionKey}`, stamping that
 * subscriber's `traceId` onto the delivered copy. `parentActivityId` is left
 * unset here: the per-turn coordinator (the single owner) annotates the
 * parent link from its active-subagent stack. The free-text `task` is never
 * reflected into the rendered label (only `agentId` + the `🤖` marker).
 *
 * Logging: the logger is injected via Deps; object-first; no
 * in-module logger construction, and the module-identity payload field is never
 * set (binding identity comes from the injected logger). Call-site scope uses
 * the `submodule`/`step` fields. A single WARN `{hint, errorKind}` fires
 * when a mapped event's `redactionsApplied` is non-empty (a tool tried to
 * substitute a secret-keyed value); a `parseActivityEvent` failure logs ERROR.
 *
 * Counters: there is no metrics-sink primitive in
 * `@comis/observability` (the package logs + emits on the bus — see
 * `health-aggregator`). The counters are therefore kept as an in-process
 * counter snapshot (`counters()`) — incremented on each emit/drop/redaction and
 * surfaced for the daemon's metrics scrape + the test harness. Per-event emit is
 * traced at DEBUG.
 *
 * Boundary: this module never imports the channels package (the hexagonal
 * constraint, enforced by a durable guard test).
 *
 * @module
 */
import {
  applyTemplate,
  parseActivityEvent,
  resolveLabelSpec,
  systemDateFrom,
  systemNowMs,
  type ActivityEvent,
  type ActivityStatusMarkers,
  type ActivityTheme,
  type ComisLogger,
  type EventMap,
  type TurnActivityContext,
  type TypedEventBus,
} from "@comis/core";
import { randomUUID } from "node:crypto";

import { createBoundedQueue, type BoundedQueue } from "./bounded-queue.js";
import { clampLabel, compressLabel } from "./label-compressor.js";

/**
 * The tool-metadata subset the stream reads to honor `suppressActivity`. Looked
 * up via the injected `getToolMetadata` so the stream does not depend on the
 * full `ComisToolMetadata` interface.
 */
export interface ActivityToolMetadata {
  readonly suppressActivity?: boolean;
}

/** Dependencies for {@link createActivityStream}. */
export interface CreateActivityStreamDeps {
  readonly eventBus: TypedEventBus;
  /** Injected bound logger. Optional — when absent the stream is silent. */
  readonly logger?: ComisLogger;
  /** Per-tool metadata lookup (for `suppressActivity`). Optional. */
  readonly getToolMetadata?: (toolName: string) => ActivityToolMetadata | undefined;
  /** Active operator theme (label override layer). Optional. */
  readonly theme?: ActivityTheme;
  /** Home directory for `$HOME`→`~` path compaction. Injected; no env read. */
  readonly homeDir?: string;
  /** Override "now" (ms) for deterministic tests. Defaults to the sanctioned `systemNowMs`. */
  readonly nowMs?: () => number;
}

/** In-process counter snapshot mirroring the activity counters. */
export interface ActivityCounters {
  /** `activity.events.emitted` total. */
  readonly emitted: number;
  /** `activity.events.dropped` total (per-consumer bounded-queue drops + filtered). */
  readonly dropped: number;
  /** `activity.template.redaction_replacements` total. */
  readonly redactionReplacements: number;
}

/**
 * The ActivityStream — implements the core `ActivityStreamPort.subscribeForTurn`
 * plus lifecycle (`dispose`) and a `counters()` snapshot.
 */
export interface ActivityStream {
  /**
   * Subscribe a coordinator to the canonical activity events scoped to a single
   * turn (filtered to `{ctx.agentId, ctx.sessionKey, ctx.traceId}`). Returns an
   * `ActivitySubscription` whose `unsubscribe()` releases the turn.
   */
  subscribeForTurn(
    ctx: TurnActivityContext,
    onEvent: (e: ActivityEvent) => void,
  ): { unsubscribe(): void };
  /** Detach all bus handlers + clear the correlation index (composition-root shutdown). */
  dispose(): void;
  /** Counter snapshot. */
  counters(): ActivityCounters;
}

interface TurnSubscriber {
  readonly ctx: TurnActivityContext;
  readonly onEvent: (e: ActivityEvent) => void;
  /** Per-consumer bounded queue at the subscription boundary. */
  readonly queue: BoundedQueue<ActivityEvent>;
}

/** A failure event bypasses the bounded-queue drop policy. */
function isFailureEvent(e: ActivityEvent): boolean {
  return e.status === "failed" || e.kind === "approval";
}

interface CorrelationEntry {
  readonly activityId: string;
  readonly agentId: string;
  readonly sessionKey: string;
  readonly traceId: string;
  /**
   * The authoritative CSPRNG `shortId` minted by the approval gate and carried
   * on `approval:requested`. Stored so `approval:resolved` (which
   * carries only `requestId`) reuses the SAME unguessable id on the close
   * event — never a weak re-derivation.
   */
  readonly shortId: string;
  readonly channelType?: string;
}

/** EventBus events this layer maps (subagent events map to kind:"subagent"). */
const SUBSCRIBED_EVENTS = [
  "tool:started",
  "tool:executed",
  "tool:timeout",
  "model:fallback_attempt",
  "model:fallback_exhausted",
  "model:lkw_fallback_attempt",
  "approval:requested",
  "approval:resolved",
  "session:sub_agent_spawned",
  "session:sub_agent_completed",
] as const satisfies ReadonlyArray<keyof EventMap>;

/**
 * The status markers used when no theme is supplied (or a markerless theme is
 * passed). These mirror the `default` theme bundle byte-for-byte so the
 * no-theme / default-theme output matches the exact glyphs the
 * channel golden fixtures assert.
 * Only `subagent` is read today (the event-produced marker baked
 * into `defaultLabel`); the closing-line `success`/`failure` markers are
 * RENDERER-derived from the `TurnOutcome` and are themed separately (a
 * channels-package change importing `ActivityStatusMarkers` from `@comis/core`
 * — the legal channels→core direction). `core`/`observability` never import
 * `channels`, so this module bakes only the markers it produces here.
 */
const DEFAULT_MARKERS: ActivityStatusMarkers = {
  success: "✓",
  failure: "❌",
  subagent: "🤖",
  running: "🔧",
};

/**
 * Create the ActivityStream. Subscribes to the EventBus immediately; call
 * `dispose()` at shutdown.
 */
export function createActivityStream(deps: CreateActivityStreamDeps): ActivityStream {
  const now = deps.nowMs ?? systemNowMs;
  // Resolve the active status-marker set ONCE. A themed subagent marker
  // is baked into `defaultLabel` here (upstream of the channel painter, which
  // paints `defaultLabel` verbatim — render.ts:21), so the painter stays dumb
  // and the ascii theme strips emoji at the source. No theme / markerless theme
  // → DEFAULT_MARKERS → byte-identical to today (default-parity).
  const markers = deps.theme?.markers ?? DEFAULT_MARKERS;
  const subscribers = new Set<TurnSubscriber>();
  // toolCallId/requestId → minted activityId (stable across start↔end).
  const activityIds = new Map<string, string>();
  // requestId → correlation context (approval index).
  const approvalIndex = new Map<string, CorrelationEntry>();
  // runId → parentSessionKey: the spawn payload carries the session, the
  // completed payload does NOT, so remember it to scope the close event.
  const subagentSessions = new Map<string, string>();

  let emitted = 0;
  let dropped = 0;
  let redactionReplacements = 0;

  const childLogger = deps.logger?.child?.({ submodule: "activity-stream" }) ?? deps.logger;

  function ts(): string {
    return systemDateFrom(now()).toISOString();
  }

  /** Mint (or reuse) the stable activityId for a correlation key. */
  function activityIdFor(key: string): string {
    const existing = activityIds.get(key);
    if (existing !== undefined) return existing;
    const id = randomUUID();
    activityIds.set(key, id);
    return id;
  }

  /**
   * Build the label for a tool/approval event, re-applying redaction
   * (defense-in-depth) and emitting the WARN when redactions fired.
   *
   * Label-egress wiring boundary: `compressLabel` runs ONCE here, on the FINAL
   * post-`applyTemplate` (post-redaction) `defaultLabel`, on BOTH return paths —
   * the single label-egress point. The redact→compress order is load-bearing:
   * the compressor runs AFTER `redactValue` (which `applyTemplate` already
   * applied), so it never lets a raw URL/path escape redaction and never
   * re-compacts an already-compacted (`~`-rooted / ≤2-segment) path (it is a
   * fixed point). It is NOT called inside `applyTemplate`
   * (a `core` redaction-only primitive) and NOT on the subagent/model marker
   * labels (those bypass `buildLabel` — short static `markers.subagent`/
   * "switching model provider" strings; compressing them is a needless no-op).
   */
  function buildLabel(
    toolName: string,
    action: string | undefined,
    params: Readonly<Record<string, unknown>>,
  ): { defaultLabel: string; semanticPhase: ActivityEvent["semanticPhase"] } {
    const spec = resolveLabelSpec(toolName, {
      ...(action !== undefined ? { action } : {}),
      ...(deps.theme !== undefined ? { theme: deps.theme } : {}),
    });
    const result = applyTemplate(
      spec,
      params,
      deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {},
    );
    if (!result.ok) {
      // unknown_key — fall back to the placeholder-stripped semantic label,
      // compressed at the egress like the success path.
      return {
        defaultLabel: compressLabel(spec.label.replace(/\{[A-Za-z0-9_]+\}/g, "").trim()),
        semanticPhase: spec.semanticPhase,
      };
    }
    if (result.value.redactionsApplied.length > 0) {
      redactionReplacements += result.value.redactionsApplied.length;
      // Exactly one WARN when a tool tried to substitute a
      // secret-keyed value. Object-first; module-identity field never set.
      childLogger?.warn?.(
        {
          toolName,
          redactionsApplied: result.value.redactionsApplied,
          truncated: result.value.truncated,
          errorKind: "validation" as const,
          hint: "activity template substituted a redact-flagged value; inspect the tool's params allowlist",
          step: "template-redaction",
        },
        "redactions applied during activity label rendering",
      );
    }
    return {
      defaultLabel: compressLabel(result.value.defaultLabel),
      semanticPhase: spec.semanticPhase,
    };
  }

  /**
   * Validate + deliver a mapped ActivityEvent to every turn subscriber it is
   * scoped to. Logs ERROR + drops on a parse failure. Returns true on
   * successful emit.
   */
  function dispatch(raw: unknown, indexFor?: { requestId: string; shortId: string }): boolean {
    const parsed = parseActivityEvent(raw);
    if (!parsed.ok) {
      childLogger?.error?.(
        {
          issues: parsed.error.issues,
          errorKind: "internal" as const,
          hint: "a producer emitted a malformed activity event; fix the emit site mapping",
          step: "parse-activity-event",
        },
        "parseActivityEvent rejected a mapped event",
      );
      return false;
    }
    const event = parsed.value;
    emitted += 1;
    childLogger?.debug?.(
      {
        activityId: event.activityId,
        traceId: event.traceId,
        agentId: event.agentId,
        sessionKey: event.sessionKey,
        kind: event.kind,
        phase: event.phase,
        status: event.status,
        ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
        step: "emit",
      },
      "activity event emitted",
    );
    // Record/refresh the approval correlation index AFTER a successful parse.
    // The authoritative shortId rides on the entry so the resolved event reuses
    // it verbatim — no re-derivation.
    if (indexFor !== undefined) {
      approvalIndex.set(indexFor.requestId, {
        activityId: event.activityId,
        agentId: event.agentId,
        sessionKey: event.sessionKey,
        traceId: event.traceId,
        shortId: indexFor.shortId,
        ...(event.channelKey !== undefined ? { channelType: event.channelKey } : {}),
      });
    }
    // Deliver to every turn subscriber whose ids match (turn-scoped filter).
    // The per-consumer bounded queue absorbs backpressure: push then
    // drain synchronously to the consumer. A push that drops (main-ring or
    // failure-overflow overflow) increments the `dropped` counter.
    for (const sub of subscribers) {
      if (
        sub.ctx.agentId === event.agentId &&
        sub.ctx.sessionKey === event.sessionKey &&
        sub.ctx.traceId === event.traceId
      ) {
        const droppedByPush = sub.queue.push(event);
        if (droppedByPush > 0) {
          dropped += droppedByPush;
          childLogger?.warn?.(
            {
              agentId: event.agentId,
              sessionKey: event.sessionKey,
              consumer: sub.ctx.rendererKey,
              reason: "queue_full",
              errorKind: "resource" as const,
              hint: "activity consumer is slow; the bounded queue dropped the oldest non-failure event",
              step: "queue-drop",
            },
            "activity bounded-queue dropped an event",
          );
        }
        for (const queued of sub.queue.drain()) {
          sub.onEvent(queued);
        }
      }
    }
    return true;
  }

  /**
   * Deliver a subagent event. The spawn/completed payloads carry no
   * `traceId` (and no parent `activityId`), so the event is delivered to every
   * turn subscriber whose `{agentId, sessionKey}` match, STAMPING that
   * subscriber's `traceId` onto a freshly-parsed copy. `parentActivityId` is left
   * to the coordinator. Mirrors the bounded-queue delivery in {@link dispatch}.
   */
  function dispatchSubagent(base: Record<string, unknown>): void {
    for (const sub of subscribers) {
      if (sub.ctx.agentId !== base.agentId || sub.ctx.sessionKey !== base.sessionKey) {
        continue;
      }
      const parsed = parseActivityEvent({ ...base, traceId: sub.ctx.traceId });
      if (!parsed.ok) {
        childLogger?.error?.(
          {
            issues: parsed.error.issues,
            errorKind: "internal" as const,
            hint: "a producer emitted a malformed subagent activity event; fix the emit site mapping",
            step: "parse-activity-event",
          },
          "parseActivityEvent rejected a mapped subagent event",
        );
        continue;
      }
      const event = parsed.value;
      emitted += 1;
      childLogger?.debug?.(
        {
          activityId: event.activityId,
          traceId: event.traceId,
          agentId: event.agentId,
          sessionKey: event.sessionKey,
          kind: event.kind,
          phase: event.phase,
          status: event.status,
          step: "emit",
        },
        "activity event emitted",
      );
      const droppedByPush = sub.queue.push(event);
      if (droppedByPush > 0) {
        dropped += droppedByPush;
        childLogger?.warn?.(
          {
            agentId: event.agentId,
            sessionKey: event.sessionKey,
            consumer: sub.ctx.rendererKey,
            reason: "queue_full",
            errorKind: "resource" as const,
            hint: "activity consumer is slow; the bounded queue dropped the oldest non-failure event",
            step: "queue-drop",
          },
          "activity bounded-queue dropped an event",
        );
      }
      for (const queued of sub.queue.drain()) {
        sub.onEvent(queued);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Per-event mappers (event → ActivityEvent | undefined)
  // -------------------------------------------------------------------------

  function onToolStarted(p: EventMap["tool:started"]): void {
    if (isSuppressed(p.toolName)) return;
    if (p.agentId === undefined || p.sessionKey === undefined || p.traceId === undefined) return;
    const { defaultLabel, semanticPhase } = buildLabel(p.toolName, p.action, p.params ?? {});
    dispatch({
      schemaVersion: 1,
      activityId: activityIdFor(`tool:${p.toolCallId}`),
      sessionKey: p.sessionKey,
      agentId: p.agentId,
      traceId: p.traceId,
      toolCallId: p.toolCallId,
      ts: ts(),
      phase: "start",
      status: "running",
      kind: "tool",
      semanticPhase,
      toolName: p.toolName,
      ...(p.action !== undefined ? { action: p.action } : {}),
      // Prepend the themed running marker to the start-phase label, consistent
      // with the subagent labels below.
      // The running marker is themed (default: 🔧, ascii: [..]) and resolved
      // once at construction. DO NOT apply to onToolExecuted
      // (phase:"end") — the running marker conveys in-flight status only. Clamp
      // the marker-prepended label to the schema cap: the marker is added AFTER
      // compressLabel, so without this a near-cap label would exceed 120 and the
      // event would be DROPPED.
      defaultLabel: clampLabel(`${markers.running} ${defaultLabel}`),
    });
  }

  function onToolExecuted(p: EventMap["tool:executed"]): void {
    if (isSuppressed(p.toolName)) return;
    if (p.agentId === undefined || p.sessionKey === undefined || p.traceId === undefined) return;
    const { defaultLabel, semanticPhase } = buildLabel(p.toolName, undefined, p.params ?? {});
    dispatch({
      schemaVersion: 1,
      activityId: activityIdFor(`tool:${p.toolCallId}`),
      sessionKey: p.sessionKey,
      agentId: p.agentId,
      traceId: p.traceId,
      toolCallId: p.toolCallId,
      ts: ts(),
      phase: "end",
      status: p.success ? "completed" : "failed",
      kind: "tool",
      semanticPhase: p.success ? semanticPhase : "error",
      toolName: p.toolName,
      durationMs: p.durationMs,
      ...(p.errorKind !== undefined ? { errorKind: p.errorKind } : {}),
      defaultLabel,
    });
  }

  function onToolTimeout(p: EventMap["tool:timeout"]): void {
    if (isSuppressed(p.toolName)) return;
    if (p.agentId === undefined || p.sessionKey === undefined) return;
    const { defaultLabel, semanticPhase } = buildLabel(p.toolName, undefined, {});
    void semanticPhase;
    dispatch({
      schemaVersion: 1,
      activityId: activityIdFor(`tool:${p.toolCallId ?? p.toolName}`),
      sessionKey: p.sessionKey,
      agentId: p.agentId,
      traceId: p.traceId,
      ...(p.toolCallId !== undefined ? { toolCallId: p.toolCallId } : {}),
      ts: ts(),
      phase: "end",
      status: "failed",
      kind: "tool",
      semanticPhase: "error",
      toolName: p.toolName,
      errorKind: "timeout",
      defaultLabel,
    });
  }

  function onModelEvent(
    p:
      | EventMap["model:fallback_attempt"]
      | EventMap["model:fallback_exhausted"]
      | EventMap["model:lkw_fallback_attempt"],
  ): void {
    if (p.agentId === undefined || p.sessionKey === undefined || p.traceId === undefined) return;
    dispatch({
      schemaVersion: 1,
      activityId: randomUUID(),
      sessionKey: p.sessionKey,
      agentId: p.agentId,
      traceId: p.traceId,
      ts: ts(),
      phase: "progress",
      status: "running",
      kind: "model",
      semanticPhase: "thinking",
      // Themed running marker on the static label, consistent with the tool path.
      // Clamped to the cap because a custom theme could supply a long marker.
      defaultLabel: clampLabel(`${markers.running} switching model provider`),
    });
  }

  function onApprovalRequested(p: EventMap["approval:requested"]): void {
    if (p.traceId === undefined) return; // trace-less restored approvals: not live activity
    const activityId = activityIdFor(`approval:${p.requestId}`);
    dispatch(
      {
        schemaVersion: 1,
        activityId,
        sessionKey: p.conversationRef,
        agentId: p.agentId,
        traceId: p.traceId,
        ts: ts(),
        phase: "start",
        status: "running",
        kind: "approval",
        semanticPhase: "queued",
        toolName: p.toolName,
        action: p.action,
        approval: {
          shortId: p.shortId,
          expiresAt: p.createdAt + p.timeoutMs,
          choices: [
            { id: "approve", defaultLabel: "Approve", style: "primary" },
            { id: "deny", defaultLabel: "Deny", style: "danger" },
          ],
        },
        defaultLabel: clampLabel(`approval required: ${p.toolName}`),
      },
      { requestId: p.requestId, shortId: p.shortId },
    );
  }

  function onApprovalResolved(p: EventMap["approval:resolved"]): void {
    const entry = approvalIndex.get(p.requestId);
    if (entry === undefined) return; // no matching index → ignore for live activity
    approvalIndex.delete(p.requestId);
    dispatch({
      schemaVersion: 1,
      activityId: entry.activityId,
      sessionKey: entry.sessionKey,
      agentId: entry.agentId,
      traceId: entry.traceId,
      ts: ts(),
      phase: "end",
      status: p.approved ? "completed" : "skipped",
      kind: "approval",
      semanticPhase: p.approved ? "done" : "queued",
      approval: {
        // Reuse the AUTHORITATIVE shortId minted on the start event (carried on
        // the correlation index) so both activity events for one approval
        // share the same unguessable id. The 2-choice block satisfies the
        // `kind === "approval"` refine; renderers still key off the start event.
        shortId: entry.shortId,
        expiresAt: 0,
        choices: [
          { id: "approve", defaultLabel: "Approve", style: "primary" },
          { id: "deny", defaultLabel: "Deny", style: "danger" },
        ],
      },
      defaultLabel: p.approved ? "approval granted" : "approval denied",
    });
  }

  function onSubAgentSpawned(p: EventMap["session:sub_agent_spawned"]): void {
    // The label uses only agentId + the resolved subagent marker
    // (`markers.subagent`; 🤖 for default/no theme, [SUB] for ascii) — never the
    // free-text `task` (which could echo user content). parentActivityId is set
    // by the coordinator, not here.
    subagentSessions.set(p.runId, p.parentSessionKey);
    dispatchSubagent({
      schemaVersion: 1,
      activityId: activityIdFor(`subagent:${p.runId}`),
      sessionKey: p.parentSessionKey,
      agentId: p.agentId,
      ts: ts(),
      phase: "start",
      status: "running",
      kind: "subagent",
      semanticPhase: "thinking",
      defaultLabel: clampLabel(`${markers.subagent} ${p.agentId} subagent`),
    });
  }

  function onSubAgentCompleted(p: EventMap["session:sub_agent_completed"]): void {
    const sessionKey = subagentSessions.get(p.runId);
    if (sessionKey === undefined) return; // no matching spawn → not live activity
    subagentSessions.delete(p.runId);
    dispatchSubagent({
      schemaVersion: 1,
      activityId: activityIdFor(`subagent:${p.runId}`),
      sessionKey,
      agentId: p.agentId,
      ts: ts(),
      phase: "end",
      status: p.success ? "completed" : "failed",
      kind: "subagent",
      semanticPhase: p.success ? "done" : "error",
      durationMs: p.runtimeMs,
      defaultLabel: clampLabel(`${markers.subagent} ${p.agentId} subagent`),
    });
  }

  function isSuppressed(toolName: string): boolean {
    return deps.getToolMetadata?.(toolName)?.suppressActivity === true;
  }

  // -------------------------------------------------------------------------
  // Subscription wiring (cache-trace bridge idiom)
  // -------------------------------------------------------------------------

  const busSubscriptions: Array<{
    eventName: keyof EventMap;
    handler: (payload: unknown) => void;
  }> = [];

  function bind<K extends keyof EventMap>(
    eventName: K,
    handler: (p: EventMap[K]) => void,
  ): void {
    const wrapped = (payload: unknown): void => handler(payload as EventMap[K]);
    deps.eventBus.on(eventName, wrapped as (p: EventMap[K]) => void);
    busSubscriptions.push({ eventName, handler: wrapped });
  }

  bind("tool:started", onToolStarted);
  bind("tool:executed", onToolExecuted);
  bind("tool:timeout", onToolTimeout);
  bind("model:fallback_attempt", onModelEvent);
  bind("model:fallback_exhausted", onModelEvent);
  bind("model:lkw_fallback_attempt", onModelEvent);
  bind("approval:requested", onApprovalRequested);
  bind("approval:resolved", onApprovalResolved);
  bind("session:sub_agent_spawned", onSubAgentSpawned);
  bind("session:sub_agent_completed", onSubAgentCompleted);
  void SUBSCRIBED_EVENTS;

  return {
    subscribeForTurn(ctx, onEvent) {
      const sub: TurnSubscriber = {
        ctx,
        onEvent,
        queue: createBoundedQueue<ActivityEvent>({ isFailure: isFailureEvent }),
      };
      subscribers.add(sub);
      return {
        unsubscribe(): void {
          subscribers.delete(sub);
        },
      };
    },
    dispose(): void {
      for (const s of busSubscriptions) {
        deps.eventBus.off(s.eventName, s.handler as (p: EventMap[keyof EventMap]) => void);
      }
      busSubscriptions.length = 0;
      subscribers.clear();
      activityIds.clear();
      approvalIndex.clear();
      subagentSessions.clear();
    },
    counters(): ActivityCounters {
      return { emitted, dropped, redactionReplacements };
    },
  };
}
