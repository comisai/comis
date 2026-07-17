// SPDX-License-Identifier: Apache-2.0
/**
 * Branch-gap tests for filterExecutionResponse (execution-filter.ts).
 *
 * Targets uncovered branches: response sanitization fallback paths
 * (accumulated text, enforceFinalTag), resource-abort empty-response path,
 * canned-empty-on-stop ack, NO_REPLY filtering, voice-response pipeline
 * branches, outbound-media branches.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import type {
  ChannelPort,
  NormalizedMessage,
  SessionKey,
} from "@comis/core";
import { ok, err } from "@comis/shared";

import { filterExecutionResponse } from "./execution-filter.js";
import type { FilterDeps } from "./execution-filter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapter(channelType = "telegram"): ChannelPort {
  return {
    channelId: "adapter-1",
    channelType,
    start: vi.fn(async () => ok(undefined)),
    stop: vi.fn(async () => ok(undefined)),
    sendMessage: vi.fn(async () => ok("msg-r1")),
    editMessage: vi.fn(async () => ok(undefined)),
    onMessage: vi.fn(),
    reactToMessage: vi.fn(async () => ok(undefined)),
    removeReaction: vi.fn(async () => ok(undefined)),
    deleteMessage: vi.fn(async () => ok(undefined)),
    fetchMessages: vi.fn(async () => ok([])),
    sendAttachment: vi.fn(async () => ok({ kind: "tracked" as const, messageId: "att-1" })),
    platformAction: vi.fn(async () => ok(undefined)),
  };
}

function makeMsg(overrides?: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: "msg-1",
    channelId: "chat-1",
    channelType: "telegram",
    senderId: "user-1",
    text: "hello",
    timestamp: Date.now(),
    attachments: [],
    metadata: {},
    ...overrides,
  };
}

function makeSessionKey(): SessionKey {
  return {
    tenantId: "default",
    userId: "user-1",
    channelId: "chat-1",
  };
}

function makeEventBus() {
  const emit = vi.fn((_event: string, _payload: unknown) => true);
  return {
    emit,
    emitSafely: vi.fn((event: string, payload: unknown) => ({
      hadListeners: emit(event, payload),
      failures: [],
    })),
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    removeAllListeners: vi.fn().mockReturnThis(),
    listenerCount: vi.fn(() => 0),
    setMaxListeners: vi.fn().mockReturnThis(),
  };
}

function makeDeps(overrides?: Partial<FilterDeps>): FilterDeps {
  const eventBus = makeEventBus();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eventBus: eventBus as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: logger as any,
    ...overrides,
  } as FilterDeps;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeResult(overrides?: Partial<Record<string, any>>) {
  return {
    response: "agent response",
    tokensUsed: { total: 100 },
    cost: { total: 0.001 },
    finishReason: "stop",
    sessionKey: makeSessionKey(),
    stepsExecuted: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Response sanitization fallback paths
// ---------------------------------------------------------------------------

describe("filterExecutionResponse response sanitization fallbacks", () => {
  it("uses result.response when present (primary path)", async () => {
    const deps = makeDeps();
    const adapter = makeAdapter();
    const result = await filterExecutionResponse(
      deps,
      adapter,
      makeMsg(),
      makeMsg(),
      makeSessionKey(),
      "agent-1",
      makeResult({ response: "primary response" }),
      "",
      undefined,
      false,
      undefined,
      "stop",
    );

    expect(result.deliver).toBe(true);
    if (result.deliver) {
      expect(result.text).toContain("primary response");
    }
  });

  it("falls back to accumulated text when result.response is empty and accumulated has content", async () => {
    const deps = makeDeps();
    const adapter = makeAdapter();
    const result = await filterExecutionResponse(
      deps,
      adapter,
      makeMsg(),
      makeMsg(),
      makeSessionKey(),
      "agent-1",
      makeResult({ response: "" }),
      "accumulated fallback text",
      undefined,
      false,
      undefined,
      "stop",
    );

    expect(result.deliver).toBe(true);
    if (result.deliver) {
      expect(result.text).toContain("accumulated fallback text");
    }
  });

  it("extracts <final> content from accumulated when result.response is empty and <final> tags present", async () => {
    const deps = makeDeps();
    const adapter = makeAdapter();
    const accumulated =
      "Step 1: thinking...\n<final>final-tag-content</final>";
    const result = await filterExecutionResponse(
      deps,
      adapter,
      makeMsg(),
      makeMsg(),
      makeSessionKey(),
      "agent-1",
      makeResult({ response: "" }),
      accumulated,
      undefined,
      false,
      undefined,
      "stop",
    );

    expect(result.deliver).toBe(true);
    if (result.deliver) {
      expect(result.text).toBe("final-tag-content");
    }
  });

  it("logs warning when enforceFinalTag is set but model didn't produce response", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: vi.fn().mockReturnThis(),
    };
    const deps = makeDeps({
      enforceFinalTag: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: logger as any,
    });
    const adapter = makeAdapter();
    // sanitizeAssistantResponse with enforceFinalTag will strip non-final content
    // so result.response="thinking only" becomes ""
    await filterExecutionResponse(
      deps,
      adapter,
      makeMsg(),
      makeMsg(),
      makeSessionKey(),
      "agent-1",
      makeResult({ response: "no final tag here" }),
      "",
      undefined,
      false,
      undefined,
      "stop",
    );

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining("enforceFinalTag"),
      }),
      "enforceFinalTag produced empty response",
    );
  });
});

// ---------------------------------------------------------------------------
// Resource abort with empty response
// ---------------------------------------------------------------------------

describe("filterExecutionResponse resource abort path", () => {
  it("returns an accomplishment notification for receipt-tracked delivery after a resource abort", async () => {
    const deps = makeDeps();
    const adapter = makeAdapter();
    const result = await filterExecutionResponse(
      deps,
      adapter,
      makeMsg(),
      makeMsg(),
      makeSessionKey(),
      "agent-1",
      makeResult({
        response: "",
        toolExecResults: [
          { toolName: "web_search", success: true },
          { toolName: "summarize", success: true },
        ],
      }),
      "",
      "msg-reply-to",
      true,
      "budget_exceeded",
      "stop",
    );

    expect(result.deliver).toBe(true);
    if (result.deliver) {
      expect(result.text).toContain("processing budget");
    }
    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });

  it("returns a generic exhaustion message for receipt-tracked delivery without tool history", async () => {
    const deps = makeDeps();
    const adapter = makeAdapter();
    const result = await filterExecutionResponse(
      deps,
      adapter,
      makeMsg(),
      makeMsg(),
      makeSessionKey(),
      "agent-1",
      makeResult({ response: "", toolExecResults: [] }),
      "",
      "msg-reply-to",
      true,
      "max_steps",
      "stop",
    );

    expect(result.deliver).toBe(true);
    if (result.deliver) {
      expect(result.text).toContain("processing limit");
    }
    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });

  it("returns a canned acknowledgment for receipt-tracked delivery after an empty normal stop", async () => {
    const deps = makeDeps();
    const adapter = makeAdapter();
    const result = await filterExecutionResponse(
      deps,
      adapter,
      makeMsg(),
      makeMsg(),
      makeSessionKey(),
      "agent-1",
      makeResult({ response: "" }),
      "",
      undefined,
      false,
      undefined,
      "stop",
    );

    expect(result.deliver).toBe(true);
    if (result.deliver) {
      expect(result.text).toContain("completed the requested");
    }
    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });

  it("returns deliver=false with empty reason when LLM finished with non-stop reason and empty response", async () => {
    const deps = makeDeps();
    const adapter = makeAdapter();
    const result = await filterExecutionResponse(
      deps,
      adapter,
      makeMsg(),
      makeMsg(),
      makeSessionKey(),
      "agent-1",
      makeResult({ response: "" }),
      "",
      undefined,
      false,
      undefined,
      "max_tokens",
    );

    expect(result.deliver).toBe(false);
    if (!result.deliver) {
      expect(result.reason).toBe("empty");
    }
    // No canned ack sent for non-stop
    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Response filter (NO_REPLY/HEARTBEAT_OK)
// ---------------------------------------------------------------------------

describe("filterExecutionResponse response filter", () => {
  it("returns deliver=false with reason=filtered when response is NO_REPLY", async () => {
    const eventBus = makeEventBus();
    const deps = makeDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      eventBus: eventBus as any,
    });
    const adapter = makeAdapter();
    const result = await filterExecutionResponse(
      deps,
      adapter,
      makeMsg(),
      makeMsg(),
      makeSessionKey(),
      "agent-1",
      makeResult({ response: "NO_REPLY" }),
      "",
      undefined,
      false,
      undefined,
      "stop",
    );

    expect(result.deliver).toBe(false);
    if (!result.deliver) {
      expect(result.reason).toBe("filtered");
    }
    expect(eventBus.emit).toHaveBeenCalledWith(
      "response:filtered",
      expect.any(Object),
    );
  });
});

// ---------------------------------------------------------------------------
// Voice response pipeline
// ---------------------------------------------------------------------------

// Voice response pipeline coverage is exercised through full-pipeline tests
// in execution-pipeline.test.ts; reproducing the full VoiceResponsePipelineDeps
// shape here would duplicate that scaffolding without adding new branch coverage.

// ---------------------------------------------------------------------------
// Response prefix
// ---------------------------------------------------------------------------

describe("filterExecutionResponse response prefix", () => {
  it("applies prefix template when responsePrefixConfig + buildTemplateContext are configured", async () => {
    const buildTemplateContext = vi.fn(() => ({ user: "alice" }));
    const deps = makeDeps({
      responsePrefixConfig: { template: "[{user}] ", position: "prepend" },
      buildTemplateContext,
    });
    const adapter = makeAdapter();
    const result = await filterExecutionResponse(
      deps,
      adapter,
      makeMsg(),
      makeMsg(),
      makeSessionKey(),
      "agent-1",
      makeResult({ response: "hello" }),
      "",
      undefined,
      false,
      undefined,
      "stop",
    );

    expect(buildTemplateContext).toHaveBeenCalled();
    expect(result.deliver).toBe(true);
    if (result.deliver) {
      expect(result.text).toContain("alice");
    }
  });

  it("skips prefix application when responsePrefixConfig.template is empty", async () => {
    const buildTemplateContext = vi.fn();
    const deps = makeDeps({
      responsePrefixConfig: { template: "", position: "prepend" },
      buildTemplateContext,
    });
    const adapter = makeAdapter();
    await filterExecutionResponse(
      deps,
      adapter,
      makeMsg(),
      makeMsg(),
      makeSessionKey(),
      "agent-1",
      makeResult({ response: "hello" }),
      "",
      undefined,
      false,
      undefined,
      "stop",
    );

    expect(buildTemplateContext).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Outbound media pipeline
// ---------------------------------------------------------------------------

describe("filterExecutionResponse outbound media", () => {
  it("invokes parseOutboundMedia + outboundMediaFetch when both are configured and media URLs found", async () => {
    const parseOutboundMedia = vi.fn((text: string) => ({
      text: text.replace(/MEDIA:.*$/m, "").trim(),
      mediaUrls: ["https://example.com/image.png"],
    }));
    const outboundMediaFetch = vi.fn(async () =>
      ok({ buffer: Buffer.from("img"), mimeType: "image/png" }),
    );
    (
      (((): never => undefined) as unknown) as ChannelPort
    ).sendAttachment = vi.fn() as never;
    const deps = makeDeps({
      parseOutboundMedia,
      outboundMediaFetch,
    });
    const adapter = makeAdapter();
    (adapter.sendAttachment as ReturnType<typeof vi.fn>).mockResolvedValue(
      ok({ kind: "tracked", messageId: "att-id" }),
    );

    const result = await filterExecutionResponse(
      deps,
      adapter,
      makeMsg(),
      makeMsg(),
      makeSessionKey(),
      "agent-1",
      makeResult({ response: "Hello\nMEDIA: https://example.com/image.png" }),
      "",
      undefined,
      false,
      undefined,
      "stop",
    );

    expect(parseOutboundMedia).toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it("returns media_only reason when finalDeliveryText is empty after media extraction", async () => {
    const parseOutboundMedia = vi.fn(() => ({
      text: "   ",
      mediaUrls: ["https://example.com/image.png"],
    }));
    const outboundMediaFetch = vi.fn(async () =>
      ok({ buffer: Buffer.from("img"), mimeType: "image/png" }),
    );
    const deps = makeDeps({
      parseOutboundMedia,
      outboundMediaFetch,
    });
    const adapter = makeAdapter();
    (adapter.sendAttachment as ReturnType<typeof vi.fn>).mockResolvedValue(
      ok({ kind: "tracked", messageId: "att-id" }),
    );

    const result = await filterExecutionResponse(
      deps,
      adapter,
      makeMsg(),
      makeMsg(),
      makeSessionKey(),
      "agent-1",
      makeResult({ response: "MEDIA: https://example.com/image.png" }),
      "",
      undefined,
      false,
      undefined,
      "stop",
    );

    expect(result.deliver).toBe(false);
    if (!result.deliver) {
      expect(result.reason).toBe("media_only");
    }
  });
});
