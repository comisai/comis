// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { StreamingConfigSchema } from "@comis/core";
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

  it("prefers the channel override over global streaming defaults", () => {
    const config = StreamingConfigSchema.parse({
      defaultTypingMode: "thinking",
      perChannel: { telegram: { typingMode: "instant" } },
    });

    expect(resolveStreamingConfig("telegram", config).typingMode).toBe("instant");
    expect(resolveStreamingConfig("slack", config).typingMode).toBe("thinking");
  });
});
