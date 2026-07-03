// SPDX-License-Identifier: Apache-2.0
/**
 * FakeTelegramAdapter — a deterministic, clock-free `ChannelPort` test double
 * for the Telegram EditPlace renderer; it records every method call.
 *
 * Mirrors `createFakeEchoAdapter` (the reference template) but:
 *   - mints `tg-msg-N` ids (Telegram's determinism source for byte-stable
 *     fixtures), and
 *   - records the `send` options so a fixture can pin the silent-notification
 *     flag (`{effects:["silent"]}` → `disable_notification:true`).
 *
 * The `nextError` injection seam returns a GrammyError-shaped object
 * (`{error_code, description, parameters:{retry_after?}}`) through the `Result`
 * err branch (one-shot, then clears) so the classifier tests drive
 * `classifyTelegramError` structurally — never by parsing the generic
 * "Failed to…" string. All methods return `Result`; they NEVER throw across the
 * port boundary (AGENTS.md §2.1). No `systemNowMs()` (would flap fixtures).
 */
import { ok, err, type Result } from "@comis/shared";
import type {
  ChannelPort,
  ChannelStatus,
  MessageHandler,
  SendMessageOptions,
  FetchMessagesOptions,
  FetchedMessage,
  RichButton,
} from "@comis/core";

/** A GrammyError-shaped platform error (the structural fields the classifier reads). */
export interface GrammyErrorShape {
  error_code: number;
  description?: string;
  parameters?: { retry_after?: number };
}

/** One recorded adapter call — discriminated by `op`, ids deterministic, no timestamps. */
export type FakeTelegramCall =
  | { op: "send"; id: string; text: string; silent: boolean; buttons?: RichButton[][] }
  | { op: "edit"; id: string; text: string }
  | { op: "delete"; id: string }
  | { op: "react"; id: string; emoji: string }
  | { op: "removeReaction"; id: string; emoji: string };

/** What `createFakeTelegramAdapter()` returns: the port + a `recorded` accessor + a one-shot error seam. */
export interface FakeTelegramAdapter extends ChannelPort {
  /** Ordered call-log — the fixture artifact. Deterministic `tg-msg-N` ids, no timestamps. */
  readonly recorded: { calls: FakeTelegramCall[] };
  /**
   * One-shot platform-error injection seam. When set, the NEXT recording call
   * returns `err(nextError)` (the raw GrammyError-shaped object) and clears the
   * seam. Drives `classifyTelegramError`.
   */
  nextError: GrammyErrorShape | Error | undefined;
}

/**
 * Create a {@link FakeTelegramAdapter}. Mints `tg-msg-0`, `tg-msg-1`, … on each
 * `sendMessage` and appends every method call to `recorded.calls` in order.
 */
export function createFakeTelegramAdapter(channelId = "chat-1"): FakeTelegramAdapter {
  const recorded: { calls: FakeTelegramCall[] } = { calls: [] };
  let messageCounter = 0;
  const handlers: MessageHandler[] = [];

  // Consume the one-shot error seam, if armed. Returns the raw GrammyError-shaped
  // object as an Error-typed err() (the port's Result<_, Error> is the contract;
  // the classifier reads the structural error_code/parameters off it).
  function takeInjectedError(self: { nextError: GrammyErrorShape | Error | undefined }): Error | undefined {
    if (self.nextError === undefined || self.nextError === null) return undefined;
    const e = self.nextError as Error;
    self.nextError = undefined;
    return e;
  }

  const adapter: FakeTelegramAdapter = {
    channelId,
    channelType: "telegram",
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
      options?: SendMessageOptions,
    ): Promise<Result<string, Error>> {
      const injected = takeInjectedError(adapter);
      if (injected) return err(injected);
      const id = `tg-msg-${messageCounter++}`;
      // The approval inline keyboard (native UI) rides on `buttons` —
      // recorded ONLY when present so the button-less golden fixtures stay
      // byte-stable.
      recorded.calls.push({
        op: "send",
        id,
        text,
        silent: options?.effects?.includes("silent") ?? false,
        ...(options?.buttons !== undefined ? { buttons: options.buttons } : {}),
      });
      return ok(id);
    },

    async editMessage(
      _channelId: string,
      messageId: string,
      text: string,
      _options?: SendMessageOptions,
    ): Promise<Result<void, Error>> {
      const injected = takeInjectedError(adapter);
      if (injected) return err(injected);
      recorded.calls.push({ op: "edit", id: messageId, text });
      return ok(undefined);
    },

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
        channelType: "telegram",
        connectionMode: "polling",
      };
    },
  };

  return adapter;
}
