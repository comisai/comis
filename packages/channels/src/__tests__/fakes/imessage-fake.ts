// SPDX-License-Identifier: Apache-2.0
/**
 * FakeIMessageAdapter — a deterministic, clock-free `ChannelPort` test double for
 * the iMessage AppendOnly renderer; it records every method call.
 *
 * Mirrors `createFakeSignalAdapter` (the non-EditPlace template) but for the
 * AppendOnly shape:
 *   - mints `imsg-msg-N` ids (iMessage's determinism source for byte-stable
 *     fixtures; clock-free, no wall-time call that would flap),
 *   - records NO `silent` flag on `send` (iMessage does not send the silent
 *     effect — AppendOnly posts a single plain opening status), and
 *   - OMITS `editMessage` / `deleteMessage` entirely. iMessage is send-only; the
 *     live adapter exposes neither, so the fake leaves both optional port methods
 *     absent — that is exactly what `makeIMessageRenderActions`'s
 *     `not_supported:edit` / `not_supported:delete` guards branch on.
 *
 * The `nextError` injection seam returns a raw `Error` through the `Result` err
 * branch (one-shot, then clears) so the classifier tests drive
 * `classifyIMessageError` — the live adapter wraps send failures in
 * `new Error("Failed to send iMessage: …")` with no structured numeric code, so
 * the seam carries a bare `Error` shape. All methods return `Result`; they NEVER
 * throw across the port boundary (AGENTS.md §2.1).
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
 * timestamps and NO `silent` field (iMessage does not send the silent effect).
 */
export type FakeIMessageCall =
  | { op: "send"; id: string; text: string }
  | { op: "react"; id: string; emoji: string }
  | { op: "removeReaction"; id: string; emoji: string };

/** What `createFakeIMessageAdapter()` returns: the port + a `recorded` accessor + a one-shot error seam. */
export interface FakeIMessageAdapter extends ChannelPort {
  /** Ordered call-log — the fixture artifact. Deterministic `imsg-msg-N` ids, no timestamps. */
  readonly recorded: { calls: FakeIMessageCall[] };
  /**
   * One-shot platform-error injection seam. When set, the NEXT recording call
   * returns `err(nextError)` (a raw "Failed to send iMessage: …" Error) and
   * clears the seam. Drives `classifyIMessageError`.
   */
  nextError: Error | undefined;
}

/**
 * Create a {@link FakeIMessageAdapter}. Mints `imsg-msg-0`, `imsg-msg-1`, … on
 * each `sendMessage` and appends every method call to `recorded.calls` in order.
 *
 * `editMessage` and `deleteMessage` are intentionally NOT defined — iMessage is
 * send-only, so a renderer that tries either must hit the optional-method guard.
 */
export function createFakeIMessageAdapter(channelId = "chat-1"): FakeIMessageAdapter {
  const recorded: { calls: FakeIMessageCall[] } = { calls: [] };
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

  const adapter: FakeIMessageAdapter = {
    channelId,
    channelType: "imessage",
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
      const id = `imsg-msg-${messageCounter++}`;
      recorded.calls.push({ op: "send", id, text });
      return ok(id);
    },

    // NOTE: no `editMessage` / `deleteMessage` — iMessage is send-only (both
    // optional port methods left absent so the renderer's not_supported guards fire).

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
        channelType: "imessage",
        connectionMode: "socket",
      };
    },
  };

  return adapter;
}
