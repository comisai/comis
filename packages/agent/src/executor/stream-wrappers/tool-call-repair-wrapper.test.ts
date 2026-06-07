// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { createToolCallRepairWrapper } from "./tool-call-repair-wrapper.js";
import { FAIL_CLOSED_PROFILE } from "../model-profile.js";
import {
  createMockLogger,
  createMockStreamFn,
  makeAssistantMessage,
  makeContext,
} from "./__test-helpers/index.js";

describe("createToolCallRepairWrapper", () => {
  let logger: ReturnType<typeof createMockLogger>;
  let base: ReturnType<typeof createMockStreamFn>;

  beforeEach(() => {
    logger = createMockLogger();
    base = createMockStreamFn();
  });

  function makeToolCall(
    name: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: Record<string, any> | string,
    id = `tc-${name}`,
  ) {
    return {
      type: "toolCall" as const,
      id,
      name,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      arguments: args as any,
    };
  }

  it("passes non-assistant messages through unchanged", () => {
    const wrapper = createToolCallRepairWrapper(FAIL_CLOSED_PROFILE, logger);
    const wrappedFn = wrapper(base);

    const userMsg: Message = { role: "user", content: "hello", timestamp: 0 };
    const ctx = makeContext([userMsg]);

    wrappedFn({} as any, ctx, {} as any);

    expect(base).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ messages: [userMsg] }),
      {},
    );
  });

  it("passes assistant messages with already-parsed object arguments unchanged", () => {
    const wrapper = createToolCallRepairWrapper(FAIL_CLOSED_PROFILE, logger);
    const wrappedFn = wrapper(base);

    const toolCall = makeToolCall("file_read", { path: "/tmp/file.txt" });
    const assistantMsg = makeAssistantMessage([toolCall]);
    const ctx = makeContext([assistantMsg]);

    wrappedFn({} as any, ctx, {} as any);

    const capturedCtx = (base as any).mock.calls[0][1] as { messages: Message[] };
    const outMsg = capturedCtx.messages[0] as typeof assistantMsg;
    expect(outMsg.role).toBe("assistant");
    const outBlock = outMsg.content[0] as typeof toolCall;
    // Arguments should be the original parsed object, not modified
    expect(outBlock.arguments).toEqual({ path: "/tmp/file.txt" });
    // No debug log for already-parsed args
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it("repairs string arguments with trailing comma (near-miss JSON)", () => {
    const wrapper = createToolCallRepairWrapper(FAIL_CLOSED_PROFILE, logger);
    const wrappedFn = wrapper(base);

    // Runtime: arguments is a string (raw JSON from SDK when parsing is lenient)
    const toolCall = makeToolCall("file_read", '{"path":"/tmp/file.txt",}' as any);
    const assistantMsg = makeAssistantMessage([toolCall]);
    const ctx = makeContext([assistantMsg]);

    wrappedFn({} as any, ctx, {} as any);

    const capturedCtx = (base as any).mock.calls[0][1] as { messages: Message[] };
    const outMsg = capturedCtx.messages[0] as typeof assistantMsg;
    const outBlock = outMsg.content[0] as typeof toolCall;
    // Repaired args should be the parsed object
    expect(outBlock.arguments).toEqual({ path: "/tmp/file.txt" });
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ submodule: "tool-call-repair-wrapper", toolName: "file_read" }),
      "Tool-call JSON shape repaired",
    );
  });

  it("S3 adversarial: repairs shape but preserves malicious value unchanged", () => {
    const wrapper = createToolCallRepairWrapper(FAIL_CLOSED_PROFILE, logger);
    const wrappedFn = wrapper(base);

    // Adversarial: shape error + dangerous command value
    const toolCall = makeToolCall("exec", '{"command":"rm -rf /",}' as any);
    const assistantMsg = makeAssistantMessage([toolCall]);
    const ctx = makeContext([assistantMsg]);

    wrappedFn({} as any, ctx, {} as any);

    const capturedCtx = (base as any).mock.calls[0][1] as { messages: Message[] };
    const outMsg = capturedCtx.messages[0] as typeof assistantMsg;
    const outBlock = outMsg.content[0] as typeof toolCall;
    // Shape IS repaired; value is UNCHANGED — exec gate blocks downstream
    expect(outBlock.arguments).toEqual({ command: "rm -rf /" });
    expect((outBlock.arguments as Record<string, unknown>)["command"]).toBe("rm -rf /");
  });

  it("converts irreparable string args to synthetic toolResult error with Validation failed prefix", () => {
    const wrapper = createToolCallRepairWrapper(FAIL_CLOSED_PROFILE, logger);
    const wrappedFn = wrapper(base);

    const toolCall = makeToolCall("exec", "not json at all <<<" as any);
    const assistantMsg = makeAssistantMessage([toolCall]);
    const ctx = makeContext([assistantMsg]);

    wrappedFn({} as any, ctx, {} as any);

    const capturedCtx = (base as any).mock.calls[0][1] as { messages: Message[] };
    // Expect: original assistant message + synthetic toolResult error
    expect(capturedCtx.messages.length).toBe(2);

    const synthErr = capturedCtx.messages[1] as any;
    expect(synthErr.role).toBe("toolResult");
    expect(synthErr.isError).toBe(true);
    expect(synthErr.toolName).toBe("exec");
    // "Validation failed" prefix → extractErrorTag → "validation_failed" → PARAMETER_VALIDATION_TAGS carve-out
    const textBlock = synthErr.content[0] as { type: string; text: string };
    expect(textBlock.text).toMatch(/^Validation failed:/);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ submodule: "tool-call-repair-wrapper", toolName: "exec" }),
      "Irreparable tool-call JSON — shape repair failed",
    );
  });

  it("function name is toolCallRepairWrapper (for wrapper chain logging)", () => {
    const wrapper = createToolCallRepairWrapper(FAIL_CLOSED_PROFILE, logger);
    expect(wrapper.name).toBe("toolCallRepairWrapper");
  });
});
