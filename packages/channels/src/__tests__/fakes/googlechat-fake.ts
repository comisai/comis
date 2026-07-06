// SPDX-License-Identifier: Apache-2.0
/**
 * FakeGoogleChatAdapter — a deterministic, clock-free `ChannelPort` test double for
 * the Google Chat renderer; it records every method call.
 *
 * Mirrors `createFakeMSTeamsAdapter` (the sibling rich-channel fake) but:
 *   - mints `gchat-msg-N` ids (the determinism source for byte-stable fixtures),
 *   - reports `connectionMode:"polling"` for the Pub/Sub-pull default and
 *     `"webhook"` for webhook mode — the switch the liveness monitor keys on, and
 *   - exposes a Chat-API-shaped (`{ status?, retryAfter? }`) `nextError` injection
 *     seam: the STRUCTURAL numeric `status` `classifyGoogleChatError` reads.
 *
 * The seam returns the raw Chat-API-shaped failure through the `Result` err branch
 * (one-shot, then clears) so a classifier is driven STRUCTURALLY off `e.status` —
 * never by parsing a message string. All methods return `Result`; they NEVER throw
 * across the port boundary (AGENTS.md §2.1). No `systemNowMs()` (would flap
 * fixtures).
 *
 * The reaction, outbound-upload, and history methods are OMITTED — not stubbed:
 * those capabilities are unreachable for a service-account Google Chat app, and the
 * honest-capability contract omits the method so a false-flag call has nothing to
 * hit (the daemon capability gate blocks it first). The approval buttons ride on
 * `send.buttons` — recorded ONLY when `options.buttons` is present so the
 * button-less frames stay byte-stable.
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
 * A Chat / Pub-Sub / token REST-shaped platform error (the structural fields the
 * classifier reads). `status` is the HTTP status of the response (`429`, `401`,
 * `404`, …); `retryAfter` is the rate-limit backoff in SECONDS.
 */
export interface GoogleChatErrorShape {
  status?: number;
  retryAfter?: number;
  message?: string;
}

/** One recorded adapter call — discriminated by `op`, deterministic ids, no timestamps. */
export type FakeGoogleChatCall =
  | { op: "send"; id: string; text: string; buttons?: RichButton[][] }
  | { op: "edit"; id: string; text: string }
  | { op: "delete"; id: string };

/** The transport the double reports through `getStatus().connectionMode`. */
export type FakeGoogleChatMode = "pubsub" | "webhook";

/** Options for {@link createFakeGoogleChatAdapter}. */
export interface CreateFakeGoogleChatAdapterOptions {
  /** Pub/Sub pull (default → connectionMode "polling") or webhook (→ "webhook"). */
  readonly mode?: FakeGoogleChatMode;
  /** The adapter instance id / space resource name. Defaults to "spaces/AAAA". */
  readonly channelId?: string;
}

/** What {@link createFakeGoogleChatAdapter} returns: the port + call log + a one-shot error seam. */
export interface FakeGoogleChatAdapter {
  /** The `ChannelPort` double under test. */
  readonly port: ChannelPort;
  /** Ordered call-log — the fixture artifact. Deterministic `gchat-msg-N` ids, no timestamps. */
  readonly recorded: { calls: FakeGoogleChatCall[] };
  /**
   * Arm the one-shot platform-error seam. The NEXT recording port call returns
   * `err(...)` (a Chat-API-shaped failure carrying the structural `status` /
   * `retryAfter`) and clears the seam. Drives a classifier off `e.status`.
   */
  nextError(e: GoogleChatErrorShape | Error): void;
}

/**
 * Coerce an injected error into a genuine `Error` carrying the structural
 * `{ status, retryAfter }` fields, so the port's `Result<_, Error>` contract holds
 * and a classifier reads the numeric status off it (never a message string). An
 * already-`Error` value is passed through untouched.
 */
function toInjectedError(e: GoogleChatErrorShape | Error): Error {
  if (e instanceof Error) return e;
  const out = new Error(e.message ?? "google chat platform error") as Error &
    GoogleChatErrorShape;
  if (e.status !== undefined) out.status = e.status;
  if (e.retryAfter !== undefined) out.retryAfter = e.retryAfter;
  return out;
}

/**
 * Create a {@link FakeGoogleChatAdapter}. Mints `gchat-msg-0`, `gchat-msg-1`, … on
 * each `sendMessage` and appends every method call to `recorded.calls` in order.
 */
export function createFakeGoogleChatAdapter(
  opts: CreateFakeGoogleChatAdapterOptions = {},
): FakeGoogleChatAdapter {
  const channelId = opts.channelId ?? "spaces/AAAA";
  const connectionMode: "polling" | "webhook" =
    opts.mode === "webhook" ? "webhook" : "polling";

  const recorded: { calls: FakeGoogleChatCall[] } = { calls: [] };
  let messageCounter = 0;
  const handlers: MessageHandler[] = [];

  // The one-shot error seam. When armed, the NEXT recording call returns err()
  // and clears it.
  let pending: Error | undefined;
  function takePending(): Error | undefined {
    if (pending === undefined) return undefined;
    const e = pending;
    pending = undefined;
    return e;
  }

  const port: ChannelPort = {
    channelId,
    channelType: "googlechat",

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
      const injected = takePending();
      if (injected) return err(injected);
      const id = `gchat-msg-${messageCounter++}`;
      // The approval buttons ride on `buttons` — recorded ONLY when present so the
      // button-less frames stay byte-stable.
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
      const injected = takePending();
      if (injected) return err(injected);
      recorded.calls.push({ op: "edit", id: messageId, text });
      return ok(undefined);
    },

    async deleteMessage(_channelId: string, messageId: string): Promise<Result<void, Error>> {
      const injected = takePending();
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
        channelType: "googlechat",
        connectionMode,
      };
    },
    // reactToMessage / removeReaction / onReaction / sendAttachment / fetchMessages
    // are deliberately OMITTED — the honest app-auth capability matrix.
  };

  return {
    port,
    recorded,
    nextError(e: GoogleChatErrorShape | Error): void {
      pending = toInjectedError(e);
    },
  };
}
