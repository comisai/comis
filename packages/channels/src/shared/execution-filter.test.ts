/**
 * Tests for the execution filter's narration suppression behavior.
 *
 * Verifies that when the accumulated fallback path is used (result.response empty),
 * narration text from tool-call turns is stripped via extractFinalTagContent.
 */

import type { ChannelPort, NormalizedMessage, SessionKey } from "@comis/core";
import { ok } from "@comis/shared";
import { describe, it, expect, vi } from "vitest";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

import { filterExecutionResponse, type FilterDeps } from "./execution-filter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<FilterDeps>): FilterDeps {
  return {
    eventBus: {
      emit: vi.fn(() => true),
      on: vi.fn().mockReturnThis(),
      off: vi.fn().mockReturnThis(),
    } as any,
    logger: createMockLogger(),
    enforceFinalTag: false,
    voiceResponsePipeline: undefined,
    parseOutboundMedia: undefined,
    outboundMediaFetch: undefined,
    responsePrefixConfig: undefined,
    buildTemplateContext: undefined,
    ...overrides,
  };
}

function makeAdapter(): ChannelPort {
  return {
    channelId: "test-chan",
    channelType: "echo",
    start: vi.fn(async () => ok(undefined)),
    stop: vi.fn(async () => ok(undefined)),
    sendMessage: vi.fn(async () => ok("msg-1")),
    editMessage: vi.fn(async () => ok(undefined)),
    onMessage: vi.fn(),
  } as any;
}

function makeMessage(overrides?: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    channelId: "12345",
    channelType: "echo",
    senderId: "user-1",
    text: "Hello",
    timestamp: Date.now(),
    attachments: [],
    metadata: {},
    ...overrides,
  };
}

function makeSessionKey(): SessionKey {
  return { tenantId: "default", userId: "user-1", channelId: "12345" };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("filterExecutionResponse - narration suppression", () => {
  const adapter = makeAdapter();
  const msg = makeMessage();
  const sessionKey = makeSessionKey();

  it("strips narration from accumulated when <final> tags are present", async () => {
    const deps = makeDeps();
    const accumulated = "Narration text\n<think>reasoning</think>\n<final>Real answer</final>";

    const result = await filterExecutionResponse(
      deps, adapter, msg, msg, sessionKey, "agent-1",
      { response: undefined }, // result.response empty -> use accumulated fallback
      accumulated,
      undefined, false, undefined, "stop",
    );

    expect(result.deliver).toBe(true);
    if (result.deliver) {
      expect(result.text).toBe("Real answer");
    }
  });

  it("preserves accumulated text when no <final> tags are present (backward compat)", async () => {
    const deps = makeDeps();
    const accumulated = "Just plain text without tags";

    const result = await filterExecutionResponse(
      deps, adapter, msg, msg, sessionKey, "agent-1",
      { response: undefined },
      accumulated,
      undefined, false, undefined, "stop",
    );

    expect(result.deliver).toBe(true);
    if (result.deliver) {
      expect(result.text).toBe("Just plain text without tags");
    }
  });

  it("extracts only <final> content when narration surrounds it", async () => {
    const deps = makeDeps();
    const accumulated = "Step 1 done\n<think>planning</think>\n<final>Here is your result</final>\nMore narration";

    const result = await filterExecutionResponse(
      deps, adapter, msg, msg, sessionKey, "agent-1",
      { response: undefined },
      accumulated,
      undefined, false, undefined, "stop",
    );

    expect(result.deliver).toBe(true);
    if (result.deliver) {
      expect(result.text).toBe("Here is your result");
    }
  });

  it("uses result.response when present, ignoring accumulated", async () => {
    const deps = makeDeps();
    const accumulated = "Narration text\n<final>Accumulated answer</final>";

    const result = await filterExecutionResponse(
      deps, adapter, msg, msg, sessionKey, "agent-1",
      { response: "Direct response from SDK" },
      accumulated,
      undefined, false, undefined, "stop",
    );

    expect(result.deliver).toBe(true);
    if (result.deliver) {
      expect(result.text).toBe("Direct response from SDK");
    }
  });

  it("returns empty/not-deliver when accumulated is empty string", async () => {
    const deps = makeDeps();

    const result = await filterExecutionResponse(
      deps, adapter, msg, msg, sessionKey, "agent-1",
      { response: undefined },
      "",
      undefined, false, undefined, "stop",
    );

    expect(result.deliver).toBe(false);
    if (!result.deliver) {
      expect(result.reason).toBe("empty_stop_ack");
    }
  });
});

// ---------------------------------------------------------------------------
// Fallback acknowledgment on normal completion with empty response
// ---------------------------------------------------------------------------

describe("filterExecutionResponse - fallback ack on empty stop response", () => {
  const msg = makeMessage();
  const sessionKey = makeSessionKey();

  it("sends canned acknowledgment when response is empty and finishReason is 'stop'", async () => {
    const deps = makeDeps();
    const adapter = makeAdapter();

    const result = await filterExecutionResponse(
      deps, adapter, msg, msg, sessionKey, "agent-1",
      { response: undefined },
      "",
      undefined, false, undefined, "stop",
    );

    expect(result.deliver).toBe(false);
    if (!result.deliver) {
      expect(result.reason).toBe("empty_stop_ack");
    }
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      msg.channelId,
      "I completed the requested operations but wasn't able to generate a summary. Please check the results or ask me to continue.",
      { replyTo: undefined },
    );
  });

  it("silently skips delivery when response is empty and finishReason is 'error'", async () => {
    const deps = makeDeps();
    const adapter = makeAdapter();

    const result = await filterExecutionResponse(
      deps, adapter, msg, msg, sessionKey, "agent-1",
      { response: undefined },
      "",
      undefined, false, undefined, "error",
    );

    expect(result.deliver).toBe(false);
    if (!result.deliver) {
      expect(result.reason).toBe("empty");
    }
    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });

  it("prefers resource abort message over stop ack when both conditions apply", async () => {
    const deps = makeDeps();
    const adapter = makeAdapter();

    const result = await filterExecutionResponse(
      deps, adapter, msg, msg, sessionKey, "agent-1",
      { response: undefined },
      "",
      undefined, true, "budget_exceeded", "stop",
    );

    expect(result.deliver).toBe(false);
    if (!result.deliver) {
      expect(result.reason).toBe("resource_abort_empty");
    }
  });
});
