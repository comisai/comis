import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context, Message } from "@mariozechner/pi-ai";
import { createValidationErrorFormatter } from "./validation-error-formatter.js";
import { createMockLogger, createMockStreamFn, makeContext } from "./__test-helpers.js";

describe("createValidationErrorFormatter", () => {
  let logger: ReturnType<typeof createMockLogger>;
  let base: ReturnType<typeof createMockStreamFn>;

  beforeEach(() => {
    logger = createMockLogger();
    base = createMockStreamFn();
  });

  function makeErrorToolResult(
    toolName: string,
    text: string,
    toolCallId?: string,
  ): Message {
    return {
      role: "toolResult",
      toolCallId: toolCallId ?? `tc-${toolName}`,
      toolName,
      content: [{ type: "text", text }],
      isError: true,
      timestamp: Date.now(),
    };
  }

  function makeNonErrorToolResult(
    toolName: string,
    text: string,
  ): Message {
    return {
      role: "toolResult",
      toolCallId: `tc-${toolName}`,
      toolName,
      content: [{ type: "text", text }],
      isError: false,
      timestamp: Date.now(),
    };
  }

  it("reformats validation error in toolResult message", () => {
    const wrapper = createValidationErrorFormatter(logger);
    const wrappedFn = wrapper(base);

    const validationText = [
      'Validation failed for tool "edit":',
      "  - /file_path: must have required property 'file_path'",
      "",
      'Received arguments: {"wrong_param": "value"}',
    ].join("\n");

    const toolMsg = makeErrorToolResult("edit", validationText);
    const context = makeContext([toolMsg]);
    const model = {} as any;

    wrappedFn(model, context);

    const calledContext = base.mock.calls[0][1] as Context;
    const calledToolResult = calledContext.messages[0] as any;
    const resultText = calledToolResult.content[0].text;

    // Should be reformatted: no "Validation failed" header, no "Received arguments"
    expect(resultText).toContain("[edit]");
    expect(resultText).toContain("file_path");
    expect(resultText).not.toContain("Received arguments");
    expect(resultText).not.toContain("Validation failed for tool");

    // Should log at debug level
    expect(logger.debug).toHaveBeenCalledWith(
      { toolName: "edit" },
      "Validation error reformatted",
    );
  });

  it("passes through non-validation-error toolResult messages unchanged", () => {
    const wrapper = createValidationErrorFormatter(logger);
    const wrappedFn = wrapper(base);

    const nonValidationText = "Command failed: permission denied";
    const toolMsg = makeErrorToolResult("bash", nonValidationText);
    const context = makeContext([toolMsg]);
    const model = {} as any;

    wrappedFn(model, context);

    const calledContext = base.mock.calls[0][1] as Context;
    const calledToolResult = calledContext.messages[0] as any;

    // Text should be unchanged (not a validation error)
    expect(calledToolResult.content[0].text).toBe(nonValidationText);

    // Should NOT log reformatting
    expect(logger.debug).not.toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "bash" }),
      "Validation error reformatted",
    );
  });

  it("passes through non-toolResult messages unchanged", () => {
    const wrapper = createValidationErrorFormatter(logger);
    const wrappedFn = wrapper(base);

    const userMsg: Message = {
      role: "user",
      content: [{ type: "text", text: "Hello" }],
      timestamp: Date.now(),
    };
    const context = makeContext([userMsg]);
    const model = {} as any;

    wrappedFn(model, context);

    const calledContext = base.mock.calls[0][1] as Context;
    const calledMsg = calledContext.messages[0] as any;

    expect(calledMsg.role).toBe("user");
    expect(calledMsg.content[0].text).toBe("Hello");
  });

  it("passes through toolResult where isError is false unchanged", () => {
    const wrapper = createValidationErrorFormatter(logger);
    const wrappedFn = wrapper(base);

    // Even if the text looks like a validation error, isError=false means skip
    const validationText = [
      'Validation failed for tool "edit":',
      "  - /file_path: must have required property 'file_path'",
    ].join("\n");

    const toolMsg = makeNonErrorToolResult("edit", validationText);
    const context = makeContext([toolMsg]);
    const model = {} as any;

    wrappedFn(model, context);

    const calledContext = base.mock.calls[0][1] as Context;
    const calledToolResult = calledContext.messages[0] as any;

    // Should be unchanged since isError is false
    expect(calledToolResult.content[0].text).toBe(validationText);
  });

  it("calls next with modified context messages", () => {
    const wrapper = createValidationErrorFormatter(logger);
    const wrappedFn = wrapper(base);

    const validationText = [
      'Validation failed for tool "bash":',
      "  - /command: must have required property 'command'",
    ].join("\n");

    const toolMsg = makeErrorToolResult("bash", validationText);
    const userMsg: Message = {
      role: "user",
      content: [{ type: "text", text: "Run a command" }],
      timestamp: Date.now(),
    };
    const context = makeContext([userMsg, toolMsg]);
    const model = {} as any;
    const options = { maxTokens: 1000 };

    wrappedFn(model, context, options);

    // next was called
    expect(base).toHaveBeenCalledTimes(1);

    // model and options passed through
    expect(base.mock.calls[0][0]).toBe(model);
    expect(base.mock.calls[0][2]).toBe(options);

    // Context has modified messages array
    const calledContext = base.mock.calls[0][1] as Context;
    expect(calledContext.systemPrompt).toBe(context.systemPrompt);
    expect(calledContext.messages).toHaveLength(2);

    // User message unchanged
    expect((calledContext.messages[0] as any).content[0].text).toBe("Run a command");

    // Tool result reformatted
    const reformattedText = (calledContext.messages[1] as any).content[0].text;
    expect(reformattedText).toContain("[bash]");
    expect(reformattedText).not.toContain("Validation failed for tool");
  });
});

// ---------------------------------------------------------------------------
// CACHEABLE_BLOCK_TYPES
