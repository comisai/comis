// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { TypedEventBus, type ResponseLocalePolicy } from "@comis/core";
import {
  applyResponseLocaleEnforcement,
  enforceResponseLocale,
} from "./response-locale-enforcement.js";
import type { RunPromptParams } from "./prompt-runner-types.js";

const ARABIC_POLICY: ResponseLocalePolicy = {
  locale: "ar",
  source: "request",
  enforceLocale: true,
};

function makeSession(onPrompt?: () => void) {
  const tools = [{ name: "write" }, { name: "message" }];
  const session = {
    agent: { state: { tools } },
    prompt: vi.fn(async () => { onPrompt?.(); }),
  };
  return { session, tools };
}

describe("enforceResponseLocale", () => {
  it("leaves a matching response untouched without another model turn", async () => {
    const { session } = makeSession();

    const outcome = await enforceResponseLocale({
      policy: ARABIC_POLICY,
      response: "هذه إجابة عربية عن Docker 25.",
      session,
      getVisibleResponse: () => "unused",
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toMatchObject({
      response: "هذه إجابة عربية عن Docker 25.",
      attempted: false,
      repaired: false,
    });
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("repairs a script mismatch once with tools disabled and restores them", async () => {
    let visibleResponse = "This answer is in English.";
    const { session, tools } = makeSession(() => {
      expect(session.agent.state.tools).toEqual([]);
      visibleResponse = "هذه هي الإجابة المصححة مع Docker 25.";
    });

    const outcome = await enforceResponseLocale({
      policy: ARABIC_POLICY,
      response: visibleResponse,
      session,
      getVisibleResponse: () => visibleResponse,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toMatchObject({
      response: "هذه هي الإجابة المصححة مع Docker 25.",
      attempted: true,
      repaired: true,
    });
    expect(outcome.value.finalFinding).toBeUndefined();
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(session.prompt).toHaveBeenCalledWith(
      expect.stringContaining('locale="ar"'),
      { expandPromptTemplates: false, source: "extension" },
    );
    expect(session.agent.state.tools).toEqual(tools);
  });

  it("restores tools and reports the remaining mismatch when the bounded repair fails", async () => {
    let visibleResponse = "This answer is still in English.";
    const { session, tools } = makeSession(() => {
      visibleResponse = "Still English after one attempt.";
    });

    const outcome = await enforceResponseLocale({
      policy: ARABIC_POLICY,
      response: visibleResponse,
      session,
      getVisibleResponse: () => visibleResponse,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toMatchObject({
      response: "Still English after one attempt.",
      attempted: true,
      repaired: false,
      finalFinding: expect.objectContaining({ actualScript: "Latn" }),
    });
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(session.agent.state.tools).toEqual(tools);
  });

  it("returns a typed failure and restores tools when the session boundary throws", async () => {
    const tools = [{ name: "write" }];
    const session = {
      agent: { state: { tools } },
      prompt: vi.fn(() => { throw new Error("provider boundary failed"); }),
    };

    const outcome = await enforceResponseLocale({
      policy: ARABIC_POLICY,
      response: "This answer is in English.",
      session,
      getVisibleResponse: () => "unused",
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.cause.message).toBe("provider boundary failed");
    expect(session.agent.state.tools).toEqual(tools);
  });
});

describe("applyResponseLocaleEnforcement", () => {
  it("records a content-free recovery event and duration for a repaired response", async () => {
    let now = 10;
    const eventBus = new TypedEventBus();
    const recoveryEvent = vi.fn();
    eventBus.on("execution:recovery_attempted", recoveryEvent);
    const logger = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    };
    const session = {
      agent: { state: { tools: [{ name: "write" }] } },
      messages: [{ role: "assistant", content: [{ type: "text", text: "English draft" }] }],
      prompt: vi.fn(async () => {
        now = 17;
        session.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "هذه إجابة مصححة." }],
        });
      }),
    };
    const result = { response: "English draft" };
    const params = {
      responseLocalePolicy: ARABIC_POLICY,
      result,
      session,
      agentId: "agent-a",
      sessionKey: {
        tenantId: "tenant-a", agentId: "agent-a", channelId: "channel-a", userId: "user_a",
      },
      deps: {
        eventBus,
        logger,
        clock: { now: () => now, nowDate: () => new Date(now) },
      },
    } as unknown as RunPromptParams;

    await applyResponseLocaleEnforcement(params);

    expect(result.response).toBe("هذه إجابة مصححة.");
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ durationMs: 7, locale: "ar" }),
      "Response locale repair completed",
    );
    expect(recoveryEvent).toHaveBeenCalledWith(expect.objectContaining({
      reason: "locale_fidelity",
      succeeded: true,
    }));
    expect(JSON.stringify(recoveryEvent.mock.calls)).not.toContain("English draft");
    expect(JSON.stringify(recoveryEvent.mock.calls)).not.toContain("إجابة مصححة");
  });
});
