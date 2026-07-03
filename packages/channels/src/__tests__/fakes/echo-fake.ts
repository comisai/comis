// SPDX-License-Identifier: Apache-2.0
/**
 * FakeEchoAdapter — a deterministic, clock-free `ChannelPort` test double;
 * it records every method call.
 *
 * Distinct from the production `EchoChannelAdapter`: the
 * production adapter stamps `systemNowMs()` timestamps (echo-adapter.ts:92),
 * which would make golden fixtures flap. This fake records call
 * ORDER only — an ordered, discriminated call-log with deterministic
 * `echo-msg-N` ids and NO timestamps.
 *
 * The `nextError` injection seam is the load-bearing piece the platform channel
 * fakes (Telegram/Discord/Slack/WhatsApp) mirror to exercise their `classify<Ch>Error`
 * functions: set `fake.nextError = <platform-error-shaped object>` and the next
 * adapter call returns it through the `Result` err branch (one-shot). All
 * methods return `Result` — they NEVER throw across the port boundary
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

/** One recorded adapter call — discriminated by `op`, ids deterministic, no timestamps. */
export type FakeEchoCall =
  | { op: "send"; id: string; text: string }
  | { op: "edit"; id: string; text: string }
  | { op: "delete"; id: string }
  | { op: "react"; id: string; emoji: string }
  | { op: "removeReaction"; id: string; emoji: string };

/** What `createFakeEchoAdapter()` returns: the port + a `recorded` accessor + a one-shot error seam. */
export interface FakeEchoAdapter extends ChannelPort {
  /** Ordered call-log — the fixture artifact. Deterministic ids, no timestamps. */
  readonly recorded: { calls: FakeEchoCall[] };
  /**
   * One-shot platform-error injection seam. When set, the NEXT recording call
   * returns `err(nextError)` (the raw platform-shaped object, e.g. a GrammyError
   * `{error_code,parameters}`) and clears the seam. Lets the platform fakes drive
   * `classify<Ch>Error`. Echo's own fixtures never set it.
   */
  nextError: unknown;
}

/**
 * Create a {@link FakeEchoAdapter}. Mints `echo-msg-0`, `echo-msg-1`, … on each
 * `sendMessage` and appends every method call to `recorded.calls` in order.
 */
export function createFakeEchoAdapter(channelId = "echo-test"): FakeEchoAdapter {
  const recorded: { calls: FakeEchoCall[] } = { calls: [] };
  let messageCounter = 0;
  const handlers: MessageHandler[] = [];

  // Consume the one-shot error seam, if armed. Returns the raw platform-shaped
  // object as an Error-typed err() (cast at the boundary — the platform classifiers
  // read platform fields off it; the port's Result<_, Error> is the contract).
  function takeInjectedError(self: { nextError: unknown }): Error | undefined {
    if (self.nextError === undefined || self.nextError === null) return undefined;
    const e = self.nextError as Error;
    self.nextError = undefined;
    return e;
  }

  const adapter: FakeEchoAdapter = {
    channelId,
    channelType: "echo",
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
      const id = `echo-msg-${messageCounter++}`;
      recorded.calls.push({ op: "send", id, text });
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
        channelType: "echo",
        connectionMode: "socket",
      };
    },
  };

  return adapter;
}
