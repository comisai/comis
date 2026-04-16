import { describe, it, expect, vi } from "vitest";
import { stripDiscoverySchemas } from "./schema-stripping.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal SessionManager mock with fileEntries and _rewriteFile(). */
function createMockSessionManager(entries: unknown[]) {
  return {
    fileEntries: entries,
    _rewriteFile: vi.fn(),
  };
}

/** Build a tool-result message entry (the shape found in SessionManager.fileEntries). */
function toolResultEntry(
  toolName: string,
  text: string,
  toolCallId = "tc_1",
) {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolName,
      toolCallId,
      content: [{ type: "text", text }],
    },
  };
}

/** Build a <functions> block with the given tool definitions. */
function functionsBlock(tools: Array<{ name: string; description?: string; parameters?: unknown }>) {
  const inner = tools
    .map((t) => `<function>${JSON.stringify(t)}</function>`)
    .join("\n");
  return `<functions>\n${inner}\n</functions>`;
}

// ---------------------------------------------------------------------------
// stripDiscoverySchemas
// ---------------------------------------------------------------------------

describe("stripDiscoverySchemas", () => {
  // ----- Core stripping behavior -----

  it("replaces <functions> block in discover_tools result with compact summary", () => {
    const text = functionsBlock([
      { name: "bash", description: "Run commands", parameters: { type: "object" } },
      { name: "file_read", description: "Read files", parameters: { type: "object" } },
    ]);
    const sm = createMockSessionManager([toolResultEntry("discover_tools", text)]);

    stripDiscoverySchemas(sm);

    const msg = (sm.fileEntries[0] as any).message;
    expect(msg.content).toEqual([
      { type: "text", text: "[Discovery loaded: 2 tool(s) are now callable]\n- bash\n- file_read" },
    ]);
  });

  it("calls _rewriteFile() exactly once when entries are mutated", () => {
    const text1 = functionsBlock([{ name: "tool_a" }]);
    const text2 = functionsBlock([{ name: "tool_b" }, { name: "tool_c" }]);
    const sm = createMockSessionManager([
      toolResultEntry("discover_tools", text1, "tc_1"),
      toolResultEntry("discover_tools", text2, "tc_2"),
    ]);

    stripDiscoverySchemas(sm);

    expect(sm._rewriteFile).toHaveBeenCalledTimes(1);
  });

  it("does NOT call _rewriteFile() when no entries need stripping", () => {
    const sm = createMockSessionManager([
      toolResultEntry("some_other_tool", "irrelevant content"),
    ]);

    stripDiscoverySchemas(sm);

    expect(sm._rewriteFile).not.toHaveBeenCalled();
  });

  // ----- Already-stripped guard -----

  it("does not double-process entries already prefixed with [Discovery loaded:", () => {
    const alreadyStripped = "[Discovery loaded: 2 tool(s) are now callable]\n- bash\n- file_read";
    const sm = createMockSessionManager([
      toolResultEntry("discover_tools", alreadyStripped),
    ]);

    stripDiscoverySchemas(sm);

    const msg = (sm.fileEntries[0] as any).message;
    expect(msg.content[0].text).toBe(alreadyStripped);
    expect(sm._rewriteFile).not.toHaveBeenCalled();
  });

  // ----- No-match results -----

  it("leaves discover_tools results without <functions> block unchanged", () => {
    const noMatch = "No matching tools found. Try different keywords.";
    const sm = createMockSessionManager([
      toolResultEntry("discover_tools", noMatch),
    ]);

    stripDiscoverySchemas(sm);

    const msg = (sm.fileEntries[0] as any).message;
    expect(msg.content[0].text).toBe(noMatch);
    expect(sm._rewriteFile).not.toHaveBeenCalled();
  });

  // ----- Non-discover_tools entries -----

  it("skips entries with toolName other than discover_tools", () => {
    const text = functionsBlock([{ name: "bash" }]);
    const sm = createMockSessionManager([
      toolResultEntry("some_tool", text),
    ]);

    stripDiscoverySchemas(sm);

    const msg = (sm.fileEntries[0] as any).message;
    expect(msg.content[0].text).toBe(text);
    expect(sm._rewriteFile).not.toHaveBeenCalled();
  });

  // ----- Non-message entries -----

  it("skips non-message entries entirely", () => {
    const sm = createMockSessionManager([
      { type: "summary", content: "some summary" },
      { type: "toolCall", message: { role: "assistant" } },
    ]);

    stripDiscoverySchemas(sm);

    expect(sm._rewriteFile).not.toHaveBeenCalled();
  });

  // ----- Edge: empty fileEntries -----

  it("handles empty fileEntries array gracefully", () => {
    const sm = createMockSessionManager([]);

    stripDiscoverySchemas(sm);

    expect(sm._rewriteFile).not.toHaveBeenCalled();
  });

  // ----- Edge: fileEntries not an array -----

  it("handles non-array fileEntries gracefully", () => {
    const sm = { fileEntries: undefined, _rewriteFile: vi.fn() };

    stripDiscoverySchemas(sm);

    expect(sm._rewriteFile).not.toHaveBeenCalled();
  });

  // ----- Edge: malformed JSON in <function> tags -----

  it("skips malformed JSON entries inside <function> tags without throwing", () => {
    const text = "<functions>\n<function>not valid json</function>\n<function>{\"name\":\"bash\"}</function>\n</functions>";
    const sm = createMockSessionManager([
      toolResultEntry("discover_tools", text),
    ]);

    stripDiscoverySchemas(sm);

    const msg = (sm.fileEntries[0] as any).message;
    expect(msg.content[0].text).toBe(
      "[Discovery loaded: 1 tool(s) are now callable]\n- bash",
    );
  });

  // ----- Edge: <function> entry missing "name" field -----

  it("skips <function> entries with missing name field", () => {
    const text = "<functions>\n<function>{\"description\":\"no name\"}</function>\n<function>{\"name\":\"valid_tool\"}</function>\n</functions>";
    const sm = createMockSessionManager([
      toolResultEntry("discover_tools", text),
    ]);

    stripDiscoverySchemas(sm);

    const msg = (sm.fileEntries[0] as any).message;
    expect(msg.content[0].text).toBe(
      "[Discovery loaded: 1 tool(s) are now callable]\n- valid_tool",
    );
  });

  // ----- Edge: all <function> entries malformed -> 0 names -----

  it("does not strip when all <function> entries yield zero names", () => {
    const text = "<functions>\n<function>bad json</function>\n<function>{\"no_name\":true}</function>\n</functions>";
    const sm = createMockSessionManager([
      toolResultEntry("discover_tools", text),
    ]);

    stripDiscoverySchemas(sm);

    // Content left unchanged because names.length === 0
    const msg = (sm.fileEntries[0] as any).message;
    expect(msg.content[0].text).toBe(text);
    expect(sm._rewriteFile).not.toHaveBeenCalled();
  });

  // ----- Edge: content not text type -----

  it("skips entries where first content block is not text type", () => {
    const sm = createMockSessionManager([
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "discover_tools",
          toolCallId: "tc_1",
          content: [{ type: "image", data: "..." }],
        },
      },
    ]);

    stripDiscoverySchemas(sm);

    expect(sm._rewriteFile).not.toHaveBeenCalled();
  });

  // ----- Edge: empty content array -----

  it("skips entries with empty content array", () => {
    const sm = createMockSessionManager([
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "discover_tools",
          toolCallId: "tc_1",
          content: [],
        },
      },
    ]);

    stripDiscoverySchemas(sm);

    expect(sm._rewriteFile).not.toHaveBeenCalled();
  });

  // ----- Logger output -----

  it("logs strippedCount and totalCharsSaved at DEBUG level when stripping occurs", () => {
    const text = functionsBlock([
      { name: "bash", description: "Run commands", parameters: { type: "object" } },
    ]);
    const sm = createMockSessionManager([toolResultEntry("discover_tools", text)]);
    const logger = { debug: vi.fn() };

    stripDiscoverySchemas(sm, logger);

    expect(logger.debug).toHaveBeenCalledTimes(1);
    const [obj, msg] = logger.debug.mock.calls[0];
    expect(obj.strippedCount).toBe(1);
    expect(obj.totalCharsSaved).toBeGreaterThan(0);
    expect(msg).toBe("Discovery schemas stripped from session history");
  });

  it("does not log when nothing was stripped", () => {
    const sm = createMockSessionManager([]);
    const logger = { debug: vi.fn() };

    stripDiscoverySchemas(sm, logger);

    expect(logger.debug).not.toHaveBeenCalled();
  });

  // ----- Mixed scenario -----

  it("strips only discover_tools entries with <functions> in a mixed list", () => {
    const strippableText = functionsBlock([{ name: "tool_x" }, { name: "tool_y" }]);
    const noMatchText = "No matching tools found.";
    const alreadyStripped = "[Discovery loaded: 1 tool(s) are now callable]\n- old_tool";
    const otherToolText = functionsBlock([{ name: "irrelevant" }]);

    const sm = createMockSessionManager([
      toolResultEntry("discover_tools", strippableText, "tc_1"),
      toolResultEntry("discover_tools", noMatchText, "tc_2"),
      toolResultEntry("discover_tools", alreadyStripped, "tc_3"),
      toolResultEntry("other_tool", otherToolText, "tc_4"),
      { type: "summary", content: "some summary" },
    ]);

    stripDiscoverySchemas(sm);

    // Only tc_1 should be stripped
    const msg1 = (sm.fileEntries[0] as any).message;
    expect(msg1.content[0].text).toBe(
      "[Discovery loaded: 2 tool(s) are now callable]\n- tool_x\n- tool_y",
    );

    // tc_2 unchanged (no <functions>)
    const msg2 = (sm.fileEntries[1] as any).message;
    expect(msg2.content[0].text).toBe(noMatchText);

    // tc_3 unchanged (already stripped)
    const msg3 = (sm.fileEntries[2] as any).message;
    expect(msg3.content[0].text).toBe(alreadyStripped);

    // tc_4 unchanged (different toolName)
    const msg4 = (sm.fileEntries[3] as any).message;
    expect(msg4.content[0].text).toBe(otherToolText);

    expect(sm._rewriteFile).toHaveBeenCalledTimes(1);
  });

  // ----- Single tool -----

  it("formats single tool discovery correctly", () => {
    const text = functionsBlock([{ name: "single_tool" }]);
    const sm = createMockSessionManager([toolResultEntry("discover_tools", text)]);

    stripDiscoverySchemas(sm);

    const msg = (sm.fileEntries[0] as any).message;
    expect(msg.content[0].text).toBe(
      "[Discovery loaded: 1 tool(s) are now callable]\n- single_tool",
    );
  });

  // ----- _rewriteFile not a function (defensive) -----

  it("handles missing _rewriteFile gracefully", () => {
    const text = functionsBlock([{ name: "bash" }]);
    const sm = {
      fileEntries: [toolResultEntry("discover_tools", text)],
      _rewriteFile: "not a function",
    };

    // Should not throw
    expect(() => stripDiscoverySchemas(sm)).not.toThrow();
  });
});
