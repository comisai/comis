// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { createSessionsSpawnTool } from "./sessions-spawn-tool.js";
import type { RpcCall } from "./cron-tool.js";

/**
 * Helper to parse the JSON text from a tool result's first content entry.
 */
function parseResult(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const text = (result.content[0] as { type: "text"; text: string }).text;
  return JSON.parse(text);
}

describe("sessions_spawn tool", () => {
  it("calls RPC with task and defaults (model=undefined, agent=undefined, async=false)", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ ok: true }));

    const tool = createSessionsSpawnTool(mockRpcCall);
    const result = await tool.execute("call-1", {
      task: "do stuff",
    } as never);

    const parsed = parseResult(result) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    expect(mockRpcCall).toHaveBeenCalledWith("session.spawn", {
      task: "do stuff",
      model: undefined,
      agent: undefined,
      async: false,
      max_steps: undefined,
    });
  });

  it("passes agent and async=true params", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ runId: "abc", async: true }));

    const tool = createSessionsSpawnTool(mockRpcCall);
    const result = await tool.execute("call-2", {
      task: "research",
      agent: "researcher",
      async: true,
    } as never);

    const parsed = parseResult(result) as { runId: string; async: boolean };
    expect(parsed.runId).toBe("abc");
    expect(parsed.async).toBe(true);
    expect(mockRpcCall).toHaveBeenCalledWith("session.spawn", {
      task: "research",
      model: undefined,
      agent: "researcher",
      async: true,
      max_steps: undefined,
    });
  });

  it("forwards the declared whole-request delegation boundary", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ runId: "abc", async: true }));
    const tool = createSessionsSpawnTool(mockRpcCall);
    const params = tool.parameters as { properties: Record<string, unknown> };

    expect(params.properties).toHaveProperty("delegation_scope");
    await tool.execute("call-scope", {
      task: "research the complete request",
      delegation_scope: "whole_request",
    } as never);

    expect(mockRpcCall).toHaveBeenCalledWith("session.spawn", expect.objectContaining({
      delegation_scope: "whole_request",
    }));
  });

  it("throws when task is missing", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({}));

    const tool = createSessionsSpawnTool(mockRpcCall);

    await expect(tool.execute("call-3", {} as never)).rejects.toThrow(
      "Missing required parameter: task",
    );
    expect(mockRpcCall).not.toHaveBeenCalled();
  });

  it("passes max_steps to RPC call", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ ok: true }));

    const tool = createSessionsSpawnTool(mockRpcCall);
    await tool.execute("call-5", {
      task: "limited task",
      max_steps: 30,
    } as never);

    expect(mockRpcCall).toHaveBeenCalledWith("session.spawn", expect.objectContaining({
      task: "limited task",
      max_steps: 30,
    }));
  });

  it("max_steps schema enforces its advertised floor of 30", () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({}));
    const tool = createSessionsSpawnTool(mockRpcCall);
    const params = tool.parameters as {
      properties: Record<string, { description?: string; minimum?: number }>;
    };
    expect(params.properties.max_steps.description).toContain("Floor of 30");
    expect(params.properties.max_steps.minimum).toBe(30);
  });

  it("schema requires explicitly named child tools to use the reachability contract", () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({}));
    const tool = createSessionsSpawnTool(mockRpcCall);
    const params = tool.parameters as { properties: Record<string, { description?: string }> };

    expect(tool.description).toContain("required_tools");
    expect(params.properties.task.description).toContain("required_tools");
    expect(params.properties.required_tools.description).toMatch(/must|mandatory/iu);
    expect(params.properties.tool_groups.description).toContain("obs_query");
    expect(params.properties.tool_groups.description).toContain("supervisor");
  });

  it("does not expose or forward model-selected announcement routes", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ runId: "run_a", async: true }));
    const tool = createSessionsSpawnTool(mockRpcCall);
    const params = tool.parameters as { properties: Record<string, unknown> };

    expect(params.properties).not.toHaveProperty("announce_channel_type");
    expect(params.properties).not.toHaveProperty("announce_channel_id");

    await tool.execute("call-route", {
      task: "inspect records",
      async: true,
      announce_channel_type: "telegram",
      announce_channel_id: "previous_chat",
    } as never);

    expect(mockRpcCall).toHaveBeenCalledWith("session.spawn", expect.not.objectContaining({
      announce_channel_type: expect.anything(),
      announce_channel_id: expect.anything(),
    }));
  });

  it("forwards executor-injected discovery state without exposing it in the model schema", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ runId: "run_a", async: true }));
    const tool = createSessionsSpawnTool(mockRpcCall);
    const params = tool.parameters as { properties: Record<string, unknown> };

    expect(params.properties).not.toHaveProperty("_discoveredDeferredTools");

    await tool.execute("call-discovery", {
      task: "inspect the discovered service",
      _discoveredDeferredTools: ["mcp__service--lookup"],
    } as never);

    expect(mockRpcCall).toHaveBeenCalledWith(
      "session.spawn",
      expect.not.objectContaining({
        _discoveredDeferredTools: expect.anything(),
      }),
      { discoveredDeferredTools: ["mcp__service--lookup"] },
    );
  });

  it("throws when the RPC request fails", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => {
      throw new Error("spawn failed");
    });

    const tool = createSessionsSpawnTool(mockRpcCall);

    await expect(
      tool.execute("call-4", { task: "do stuff" } as never),
    ).rejects.toThrow("spawn failed");
  });

  // Declaring expected_outputs is the ONLY thing that makes a file the sub-agent
  // produced reach the requester: post-run validation turns each existing declared
  // path into a completion attachment, and the governed announcement delivers it.
  // Describing the field as post-hoc "validation" gave a caller no reason to
  // declare it for a file-producing task, so the file was written and never sent.
  //
  // Measured live on comis-moshe: three report requests were answered with
  // "working on it, I'll send the file", the files were produced in the workspace,
  // and the wire carried ZERO document sends across the whole campaign because no
  // spawn declared an output. The schema must state the consequence, not just the
  // check.
  it("tells the caller that declaring expected_outputs is what delivers the file", () => {
    const tool = createSessionsSpawnTool(vi.fn(async () => ({ ok: true })) as RpcCall);
    const schema = (tool as unknown as {
      parameters: { properties: { expected_outputs?: { description?: string } } };
    }).parameters;
    const description = String(schema.properties.expected_outputs?.description ?? "");

    expect(description.length).toBeGreaterThan(0);
    // Names the outcome (the file is sent), not merely that paths are checked.
    expect(description).toMatch(/deliver|attach|sent/i);
    // Names the cost of omitting it, so the default is an informed choice.
    expect(description).toMatch(/not be (delivered|sent|attached)|never (delivered|sent)/i);
  });
});
