// SPDX-License-Identifier: Apache-2.0
/**
 * FakeSlackAdapter — a deterministic, clock-free `ChannelPort` test double for
 * the Slack EditPlace renderer; it records every method call.
 *
 * Mirrors `createFakeTelegramAdapter` (the canonical fake) but:
 *   - mints `sl-msg-N` ids (Slack's `ts` analogue; the determinism source for
 *     byte-stable fixtures), and
 *   - exposes a Slack-Bolt-shaped (`{ data: { error }, retryAfter? }`) `nextError`
 *     injection seam (distinct from grammy's `error_code` and discord's `.code`).
 *
 * Slack has no silent-notification effect (the adapter has no `disable_notification`
 * analogue), so `send` records `silent:false` unconditionally — the fixture
 * reflects the real platform behaviour.
 *
 * `chat.delete` on success (the required delete-on-success op) is exercised
 * through `deleteMessage` and recorded as a `delete` entry.
 *
 * The seam returns the raw Slack-shaped object through the `Result` err branch
 * (one-shot, then clears) so the classifier tests drive `classifySlackError`
 * STRUCTURALLY off `e.data.error` — never by parsing the generic "Failed to…"
 * string. All methods return `Result`; they NEVER throw across the port boundary
 * (AGENTS.md §2.1). No `systemNowMs()` (would flap fixtures).
 *
 * The Block Kit `actions` approval is a SHELL only: no interaction handler is
 * registered and no signed callback_data is produced — the
 * InteractiveCallbackRouter is handled separately.
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
 * A Slack-Bolt-shaped platform error (the structural fields the classifier
 * reads). `data.error` is the Slack API error string (`"ratelimited"`,
 * `"message_not_found"`, `"not_in_channel"`, …); `retryAfter` is the rate-limit
 * backoff in SECONDS.
 */
export interface SlackErrorShape {
  data?: { error?: string };
  retryAfter?: number;
  message?: string;
}

/** One recorded adapter call — discriminated by `op`, ids deterministic, no timestamps. */
export type FakeSlackCall =
  | { op: "send"; id: string; text: string; silent: boolean; buttons?: RichButton[][] }
  | { op: "thread"; parentId: string }
  | { op: "edit"; id: string; text: string }
  | { op: "delete"; id: string }
  | { op: "react"; id: string; emoji: string }
  | { op: "removeReaction"; id: string; emoji: string };

/** What `createFakeSlackAdapter()` returns: the port + a `recorded` accessor + a one-shot error seam. */
export interface FakeSlackAdapter extends ChannelPort {
  /** Ordered call-log — the fixture artifact. Deterministic `sl-msg-N` ids, no timestamps. */
  readonly recorded: { calls: FakeSlackCall[] };
  /**
   * One-shot platform-error injection seam. When set, the NEXT recording call
   * returns `err(nextError)` (the raw Slack-shaped object) and clears the seam.
   * Drives `classifySlackError` off `e.data.error`.
   */
  nextError: SlackErrorShape | Error | undefined;
}

/**
 * Create a {@link FakeSlackAdapter}. Mints `sl-msg-0`, `sl-msg-1`, … on each
 * `sendMessage` and appends every method call to `recorded.calls` in order.
 */
export function createFakeSlackAdapter(channelId = "chat-1"): FakeSlackAdapter {
  const recorded: { calls: FakeSlackCall[] } = { calls: [] };
  let messageCounter = 0;
  const handlers: MessageHandler[] = [];

  // Consume the one-shot error seam, if armed. Returns the raw Slack-shaped
  // object as an Error-typed err() (the port's Result<_, Error> is the contract;
  // the classifier reads the structural data.error off it).
  function takeInjectedError(self: {
    nextError: SlackErrorShape | Error | undefined;
  }): Error | undefined {
    if (self.nextError === undefined || self.nextError === null) return undefined;
    const e = self.nextError as Error;
    self.nextError = undefined;
    return e;
  }

  const adapter: FakeSlackAdapter = {
    channelId,
    channelType: "slack",
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
      const id = `sl-msg-${messageCounter++}`;
      // Slack has no silent-notification effect; record silent:false to reflect
      // the real platform behaviour. The Block Kit approval `actions` (native
      // UI) ride on `buttons` — recorded ONLY when present so the
      // button-less golden fixtures stay byte-stable.
      recorded.calls.push({
        op: "send",
        id,
        text,
        silent: options?.effects?.includes("silent") ?? false,
        ...(options?.buttons !== undefined ? { buttons: options.buttons } : {}),
      });
      // A subagent placeholder requests a thread (`thread_ts`) for its expand
      // affordance; record the thread egress (no callback handler — the
      // router owns resolution).
      if (options?.threadReply) {
        recorded.calls.push({ op: "thread", parentId: id });
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
        channelType: "slack",
        connectionMode: "socket",
      };
    },
  };

  return adapter;
}
