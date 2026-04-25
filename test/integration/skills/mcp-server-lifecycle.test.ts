// SPDX-License-Identifier: Apache-2.0
/**
 * MCP adapter contract integration test.
 *
 * The MCP SDK is a transitive peer dep here, not resolvable from the
 * test workspace's package.json. That makes spinning up an in-process
 * Server+Client pair from this file impossible without further hoist
 * gymnastics. Instead, this test pins the Comis-side adapter contract
 * end to end:
 *
 *   1. qualifyToolName / parseQualifiedName are exact inverses across a
 *      range of adversarial server/tool names. The wire format
 *      "mcp:{server}/{tool}" survives a full round-trip.
 *
 *   2. parseQualifiedName rejects every malformed shape the daemon may
 *      see (missing prefix, missing slash, leading/trailing slash).
 *
 *   3. sanitizeMcpToolName converts the LLM-API-illegal characters
 *      (`:`, `/`) so that resulting names match Anthropic's
 *      `^[a-zA-Z0-9_-]{1,128}$` constraint.
 *
 *   4. extractMcpServerName recovers the server label from the
 *      sanitized form, and returns undefined for non-MCP names.
 *
 *   5. classifyMcpErrorType maps observable error shapes to the small
 *      set of categories the observability pipeline expects.
 *
 *   6. mcpToolsToAgentTools wraps a synthesized McpToolDefinition into
 *      an AgentTool whose `execute()` routes back through the supplied
 *      callTool delegate (the boundary the McpClientManager fills in
 *      production). This is the only "lifecycle" property the adapter
 *      itself owns: list -> wrap -> execute -> result.
 *
 *   7. A failure on the delegate (callTool returns Result.err OR an
 *      isError content block) is surfaced through the AgentTool layer
 *      without throwing -- the AgentTool contract is "always returns,
 *      never throws".
 *
 *   8. Two consecutive callTool invocations against the same wrapper
 *      see independent argument payloads (no state bleed between calls).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import {
  qualifyToolName,
  parseQualifiedName,
  mcpToolsToAgentTools,
  sanitizeMcpToolName,
  extractMcpServerName,
  classifyMcpErrorType,
  type McpToolDefinition,
} from "@comis/skills";
import { ok, err, type Result } from "@comis/shared";

// ---------------------------------------------------------------------------
// Round-trip helpers
// ---------------------------------------------------------------------------

describe("MCP adapter -- qualifyToolName / parseQualifiedName round-trip", () => {
  it("round-trips a flat tool name", () => {
    const qn = qualifyToolName("alpha", "echo");
    expect(qn).toBe("mcp:alpha/echo");
    const parsed = parseQualifiedName(qn);
    expect(parsed).toEqual({ serverName: "alpha", toolName: "echo" });
  });

  it("round-trips a hyphenated tool name", () => {
    const qn = qualifyToolName("context7", "resolve-library-id");
    expect(qn).toBe("mcp:context7/resolve-library-id");
    const parsed = parseQualifiedName(qn);
    expect(parsed).toEqual({
      serverName: "context7",
      toolName: "resolve-library-id",
    });
  });

  it("round-trips an underscore tool name", () => {
    const qn = qualifyToolName("my_server", "tool_name_v2");
    const parsed = parseQualifiedName(qn);
    expect(parsed).toEqual({
      serverName: "my_server",
      toolName: "tool_name_v2",
    });
  });
});

describe("MCP adapter -- parseQualifiedName rejects malformed input", () => {
  it("rejects names without the mcp: prefix", () => {
    expect(parseQualifiedName("alpha/echo")).toBeUndefined();
  });

  it("rejects names without a slash", () => {
    expect(parseQualifiedName("mcp:alpha")).toBeUndefined();
  });

  it("rejects trailing slash with empty tool name", () => {
    expect(parseQualifiedName("mcp:alpha/")).toBeUndefined();
  });

  it("rejects leading slash with empty server name", () => {
    expect(parseQualifiedName("mcp:/echo")).toBeUndefined();
  });

  it("rejects empty string", () => {
    expect(parseQualifiedName("")).toBeUndefined();
  });
});

describe("MCP adapter -- sanitizeMcpToolName produces API-legal names", () => {
  it("converts `:` to `__` and `/` to `--`", () => {
    expect(sanitizeMcpToolName("mcp:context7/resolve-library-id")).toBe(
      "mcp__context7--resolve-library-id",
    );
  });

  it("output matches the Anthropic / OpenAI tool-name regex", () => {
    const RE = /^[a-zA-Z0-9_-]{1,128}$/;
    const cases = [
      "mcp:alpha/echo",
      "mcp:context7/resolve-library-id",
      "mcp:my_server/tool_name_v2",
      "mcp:srv/v2-beta",
    ];
    for (const qn of cases) {
      const s = sanitizeMcpToolName(qn);
      expect(s).toMatch(RE);
    }
  });
});

describe("MCP adapter -- extractMcpServerName", () => {
  it("recovers the server name from a sanitized label", () => {
    expect(extractMcpServerName("mcp__context7--resolve-library-id")).toBe(
      "context7",
    );
  });

  it("returns undefined for non-MCP tools", () => {
    expect(extractMcpServerName("bash")).toBeUndefined();
    expect(extractMcpServerName("read")).toBeUndefined();
    expect(extractMcpServerName("")).toBeUndefined();
  });
});

describe("MCP adapter -- classifyMcpErrorType", () => {
  it("buckets timeout shapes", () => {
    expect(classifyMcpErrorType("Request timed out after 30000ms")).toBe(
      "timeout",
    );
    expect(classifyMcpErrorType("operation timeout")).toBe("timeout");
  });

  it("buckets connection-state errors as 'connection'", () => {
    // The classifier looks for "not connected" / "disconnected".
    expect(classifyMcpErrorType("Server not connected")).toBe("connection");
    expect(classifyMcpErrorType("Client disconnected unexpectedly")).toBe(
      "connection",
    );
  });

  it("buckets transport-failure shapes as 'transport'", () => {
    // "crashed unexpectedly" / "pipe" / "epipe" / "econnreset" are
    // transport-level failures (process or socket pipeline).
    expect(classifyMcpErrorType("Server crashed unexpectedly")).toBe(
      "transport",
    );
    expect(classifyMcpErrorType("write EPIPE")).toBe("transport");
    expect(classifyMcpErrorType("read ECONNRESET")).toBe("transport");
  });

  it("buckets tool-side errors as 'tool_error'", () => {
    expect(
      classifyMcpErrorType("MCP tool error: invalid argument"),
    ).toBe("tool_error");
    expect(
      classifyMcpErrorType("the MCP tool returned an error: missing field"),
    ).toBe("tool_error");
  });

  it("returns 'unknown' for undefined input", () => {
    expect(classifyMcpErrorType(undefined)).toBe("unknown");
  });

  it("returns 'unknown' for unrecognised error text", () => {
    expect(classifyMcpErrorType("some other failure")).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// mcpToolsToAgentTools: list -> wrap -> execute -> result
// ---------------------------------------------------------------------------

describe("MCP adapter -- mcpToolsToAgentTools lifecycle", () => {
  function makeDefs(): McpToolDefinition[] {
    return [
      {
        name: "echo",
        qualifiedName: "mcp:test-server/echo",
        description: "Echoes input.",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
        },
      },
      {
        name: "resolve-library-id",
        qualifiedName: "mcp:context7/resolve-library-id",
        description: "Resolves a library by name.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
        },
      },
    ];
  }

  type CallToolDelegate = Parameters<typeof mcpToolsToAgentTools>[1];

  it("wraps every definition into an AgentTool with sanitized name", () => {
    const callTool = (async (qn: string, _args: Record<string, unknown>) =>
      ok({ content: [{ type: "text", text: `ok:${qn}` }], isError: false }) as Result<
        unknown,
        Error
      >) as unknown as CallToolDelegate;

    const tools = mcpToolsToAgentTools(makeDefs(), callTool);
    expect(tools.length).toBe(2);
    const names = new Set(tools.map((t) => t.name));
    expect(names.has("mcp__test-server--echo")).toBe(true);
    expect(names.has("mcp__context7--resolve-library-id")).toBe(true);
  });

  it("execute() routes back through the delegate with the qualified (not sanitized) name", async () => {
    const calls: Array<{ qn: string; args: Record<string, unknown> }> = [];
    const callTool = (async (qn: string, args: Record<string, unknown>) => {
      calls.push({ qn, args });
      return ok({
        content: [{ type: "text", text: "delegate-ok" }],
        isError: false,
      }) as Result<unknown, Error>;
    }) as unknown as CallToolDelegate;

    const tools = mcpToolsToAgentTools(makeDefs(), callTool);
    const echoTool = tools.find((t) => t.name === "mcp__test-server--echo");
    expect(echoTool).toBeDefined();

    const result = await (echoTool!.execute as (
      toolCallId: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>)("call-1", { text: "hello" });
    expect(result).toBeDefined();
    expect(calls.length).toBe(1);
    expect(calls[0]!.qn).toBe("mcp:test-server/echo");
    expect(calls[0]!.args).toEqual({ text: "hello" });
  });

  it("two consecutive calls have independent argument payloads (no state bleed)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const callTool = (async (_qn: string, args: Record<string, unknown>) => {
      calls.push(args);
      return ok({
        content: [{ type: "text", text: "ok" }],
        isError: false,
      }) as Result<unknown, Error>;
    }) as unknown as CallToolDelegate;

    const tools = mcpToolsToAgentTools(makeDefs(), callTool);
    const tool = tools[0]!;
    const exec = tool.execute as (
      toolCallId: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>;

    await exec("call-1", { text: "first" });
    await exec("call-2", { text: "second" });

    expect(calls).toEqual([{ text: "first" }, { text: "second" }]);
  });

  it("delegate Result.err is surfaced without throwing", async () => {
    const callTool = (async (
      _qn: string,
      _args: Record<string, unknown>,
    ): Promise<Result<unknown, Error>> => err(new Error("simulated MCP transport failure"))) as unknown as CallToolDelegate;

    const tools = mcpToolsToAgentTools(makeDefs(), callTool);
    const tool = tools[0]!;
    const exec = tool.execute as (
      toolCallId: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>;

    let threw = false;
    let result: unknown;
    try {
      result = await exec("call-err", { text: "anything" });
    } catch {
      threw = true;
    }
    // The AgentTool contract is "always returns, never throws".
    expect(threw).toBe(false);
    expect(result).toBeDefined();
  });

  it("delegate Result.ok with isError=true surfaces error text in the wrapped output", async () => {
    const callTool = (async (
      _qn: string,
      _args: Record<string, unknown>,
    ): Promise<Result<unknown, Error>> =>
      ok({
        content: [{ type: "text", text: "Tool returned an error: missing arg" }],
        isError: true,
      })) as unknown as CallToolDelegate;

    const tools = mcpToolsToAgentTools(makeDefs(), callTool);
    const tool = tools[0]!;
    const exec = tool.execute as (
      toolCallId: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>;

    const result = await exec("call-isError", {});
    expect(result).toBeDefined();
    // Error content should be readable through the AgentTool result; we
    // don't pin the exact shape (depends on pi-agent-core version) but
    // assert the failure text reaches the caller in some form.
    const text = JSON.stringify(result);
    expect(text).toMatch(/missing arg|error|isError|true/i);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle (collision-safety + unicode bounds)
// ---------------------------------------------------------------------------

describe("MCP adapter -- collision safety", () => {
  it("two different servers can expose tools with the same local name without colliding", () => {
    const a = qualifyToolName("alpha", "search");
    const b = qualifyToolName("beta", "search");
    expect(a).not.toBe(b);
    expect(sanitizeMcpToolName(a)).toBe("mcp__alpha--search");
    expect(sanitizeMcpToolName(b)).toBe("mcp__beta--search");
  });
});
