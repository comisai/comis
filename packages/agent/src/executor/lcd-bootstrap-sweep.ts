// SPDX-License-Identifier: Apache-2.0
/**
 * Bootstrap crash-recovery sweep.
 *
 * Closes the mid-turn crash gap: when the daemon is killed AFTER the JSONL
 * trajectory write but BEFORE the `afterTurn` ingest, those messages never reach
 * the durable LCD store. On session start this sweep triggers the EXISTING
 * `ingestTurnGuarded` (lcd-ingest.ts:269) — the SAME epoch-cursor continue-append
 * the afterTurn path uses — so live-transcript messages newer than the durable
 * `lcd_ingest_cursor` and absent from LCD are continue-appended EXACTLY ONCE.
 *
 * This module is the TRIGGER only — the recovery logic is `ingestTurnGuarded`,
 * NOT reimplemented here:
 *   - EXACTLY-ONCE is the cursor: the sweep bumps `ingestedLiveLen` to
 *     `live.length`; the subsequent first-turn afterTurn then sees the cursor
 *     already there and appends only genuinely-new messages (no
 *     double-append, no seq collision).
 *   - FAIL-CLOSED on ambiguous transcript identity is the existing
 *     `isScopeSafeForIngest` guard inside `ingestTurnGuarded` (an empty security
 *     column OR conversationRef≠sessionKey → refuse + onFailClosed), extending the
 *     `live_store_divergence` family — a mis-derived session key can never
 *     silently reattach this transcript to a prior conversation.
 *   - LCD-IS-TRUTH: this is a one-way catch-up SWEEP. The design
 *     explicitly REJECTS reconciling the JSONL and the store as co-equal
 *     authorities (no comparison of the JSONL's byte position / modification time
 *     / content hash); the durable LCD store is the single source of truth and is
 *     only appended to, never rewritten or deleted (losslessness).
 *
 * The additional behavior at the afterTurn site is only: (1) this distinct trigger that runs
 * ONCE at session start before the first turn, and (2) a distinct content-free
 * DEBUG (`step: "lcd_bootstrap_sweep"`) so an operator can tell a bootstrap
 * recovery from an afterTurn one. The three `context:dag_degraded` emits are the
 * verbatim content-free closed-union shapes from executor-post-execution.ts.
 *
 * Architecture cut (agent↛memory): this module imports ONLY the CORE
 * `ContextStorePort`/`ContextStoreScope`/`ComisLogger`/`ClockPort`/`TypedEventBus`
 * TYPES + the in-package `ingestTurnGuarded` + `shouldRunContextStorePasses`. The
 * concrete `createLcdStore` is injected by the daemon — the memory package is
 * never imported here (the agent depends on the core port type, not the adapter).
 *
 * @module
 */

import type {
  ClockPort,
  ComisLogger,
  ContextStorePort,
  ContextStoreScope,
  TypedEventBus,
} from "@comis/core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { ingestTurnGuarded } from "./lcd-ingest.js";
import { shouldRunContextStorePasses } from "./executor-post-execution.js";

/**
 * Arguments for {@link bootstrapLcdSweep}. The shape carries the same fields the
 * afterTurn ingest block reads — kept small + structural (primitives, mirroring
 * how `ingestTurnGuarded` takes primitives rather than the whole executor deps
 * object) so the trigger is unit-testable without the full executor.
 */
export interface BootstrapLcdSweepArgs {
  /** The injected core ContextStorePort (the concrete store is daemon-injected). */
  store: ContextStorePort;
  /** Canonical authority columns plus a display-only session key. */
  scope: ContextStoreScope;
  /** The JSONL-loaded live canonical AgentMessage[] (session.agent.state.messages). */
  live: AgentMessage[];
  /** Injected wall clock — `clock.now()`, NEVER Date.now(). */
  clock: ClockPort;
  /** For the bootstrap-origin DEBUG + the delegated ingest logs. */
  logger: ComisLogger;
  /** For the three content-free context:dag_degraded health signals. */
  eventBus: TypedEventBus;
  /** Read by `shouldRunContextStorePasses`; disabled context assembly skips the sweep. */
  config: { contextEngine?: { enabled?: boolean } };
}

/**
 * Run the bootstrap crash-recovery sweep ONCE at session start, before the first
 * turn proceeds. Gated exactly like afterTurn ingest: explicitly disabled
 * context assembly does no sweep work (no read, no event). Steady-state (no
 * gap) is a no-op — `ingestTurnGuarded`'s delta is empty, byte-identical to not
 * running it.
 *
 * The recovery itself is `ingestTurnGuarded` inside the per-conversation
 * single-flight serializer (`runOnConversation`) so the cursor + rows are written
 * in one serialized slot (atomicity) and the sweep cannot interleave with a
 * deferred compaction on the same conversation.
 */
export async function bootstrapLcdSweep(args: BootstrapLcdSweepArgs): Promise<void> {
  const { store, scope, live, clock, logger, eventBus, config } = args;

  // Same gate as the afterTurn block. No store read or event when context
  // assembly is explicitly disabled.
  if (!shouldRunContextStorePasses(config)) return;

  // Time the sweep with two clock reads (entry → emit), like the afterTurn site —
  // bound to the injected ClockPort, never Date.now().
  const sweepStart = clock.now();

  // Route the recovery through the per-conversation single-flight serializer so
  // the cursor + rows land in the same serialized slot (atomic; the unique
  // (conversation, agent, tenant, seq) index is the final guard). The sweep is a
  // fast synchronous append — it shares the queue with any deferred compaction.
  await store.runOnConversation(scope.conversationRef, () =>
    ingestTurnGuarded(
      store,
      scope,
      live,
      clock.now(),
      logger,
      // onFailClosed: the existing isScopeSafeForIngest refuse path — an
      // ambiguous/malformed scope refused the import rather than silently
      // reattaching to a prior conversation. Emit the content-free closed-union
      // reason (identifiers + reason + durationMs only — NEVER message content).
      () => {
        eventBus.emit("context:dag_degraded", {
          conversationId: scope.conversationRef,
          agentId: scope.agentId,
          sessionKey: scope.sessionKey,
          reason: "fail_closed_rollover",
          durationMs: Math.max(0, clock.now() - sweepStart),
          timestamp: clock.now(),
        });
      },
      // onDivergence: the genuine in-session shrink skip (live shorter than
      // the cursor within the same epoch) — surfaced as a content-free
      // live_store_divergence health signal, same as the afterTurn site.
      () => {
        eventBus.emit("context:dag_degraded", {
          conversationId: scope.conversationRef,
          agentId: scope.agentId,
          sessionKey: scope.sessionKey,
          reason: "live_store_divergence",
          durationMs: Math.max(0, clock.now() - sweepStart),
          timestamp: clock.now(),
        });
      },
      // onRebase: a detected epoch re-base that continued appending at the store's
      // max seq (the same rebase path the afterTurn ingest takes, also reachable
      // at bootstrap) — a correct continuation, not degradation. Content-free session_rebase.
      () => {
        eventBus.emit("context:dag_degraded", {
          conversationId: scope.conversationRef,
          agentId: scope.agentId,
          sessionKey: scope.sessionKey,
          reason: "session_rebase",
          durationMs: Math.max(0, clock.now() - sweepStart),
          timestamp: clock.now(),
        });
      },
    ),
  );

  // Distinct bootstrap-origin trace (§2.7) so an operator can tell a bootstrap
  // crash-recovery from an afterTurn ingest. Content-free — identifiers/durations
  // only, NEVER message bodies. The per-message append accounting (counts) lives
  // in ingestTurn's own DEBUG; this line marks the bootstrap trigger fired.
  logger.debug(
    {
      step: "lcd_bootstrap_sweep",
      conversationRef: scope.conversationRef,
      agentId: scope.agentId,
      sessionKey: scope.sessionKey,
      liveLen: live.length,
      durationMs: Math.max(0, clock.now() - sweepStart),
    },
    "LCD bootstrap crash-recovery sweep ran",
  );
}
