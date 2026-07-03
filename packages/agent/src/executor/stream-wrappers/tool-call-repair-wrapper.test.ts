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

  it("adversarial input: repairs shape but preserves malicious value unchanged", () => {
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

  it("irreparable branch replaces the assistant block's string args with an empty object (well-formed)", () => {
    const wrapper = createToolCallRepairWrapper(FAIL_CLOSED_PROFILE, logger);
    const wrappedFn = wrapper(base);

    const toolCall = makeToolCall("exec", "not json at all <<<" as any);
    const assistantMsg = makeAssistantMessage([toolCall]);
    const ctx = makeContext([assistantMsg]);

    wrappedFn({} as any, ctx, {} as any);

    const capturedCtx = (base as any).mock.calls[0][1] as { messages: Message[] };
    const outAssistant = capturedCtx.messages[0] as typeof assistantMsg;
    const outBlock = outAssistant.content[0] as typeof toolCall;
    // The string args MUST be replaced with a parsed object so the provider
    // serializer never receives a raw string for ToolCall.arguments.
    expect(typeof outBlock.arguments).toBe("object");
    expect(outBlock.arguments).toEqual({});
  });

  it("idempotency: a second pass over the wrapper output injects NO duplicate synthetic toolResult", () => {
    const wrapper = createToolCallRepairWrapper(FAIL_CLOSED_PROFILE, logger);

    const toolCall = makeToolCall("exec", "not json at all <<<" as any);
    const assistantMsg = makeAssistantMessage([toolCall]);

    // First pass: produces assistant(sanitized args) + 1 synthetic toolResult.
    const firstBase = createMockStreamFn();
    wrapper(firstBase)({} as any, makeContext([assistantMsg]), {} as any);
    const firstOut = (firstBase as any).mock.calls[0][1] as { messages: Message[] };
    const firstSynthCount = firstOut.messages.filter(
      (m) => m.role === "toolResult",
    ).length;
    expect(firstSynthCount).toBe(1);

    // Second pass: feed the FIRST pass output back through a fresh wrapper.
    const secondBase = createMockStreamFn();
    wrapper(secondBase)({} as any, makeContext(firstOut.messages), {} as any);
    const secondOut = (secondBase as any).mock.calls[0][1] as { messages: Message[] };

    // Still exactly ONE synthetic toolResult — no duplication, no context growth.
    const secondSynthCount = secondOut.messages.filter(
      (m) => m.role === "toolResult",
    ).length;
    expect(secondSynthCount).toBe(1);
    expect(secondOut.messages.length).toBe(firstOut.messages.length);
  });

  it("de-dup: irreparable args with a pre-existing toolResult for that id inject NO new synthetic result", () => {
    const wrapper = createToolCallRepairWrapper(FAIL_CLOSED_PROFILE, logger);
    const wrappedFn = wrapper(base);

    const toolCall = makeToolCall("exec", "still not json <<<" as any, "tc-dup");
    const assistantMsg = makeAssistantMessage([toolCall]);
    // A toolResult for tc-dup already exists in history.
    const existingResult: Message = {
      role: "toolResult",
      toolCallId: "tc-dup",
      toolName: "exec",
      isError: true,
      content: [{ type: "text", text: "Validation failed: prior attempt" }],
      timestamp: 0,
    } as any;
    const ctx = makeContext([assistantMsg, existingResult]);

    wrappedFn({} as any, ctx, {} as any);

    const capturedCtx = (base as any).mock.calls[0][1] as { messages: Message[] };
    const toolResults = capturedCtx.messages.filter((m) => m.role === "toolResult");
    // Only the pre-existing toolResult remains — no second one was injected.
    expect(toolResults.length).toBe(1);
  });

  it("function name is toolCallRepairWrapper (for wrapper chain logging)", () => {
    const wrapper = createToolCallRepairWrapper(FAIL_CLOSED_PROFILE, logger);
    expect(wrapper.name).toBe("toolCallRepairWrapper");
  });

  // Legit empty-args string '{}' MUST NOT be flagged irreparable
  it("legit empty-args string '{}' passes through as parsed {} (NOT flagged irreparable)", () => {
    const wrapper = createToolCallRepairWrapper(FAIL_CLOSED_PROFILE, logger);
    const wrappedFn = wrapper(base);

    const toolCall = makeToolCall("no_args", "{}" as any);
    const assistantMsg = makeAssistantMessage([toolCall]);
    const ctx = makeContext([assistantMsg]);

    wrappedFn({} as any, ctx, {} as any);

    const capturedCtx = (base as any).mock.calls[0][1] as { messages: Message[] };
    // Must be exactly 1 message — no synthetic toolResult injected
    expect(capturedCtx.messages.length).toBe(1);
    const outMsg = capturedCtx.messages[0] as typeof assistantMsg;
    const outBlock = outMsg.content[0] as typeof toolCall;
    // Parsed result of "{}" is {}
    expect(outBlock.arguments).toEqual({});
    // No synthetic error path — warn must NOT have been called
    expect(logger.warn).not.toHaveBeenCalled();
  });

  // Empty string rawArgs MUST NOT be flagged irreparable
  it("empty string rawArgs passes through as parsed {} (NOT flagged irreparable)", () => {
    const wrapper = createToolCallRepairWrapper(FAIL_CLOSED_PROFILE, logger);
    const wrappedFn = wrapper(base);

    const toolCall = makeToolCall("no_args", "" as any);
    const assistantMsg = makeAssistantMessage([toolCall]);
    const ctx = makeContext([assistantMsg]);

    wrappedFn({} as any, ctx, {} as any);

    const capturedCtx = (base as any).mock.calls[0][1] as { messages: Message[] };
    // Must be exactly 1 message — no synthetic toolResult injected
    expect(capturedCtx.messages.length).toBe(1);
    const outMsg = capturedCtx.messages[0] as typeof assistantMsg;
    const outBlock = outMsg.content[0] as typeof toolCall;
    // parseStreamingJson("") returns {}
    expect(outBlock.arguments).toEqual({});
    // No synthetic error path — warn must NOT have been called
    expect(logger.warn).not.toHaveBeenCalled();
  });

  // Valid JSON string MUST be parsed to the same object as JSON.parse (byte-identical)
  it("valid JSON string arg parsed to object byte-identical to JSON.parse", () => {
    const wrapper = createToolCallRepairWrapper(FAIL_CLOSED_PROFILE, logger);
    const wrappedFn = wrapper(base);

    const toolCall = makeToolCall("exec", '{"command":"ls"}' as any);
    const assistantMsg = makeAssistantMessage([toolCall]);
    const ctx = makeContext([assistantMsg]);

    wrappedFn({} as any, ctx, {} as any);

    const capturedCtx = (base as any).mock.calls[0][1] as { messages: Message[] };
    // Must be exactly 1 message — no synthetic toolResult injected
    expect(capturedCtx.messages.length).toBe(1);
    const outMsg = capturedCtx.messages[0] as typeof assistantMsg;
    const outBlock = outMsg.content[0] as typeof toolCall;
    // Result must equal JSON.parse('{"command":"ls"}')
    expect(outBlock.arguments).toEqual({ command: "ls" });
    // No synthetic error path — warn must NOT have been called
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
