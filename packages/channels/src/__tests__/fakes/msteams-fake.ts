// SPDX-License-Identifier: Apache-2.0
/**
 * FakeMSTeamsAdapter — a deterministic, clock-free `ChannelPort` test double for
 * the Microsoft Teams EditPlace renderer; it records every method call.
 *
 * Mirrors `createFakeSlackAdapter` (the sibling rich-channel fake) but:
 *   - mints `ms-msg-N` ids (the determinism source for byte-stable fixtures),
 *   - reports `connectionMode:"webhook"` — the Teams ingress is a public
 *     endpoint, not a socket, and
 *   - exposes a Connector-shaped (`{ status?, retryAfter? }`) `nextError`
 *     injection seam: the STRUCTURAL numeric `status` `classifyMSTeamsError`
 *     reads, distinct from Slack's `{ data: { error } }` string.
 *
 * The seam returns the raw Connector-shaped object through the `Result` err
 * branch (one-shot, then clears) so the classifier is driven STRUCTURALLY off
 * `e.status` — never by parsing a message string. All methods return `Result`;
 * they NEVER throw across the port boundary (AGENTS.md §2.1). No `systemNowMs()`
 * (would flap fixtures).
 *
 * The signed approval buttons ride on `send.buttons` — recorded ONLY when
 * `options.buttons` is present so the button-less fixtures (the absent-signer
 * approval frame and every non-approval frame) stay byte-stable.
 */
import { ok, err, type Result } from "@comis/shared";
import type {
  ChannelPort,
  ChannelStatus,
  MessageHandler,
  SendMessageOptions,
  RichButton,
} from "@comis/core";

/**
 * A Bot Framework Connector-shaped platform error (the structural fields the
 * classifier reads). `status` is the HTTP status of the Connector response
 * (`429`, `401`, `404`, …); `retryAfter` is the rate-limit backoff in SECONDS.
 */
export interface MSTeamsErrorShape {
  status?: number;
  retryAfter?: number;
  message?: string;
}

/** One recorded adapter call — discriminated by `op`, deterministic ids, no timestamps. */
export type FakeMSTeamsCall =
  | { op: "send"; id: string; text: string; buttons?: RichButton[][] }
  | { op: "edit"; id: string; text: string }
  | { op: "delete"; id: string };

/** What `createFakeMSTeamsAdapter()` returns: the port + a `recorded` accessor + a one-shot error seam. */
export interface FakeMSTeamsAdapter extends ChannelPort {
  /** Ordered call-log — the fixture artifact. Deterministic `ms-msg-N` ids, no timestamps. */
  readonly recorded: { calls: FakeMSTeamsCall[] };
  /**
   * One-shot platform-error injection seam. When set, the NEXT recording call
   * returns `err(nextError)` (the raw Connector-shaped object) and clears the
   * seam. Drives `classifyMSTeamsError` off the structural numeric `e.status`.
   */
  nextError: MSTeamsErrorShape | Error | undefined;
}

/**
 * Create a {@link FakeMSTeamsAdapter}. Mints `ms-msg-0`, `ms-msg-1`, … on each
 * `sendMessage` and appends every method call to `recorded.calls` in order.
 */
export function createFakeMSTeamsAdapter(channelId = "chat-1"): FakeMSTeamsAdapter {
  const recorded: { calls: FakeMSTeamsCall[] } = { calls: [] };
  let messageCounter = 0;
  const handlers: MessageHandler[] = [];

  // Consume the one-shot error seam, if armed. Returns the raw Connector-shaped
  // object as an Error-typed err() (the port's Result<_, Error> is the contract;
  // the classifier reads the structural numeric status off it).
  function takeInjectedError(self: {
    nextError: MSTeamsErrorShape | Error | undefined;
  }): Error | undefined {
    if (self.nextError === undefined || self.nextError === null) return undefined;
    const e = self.nextError as Error;
    self.nextError = undefined;
    return e;
  }

  const adapter: FakeMSTeamsAdapter = {
    channelId,
    channelType: "msteams",
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
      const id = `ms-msg-${messageCounter++}`;
      // The signed approval buttons ride on `buttons` — recorded ONLY when
      // present so the button-less fixtures (absent-signer / non-approval
      // frames) stay byte-stable.
      recorded.calls.push({
        op: "send",
        id,
        text,
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
        channelType: "msteams",
        connectionMode: "webhook",
      };
    },
  };

  return adapter;
}
