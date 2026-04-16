/**
 * ChaosEchoAdapter: A fault-injecting ChannelPort wrapper around EchoChannelAdapter.
 *
 * Provides configurable failure rates, deterministic failures, latency injection,
 * rate limiting simulation, and call recording for post-hoc assertion in
 * integration tests that exercise retry logic, circuit breakers, and queue overflow.
 */

import { setTimeout } from "node:timers/promises";

import { EchoChannelAdapter } from "@comis/channels";
import type {
  ChannelPort,
  MessageHandler,
  SendMessageOptions,
  FetchMessagesOptions,
  AttachmentPayload,
} from "@comis/core";
import { err, type Result } from "@comis/shared";

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface ChaosConfig {
  failRate?: number; // 0-1 probability of failure. Default: 0
  failOnNext?: number; // Next N calls fail deterministically
  latencyMs?: number; // Artificial delay in ms. Default: 0
  rateLimiting?: {
    maxCalls: number;
    windowMs: number;
  };
}

export interface CallRecord {
  method: string;
  args: unknown[];
  timestamp: number;
  result: "success" | "failure";
  error?: string;
  durationMs: number;
}

export interface ChaosEchoAdapter extends ChannelPort {
  setChaos(config: Partial<ChaosConfig>): void;
  getCallLog(): ReadonlyArray<CallRecord>;
  clearCallLog(): void;
  resetChaos(): void;
  readonly inner: EchoChannelAdapter;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface ChaosEchoAdapterOptions {
  chaos?: ChaosConfig;
  channelId?: string;
  channelType?: string;
}

export function createChaosEchoAdapter(
  options?: ChaosEchoAdapterOptions,
): ChaosEchoAdapter {
  const inner = new EchoChannelAdapter({
    channelId: options?.channelId,
    channelType: options?.channelType,
  });

  // Internal mutable state
  let chaosConfig: ChaosConfig = {
    failRate: options?.chaos?.failRate ?? 0,
    failOnNext: options?.chaos?.failOnNext,
    latencyMs: options?.chaos?.latencyMs ?? 0,
    rateLimiting: options?.chaos?.rateLimiting,
  };
  let callLog: CallRecord[] = [];
  let rateLimitTimestamps: number[] = [];
  let failOnNextRemaining: number = chaosConfig.failOnNext ?? 0;

  // -------------------------------------------------------------------------
  // Shared interception logic
  // -------------------------------------------------------------------------

  async function intercept<T>(
    method: string,
    args: unknown[],
    delegate: () => Promise<Result<T, Error>>,
  ): Promise<Result<T, Error>> {
    const start = Date.now();

    // 1. Latency injection (before any logic)
    if (chaosConfig.latencyMs && chaosConfig.latencyMs > 0) {
      await setTimeout(chaosConfig.latencyMs);
    }

    // 2. Rate limiting check
    if (chaosConfig.rateLimiting) {
      const now = Date.now();
      const { maxCalls, windowMs } = chaosConfig.rateLimiting;
      // Clean old timestamps outside the sliding window
      rateLimitTimestamps = rateLimitTimestamps.filter(
        (t) => t > now - windowMs,
      );
      if (rateLimitTimestamps.length >= maxCalls) {
        const record: CallRecord = {
          method,
          args,
          timestamp: start,
          result: "failure",
          error: "Rate limited",
          durationMs: Date.now() - start,
        };
        callLog.push(record);
        return err(new Error("Chaos: rate limited"));
      }
      rateLimitTimestamps.push(now);
    }

    // 3. Deterministic failure (failOnNext)
    if (failOnNextRemaining > 0) {
      failOnNextRemaining--;
      const record: CallRecord = {
        method,
        args,
        timestamp: start,
        result: "failure",
        error: `Chaos: deterministic failure (${method})`,
        durationMs: Date.now() - start,
      };
      callLog.push(record);
      return err(new Error(`Chaos: deterministic failure (${method})`));
    }

    // 4. Probabilistic failure (failRate)
    if (chaosConfig.failRate && Math.random() < chaosConfig.failRate) {
      const record: CallRecord = {
        method,
        args,
        timestamp: start,
        result: "failure",
        error: `Chaos: random failure (${method})`,
        durationMs: Date.now() - start,
      };
      callLog.push(record);
      return err(new Error(`Chaos: random failure (${method})`));
    }

    // 5. Delegate to inner adapter
    const result = await delegate();
    const record: CallRecord = {
      method,
      args,
      timestamp: start,
      result: result.ok ? "success" : "failure",
      error: result.ok ? undefined : result.error.message,
      durationMs: Date.now() - start,
    };
    callLog.push(record);
    return result;
  }

  // -------------------------------------------------------------------------
  // ChaosEchoAdapter object
  // -------------------------------------------------------------------------

  return {
    // Expose inner adapter for test helpers
    get inner() {
      return inner;
    },

    // Passthrough properties
    get channelId() {
      return inner.channelId;
    },
    get channelType() {
      return inner.channelType;
    },

    // Passthrough lifecycle methods (no chaos)
    start() {
      return inner.start();
    },
    stop() {
      return inner.stop();
    },
    onMessage(handler: MessageHandler) {
      inner.onMessage(handler);
    },
    getStatus() {
      return inner.getStatus?.();
    },

    // Intercepted methods (chaos injection)
    sendMessage(
      channelId: string,
      text: string,
      messageOptions?: SendMessageOptions,
    ) {
      return intercept("sendMessage", [channelId, text, messageOptions], () =>
        inner.sendMessage(channelId, text, messageOptions),
      );
    },

    editMessage(channelId: string, messageId: string, text: string) {
      return intercept(
        "editMessage",
        [channelId, messageId, text],
        () => inner.editMessage(channelId, messageId, text),
      );
    },

    reactToMessage(channelId: string, messageId: string, emoji: string) {
      return intercept(
        "reactToMessage",
        [channelId, messageId, emoji],
        () => inner.reactToMessage(channelId, messageId, emoji),
      );
    },

    deleteMessage(channelId: string, messageId: string) {
      return intercept("deleteMessage", [channelId, messageId], () =>
        inner.deleteMessage(channelId, messageId),
      );
    },

    fetchMessages(channelId: string, fetchOptions?: FetchMessagesOptions) {
      return intercept(
        "fetchMessages",
        [channelId, fetchOptions],
        () => inner.fetchMessages(channelId, fetchOptions),
      );
    },

    sendAttachment(
      channelId: string,
      attachment: AttachmentPayload,
      messageOptions?: SendMessageOptions,
    ) {
      return intercept(
        "sendAttachment",
        [channelId, attachment, messageOptions],
        () => inner.sendAttachment(channelId, attachment, messageOptions),
      );
    },

    platformAction(action: string, params: Record<string, unknown>) {
      return intercept("platformAction", [action, params], () =>
        inner.platformAction(action, params),
      );
    },

    // Control methods
    setChaos(config: Partial<ChaosConfig>) {
      chaosConfig = { ...chaosConfig, ...config };
      if (config.failOnNext !== undefined) {
        failOnNextRemaining = config.failOnNext;
      }
    },

    getCallLog(): ReadonlyArray<CallRecord> {
      return callLog;
    },

    clearCallLog() {
      callLog = [];
      rateLimitTimestamps = [];
    },

    resetChaos() {
      chaosConfig = {
        failRate: 0,
        failOnNext: undefined,
        latencyMs: 0,
        rateLimiting: undefined,
      };
      failOnNextRemaining = 0;
      rateLimitTimestamps = [];
    },
  };
}
