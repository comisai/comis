// SPDX-License-Identifier: Apache-2.0
/**
 * FakeMatrixAdapter — a deterministic, clock-free `ChannelPort` test double for
 * the Matrix channel; it records every outbound `sendMessage` and lets a test
 * push inbound messages to the registered handlers.
 *
 * Mirrors the sibling channel fakes but matches the Matrix plaintext surface:
 *   - reports `connectionMode:"polling"` — Matrix is a `/sync` long-poll channel
 *     (stale-exempt, like Telegram), not a socket or a webhook,
 *   - `channelType:"matrix"`, and mints `matrix-msg-N` ids (the determinism
 *     source for byte-stable fixtures),
 *   - exposes a one-shot `nextError` injection seam so a test can drive the
 *     `sendMessage` failure branch through the `Result` err path,
 *   - omits `editMessage`/`deleteMessage`/`onReaction`/`reactToMessage` — the
 *     Matrix adapter declares none of those this scope (an honest absence, not a
 *     gap), so the fake matches the real port surface exactly.
 *
 * All methods return `Result`; they NEVER throw across the port boundary
 * (AGENTS.md §2.1). No `systemNowMs()` (would flap fixtures).
 */
import { ok, err, type Result } from "@comis/shared";
import type {
  ChannelPort,
  ChannelStatus,
  MessageHandler,
  NormalizedMessage,
  SendMessageOptions,
} from "@comis/core";

/** One recorded adapter call — the Matrix scope records only sends. */
export type FakeMatrixCall = { op: "send"; id: string; roomId: string; text: string };

/** What `createFakeMatrixAdapter()` returns: the port + a `recorded` accessor + seams. */
export interface FakeMatrixAdapter extends ChannelPort {
  /** Ordered call-log — the fixture artifact. Deterministic `matrix-msg-N` ids, no timestamps. */
  readonly recorded: { calls: FakeMatrixCall[] };
  /**
   * One-shot platform-error injection seam. When set, the NEXT `sendMessage`
   * returns `err(nextError)` and clears the seam — drives the adapter's outbound
   * failure branch without a real homeserver.
   */
  nextError: Error | undefined;
  /** Push an inbound message to every registered handler (the inbound flow). */
  deliver(message: NormalizedMessage): void;
}

/**
 * Create a {@link FakeMatrixAdapter}. Mints `matrix-msg-0`, `matrix-msg-1`, … on
 * each `sendMessage` and appends every call to `recorded.calls` in order.
 */
export function createFakeMatrixAdapter(channelId = "matrix"): FakeMatrixAdapter {
  const recorded: { calls: FakeMatrixCall[] } = { calls: [] };
  let messageCounter = 0;
  const handlers: MessageHandler[] = [];

  const adapter: FakeMatrixAdapter = {
    channelId,
    channelType: "matrix",
    recorded,
    nextError: undefined,

    async start(): Promise<Result<void, Error>> {
      return ok(undefined);
    },

    async stop(): Promise<Result<void, Error>> {
      return ok(undefined);
    },

    async sendMessage(
      roomId: string,
      text: string,
      _options?: SendMessageOptions,
    ): Promise<Result<string, Error>> {
      if (adapter.nextError !== undefined) {
        const injected = adapter.nextError;
        adapter.nextError = undefined;
        return err(injected);
      }
      const id = `matrix-msg-${messageCounter++}`;
      recorded.calls.push({ op: "send", id, roomId, text });
      return ok(id);
    },

    onMessage(handler: MessageHandler): void {
      handlers.push(handler);
    },

    deliver(message: NormalizedMessage): void {
      for (const handler of handlers) {
        void handler(message);
      }
    },

    getStatus(): ChannelStatus {
      return {
        connected: true,
        channelId,
        channelType: "matrix",
        connectionMode: "polling",
      };
    },

    async platformAction(
      action: string,
      params: Record<string, unknown>,
    ): Promise<Result<unknown, Error>> {
      return ok({ action, params, echoed: true });
    },
  };

  return adapter;
}
