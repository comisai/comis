// SPDX-License-Identifier: Apache-2.0
/**
 * Cross-session sender module.
 * Supports three messaging modes between agent sessions:
 * - fire-and-forget: inject message and return immediately
 * - wait: inject message, execute target agent, return response
 * - ping-pong: multi-turn alternating exchange between two sessions
 * Extracted from daemon.ts inline session.send handler for testability.
 */

import {
  parseFormattedSessionKey,
  type SessionKey,
  type TypedEventBus,
  type AgentToAgentConfig,
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

  async function announce(
    channelType: string | undefined,
    channelId: string | undefined,
    text: string,
  ): Promise<boolean> {
    if (!channelType || !channelId) return false;
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
        timestamp: Date.now(),
        metadata: { crossSession: true, fromSession: params.callerSessionKey },
      };
      const updatedMessages = [...data.messages, newMessage];
      deps.sessionStore.save(parsedKey, updatedMessages, data.metadata);

      // 4. Emit cross-send event
      deps.eventBus.emit("session:cross_send", {
        fromSessionKey: params.callerSessionKey ?? "unknown",
        toSessionKey: params.targetSessionKey,
        mode: params.mode,
        timestamp: Date.now(),
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
      const startMs = Date.now();
      const timeoutMs = params.timeoutMs ?? deps.config.waitTimeoutMs;

      const execResult = await Promise.race([
        deps.executeInSession(agentId, parsedKey, params.text),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Cross-session wait timed out")), timeoutMs),
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
          : await announce(params.announceChannelType, params.announceChannelId, stripped);
        return {
          sent: true,
          response: stripped,
          announced,
          stats: {
            runtimeMs: Date.now() - startMs,
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
          timestamp: Date.now(),
        });

        // Swap directions for next turn
        [currentTarget, currentSource] = [currentSource, currentTarget];
      }

      // 10. Announce final result
      const { stripped, hadSkip } = stripAnnounceSkip(lastResponse);
      const announced = hadSkip
        ? false
        : await announce(params.announceChannelType, params.announceChannelId, stripped);

      return {
        sent: true,
        response: stripped,
        turnsCompleted,
        announced,
        stats: {
          runtimeMs: Date.now() - startMs,
          totalTokens,
          totalCost,
        },
      };
    },
  };
}
