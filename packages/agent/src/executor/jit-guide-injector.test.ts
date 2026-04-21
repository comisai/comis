// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from "vitest";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { registerToolMetadata } from "@comis/core";
import {
  wrapToolResultWithGuide,
  createJitGuideWrapper,
} from "./jit-guide-injector.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Test helpers
/**
 * Create a mock tool result matching AgentToolResult<unknown> shape.
 * The isError field is a runtime extension (not in AgentToolResult type)
 * but added by some tool implementations and the agent-loop.
 */
function makeToolResult(text: string, isError = false): AgentToolResult<unknown> {
  return {
    content: [{ type: "text" as const, text }],
    details: undefined,
    ...(isError ? { isError: true } : {}),
  } as AgentToolResult<unknown>;
}

// ---------------------------------------------------------------------------
// wrapToolResultWithGuide (TOOL_GUIDES)
// ---------------------------------------------------------------------------

describe("wrapToolResultWithGuide", () => {
  it("injects guide on first use of a guided tool", () => {
    const logger = createMockLogger();
    const delivered = new Set<string>();
    const result = makeToolResult("Agent created successfully");

    const wrapped = wrapToolResultWithGuide("agents_manage", result, delivered, logger);

    expect(wrapped.content).toHaveLength(2);
    expect((wrapped.content[1] as { text: string }).text).toContain("[Tool Guide - shown once per session]");
    expect((wrapped.content[1] as { text: string }).text).toContain("Workspace Customization Guide");
    // Also includes privileged tools section guide (agents_manage is privileged)
    expect((wrapped.content[1] as { text: string }).text).toContain("Privileged Tools");
    expect(delivered.has("agents_manage")).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "agents_manage", guideSize: expect.any(Number) }),
      "JIT guide injected",
    );
  });

  it("does not re-inject on second use", () => {
    const logger = createMockLogger();
    const delivered = new Set<string>();
    const result = makeToolResult("Agent created");

    // First call -- injects
    wrapToolResultWithGuide("agents_manage", result, delivered, logger);

    // Second call -- should not inject
    const secondResult = makeToolResult("Agent updated");
    const wrapped = wrapToolResultWithGuide("agents_manage", secondResult, delivered, logger);

    expect(wrapped.content).toHaveLength(1);
    expect((wrapped.content[0] as { text: string }).text).toBe("Agent updated");
    expect(logger.info).toHaveBeenCalledTimes(1); // Only first call logged
  });

  it("does not inject for unguided tools", () => {
    const logger = createMockLogger();
    const delivered = new Set<string>();
    const result = makeToolResult("File contents here");

    const wrapped = wrapToolResultWithGuide("ls", result, delivered, logger);

    expect(wrapped).toBe(result); // Exact same reference
    expect(wrapped.content).toHaveLength(1);
    expect(delivered.size).toBe(0);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("does NOT mark tool as delivered on error results (so a retry can still fire)", () => {
    // Previously this function consumed the delivery slot even on error,
    // which silently swallowed guides for any tool whose first call failed
    // (validation errors, approval-required, etc.). The NVDA team-agent
    // session hit this: first agents_manage call validation-errored on a
    // stringified config, consumed the slot, subsequent successful creates
    // never got the Workspace Customization Guide. Fix: leave deliveredGuides
    // untouched on error so the next call has another chance.
    const logger = createMockLogger();
    const delivered = new Set<string>();
    const result = makeToolResult("Agent creation failed", true);

    const wrapped = wrapToolResultWithGuide("agents_manage", result, delivered, logger);

    // No guide injected on error
    expect(wrapped.content).toHaveLength(1);
    expect((wrapped.content[0] as { text: string }).text).toBe("Agent creation failed");
    // Tool NOT marked as delivered -- a subsequent successful call can still fire.
    expect(delivered.has("agents_manage")).toBe(false);
    // No INFO log on skipped injection
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("clears and re-delivers after Set.clear()", () => {
    const logger = createMockLogger();
    const delivered = new Set<string>();
    const result = makeToolResult("Pipeline defined");

    // First delivery
    const first = wrapToolResultWithGuide("pipeline", result, delivered, logger);
    expect(first.content).toHaveLength(2);
    expect((first.content[1] as { text: string }).text).toContain("Pipeline Usage Guide");

    // Clear (simulates session reset)
    delivered.clear();

    // Re-delivery
    const second = wrapToolResultWithGuide("pipeline", result, delivered, logger);
    expect(second.content).toHaveLength(2);
    expect((second.content[1] as { text: string }).text).toContain("Pipeline Usage Guide");
    expect(logger.info).toHaveBeenCalledTimes(2);
  });

  it("appends to existing content array", () => {
    const logger = createMockLogger();
    const delivered = new Set<string>();
    const result: AgentToolResult<unknown> = {
      content: [
        { type: "text" as const, text: "First block" },
        { type: "text" as const, text: "Second block" },
      ],
      details: undefined,
    };

    const wrapped = wrapToolResultWithGuide("gateway", result, delivered, logger);

    expect(wrapped.content).toHaveLength(3);
    expect((wrapped.content[0] as { text: string }).text).toBe("First block");
    expect((wrapped.content[1] as { text: string }).text).toBe("Second block");
    // Gateway has both TOOL_GUIDES and SYSTEM_PROMPT_GUIDES entries
    expect((wrapped.content[2] as { text: string }).text).toContain("Gateway Security");
    expect((wrapped.content[2] as { text: string }).text).toContain("Confirmation Protocol");
  });

  it("injects guide for grep on first use", () => {
    const logger = createMockLogger();
    const delivered = new Set<string>();
    const result = makeToolResult("3 matches found");

    const wrapped = wrapToolResultWithGuide("grep", result, delivered, logger);

    // grep now has a TOOL_GUIDES entry ( file tool adoptions)
    expect(wrapped.content).toHaveLength(2);
    expect((wrapped.content[1] as { text: string }).text).toContain("Grep Guide");
    expect(delivered.has("grep")).toBe(true);
  });

  it("injects guide for edit on first use", () => {
    const logger = createMockLogger();
    const delivered = new Set<string>();
    const result = makeToolResult("File edited");

    const wrapped = wrapToolResultWithGuide("edit", result, delivered, logger);

    // edit now has a TOOL_GUIDES entry ( file tool adoptions)
    expect(wrapped.content).toHaveLength(2);
    expect((wrapped.content[1] as { text: string }).text).toContain("Edit Guide");
    expect(delivered.has("edit")).toBe(true);
  });

  it("injects guide on first use of message", () => {
    const logger = createMockLogger();
    const delivered = new Set<string>();
    const result = makeToolResult("Message sent");

    const wrapped = wrapToolResultWithGuide("message", result, delivered, logger);

    expect(wrapped.content).toHaveLength(2);
    const guideText = (wrapped.content[1] as { text: string }).text;
    expect(guideText).toContain("Message Guide");
    expect(guideText).toContain("channel_id");
    expect(guideText).toContain("Cross-channel messaging is a safety boundary");
    expect(delivered.has("message")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SYSTEM_PROMPT_GUIDES delivery
// ---------------------------------------------------------------------------

describe("wrapToolResultWithGuide -- SYSTEM_PROMPT_GUIDES", () => {
  it("injects system prompt guide for sessions_spawn (Task Delegation)", () => {
    const logger = createMockLogger();
    const delivered = new Set<string>();
    const result = makeToolResult("Sub-agent spawned");

    const wrapped = wrapToolResultWithGuide("sessions_spawn", result, delivered, logger);

    expect(wrapped.content).toHaveLength(2);
    const guideText = (wrapped.content[1] as { text: string }).text;
    // sessions_spawn has both a TOOL_GUIDE (workspace isolation) and SYSTEM_PROMPT_GUIDE (task delegation)
    expect(guideText).toContain("Sub-Agent Workspace Isolation");
    expect(guideText).toContain("Task Delegation");
    expect(guideText).toContain("MUST delegate");
    expect(delivered.has("section:sessions_spawn")).toBe(true);
  });

  it("injects system prompt guide for gateway (Confirmation Protocol)", () => {
    const logger = createMockLogger();
    const delivered = new Set<string>();
    const result = makeToolResult("Config patched");

    const wrapped = wrapToolResultWithGuide("gateway", result, delivered, logger);

    expect(wrapped.content).toHaveLength(2);
    const guideText = (wrapped.content[1] as { text: string }).text;
    // Gateway has both TOOL_GUIDE and SYSTEM_PROMPT_GUIDE
    expect(guideText).toContain("Gateway Security");
    expect(guideText).toContain("Confirmation Protocol");
    expect(guideText).toContain("_confirmed: true");
    expect(delivered.has("section:gateway")).toBe(true);
  });

  it("injects both TOOL_GUIDE and system prompt guide for exec", () => {
    const logger = createMockLogger();
    const delivered = new Set<string>();
    const result = makeToolResult("Command output");

    const wrapped = wrapToolResultWithGuide("exec", result, delivered, logger);

    // exec now has BOTH a TOOL_GUIDE (anti-pattern redirections) and SYSTEM_PROMPT_GUIDE (coding fallback)
    expect(wrapped.content).toHaveLength(2);
    const guideText = (wrapped.content[1] as { text: string }).text;
    // TOOL_GUIDES["exec"] content: anti-pattern redirections
    expect(guideText).toContain("Exec Guide");
    expect(guideText).toContain("dedicated tools");
    // SYSTEM_PROMPT_GUIDES["exec"] content: coding fallback
    expect(guideText).toContain("Coding & Execution Fallback");
    expect(guideText).toContain("headless");
    // Both tracked
    expect(delivered.has("exec")).toBe(true);
    expect(delivered.has("section:exec")).toBe(true);
  });

  it("injects privileged tools guide on first privileged tool use", () => {
    const logger = createMockLogger();
    const delivered = new Set<string>();
    const result = makeToolResult("Agent data");

    const wrapped = wrapToolResultWithGuide("agents_manage", result, delivered, logger);

    expect(wrapped.content).toHaveLength(2);
    const guideText = (wrapped.content[1] as { text: string }).text;
    expect(guideText).toContain("Privileged Tools & Approval Gate");
    expect(guideText).toContain("Fleet Management Patterns");
    expect(delivered.has("section:privileged")).toBe(true);
  });

  it("does not re-inject privileged tools guide on second privileged tool", () => {
    const logger = createMockLogger();
    const delivered = new Set<string>();

    // First privileged tool use
    wrapToolResultWithGuide("agents_manage", makeToolResult("Agent data"), delivered, logger);
    expect(delivered.has("section:privileged")).toBe(true);

    // Second privileged tool use -- should NOT get privileged section again
    const secondResult = wrapToolResultWithGuide("obs_query", makeToolResult("Diagnostics"), delivered, logger);

    // obs_query has no TOOL_GUIDE and privileged section already delivered
    expect(secondResult.content).toHaveLength(1);
    expect((secondResult.content[0] as { text: string }).text).toBe("Diagnostics");
  });

  it("injects both TOOL_GUIDES and SYSTEM_PROMPT_GUIDES for a tool that has both", () => {
    const logger = createMockLogger();
    const delivered = new Set<string>();
    const result = makeToolResult("Config read");

    const wrapped = wrapToolResultWithGuide("gateway", result, delivered, logger);

    expect(wrapped.content).toHaveLength(2);
    const guideText = (wrapped.content[1] as { text: string }).text;
    // TOOL_GUIDES["gateway"] content
    expect(guideText).toContain("Gateway Security");
    // SYSTEM_PROMPT_GUIDES["gateway"] content
    expect(guideText).toContain("Self-Update & Configuration");
    expect(guideText).toContain("Confirmation Protocol");
    // Both delivered
    expect(delivered.has("gateway")).toBe(true);
    expect(delivered.has("section:gateway")).toBe(true);
  });

  it("does not inject guides on second use of exec (only delivers once)", () => {
    const logger = createMockLogger();
    const delivered = new Set<string>();

    // First call injects both TOOL_GUIDE (anti-pattern) and SYSTEM_PROMPT_GUIDE (coding fallback)
    const first = wrapToolResultWithGuide("exec", makeToolResult("Output 1"), delivered, logger);
    expect(first.content).toHaveLength(2);
    expect(delivered.has("exec")).toBe(true);
    expect(delivered.has("section:exec")).toBe(true);

    // Second call -- no guides (both tool guide and section guide already delivered)
    const second = wrapToolResultWithGuide("exec", makeToolResult("Output 2"), delivered, logger);
    expect(second.content).toHaveLength(1);
    expect((second.content[0] as { text: string }).text).toBe("Output 2");
  });
});

// ---------------------------------------------------------------------------
// createJitGuideWrapper
// ---------------------------------------------------------------------------

describe("createJitGuideWrapper", () => {
  it("wraps tool execute to inject guide", async () => {
    const logger = createMockLogger();
    const delivered = new Set<string>();

    const mockTool = {
      name: "pipeline",
      label: "Pipeline",
      description: "Pipeline tool",
      parameters: {},
      execute: vi.fn().mockResolvedValue(makeToolResult("Graph executed")),
    } as unknown as ToolDefinition;

    const [wrapped] = createJitGuideWrapper([mockTool], delivered, logger);

    const result = await wrapped.execute("call-1", {}, undefined, undefined, undefined as any);

    expect(mockTool.execute).toHaveBeenCalledWith("call-1", {}, undefined, undefined, undefined);
    expect(result.content).toHaveLength(2);
    expect((result.content[1] as { text: string }).text).toContain("Pipeline Usage Guide");
  });

  it("passes through non-guided tools unchanged", async () => {
    const logger = createMockLogger();
    const delivered = new Set<string>();
    const originalResult = makeToolResult("Directory listed");

    const mockTool = {
      name: "ls",
      label: "Ls",
      description: "List directory",
      parameters: {},
      execute: vi.fn().mockResolvedValue(originalResult),
    } as unknown as ToolDefinition;

    const [wrapped] = createJitGuideWrapper([mockTool], delivered, logger);

    const result = await wrapped.execute("call-1", {}, undefined, undefined, undefined as any);

    expect(result.content).toHaveLength(1);
    expect((result.content[0] as { text: string }).text).toBe("Directory listed");
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("preserves all tool properties except execute", () => {
    const logger = createMockLogger();
    const delivered = new Set<string>();

    const mockTool = {
      name: "sessions_spawn",
      label: "Sessions Spawn",
      description: "Spawn sub-agent",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(),
    } as unknown as ToolDefinition;

    const [wrapped] = createJitGuideWrapper([mockTool], delivered, logger);

    expect(wrapped.name).toBe("sessions_spawn");
    expect(wrapped.description).toBe("Spawn sub-agent");
    expect(wrapped.parameters).toEqual({ type: "object", properties: {} });
    expect(wrapped.execute).not.toBe(mockTool.execute); // Wrapped
  });
});

// ---------------------------------------------------------------------------
// wrapToolResultWithGuide -- output schema injection
// ---------------------------------------------------------------------------

describe("wrapToolResultWithGuide -- output schema injection", () => {
  // Track registered test tool names for cleanup
  const registeredTools: string[] = [];

  function registerTestSchema(toolName: string, outputSchema: Record<string, unknown>): void {
    registerToolMetadata(toolName, { outputSchema });
    registeredTools.push(toolName);
  }

  afterEach(() => {
    // Overwrite test schemas to prevent cross-test leakage
    for (const name of registeredTools) {
      registerToolMetadata(name, { outputSchema: undefined });
    }
    registeredTools.length = 0;
  });

  it("injects schema-only guide for tool with outputSchema but no TOOL_GUIDES entry", () => {
    const logger = createMockLogger();
    const delivered = new Set<string>();
    const result = makeToolResult("Sessions listed");

    // sessions_list has no TOOL_GUIDES entry but we register an outputSchema
    registerTestSchema("sessions_list", {
      type: "object",
      description: "Test schema",
      properties: { total: { type: "number" } },
    });

    const wrapped = wrapToolResultWithGuide("sessions_list", result, delivered, logger);

    expect(wrapped.content).toHaveLength(2);
    const guideText = (wrapped.content[1] as { text: string }).text;
    expect(guideText).toContain("Output Schema");
    expect(guideText).toContain("```json");
    expect(guideText).toContain('"total"');
    expect(delivered.has("sessions_list")).toBe(true);
  });

  it("injects combined guide + schema for tool with both TOOL_GUIDES and outputSchema", () => {
    const logger = createMockLogger();
    const delivered = new Set<string>();
    const result = makeToolResult("command output");

    // exec has a TOOL_GUIDES entry; register an outputSchema for it
    registerTestSchema("exec", {
      type: "string",
      description: "Command output text",
    });

    const wrapped = wrapToolResultWithGuide("exec", result, delivered, logger);

    expect(wrapped.content).toHaveLength(2);
    const guideText = (wrapped.content[1] as { text: string }).text;
    // From TOOL_GUIDES
    expect(guideText).toContain("Exec Guide");
    // From outputSchema
    expect(guideText).toContain("Output Schema");
    expect(guideText).toContain("Command output text");
  });

  it("does not inject for tool with no guide and no schema", () => {
    const logger = createMockLogger();
    const delivered = new Set<string>();
    const result = makeToolResult("Directory listed");

    // "ls" has neither TOOL_GUIDES nor outputSchema
    const wrapped = wrapToolResultWithGuide("ls", result, delivered, logger);

    expect(wrapped).toBe(result); // Exact same reference
    expect(delivered.size).toBe(0);
  });

  it("delivers schema-only guide exactly once per session", () => {
    const logger = createMockLogger();
    const delivered = new Set<string>();

    registerTestSchema("find", {
      type: "string",
      description: "Find output",
    });

    // First call: guide injected
    const first = wrapToolResultWithGuide("find", makeToolResult("file1.ts"), delivered, logger);
    expect(first.content).toHaveLength(2);
    expect((first.content[1] as { text: string }).text).toContain("Output Schema");

    // Second call: no guide (already delivered)
    const second = wrapToolResultWithGuide("find", makeToolResult("file2.ts"), delivered, logger);
    expect(second.content).toHaveLength(1);
    expect((second.content[0] as { text: string }).text).toBe("file2.ts");

    // Simulate session reset
    delivered.clear();

    // Third call: guide injected again
    const third = wrapToolResultWithGuide("find", makeToolResult("file3.ts"), delivered, logger);
    expect(third.content).toHaveLength(2);
    expect((third.content[1] as { text: string }).text).toContain("Output Schema");
  });

  it("does not inject schema guide on error results", () => {
    const logger = createMockLogger();
    const delivered = new Set<string>();

    registerTestSchema("memory_search", {
      type: "object",
      description: "Search results",
      properties: { results: { type: "array" } },
    });

    const wrapped = wrapToolResultWithGuide(
      "memory_search",
      makeToolResult("Search failed", true),
      delivered,
      logger,
    );

    // No guide injected on error
    expect(wrapped.content).toHaveLength(1);
    // Tool NOT marked as delivered -- preserves the slot for a retry.
    expect(delivered.has("memory_search")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Regression coverage for the two bugs identified by the NVDA team-agent run
// (COMIS-JIT-GUIDE-DEFERRED-TOOLS-BUG.md).
// ---------------------------------------------------------------------------

describe("regression: isError does not consume the delivery slot", () => {
  it("first call errored -> retry fires the tool guide", () => {
    const logger = createMockLogger();
    const delivered = new Set<string>();

    // Attempt 1: validation error (e.g. stringified config rejected).
    const firstTry = wrapToolResultWithGuide(
      "agents_manage",
      makeToolResult("validation error", true),
      delivered,
      logger,
    );
    expect(firstTry.content).toHaveLength(1);                       // no guide appended
    expect(delivered.has("agents_manage")).toBe(false);             // slot preserved
    expect(logger.info).not.toHaveBeenCalled();

    // Attempt 2: same tool succeeds -> guide fires now.
    const secondTry = wrapToolResultWithGuide(
      "agents_manage",
      makeToolResult("Agent created"),
      delivered,
      logger,
    );
    expect(secondTry.content).toHaveLength(2);
    expect((secondTry.content[1] as { text: string }).text).toContain("Workspace Customization Guide");
    expect(delivered.has("agents_manage")).toBe(true);
    expect(logger.info).toHaveBeenCalledOnce();
  });

  it("successful call stays one-shot (second success does not re-fire)", () => {
    const logger = createMockLogger();
    const delivered = new Set<string>();

    const first = wrapToolResultWithGuide(
      "agents_manage",
      makeToolResult("Agent created"),
      delivered,
      logger,
    );
    expect(first.content).toHaveLength(2);
    expect(logger.info).toHaveBeenCalledOnce();

    const second = wrapToolResultWithGuide(
      "agents_manage",
      makeToolResult("Another agent created"),
      delivered,
      logger,
    );
    expect(second.content).toHaveLength(1);                         // no re-inject
    expect(logger.info).toHaveBeenCalledOnce();                     // still only the first
  });

  it("SYSTEM_PROMPT_GUIDES section key is also preserved across errors", () => {
    // sessions_spawn has a section guide (Task Delegation). Section keys are
    // tracked independently but must follow the same isError rules.
    const logger = createMockLogger();
    const delivered = new Set<string>();

    // Error on first call must not consume section:sessions_spawn.
    wrapToolResultWithGuide(
      "sessions_spawn",
      makeToolResult("approval required", true),
      delivered,
      logger,
    );
    expect(delivered.has("section:sessions_spawn")).toBe(false);

    // Success -> both the tool guide AND the section guide fire.
    const ok = wrapToolResultWithGuide(
      "sessions_spawn",
      makeToolResult("spawn started"),
      delivered,
      logger,
    );
    expect(ok.content).toHaveLength(2);
    // sessions_spawn has both TOOL_GUIDES entry + SYSTEM_PROMPT_GUIDES entry;
    // both slots should now be committed.
    expect(delivered.has("sessions_spawn")).toBe(true);
    expect(delivered.has("section:sessions_spawn")).toBe(true);
  });
});

describe("regression: mid-turn discovered tool path (Bug 1)", () => {
  // This mirrors pi-executor.ts's mid-turn tool injection: when discover_tools
  // returns a new tool, pi-executor pushes it into the live contextTools array
  // and must route its execute() result through wrapToolResultWithGuide so the
  // guide fires on first use. The call shape here is the exact one that
  // pi-executor uses post-fix.
  it("simulated mid-turn injection wires the guide correctly", async () => {
    const logger = createMockLogger();
    const delivered = new Set<string>();

    // The `original` is the bare deferred tool's AgentTool; we wrap its
    // execute() through wrapToolResultWithGuide, exactly like pi-executor does.
    const original = {
      execute: async () => makeToolResult("Agent created"),
    };
    const executeWithGuide = async () => {
      const res = await original.execute();
      return wrapToolResultWithGuide("agents_manage", res, delivered, logger);
    };

    const out1 = await executeWithGuide();
    expect(out1.content).toHaveLength(2);                           // guide fired
    expect((out1.content[1] as { text: string }).text).toContain("Workspace Customization Guide");
    expect(delivered.has("agents_manage")).toBe(true);

    // Same tool called again inside the mid-turn agentic loop -> one-shot.
    const out2 = await executeWithGuide();
    expect(out2.content).toHaveLength(1);
  });
});
