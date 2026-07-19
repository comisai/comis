// SPDX-License-Identifier: Apache-2.0
/** Canonical conversation-scope construction for the inbound resolve phase. */
import { describe, it, expect, vi } from "vitest";
import { formatSessionKey } from "@comis/core";
import type { NormalizedMessage, ChannelPort } from "@comis/core";
import { ok } from "@comis/shared";
import { createFakePrincipalResolver } from "../../../../test/support/fake-principal-resolver.js";

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

function insertedPersistence(plan = { payloads: [], ledgerContent: "" }) {
  return { ok: true as const, value: plan };
}

function makeDeps(overrides?: Partial<ResolveAndPreprocessDeps>): ResolveAndPreprocessDeps {
  const defaultExecutor = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const principalResolver = createFakePrincipalResolver();
  const defaults: ResolveAndPreprocessDeps = {
    tenantId: "default",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: makeLogger() as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eventBus: { emit: vi.fn() } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messageRouter: { resolve: vi.fn(() => "agent-test") } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sessionManager: { loadOrCreate: vi.fn(() => ok([])) } as any,
    principalResolver,
    getDmScope: () => ({ mode: "per-account-channel-peer", threadIsolation: true }),
    createExecutor: vi.fn(() => defaultExecutor),
    persistInboundMessage: vi.fn(async () => insertedPersistence()),
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
    expect(key).toMatch(/^default:agent:agent-test:platform_/);
    expect(key).toContain(":msteams:19:dm@thread.tacv2:19:dm@thread.tacv2:peer:platform_");
  });
});

describe("resolveAndPreprocess cross-channel thread isolation", () => {
  it("includes a Slack thread timestamp in canonical conversation authority", async () => {
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

    expect(key).toMatch(/^default:agent:agent-test:platform_/);
    expect(key).toContain(":slack:C12345:C12345:peer:platform_");
    expect(key.endsWith(":thread:1700000000.123456")).toBe(true);
  });

  it("includes a Telegram thread id in canonical conversation authority", async () => {
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

    expect(key).toMatch(/^default:agent:agent-test:platform_/);
    expect(key).toContain(":telegram:chat-999:chat-999:peer:platform_");
    expect(key.endsWith(":thread:42")).toBe(true);
  });

  it("isolates a Discord thread as a conversation partition", async () => {
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

    expect(key).toBe("default:agent:agent-test:conversation:discord:thread-chan-77:thread-chan-77:thread:thread-chan-77");
  });
});

describe("resolveAndPreprocess inbound provenance ownership", () => {
  it("redacts credentials from durable provenance failure logs", async () => {
    const credential = `xoxb-${"r".repeat(32)}`;
    const deps = makeDeps({
      persistInboundMessage: vi.fn(async () => ({
        ok: false as const,
        error: {
          error: new Error(`provenance unavailable ${credential}`),
          errorKind: "resource" as const,
        },
      })) as never,
    });

    await expect(resolveAndPreprocess(
      deps,
      makeAdapter(),
      makeMsg({ id: "11111111-1111-4111-8111-111111111119" }),
    )).rejects.toThrow("provenance unavailable");

    expect(JSON.stringify(deps.logger.error.mock.calls)).not.toContain(credential);
  });

  it("directs integrity failures to quarantine without asking for a resend", async () => {
    const credential = `xoxb-${"q".repeat(32)}`;
    const deps = makeDeps({
      persistInboundMessage: vi.fn(async () => ({
        ok: false as const,
        error: {
          error: new Error(`provenance identity collision ${credential}`),
          errorKind: "precondition" as const,
        },
      })) as never,
    });

    await expect(resolveAndPreprocess(
      deps,
      makeAdapter(),
      makeMsg({ id: "11111111-1111-4111-8111-111111111118" }),
    )).rejects.toThrow("provenance identity collision");

    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "precondition",
        hint: expect.stringMatching(/quarantine/i),
      }),
      "Inbound message provenance persistence failed",
    );
    const logged = JSON.stringify(deps.logger.error.mock.calls);
    expect(logged).not.toContain(credential);
    expect(logged).not.toMatch(/resend/i);
  });

  it("persists the admitted physical message before discovering that no executor exists", async () => {
    const persistInboundMessage = vi.fn(async () => insertedPersistence());
    const deps = makeDeps({
      createExecutor: vi.fn(() => undefined),
      persistInboundMessage,
    });
    const message = makeMsg({ id: "11111111-1111-4111-8111-111111111111" });

    const result = await resolveAndPreprocess(deps, makeAdapter(), message);

    expect(result).toMatchObject({ kind: "no_executor", agentId: "agent-test" });
    expect(persistInboundMessage).toHaveBeenCalledOnce();
    expect(deps.sessionManager.loadOrCreate).not.toHaveBeenCalled();
  });

  it("returns the exact immutable provenance plan produced by the durable append", async () => {
    const persistedPlan = {
      payloads: [{
        schemaVersion: 1,
        batchId: "11111111-1111-4111-8111-111111111111",
        chunkIndex: 0,
        chunkCount: 1,
        recordedAt: 1_789_000_100_000,
        messages: [],
      }],
      ledgerContent: "planned-line\n",
    };
    const deps = makeDeps({
      persistInboundMessage: vi.fn(async () => ({
        ok: true,
        value: persistedPlan,
      })) as never,
    });

    const result = await resolveAndPreprocess(
      deps,
      makeAdapter(),
      makeMsg({ id: "11111111-1111-4111-8111-111111111111" }),
    );

    expect(result).toMatchObject({ inboundProvenancePlan: persistedPlan });
  });
});
