// SPDX-License-Identifier: Apache-2.0
// @allow-throw: cross-session-sender validation guards (invalid session key, session-not-found, deadlock-risk); consumed via daemon session-handlers (@allow-throw).
/**
 * Cross-session sender module.
 * Supports three messaging modes between agent sessions:
 * - fire-and-forget: inject message and return immediately
 * - wait: inject message, execute target agent, return response
 * - ping-pong: multi-turn alternating exchange between two sessions
 * Extracted from daemon.ts inline session.send handler for testability.
 */

import { createHash } from "node:crypto";
import {
  parseFormattedSessionKey,
  isPermanentError,
  type SessionKey,
  type TypedEventBus,
  type AgentToAgentConfig,
  type OutwardSendLedgerPort,
  type DurableRunPort,
  systemNowMs,
  systemSetTimeout,
} from "@comis/core";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface CrossSessionSenderDeps {
  sessionStore: {
    loadByFormattedKey(key: string): { messages: unknown[]; metadata: Record<string, unknown> } | undefined;
    save(key: SessionKey, messages: unknown[], metadata: Record<string, unknown>): void;
  };
  executeInSession: (
    agentId: string,
    sessionKey: SessionKey,
    text: string,
  ) => Promise<{
    response: string;
    tokensUsed: { total: number };
    cost: { total: number };
  }>;
  sendToChannel: (channelType: string, channelId: string, text: string) => Promise<boolean>;
  eventBus: TypedEventBus;
  config: AgentToAgentConfig;
  /**
   * The three-state outward-send ledger. When present
   * (alongside {@link CrossSessionSenderDeps.durableRuns} + a resolvable
   * rootRunId), the completion-announcement send is routed through the SAME
   * exactly-once ledger as `message.send`, so a restart-driven re-announce of an
   * already-committed announcement is a no-op (no double-notify). `undefined` on
   * a non-autonomy daemon ⇒ the announce is a pass-through.
   * Wired from the daemon.
   */
  outwardLedger?: OutwardSendLedgerPort;
  /**
   * Allocates the stable per-announce `stepIndex` (the other half of the
   * `(rootRunId, stepIndex)` idempotency key) ONCE via `allocateOutwardStep`.
   * `undefined` ⇒ pass-through. Wired from the daemon.
   */
  durableRuns?: DurableRunPort;
  /**
   * Resolves the announce origin's `rootRunId` from the (parsed) caller
   * session key, the SAME resolver the message handlers use. `undefined` (or an
   * unresolvable key) ⇒ pass-through. Wired from the daemon.
   */
  resolveRootRunId?: (sessionKey: SessionKey) => string;
}

export interface CrossSessionSendParams {
  targetSessionKey: string;
  text: string;
  mode: "fire-and-forget" | "wait" | "ping-pong";
  timeoutMs?: number;
  maxTurns?: number;
  callerSessionKey?: string;
  announceChannelType?: string;
  announceChannelId?: string;
  /** Target agent ID for wait/ping-pong execution. Overrides session key agentId inference. */
  agentId?: string;
}

export interface CrossSessionSendResult {
  sent: boolean;
  response?: string;
  turnsCompleted?: number;
  announced?: boolean;
  stats?: { runtimeMs: number; totalTokens: number; totalCost: number };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCrossSessionSender(deps: CrossSessionSenderDeps) {
  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Resolve the announce origin's rootRunId from the caller session key, using
   * the SAME `resolveRootRunId ∘ parseFormattedSessionKey` chain the message
   * handlers use. Returns `undefined` for an absent/malformed key or when the
   * resolver dep is not wired (⇒ a pass-through, non-ledgered announce).
   */
  function resolveAnnounceRootRunId(callerSessionKey: string | undefined): string | undefined {
    if (!callerSessionKey || !deps.resolveRootRunId) return undefined;
    const parsed = parseFormattedSessionKey(callerSessionKey);
    return parsed ? deps.resolveRootRunId(parsed) : undefined;
  }

  /**
   * Send the completion announcement through the SAME three-state ONCE ledger as
   * `message.send`. The lifecycle written around the single
   * `deps.sendToChannel` call mirrors `wrapOutwardSend` exactly:
   *   lookup (committed → no-op) → begin (send_attempt_started, the SOLE INSERT)
   *   → markUnknown (unknown_after_send) → sendToChannel → commit.
   * A committed `(rootRunId, stepIndex)` short-circuits to a no-op (the announce
   * already landed across a restart — no double-notify). A begin UNIQUE-collision
   * is "already in flight" (NO second send). A permanent failure → markFailed
   * (no retry); a transient failure leaves the row `unknown_after_send`
   * for the recovery scan. Content-free: only a sha256 digest
   * reaches the ledger, never the announcement body. The agentId for the row is
   * the caller's resolved agent (the announce origin).
   */
  async function ledgeredAnnounce(
    ledger: OutwardSendLedgerPort,
    rootRunId: string,
    stepIndex: number,
    agentId: string,
    channelType: string,
    channelId: string,
    text: string,
  ): Promise<boolean> {
    // Dedup read: a committed row short-circuits a replay to a no-op —
    // deps.sendToChannel is never reached (no restart double-notify).
    const existing = await ledger.lookup(rootRunId, stepIndex);
    if (existing.ok && existing.value?.state === "committed") {
      return true; // the announcement already landed
    }

    // Content-free key: only the sha256 slice — never the body.
    const contentDigest = createHash("sha256").update(text).digest("hex").slice(0, 16);

    // send_attempt_started BEFORE the platform call. A UNIQUE
    // (rootRunId, stepIndex) collision means another attempt owns this send →
    // do NOT issue a second platform call (no double-notify).
    const begun = await ledger.begin({ rootRunId, stepIndex, agentId, channelType, channelId, contentDigest });
    if (!begun.ok) {
      return true; // already in flight — another attempt owns it
    }

    // unknown_after_send — written BEFORE the platform-call window closes so a
    // crash mid-announce leaves a durable row the recovery scan reconciles.
    await ledger.markUnknown(rootRunId, stepIndex);

    let success = false;
    let sendErr: Error | undefined;
    try {
      success = await deps.sendToChannel(channelType, channelId, text);
    } catch (err) {
      sendErr = err instanceof Error ? err : new Error(String(err));
    }

    if (success) {
      // The announcement has no platform-message-id surface (sendToChannel
      // returns boolean), so commit with a "delivered" sentinel.
      await ledger.commit(rootRunId, stepIndex, "delivered");
      return true;
    }

    // A permanent failure is terminal: markFailed, skip retry. A
    // transient failure (or a false return) leaves the row unknown_after_send for
    // the recovery scan — never a blind replay.
    if (sendErr && isPermanentError(sendErr.message)) {
      await ledger.markFailed(rootRunId, stepIndex, "permanent");
    }
    return false;
  }

  async function announce(
    channelType: string | undefined,
    channelId: string | undefined,
    text: string,
    callerSessionKey: string | undefined,
  ): Promise<boolean> {
    if (!channelType || !channelId) return false;

    // Route the announce through the ONCE ledger when the ledger +
    // durableRuns deps are wired AND the caller resolves to a rootRunId. Allocate
    // the stepIndex ONCE for this announce (the stable key across a restart).
    const rootRunId = resolveAnnounceRootRunId(callerSessionKey);
    if (deps.outwardLedger && deps.durableRuns && rootRunId !== undefined) {
      const allocated = await deps.durableRuns.allocateOutwardStep(rootRunId);
      if (allocated.ok) {
        const parsed = parseFormattedSessionKey(callerSessionKey!);
        const agentId = parsed?.agentId ?? "default";
        return ledgeredAnnounce(
          deps.outwardLedger,
          rootRunId,
          allocated.value,
          agentId,
          channelType,
          channelId,
          text,
        );
      }
      // allocation failed → fall through to a direct (unledgered) send rather
      // than dropping the announcement.
    }

    // Pass-through (non-autonomy / unwired / unresolvable rootRunId): the send is
    // unchanged.
    return deps.sendToChannel(channelType, channelId, text);
  }

  function stripAnnounceSkip(text: string): { stripped: string; hadSkip: boolean } {
    const hadSkip = text.includes("ANNOUNCE_SKIP");
    const stripped = hadSkip ? text.replace("ANNOUNCE_SKIP", "").trim() : text;
    return { stripped, hadSkip };
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    async send(params: CrossSessionSendParams): Promise<CrossSessionSendResult> {
      // 1. Parse and validate target session key
      const parsedKey = parseFormattedSessionKey(params.targetSessionKey);
      if (!parsedKey) {
        throw new Error(`Invalid session key: ${params.targetSessionKey}`);
      }

      // 2. Load target session
      const data = deps.sessionStore.loadByFormattedKey(params.targetSessionKey);
      if (!data) {
        throw new Error(`Session not found: ${params.targetSessionKey}`);
      }

      // 3. Inject synthetic user message into target session
      const newMessage = {
        role: "user",
        content: params.text,
        timestamp: systemNowMs(),
        metadata: { crossSession: true, fromSession: params.callerSessionKey },
      };
      const updatedMessages = [...data.messages, newMessage];
      deps.sessionStore.save(parsedKey, updatedMessages, data.metadata);

      // 4. Emit cross-send event
      deps.eventBus.emit("session:cross_send", {
        fromSessionKey: params.callerSessionKey ?? "unknown",
        toSessionKey: params.targetSessionKey,
        mode: params.mode,
        timestamp: systemNowMs(),
      });

      // 5. Fire-and-forget: return immediately
      if (params.mode === "fire-and-forget") {
        return { sent: true };
      }

      // 6. Self-targeting guard for wait/ping-pong modes
      if (params.callerSessionKey === params.targetSessionKey) {
        throw new Error(
          "Cannot send to own session in wait/ping-pong mode (deadlock risk). Use fire-and-forget mode instead.",
        );
      }

      // 7. Execute target agent (use explicit agentId if provided, else infer from key, else "default")
      const agentId = params.agentId ?? parsedKey.agentId ?? "default";
      const startMs = systemNowMs();
      const timeoutMs = params.timeoutMs ?? deps.config.waitTimeoutMs;

      const execResult = await Promise.race([
        deps.executeInSession(agentId, parsedKey, params.text),
        new Promise<never>((_, reject) =>
          systemSetTimeout(() => reject(new Error("Cross-session wait timed out")), timeoutMs),
        ),
      ]);

      let totalTokens = execResult.tokensUsed.total;
      let totalCost = execResult.cost.total;
      let lastResponse = execResult.response;

      // 8. Wait mode: announce and return
      if (params.mode === "wait") {
        const { stripped, hadSkip } = stripAnnounceSkip(lastResponse);
        const announced = hadSkip
          ? false
          : await announce(params.announceChannelType, params.announceChannelId, stripped, params.callerSessionKey);
        return {
          sent: true,
          response: stripped,
          announced,
          stats: {
            runtimeMs: systemNowMs() - startMs,
            totalTokens,
            totalCost,
          },
        };
      }

      // 9. Ping-pong mode: loop alternating between sessions
      const maxTurns = params.maxTurns ?? deps.config.maxPingPongTurns;
      let turnsCompleted = 0;
      let currentTarget = params.callerSessionKey!;
      let currentSource = params.targetSessionKey;

      while (turnsCompleted < maxTurns) {
        // Check for ANNOUNCE_SKIP escape in last response
        if (lastResponse.includes("ANNOUNCE_SKIP")) {
          break;
        }

        const targetKey = parseFormattedSessionKey(currentTarget);
        if (!targetKey) break;

        const turnAgentId = targetKey.agentId ?? "default";
        const turnResult = await deps.executeInSession(turnAgentId, targetKey, lastResponse);

        totalTokens += turnResult.tokensUsed.total;
        totalCost += turnResult.cost.total;
        lastResponse = turnResult.response;
        turnsCompleted++;

        // Emit ping-pong turn event
        deps.eventBus.emit("session:ping_pong_turn", {
          fromSessionKey: currentSource,
          toSessionKey: currentTarget,
          turnNumber: turnsCompleted,
          totalTurns: maxTurns,
          tokensUsed: turnResult.tokensUsed.total,
          timestamp: systemNowMs(),
        });

        // Swap directions for next turn
        [currentTarget, currentSource] = [currentSource, currentTarget];
      }

      // 10. Announce final result
      const { stripped, hadSkip } = stripAnnounceSkip(lastResponse);
      const announced = hadSkip
        ? false
        : await announce(params.announceChannelType, params.announceChannelId, stripped, params.callerSessionKey);

      return {
        sent: true,
        response: stripped,
        turnsCompleted,
        announced,
        stats: {
          runtimeMs: systemNowMs() - startMs,
          totalTokens,
          totalCost,
        },
      };
    },
  };
}
