// SPDX-License-Identifier: Apache-2.0
/**
 * FakeEmailAdapter — a deterministic, clock-free `ChannelPort` test double for
 * the Email DigestOnly renderer; it records every method call.
 *
 * Mirrors `createFakeIMessageAdapter` (the send-only template) but for the
 * DigestOnly shape:
 *   - mints `email-msg-N` ids (Email's determinism source for byte-stable
 *     fixtures; clock-free, no wall-time call that would flap),
 *   - records NO `silent` flag on `send` (Email does not send a silent effect —
 *     DigestOnly emits at most one plain end-of-turn digest body), and
 *   - OMITS `editMessage` / `deleteMessage` entirely. Email is send-only; the
 *     live adapter exposes neither, so the fake leaves both optional port methods
 *     absent — that is exactly what `makeEmailRenderActions`'s `not_supported:edit`
 *     / `not_supported:delete` early returns are the honest answer for.
 *
 * The `nextError` injection seam returns a raw `Error` through the `Result` err
 * branch (one-shot, then clears) so the classifier tests drive `classifyEmailError`
 * — the live adapter returns a bare nodemailer `Error` (`err(error)`) on an SMTP
 * send failure with no structured numeric code attached to the returned object,
 * so the seam carries a bare `Error` shape. All methods return `Result`; they
 * NEVER throw across the port boundary (AGENTS.md §2.1).
 *
 * NOTE on the `Re: <thread>` subject: the live email adapter sets reply-threading
 * headers on its OWN send path (outside the `send(text)` body the renderer
 * controls). The fake records only the body text the renderer produced — the
 * transport subject is not part of the `ActivityRenderActions.send(text)` string.
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
 * timestamps and NO `silent` field (Email does not send a silent effect).
 */
export type FakeEmailCall =
  | { op: "send"; id: string; text: string }
  | { op: "react"; id: string; emoji: string }
  | { op: "removeReaction"; id: string; emoji: string };

/** What `createFakeEmailAdapter()` returns: the port + a `recorded` accessor + a one-shot error seam. */
export interface FakeEmailAdapter extends ChannelPort {
  /** Ordered call-log — the fixture artifact. Deterministic `email-msg-N` ids, no timestamps. */
  readonly recorded: { calls: FakeEmailCall[] };
  /**
   * One-shot platform-error injection seam. When set, the NEXT recording call
   * returns `err(nextError)` (a raw SMTP `Error`) and clears the seam. Drives
   * `classifyEmailError`.
   */
  nextError: Error | undefined;
}

/**
 * Create a {@link FakeEmailAdapter}. Mints `email-msg-0`, `email-msg-1`, … on
 * each `sendMessage` and appends every method call to `recorded.calls` in order.
 *
 * `editMessage` and `deleteMessage` are intentionally NOT defined — Email is
 * send-only, so a renderer that tries either must hit the `not_supported` answer.
 */
export function createFakeEmailAdapter(channelId = "inbox-1"): FakeEmailAdapter {
  const recorded: { calls: FakeEmailCall[] } = { calls: [] };
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

  const adapter: FakeEmailAdapter = {
    channelId,
    channelType: "email",
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
      const id = `email-msg-${messageCounter++}`;
      recorded.calls.push({ op: "send", id, text });
      return ok(id);
    },

    // NOTE: no `editMessage` / `deleteMessage` — Email is send-only (both optional
    // port methods left absent so the renderer's not_supported answers are honest).

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
        channelType: "email",
        connectionMode: "polling",
      };
    },
  };

  return adapter;
}
