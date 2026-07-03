// SPDX-License-Identifier: Apache-2.0
/**
 * FakeDiscordAdapter — a deterministic, clock-free `ChannelPort` test double for
 * the Discord EditPlace renderer; it records every method call.
 *
 * Mirrors `createFakeTelegramAdapter` (the canonical fake) but:
 *   - mints `dc-msg-N` ids (Discord's determinism source for byte-stable
 *     fixtures),
 *   - records a `threadCreate` call when `send` is given `{ threadReply: true }`
 *     so a fixture can pin the S7 subagent-expand affordance SHELL (the parent
 *     line + the thread-create), and
 *   - exposes a DiscordAPIError-shaped (`{ code?, status?, retryAfter? }`)
 *     `nextError` injection seam (distinct from grammy's `error_code`).
 *
 * The seam returns the raw DiscordAPIError-shaped object through the `Result` err
 * branch (one-shot, then clears) so the classifier tests drive
 * `classifyDiscordError` STRUCTURALLY — never by parsing the generic "Failed to…"
 * string. All methods return `Result`; they NEVER throw across the port boundary
 * (AGENTS.md §2.1). No `systemNowMs()` (would flap fixtures).
 *
 * The affordance is a SHELL only: this fake records the thread-create egress, but
 * NO interaction handler is registered and NO signed callback_data is produced —
 * the InteractiveCallbackRouter lives in a separate component.
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

/**
 * A DiscordAPIError-shaped platform error (the structural fields the classifier
 * reads). `code` is the discord.js numeric API error code (10008 Unknown
 * Message, 50013 Missing Permissions); `status` is the HTTP status (429);
 * `retryAfter` is the RateLimitError backoff in SECONDS.
 */
export interface DiscordErrorShape {
  code?: number;
  status?: number;
  retryAfter?: number;
  message?: string;
}

/** One recorded adapter call — discriminated by `op`, ids deterministic, no timestamps. */
export type FakeDiscordCall =
  | { op: "send"; id: string; text: string; silent: boolean; buttons?: RichButton[][] }
  | { op: "threadCreate"; parentId: string }
  | { op: "edit"; id: string; text: string }
  | { op: "delete"; id: string }
  | { op: "react"; id: string; emoji: string }
  | { op: "removeReaction"; id: string; emoji: string };

/** What `createFakeDiscordAdapter()` returns: the port + a `recorded` accessor + a one-shot error seam. */
export interface FakeDiscordAdapter extends ChannelPort {
  /** Ordered call-log — the fixture artifact. Deterministic `dc-msg-N` ids, no timestamps. */
  readonly recorded: { calls: FakeDiscordCall[] };
  /**
   * One-shot platform-error injection seam. When set, the NEXT recording call
   * returns `err(nextError)` (the raw DiscordAPIError-shaped object) and clears
   * the seam. Drives `classifyDiscordError`.
   */
  nextError: DiscordErrorShape | Error | undefined;
}

/**
 * Create a {@link FakeDiscordAdapter}. Mints `dc-msg-0`, `dc-msg-1`, … on each
 * `sendMessage` and appends every method call to `recorded.calls` in order. When
 * a `send` carries `{ threadReply: true }`, a `threadCreate` entry is appended
 * after the `send` (the S7 affordance-shell egress).
 */
export function createFakeDiscordAdapter(channelId = "chat-1"): FakeDiscordAdapter {
  const recorded: { calls: FakeDiscordCall[] } = { calls: [] };
  let messageCounter = 0;
  const handlers: MessageHandler[] = [];

  // Consume the one-shot error seam, if armed. Returns the raw DiscordAPIError-
  // shaped object as an Error-typed err() (the port's Result<_, Error> is the
  // contract; the classifier reads the structural code/status/retryAfter off it).
  function takeInjectedError(self: {
    nextError: DiscordErrorShape | Error | undefined;
  }): Error | undefined {
    if (self.nextError === undefined || self.nextError === null) return undefined;
    const e = self.nextError as Error;
    self.nextError = undefined;
    return e;
  }

  const adapter: FakeDiscordAdapter = {
    channelId,
    channelType: "discord",
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
      const id = `dc-msg-${messageCounter++}`;
      // Discord silently ignores rich effects (discord-adapter.ts:392-395); the
      // fixture records silent:false to reflect the real platform behaviour. The
      // approval `buttons` (native components) are recorded ONLY when present so
      // the button-less golden fixtures stay byte-stable.
      recorded.calls.push({
        op: "send",
        id,
        text,
        silent: options?.effects?.includes("silent") ?? false,
        ...(options?.buttons !== undefined ? { buttons: options.buttons } : {}),
      });
      // S7 affordance SHELL: a thread-expand request records the thread-create
      // egress (no callback handler, no signed callback_data).
      if (options?.threadReply) {
        recorded.calls.push({ op: "threadCreate", parentId: id });
      }
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
        channelType: "discord",
        // Matches the live discord-adapter getStatus (discord-adapter.ts:665).
        connectionMode: "socket",
      };
    },
  };

  return adapter;
}
