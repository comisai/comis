// SPDX-License-Identifier: Apache-2.0
/**
 * FakeIrcAdapter — a deterministic, clock-free `ChannelPort` test double for the
 * IRC LinePerEvent renderer; it records every method call.
 *
 * Mirrors `createFakeSignalAdapter` (the non-EditPlace template) but for the
 * LinePerEvent shape:
 *   - mints `irc-msg-N` ids on each `sendMessage`. IRC's LIVE adapter returns the
 *     synthetic id `"sent"` for EVERY message (IRC has no standard message ids),
 *     which would collapse a multi-line call-log into indistinguishable rows. The
 *     fake mints per-call `irc-msg-0`, `irc-msg-1`, … instead so the byte-stable
 *     fixture reads unambiguously (clock-free, no wall-time call that
 *     would flap).
 *   - records NO `silent` flag on `send` (IRC has no rich effects — the
 *     LinePerEvent strategy posts one plain line per event), and
 *   - OMITS `editMessage` AND `deleteMessage` entirely. IRC is send-only (no
 *     in-place edit, no delete); the live adapter exposes neither, so the fake
 *     leaves both optional port methods absent — that is exactly what
 *     `makeIrcRenderActions`'s `not_supported:edit` / `not_supported:delete`
 *     early returns answer.
 *
 * The `nextError` injection seam returns the IRC adapter's wrapped send `Error`
 * (`new Error("Failed to send IRC message: …")`) through the `Result` err branch
 * (one-shot, then clears) so the classifier tests drive `classifyIrcError`
 * structurally — IRC exposes no numeric code, so the seam carries a bare `Error`
 * shape (the live adapter returns the wrapped send error). All methods return
 * `Result`; they NEVER throw across the port boundary (AGENTS.md §2.1).
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
 * timestamps and NO `silent` field (IRC has no rich effects). Edit/delete are
 * absent from the union — IRC is send-only, so the renderer never records them.
 */
export type FakeIrcCall =
  | { op: "send"; id: string; text: string }
  | { op: "react"; id: string; emoji: string }
  | { op: "removeReaction"; id: string; emoji: string };

/** What `createFakeIrcAdapter()` returns: the port + a `recorded` accessor + a one-shot error seam. */
export interface FakeIrcAdapter extends ChannelPort {
  /** Ordered call-log — the fixture artifact. Deterministic `irc-msg-N` ids, no timestamps. */
  readonly recorded: { calls: FakeIrcCall[] };
  /**
   * One-shot platform-error injection seam. When set, the NEXT recording call
   * returns `err(nextError)` (the IRC adapter's wrapped send Error) and clears the
   * seam. Drives `classifyIrcError`.
   */
  nextError: Error | undefined;
}

/**
 * Create a {@link FakeIrcAdapter}. Mints `irc-msg-0`, `irc-msg-1`, … on each
 * `sendMessage` and appends every method call to `recorded.calls` in order.
 *
 * `editMessage` and `deleteMessage` are intentionally NOT defined — IRC is
 * send-only (no in-place edit, no delete), so a renderer that tries either must
 * hit the optional-method guard / unconditional `not_supported` answer.
 */
export function createFakeIrcAdapter(channelId = "chan-1"): FakeIrcAdapter {
  const recorded: { calls: FakeIrcCall[] } = { calls: [] };
  let messageCounter = 0;
  const handlers: MessageHandler[] = [];

  // Consume the one-shot error seam, if armed. Returns the wrapped send Error (the
  // port's Result<_, Error> is the contract; the classifier reads it structurally).
  function takeInjectedError(self: { nextError: Error | undefined }): Error | undefined {
    if (self.nextError === undefined || self.nextError === null) return undefined;
    const e = self.nextError;
    self.nextError = undefined;
    return e;
  }

  const adapter: FakeIrcAdapter = {
    channelId,
    channelType: "irc",
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
      const id = `irc-msg-${messageCounter++}`;
      recorded.calls.push({ op: "send", id, text });
      return ok(id);
    },

    // NOTE: no `editMessage` / `deleteMessage` — IRC is send-only (optional port
    // methods left absent so the renderer's not_supported guards fire).

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
        channelType: "irc",
        connectionMode: "socket",
      };
    },
  };

  return adapter;
}
