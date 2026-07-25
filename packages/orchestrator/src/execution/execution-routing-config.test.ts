// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { runWithContext, StreamingConfigSchema } from "@comis/core";
import {
  buildThreadSendOpts,
  resolveStreamingConfig,
  THREAD_PROPAGATION_KEYS,
} from "./execution-routing-config.js";

describe("execution routing configuration", () => {
  it("builds thread options without losing the Telegram thread scope", () => {
    expect(buildThreadSendOpts({
      threadId: "topic-1",
      telegramThreadScope: "forum",
    })).toEqual({
      threadId: "topic-1",
      extra: { telegramThreadScope: "forum" },
    });
    expect(THREAD_PROPAGATION_KEYS).toContain("telegramThreadScope");
  });

  it("uses the authenticated turn thread instead of Slack message metadata", async () => {
    await runWithContext({
      tenantId: "tenant-a",
      userId: "user_a",
      sessionKey: "tenant-a:user_a:C123",
      agentId: "agent-1",
      traceId: "550e8400-e29b-41d4-a716-446655440001",
      startedAt: 1,
      trustLevel: "user",
      channelType: "slack",
      turnScope: {
        conversation: {
          tenantId: "tenant-a",
          agentId: "agent-1",
          partition: { kind: "principal", principalId: "user_a" },
        },
        principal: { principalId: "user_a" },
        endpoint: {
          channelType: "slack",
          channelInstanceId: "slack-primary",
          conversationId: "C123",
          threadId: "1699999999.000000",
          conversationKind: "shared",
        },
      },
    }, () => {
      expect(buildThreadSendOpts({
        slackTs: "1700000001.000000",
        slackThreadTs: "1699999999.000000",
      })).toEqual({
        threadId: "1699999999.000000",
        extra: undefined,
      });
    });
  });

  it("prefers the channel override over global streaming defaults", () => {
    const config = StreamingConfigSchema.parse({
      defaultTypingMode: "thinking",
      perChannel: { telegram: { typingMode: "instant" } },
    });

    expect(resolveStreamingConfig("telegram", config).typingMode).toBe("instant");
    expect(resolveStreamingConfig("slack", config).typingMode).toBe("thinking");
  });
});
