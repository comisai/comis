// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { ok, type Result } from "@comis/shared";
import type { ChannelPort, ReactionHandler, SendMessageOptions } from "./channel.js";
import type { NormalizedReaction } from "../domain/normalized-reaction.js";

// ---------------------------------------------------------------------------
// editMessage — the optional rich-options arg
//
// ChannelPort.editMessage accepts an optional 4th `options?:
// SendMessageOptions` arg so activity renderers can update inline keyboards /
// components / Block Kit, not just text. The hand-built adapter below passes
// `{ buttons }` to editMessage and must satisfy ChannelPort — a compile-level
// proof that the 4-arg signature is part of the port contract.
// ---------------------------------------------------------------------------

/** Records the last editMessage options it was given, for the call assertion. */
function makeRichEditAdapter(): ChannelPort & { lastOptions?: SendMessageOptions } {
  const adapter: ChannelPort & { lastOptions?: SendMessageOptions } = {
    channelId: "test-rich",
    channelType: "test",
    async start(): Promise<Result<void, Error>> {
      return ok(undefined);
    },
    async stop(): Promise<Result<void, Error>> {
      return ok(undefined);
    },
    async sendMessage(): Promise<Result<string, Error>> {
      return ok("msg-1");
    },
    // 4th optional param exercised — this is the rich-options surface.
    async editMessage(
      _channelId: string,
      _messageId: string,
      _text: string,
      options?: SendMessageOptions,
    ): Promise<Result<void, Error>> {
      adapter.lastOptions = options;
      return ok(undefined);
    },
    onMessage(): void {
      /* no-op */
    },
    async platformAction(): Promise<Result<unknown, Error>> {
      return ok(undefined);
    },
  };
  return adapter;
}

describe("ChannelPort.editMessage rich options", () => {
  it("accepts an adapter whose editMessage takes SendMessageOptions", () => {
    const adapter = makeRichEditAdapter();
    // Type-level: assigning to ChannelPort proves the widened signature is
    // structurally compatible.
    const port: ChannelPort = adapter;
    expect(port.channelType).toBe("test");
  });

  it("forwards inline buttons through the editMessage options arg", async () => {
    const adapter = makeRichEditAdapter();
    const options: SendMessageOptions = {
      buttons: [[{ text: "Approve", callback_data: "approve:abc" }]],
    };

    const result = await adapter.editMessage!("c1", "m1", "Updated", options);

    expect(result.ok).toBe(true);
    expect(adapter.lastOptions?.buttons?.[0]?.[0]?.text).toBe("Approve");
  });

  it("still allows calling editMessage with only the three required args", async () => {
    const adapter = makeRichEditAdapter();
    const result = await adapter.editMessage!("c1", "m1", "Plain text");
    expect(result.ok).toBe(true);
    expect(adapter.lastOptions).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// onReaction? — the OPTIONAL inbound-reaction capability
//
// onReaction is OPTIONAL on ChannelPort so non-binding adapters
// (iMessage/LINE/IRC/Email/Echo) OMIT it — an honest no-op, NOT a gap, exactly
// like reactToMessage?. A REQUIRED method would force dummy stubs on those
// adapters. The typed `port.onReaction?.(handler)` calls below prove the
// optional member is part of the port contract at the compile level.
// ---------------------------------------------------------------------------

/** A no-op adapter that OMITS onReaction (e.g. iMessage/IRC/Email) — must still satisfy ChannelPort. */
function makeNoOpReactionAdapter(): ChannelPort {
  return {
    channelId: "noop",
    channelType: "echo",
    async start(): Promise<Result<void, Error>> {
      return ok(undefined);
    },
    async stop(): Promise<Result<void, Error>> {
      return ok(undefined);
    },
    async sendMessage(): Promise<Result<string, Error>> {
      return ok("msg-1");
    },
    onMessage(): void {
      /* no-op */
    },
    // onReaction intentionally OMITTED — the honest no-op.
    async platformAction(): Promise<Result<unknown, Error>> {
      return ok(undefined);
    },
  };
}

/** A reaction-capable adapter that DEFINES onReaction and fans out to its handlers (e.g. Discord/Slack/Telegram). */
function makeReactionAdapter(): ChannelPort & { handlers: ReactionHandler[] } {
  const handlers: ReactionHandler[] = [];
  return {
    channelId: "reacting",
    channelType: "discord",
    handlers,
    async start(): Promise<Result<void, Error>> {
      return ok(undefined);
    },
    async stop(): Promise<Result<void, Error>> {
      return ok(undefined);
    },
    async sendMessage(): Promise<Result<string, Error>> {
      return ok("msg-1");
    },
    onMessage(): void {
      /* no-op */
    },
    onReaction(handler: ReactionHandler): void {
      handlers.push(handler);
    },
    async platformAction(): Promise<Result<unknown, Error>> {
      return ok(undefined);
    },
  };
}

describe("ChannelPort.onReaction optional capability", () => {
  it("ChannelPort allows an adapter to omit onReaction (optional no-op capability)", () => {
    // Type-level: a no-op adapter WITHOUT onReaction is assignable to ChannelPort.
    const port: ChannelPort = makeNoOpReactionAdapter();
    expect(port.onReaction).toBeUndefined();
  });

  it("adapter.onReaction?.(handler) is a safe no-op when the method is absent", () => {
    const port: ChannelPort = makeNoOpReactionAdapter();
    const handler: ReactionHandler = () => {
      /* never called */
    };
    // Optional-call form: undefined method → expression is undefined, no throw.
    expect(() => port.onReaction?.(handler)).not.toThrow();
    expect(port.onReaction?.(handler)).toBeUndefined();
  });

  it("a reaction-capable adapter registers handlers via onReaction and they receive a NormalizedReaction", () => {
    const adapter = makeReactionAdapter();
    const port: ChannelPort = adapter;
    const received: NormalizedReaction[] = [];
    const handler: ReactionHandler = (reaction) => {
      received.push(reaction);
    };

    port.onReaction?.(handler);
    expect(adapter.handlers).toHaveLength(1);

    const reaction: NormalizedReaction = {
      messageId: "m-1",
      reactorId: "u-1",
      emoji: "👍",
      channelType: "discord",
      channelId: "c-1",
    };
    for (const h of adapter.handlers) {
      void h(reaction);
    }
    expect(received).toEqual([reaction]);
  });
});
