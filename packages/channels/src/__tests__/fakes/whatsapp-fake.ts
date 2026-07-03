// SPDX-License-Identifier: Apache-2.0
/**
 * FakeWhatsAppAdapter — a deterministic, clock-free `ChannelPort` test double for
 * the WhatsApp windowed EditPlace renderer; it records every method call.
 *
 * Mirrors `createFakeTelegramAdapter` (the canonical fake) but:
 *   - mints `wa-msg-N` ids (WhatsApp's determinism source for byte-stable
 *     fixtures), and
 *   - exposes a baileys-shaped error-injection seam. baileys surfaces an
 *     operation failure as a thrown `Boom` carrying `.output.statusCode`
 *     (`@hapi/boom`; the live `whatsapp-adapter.ts` already reads
 *     `(error as Boom).output.statusCode` for disconnects). The seam can either
 *     RETURN the Boom-shaped error through the `Result` err branch (the default —
 *     this is exactly what the live adapter does after catching the throw and
 *     attaching it as `Error.cause`) OR genuinely THROW it (`nextThrow`) to prove
 *     the render-actions adapter never lets a throw escape across the boundary.
 *
 * The window-expiry case is the load-bearing one: WhatsApp Business edit/delete is
 * windowed (~15 min). An edit after the window is rejected with a Boom whose
 * `.output.statusCode` is a 4xx client error (400) — `classifyWhatsAppError` maps
 * that to `{kind:"not_supported", capability:"edit"}` (drop further edits). The
 * not-connected guard returns a bare `new Error("WhatsApp not connected")` →
 * `{kind:"transient_network"}`.
 *
 * All methods return `Result`; the default seam NEVER throws across the port
 * boundary (AGENTS.md §2.1). No `systemNowMs()` (would flap fixtures).
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
 * A baileys/`@hapi/boom`-shaped platform error (the structural fields the
 * classifier reads). `output.statusCode` is the HTTP-style Boom status: a windowed
 * edit-expiry rejection surfaces as a 4xx client error (400). The optional
 * `message` carries the human-readable window-expiry signal — used ONLY to
 * disambiguate the variant, never rendered or logged.
 */
export interface BaileysErrorShape {
  output?: { statusCode?: number };
  message?: string;
}

/** One recorded adapter call — discriminated by `op`, ids deterministic, no timestamps. */
export type FakeWhatsAppCall =
  | { op: "send"; id: string; text: string; silent: boolean; buttons: boolean }
  | { op: "edit"; id: string; text: string }
  | { op: "delete"; id: string }
  | { op: "react"; id: string; emoji: string }
  | { op: "removeReaction"; id: string; emoji: string };

/** What `createFakeWhatsAppAdapter()` returns: the port + a `recorded` accessor + injection seams. */
export interface FakeWhatsAppAdapter extends ChannelPort {
  /** Ordered call-log — the fixture artifact. Deterministic `wa-msg-N` ids, no timestamps. */
  readonly recorded: { calls: FakeWhatsAppCall[] };
  /**
   * One-shot error-injection seam. When set, the NEXT recording call RETURNS
   * `err(nextError)` (the raw Boom-shaped object) and clears the seam — exactly
   * what the live adapter does after catching the baileys throw. Drives
   * `classifyWhatsAppError`.
   */
  nextError: BaileysErrorShape | Error | undefined;
  /**
   * One-shot THROW seam. When set, the NEXT recording call genuinely THROWS the
   * value (simulating baileys throwing before the live adapter's try/catch). Proves
   * the render-actions adapter never lets a throw escape across the boundary. The
   * live adapter catches it and returns `err`, so in production this is the same
   * path as {@link nextError}; the fake separates them so a test can assert the
   * throw is contained.
   */
  nextThrow: BaileysErrorShape | Error | undefined;
}

/**
 * Create a {@link FakeWhatsAppAdapter}. Mints `wa-msg-0`, `wa-msg-1`, … on each
 * `sendMessage` and appends every method call to `recorded.calls` in order. The
 * recorded `send` carries `silent` + `buttons` flags so a fixture can prove the
 * plain-text approval shell attaches NO button surface (`buttons:"none"`).
 */
export function createFakeWhatsAppAdapter(channelId = "chat-1"): FakeWhatsAppAdapter {
  const recorded: { calls: FakeWhatsAppCall[] } = { calls: [] };
  let messageCounter = 0;
  const handlers: MessageHandler[] = [];

  // Consume the one-shot RETURN seam, if armed. Returns the raw Boom-shaped object
  // as an Error-typed err() (the port's Result<_, Error> is the contract; the
  // classifier reads the structural output.statusCode off it).
  function takeInjectedError(self: {
    nextError: BaileysErrorShape | Error | undefined;
  }): Error | undefined {
    if (self.nextError === undefined || self.nextError === null) return undefined;
    const e = self.nextError as Error;
    self.nextError = undefined;
    return e;
  }

  // Consume the one-shot THROW seam, if armed — genuinely throws (simulates baileys).
  function maybeThrow(self: { nextThrow: BaileysErrorShape | Error | undefined }): void {
    if (self.nextThrow === undefined || self.nextThrow === null) return;
    const e = self.nextThrow;
    self.nextThrow = undefined;
    // @allow-throw: test double simulating a baileys throw; the render-actions
    // adapter under test must contain it and return a Result.
    throw e;
  }

  const adapter: FakeWhatsAppAdapter = {
    channelId,
    channelType: "whatsapp",
    recorded,
    nextError: undefined,
    nextThrow: undefined,

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
      maybeThrow(adapter);
      const injected = takeInjectedError(adapter);
      if (injected) return err(injected);
      const id = `wa-msg-${messageCounter++}`;
      // WhatsApp ignores rich effects (whatsapp-adapter.ts:286-288); record the
      // observed flags so a fixture can pin `buttons:"none"` (no button surface).
      recorded.calls.push({
        op: "send",
        id,
        text,
        silent: options?.effects?.includes("silent") ?? false,
        buttons: (options?.buttons?.length ?? 0) > 0,
      });
      return ok(id);
    },

    async editMessage(
      _channelId: string,
      messageId: string,
      text: string,
      _options?: SendMessageOptions,
    ): Promise<Result<void, Error>> {
      maybeThrow(adapter);
      const injected = takeInjectedError(adapter);
      if (injected) return err(injected);
      recorded.calls.push({ op: "edit", id: messageId, text });
      return ok(undefined);
    },

    async deleteMessage(_channelId: string, messageId: string): Promise<Result<void, Error>> {
      maybeThrow(adapter);
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
        channelType: "whatsapp",
        // Matches the live whatsapp-adapter getStatus connectionMode.
        connectionMode: "socket",
      };
    },
  };

  return adapter;
}
