// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import type { AgentExecutor } from "@comis/agent";
import type { ChannelPort, NormalizedMessage, SessionKey } from "@comis/core";
import { TypedEventBus } from "@comis/core";
import { ok } from "@comis/shared";
import { resolveExecutionTrustLevel, runExecutionPolicy } from "./execution-policy.js";

const sessionKey: SessionKey = {
  tenantId: "tenant",
  userId: "user-1",
  channelId: "chat-1",
};

function makeMessage(): NormalizedMessage {
  return {
    id: "message-1",
    channelId: "chat-1",
    channelType: "telegram",
    senderId: "user-1",
    text: "hello",
    timestamp: 1_000,
    attachments: [],
    metadata: {},
  };
}

function makeAdapter(): ChannelPort {
  return {
    channelId: "adapter-1",
    channelType: "telegram",
    start: vi.fn(async () => ok(undefined)),
    stop: vi.fn(async () => ok(undefined)),
    sendMessage: vi.fn(async () => ok("reply-1")),
    onMessage: vi.fn(),
  } as unknown as ChannelPort;
}

function makeExecutor(): AgentExecutor {
  return {
    execute: vi.fn(async () => ({
      response: "result",
      sessionKey,
      tokensUsed: { input: 1, output: 1, total: 2 },
      cost: { total: 0 },
      stepsExecuted: 0,
      llmCalls: 1,
      finishReason: "stop" as const,
    })),
  } as unknown as AgentExecutor;
}

function makeBaseInput() {
  return {
    deps: {
      eventBus: new TypedEventBus(),
      logger: {
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        audit: vi.fn(),
        child: vi.fn(),
      } as never,
    },
    adapter: makeAdapter(),
    effectiveMsg: makeMessage(),
    originalMsg: makeMessage(),
    executor: makeExecutor(),
    sessionKey,
    agentId: "agent-1",
    sendOverrides: {
      get: vi.fn(() => "inherit" as const),
      set: vi.fn(),
      delete: vi.fn(),
    },
    onExecutionStart: vi.fn(),
    onExecutionComplete: vi.fn(),
  };
}

describe("execution policy", () => {
  it("forces Telegram non-user sender identities to guest trust", () => {
    const config = {
      enabled: true,
      defaultTrustLevel: "admin" as const,
      senderTrustMap: {
        "chat:-100777": "admin" as const,
        "unknown:123:42": "admin" as const,
      },
      trustModelRoutes: {},
      trustPromptOverrides: {},
    };

    expect(resolveExecutionTrustLevel(config, "chat:-100777")).toBe("guest");
    expect(resolveExecutionTrustLevel(config, "unknown:123:42")).toBe("guest");
    expect(resolveExecutionTrustLevel(undefined, "chat:-100777")).toBe("guest");
  });

  it("executes but classifies a send-policy-denied turn for silent completion", async () => {
    const input = makeBaseInput();
    input.deps = {
      ...input.deps,
      sendPolicyConfig: { enabled: true, defaultAction: "deny", rules: [] },
    };

    const result = await runExecutionPolicy(input);

    expect(result.kind).toBe("denied");
    expect(input.executor.execute).toHaveBeenCalledOnce();
    expect(input.onExecutionStart).toHaveBeenCalledOnce();
    expect(input.onExecutionComplete).toHaveBeenCalledOnce();
  });

  it("applies sender trust model and prompt routing on an allowed turn", async () => {
    const input = makeBaseInput();
    input.deps = {
      ...input.deps,
      getElevatedReplyConfig: () => ({
        enabled: true,
        defaultTrustLevel: "guest",
        senderTrustMap: { "user-1": "admin" },
        trustModelRoutes: { admin: "operator-model" },
        trustPromptOverrides: { admin: "operator prompt" },
      }),
    };

    const result = await runExecutionPolicy(input);

    expect(result).toMatchObject({
      kind: "continue",
      trustLevel: "admin",
      effectiveMsg: {
        metadata: {
          modelRoute: "operator-model",
          systemPromptOverride: "operator prompt",
        },
      },
    });
    expect(input.executor.execute).not.toHaveBeenCalled();
  });
});
