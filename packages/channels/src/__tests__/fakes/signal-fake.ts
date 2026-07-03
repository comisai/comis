// SPDX-License-Identifier: Apache-2.0
/**
 * FakeSignalAdapter — a deterministic, clock-free `ChannelPort` test double for
 * the Signal DeleteAndRepost renderer; it records every method call.
 *
 * Mirrors `createFakeTelegramAdapter` (the canonical template) but for the
 * DeleteAndRepost shape:
 *   - mints `sig-msg-N` ids (Signal's determinism source for byte-stable
 *     fixtures; clock-free, no wall-time call that would flap),
 *   - records NO `silent` flag on `send` (Signal does not send the silent
 *     effect — the renderer posts a plain message per transition), and
 *   - OMITS `editMessage` entirely. Signal has no in-place edit; the live
 *     adapter exposes no `editMessage`, so the fake leaves the optional port
 *     method absent — that is exactly what `makeSignalRenderActions`'s
 *     `not_supported:edit` guard branches on.
 *
 * The `nextError` injection seam returns a raw signal-cli RPC `Error` through the
 * `Result` err branch (one-shot, then clears) so the classifier tests drive
 * `classifySignalError` — Signal exposes no structured numeric code, so the seam
 * carries a bare `Error` shape (the live adapter returns `err(result.error)`).
 * All methods return `Result`; they NEVER throw across the port boundary
 * (AGENTS.md §2.1).
 */
import { ok, err, type Result } from "@comis/shared";
import type {
  ChannelPort,
  ChannelStatus,
  MessageHandler,
  SendMessageOptions,
  FetchMessagesOptions,
  FetchedMessage,
} from "@comis/core";

/**
 * One recorded adapter call — discriminated by `op`, ids deterministic, no
 * timestamps and NO `silent` field (Signal does not send the silent effect).
 */
export type FakeSignalCall =
  | { op: "send"; id: string; text: string }
  | { op: "delete"; id: string }
  | { op: "react"; id: string; emoji: string }
  | { op: "removeReaction"; id: string; emoji: string };

/** What `createFakeSignalAdapter()` returns: the port + a `recorded` accessor + a one-shot error seam. */
export interface FakeSignalAdapter extends ChannelPort {
  /** Ordered call-log — the fixture artifact. Deterministic `sig-msg-N` ids, no timestamps. */
  readonly recorded: { calls: FakeSignalCall[] };
  /**
   * One-shot platform-error injection seam. When set, the NEXT recording call
   * returns `err(nextError)` (a raw signal-cli RPC Error) and clears the seam.
   * Drives `classifySignalError`.
   */
  nextError: Error | undefined;
}

/**
 * Create a {@link FakeSignalAdapter}. Mints `sig-msg-0`, `sig-msg-1`, … on each
 * `sendMessage` and appends every method call to `recorded.calls` in order.
 *
 * `editMessage` is intentionally NOT defined — Signal has no in-place edit, so a
 * renderer that tries to edit must hit the optional-method guard.
 */
export function createFakeSignalAdapter(channelId = "chat-1"): FakeSignalAdapter {
  const recorded: { calls: FakeSignalCall[] } = { calls: [] };
  let messageCounter = 0;
  const handlers: MessageHandler[] = [];

  // Consume the one-shot error seam, if armed. Returns the raw Error (the port's
  // Result<_, Error> is the contract; the classifier reads it structurally).
  function takeInjectedError(self: { nextError: Error | undefined }): Error | undefined {
    if (self.nextError === undefined || self.nextError === null) return undefined;
    const e = self.nextError;
    self.nextError = undefined;
    return e;
  }

  const adapter: FakeSignalAdapter = {
    channelId,
    channelType: "signal",
    recorded,
    nextError: undefined,

    async start(): Promise<Result<void, Error>> {
      return ok(undefined);
    },

    async stop(): Promise<Result<void, Error>> {
      return ok(undefined);
    },

    async sendMessage(
      _channelId: string,
      text: string,
      _options?: SendMessageOptions,
    ): Promise<Result<string, Error>> {
      const injected = takeInjectedError(adapter);
      if (injected) return err(injected);
      const id = `sig-msg-${messageCounter++}`;
      recorded.calls.push({ op: "send", id, text });
      return ok(id);
    },

    // NOTE: no `editMessage` — Signal has no in-place edit (optional port method
    // left absent so the renderer's not_supported:edit guard fires).

    async deleteMessage(_channelId: string, messageId: string): Promise<Result<void, Error>> {
      const injected = takeInjectedError(adapter);
      if (injected) return err(injected);
      recorded.calls.push({ op: "delete", id: messageId });
      return ok(undefined);
    },

    async reactToMessage(
      _channelId: string,
      messageId: string,
      emoji: string,
    ): Promise<Result<void, Error>> {
      const injected = takeInjectedError(adapter);
      if (injected) return err(injected);
      recorded.calls.push({ op: "react", id: messageId, emoji });
      return ok(undefined);
    },

    async removeReaction(
      _channelId: string,
      messageId: string,
      emoji: string,
    ): Promise<Result<void, Error>> {
      const injected = takeInjectedError(adapter);
      if (injected) return err(injected);
      recorded.calls.push({ op: "removeReaction", id: messageId, emoji });
      return ok(undefined);
    },

    async fetchMessages(
      _channelId: string,
      _options?: FetchMessagesOptions,
    ): Promise<Result<FetchedMessage[], Error>> {
      return ok([]);
    },

    async platformAction(
      action: string,
      params: Record<string, unknown>,
    ): Promise<Result<unknown, Error>> {
      return ok({ action, params, echoed: true });
    },

    onMessage(handler: MessageHandler): void {
      handlers.push(handler);
    },

    getStatus(): ChannelStatus {
      return {
        connected: true,
        channelId,
        channelType: "signal",
        connectionMode: "socket",
      };
    },
  };

  return adapter;
}
