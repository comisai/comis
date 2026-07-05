// SPDX-License-Identifier: Apache-2.0
/**
 * Session-key thread-isolation wiring for the inbound resolve phase.
 *
 * Proves the Teams-scoped thread root (`metadata.msteamsThreadId`, set by the
 * Teams mapper) is folded into the scoped session key so two Teams channel
 * threads get two distinct keys and a Teams DM gets one — while every other
 * channel's session key stays byte-identical. The generic thread extractor is
 * deliberately NOT wired at this shared inbound path: reading a Teams-only
 * metadata key leaves every other channel at `threadId: undefined`.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import { formatSessionKey } from "@comis/core";
import type { NormalizedMessage, ChannelPort } from "@comis/core";

import {
  resolveAndPreprocess,
  type ResolveAndPreprocessDeps,
} from "./resolve-and-preprocess.js";

function makeMsg(overrides?: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: "msg-1",
    channelId: "chat-1",
    channelType: "telegram",
    senderId: "user-1",
    text: "hello",
    timestamp: 1_700_000_000_000,
    attachments: [],
    metadata: {},
    ...overrides,
  };
}

function makeAdapter(overrides?: Partial<ChannelPort>): ChannelPort {
  return {
    channelType: "telegram",
    channelId: "chat-1",
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function makeDeps(overrides?: Partial<ResolveAndPreprocessDeps>): ResolveAndPreprocessDeps {
  const defaultExecutor = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const defaults: ResolveAndPreprocessDeps = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: makeLogger() as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eventBus: { emit: vi.fn() } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messageRouter: { resolve: vi.fn(() => "agent-test") } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sessionManager: { loadOrCreate: vi.fn() } as any,
    createExecutor: vi.fn(() => defaultExecutor),
  };
  return { ...defaults, ...overrides };
}

/** Resolve the inbound message and return its serialized scoped session key. */
async function resolvedKeyString(
  msg: NormalizedMessage,
  adapter: ChannelPort,
): Promise<string> {
  const result = await resolveAndPreprocess(makeDeps(), adapter, msg);
  expect(result).toBeDefined();
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return formatSessionKey(result!.sessionKey);
}

describe("resolveAndPreprocess Teams thread isolation", () => {
  it("maps two Teams channel threads with distinct thread roots to two distinct session keys", async () => {
    const adapter = makeAdapter({
      channelType: "msteams",
      channelId: "19:team-abc@thread.tacv2",
    });
    // Same tenant / channel / user — only the thread root differs.
    const base: Partial<NormalizedMessage> = {
      channelType: "msteams",
      channelId: "19:team-abc@thread.tacv2",
      senderId: "aad-user-1",
    };

    const keyThreadA = await resolvedKeyString(
      makeMsg({ ...base, metadata: { msteamsThreadId: "aaa" } }),
      adapter,
    );
    const keyThreadB = await resolvedKeyString(
      makeMsg({ ...base, metadata: { msteamsThreadId: "bbb" } }),
      adapter,
    );

    // No cross-thread bleed: the two roots produce two different keys.
    expect(keyThreadA).not.toBe(keyThreadB);
    expect(keyThreadA.endsWith(":thread:aaa")).toBe(true);
    expect(keyThreadB.endsWith(":thread:bbb")).toBe(true);
  });

  it("maps a Teams direct message with no thread root to a single thread-less session key", async () => {
    const adapter = makeAdapter({
      channelType: "msteams",
      channelId: "19:dm@thread.tacv2",
    });

    const key = await resolvedKeyString(
      makeMsg({
        channelType: "msteams",
        channelId: "19:dm@thread.tacv2",
        senderId: "aad-user-2",
        metadata: {},
      }),
      adapter,
    );

    expect(key).not.toContain(":thread:");
    expect(key).toBe("default:aad-user-2:19:dm@thread.tacv2:peer:aad-user-2");
  });
});

describe("resolveAndPreprocess cross-channel session key is byte-identical", () => {
  // Each fixture carries the platform-specific thread metadata that the generic
  // `extractThreadId` helper recognizes (parentChannelId / slackThreadTs /
  // telegramThreadId). Because the inbound path reads ONLY the Teams-scoped
  // `msteamsThreadId`, none of these produce a `:thread:` segment — the exact
  // pre-wiring key string is preserved. Wiring the generic extractor here would
  // flip these assertions to fail.

  it("keeps a Slack inbound carrying a thread timestamp at its pre-wiring thread-less key", async () => {
    const adapter = makeAdapter({ channelType: "slack", channelId: "C12345" });

    const key = await resolvedKeyString(
      makeMsg({
        channelType: "slack",
        channelId: "C12345",
        senderId: "U67890",
        metadata: { slackThreadTs: "1700000000.123456" },
      }),
      adapter,
    );

    expect(key).toBe("default:U67890:C12345:peer:U67890");
  });

  it("keeps a Telegram inbound carrying a thread id at its pre-wiring thread-less key", async () => {
    const adapter = makeAdapter({ channelType: "telegram", channelId: "chat-999" });

    const key = await resolvedKeyString(
      makeMsg({
        channelType: "telegram",
        channelId: "chat-999",
        senderId: "tg-user-3",
        metadata: { telegramThreadId: 42 },
      }),
      adapter,
    );

    expect(key).toBe("default:tg-user-3:chat-999:peer:tg-user-3");
  });

  it("keeps a Discord thread inbound carrying a parent channel at its pre-wiring key with no thread segment", async () => {
    const adapter = makeAdapter({ channelType: "discord", channelId: "thread-chan-77" });

    const key = await resolvedKeyString(
      makeMsg({
        channelType: "discord",
        channelId: "thread-chan-77",
        senderId: "dc-user-4",
        metadata: { parentChannelId: "parent-chan-1", guildId: "guild-9" },
      }),
      adapter,
    );

    expect(key).not.toContain(":thread:");
    expect(key).toBe("default:dc-user-4:thread-chan-77:peer:dc-user-4:guild:guild-9");
  });
});
