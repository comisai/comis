// SPDX-License-Identifier: Apache-2.0
/**
 * DEPTH-03 (Plan 174-03 / WR-02 Plan 174-04) — the run-ONCE bootstrap crash-recovery
 * trigger, extracted from `createPiExecutor`'s in-lock `runSessionLocked` body.
 *
 * Closure-extraction protocol: state-by-parameter (`Readonly<MaybeRunBootstrapSweepState>`)
 * — mirrors `installCompactionTrigger` / `runSafetyGates`, keeping the over-cap
 * `pi-executor.ts` from accreting another inline wiring block (IN-01).
 *
 * WR-02 (Plan 174-04): the trigger now runs EXACTLY ONCE per session — gated on the
 * existing `isFirstMessageInSession` signal (`sessionContext.messages.length === 0`),
 * computed once at the top of `runSessionLocked`. The previous inline block gated only
 * on `contextStore` presence, so it re-ran the sweep on EVERY turn for the life of every
 * dag session. Exactly-once was already guaranteed by the durable ingest cursor (turns
 * 2+ were idempotent no-ops), so this removes per-turn LCD single-flight overhead
 * (`runOnConversation` + `getIngestCursor` + `getMessages` + `upsertIngestCursor`) and
 * honors the documented "Runs ONCE at session start" contract — code and comment now agree.
 *
 * The recovery itself is the EXISTING `bootstrapLcdSweep` (epoch cursor + fail-closed
 * identity guard); this helper is only the gate + scope build + delegating call. The scope
 * is built EXACTLY as the afterTurn ingest block does so read scope == write scope
 * (DAG-CRIT-1 / WR-02): conversationId === sessionKey === formattedKey,
 * agentId === `agentId ?? "default"`.
 *
 * Architecture cut (agent↛memory): imports ONLY the core `ContextStorePort`/`ClockPort`/
 * `ComisLogger`/`TypedEventBus` TYPES + the in-package `bootstrapLcdSweep`. The concrete
 * store is daemon-injected; the memory package is never imported here.
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
import { bootstrapLcdSweep } from "../lcd-bootstrap-sweep.js";

/**
 * State surface for {@link maybeRunBootstrapSweep} — the exact inputs the previous inline
 * sweep block read from the `runSessionLocked` closure, passed explicitly (closure-extraction
 * protocol). All primitives/types (no `@comis/memory` value imports).
 */
export interface MaybeRunBootstrapSweepState {
  /**
   * WR-02 run-once gate: true on the FIRST message of this session
   * (`sessionContext.messages.length === 0`). When false the helper is a no-op (no store
   * read, no event) — the durable cursor already covered any gap on the first message.
   */
  readonly isFirstMessageInSession: boolean;
  /** The injected core ContextStorePort (daemon-injected concrete store). Absent ⇒ no-op. */
  readonly contextStore: ContextStorePort | undefined;
  /** The formatted session key — conversationId === sessionKey === formattedKey (well-formed). */
  readonly formattedKey: string;
  /** The agent's tenant id (frozenDeps.tenantId ?? sessionKey.tenantId at the call site). */
  readonly tenantId: string;
  /** The agent id (`agentId ?? "default"` — the afterTurn write-scope invariant). */
  readonly agentId: string;
  /** The JSONL-loaded live canonical AgentMessage[] (session.agent.state.messages). */
  readonly live: AgentMessage[];
  /** Injected wall clock — `clock.now()`, NEVER Date.now(). */
  readonly clock: ClockPort;
  /** For the bootstrap-origin DEBUG + the delegated ingest logs. */
  readonly logger: ComisLogger;
  /** For the three content-free context:dag_degraded health signals. */
  readonly eventBus: TypedEventBus;
  /** Read by `shouldRunLcdStorePasses` inside the sweep — only dag mode reads the LCD store. */
  readonly config: { contextEngine?: { version?: "pipeline" | "dag" } };
}

/**
 * Run the DEPTH-03 bootstrap crash-recovery sweep ONCE at session start, before the first
 * turn proceeds. No-op when this is NOT the first message in the session (WR-02) or when no
 * store is wired. Delegates to {@link bootstrapLcdSweep} (the recovery logic + the
 * `shouldRunLcdStorePasses` dag gate live there; a pipeline agent does no sweep work).
 */
export async function maybeRunBootstrapSweep(
  state: Readonly<MaybeRunBootstrapSweepState>,
): Promise<void> {
  // WR-02: truly run ONCE — gate on the first-message signal. Turns 2+ were already
  // idempotent via the durable ingest cursor; skipping them removes the per-turn LCD
  // single-flight overhead and matches the "Runs ONCE at session start" contract.
  if (!state.isFirstMessageInSession || !state.contextStore) return;

  const scope: ContextStoreScope = {
    conversationId: state.formattedKey,
    tenantId: state.tenantId,
    agentId: state.agentId,
    sessionKey: state.formattedKey,
  };
  await bootstrapLcdSweep({
    store: state.contextStore,
    scope,
    live: state.live,
    clock: state.clock,
    logger: state.logger,
    eventBus: state.eventBus,
    config: state.config,
  });
}
