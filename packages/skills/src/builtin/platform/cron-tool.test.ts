// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { createCronTool, type RpcCall } from "./cron-tool.js";

/**
 * Helper to parse the JSON text from a tool result's first content entry.
 */
function parseResult(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const text = (result.content[0] as { type: "text"; text: string }).text;
  return JSON.parse(text);
}

describe("cron tool", () => {
  it("list action returns jobs from rpcCall('cron.list')", async () => {
    const mockRpcCall: RpcCall = vi.fn(async (method, _params) => {
      if (method === "cron.list") {
        return { jobs: [{ id: "job-1", name: "daily-check", enabled: true }] };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const tool = createCronTool(mockRpcCall);
    const result = await tool.execute("call-1", { action: "list" } as never);

    const parsed = parseResult(result) as { jobs: Array<{ id: string }> };
    expect(parsed.jobs).toHaveLength(1);
    expect(parsed.jobs[0]!.id).toBe("job-1");
    expect(mockRpcCall).toHaveBeenCalledWith("cron.list", {});
  });

  it("add action delegates to rpcCall (mutate gate, auto-approved)", async () => {
    const mockRpcCall: RpcCall = vi.fn(async (method, _params) => {
      if (method === "cron.add") {
        return { id: "job-new", created: true };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const tool = createCronTool(mockRpcCall);
    const result = await tool.execute("call-2", {
      action: "add",
      name: "test-job",
      schedule_kind: "every",
      schedule_every_ms: 60000,
      payload_kind: "system_event",
      payload_text: "Hello",
    } as never);

    const parsed = parseResult(result) as { id: string; created: boolean };
    expect(parsed.created).toBe(true);
    expect(parsed.id).toBe("job-new");
    expect(mockRpcCall).toHaveBeenCalledWith("cron.add", {
      name: "test-job",
      schedule_kind: "every",
      schedule_expr: undefined,
      schedule_every_ms: 60000,
      schedule_at: undefined,
      timezone: undefined,
      payload_kind: "system_event",
      payload_text: "Hello",
    });
  });

  it("add action passes model param to rpcCall when provided", async () => {
    const mockRpcCall: RpcCall = vi.fn(async (method, _params) => {
      if (method === "cron.add") {
        return { id: "job-new", created: true };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const tool = createCronTool(mockRpcCall);
    await tool.execute("call-model", {
      action: "add",
      name: "model-job",
      schedule_kind: "every",
      schedule_every_ms: 60000,
      payload_kind: "agent_turn",
      payload_text: "Hello",
      model: "gemini-2.5-flash",
    } as never);

    expect(mockRpcCall).toHaveBeenCalledWith("cron.add", expect.objectContaining({
      model: "gemini-2.5-flash",
    }));
  });

  it("add action does not pass model when not provided", async () => {
    const mockRpcCall: RpcCall = vi.fn(async (method, _params) => {
      if (method === "cron.add") {
        return { id: "job-new", created: true };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const tool = createCronTool(mockRpcCall);
    await tool.execute("call-no-model", {
      action: "add",
      name: "no-model-job",
      schedule_kind: "every",
      schedule_every_ms: 60000,
      payload_kind: "system_event",
      payload_text: "Hello",
    } as never);

    expect(mockRpcCall).toHaveBeenCalledWith("cron.add", expect.objectContaining({
      model: undefined,
    }));
  });

  it("add action passes session_strategy and max_history_turns to rpcCall", async () => {
    const mockRpcCall: RpcCall = vi.fn(async (method, _params) => {
      if (method === "cron.add") {
        return { id: "job-new", created: true };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const tool = createCronTool(mockRpcCall);
    await tool.execute("call-ss", {
      action: "add",
      name: "rolling-job",
      schedule_kind: "every",
      schedule_every_ms: 120000,
      payload_kind: "agent_turn",
      payload_text: "check status",
      session_strategy: "rolling",
      max_history_turns: 5,
    } as never);

    expect(mockRpcCall).toHaveBeenCalledWith("cron.add", expect.objectContaining({
      session_strategy: "rolling",
      max_history_turns: 5,
    }));
  });

  it("remove action returns requiresConfirmation with hint (destructive gate)", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({ ok: true }));

    const tool = createCronTool(mockRpcCall);
    const result = await tool.execute("call-3", {
      action: "remove",
      job_name: "job-1",
    } as never);

    const parsed = parseResult(result) as { requiresConfirmation: boolean; actionType: string; hint: string };
    expect(parsed.requiresConfirmation).toBe(true);
    expect(parsed.actionType).toBe("cron.remove");
    expect(parsed.hint).toContain("_confirmed: true");
    expect(mockRpcCall).not.toHaveBeenCalled();
  });

  it("update action delegates to rpcCall('cron.update') with correct params", async () => {
    const mockRpcCall: RpcCall = vi.fn(async (method, params) => {
      if (method === "cron.update") {
        return { updated: true, jobName: params.jobName };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const tool = createCronTool(mockRpcCall);
    const result = await tool.execute("call-4", {
      action: "update",
      job_name: "job-1",
      enabled: false,
      name: "renamed-job",
    } as never);

    const parsed = parseResult(result) as { updated: boolean; jobName: string };
    expect(parsed.updated).toBe(true);
    expect(parsed.jobName).toBe("job-1");
    expect(mockRpcCall).toHaveBeenCalledWith("cron.update", {
      jobName: "job-1",
      enabled: false,
      name: "renamed-job",
    });
  });

  it("status action delegates to rpcCall('cron.status')", async () => {
    const mockRpcCall: RpcCall = vi.fn(async (method, _params) => {
      if (method === "cron.status") {
        return { running: true, jobCount: 5 };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const tool = createCronTool(mockRpcCall);
    const result = await tool.execute("call-5", { action: "status" } as never);

    const parsed = parseResult(result) as { running: boolean; jobCount: number };
    expect(parsed.running).toBe(true);
    expect(parsed.jobCount).toBe(5);
    expect(mockRpcCall).toHaveBeenCalledWith("cron.status", {});
  });

  it("runs action delegates to rpcCall('cron.runs') with jobName and limit", async () => {
    const mockRpcCall: RpcCall = vi.fn(async (method, params) => {
      if (method === "cron.runs") {
        return {
          runs: [{ id: "run-1", jobName: params.jobName, status: "completed" }],
          limit: params.limit,
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const tool = createCronTool(mockRpcCall);
    const result = await tool.execute("call-6", {
      action: "runs",
      job_name: "job-1",
      limit: 5,
    } as never);

    const parsed = parseResult(result) as { runs: Array<{ jobName: string }>; limit: number };
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.limit).toBe(5);
    expect(mockRpcCall).toHaveBeenCalledWith("cron.runs", { jobName: "job-1", limit: 5 });
  });

  it("runs action defaults limit to 20 when not provided", async () => {
    const mockRpcCall: RpcCall = vi.fn(async (method, params) => {
      if (method === "cron.runs") {
        return { runs: [], limit: params.limit };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const tool = createCronTool(mockRpcCall);
    await tool.execute("call-6b", {
      action: "runs",
      job_name: "job-1",
    } as never);

    expect(mockRpcCall).toHaveBeenCalledWith("cron.runs", { jobName: "job-1", limit: 20 });
  });

  it("run action delegates to rpcCall('cron.run') with jobName and mode", async () => {
    const mockRpcCall: RpcCall = vi.fn(async (method, params) => {
      if (method === "cron.run") {
        return { triggered: true, jobName: params.jobName, mode: params.mode };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const tool = createCronTool(mockRpcCall);
    const result = await tool.execute("call-7", {
      action: "run",
      job_name: "job-1",
      mode: "due",
    } as never);

    const parsed = parseResult(result) as { triggered: boolean; mode: string };
    expect(parsed.triggered).toBe(true);
    expect(parsed.mode).toBe("due");
    expect(mockRpcCall).toHaveBeenCalledWith("cron.run", { jobName: "job-1", mode: "due" });
  });

  it("run action defaults mode to 'force' when not provided", async () => {
    const mockRpcCall: RpcCall = vi.fn(async (method, params) => {
      if (method === "cron.run") {
        return { triggered: true, mode: params.mode };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const tool = createCronTool(mockRpcCall);
    await tool.execute("call-7b", {
      action: "run",
      job_name: "job-1",
    } as never);

    expect(mockRpcCall).toHaveBeenCalledWith("cron.run", { jobName: "job-1", mode: "force" });
  });

  it("throws [invalid_value] for unknown action", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({}));

    const tool = createCronTool(mockRpcCall);

    await expect(
      tool.execute("call-8", { action: "invalid" } as never),
    ).rejects.toThrow(/\[invalid_value\]/);
    expect(mockRpcCall).not.toHaveBeenCalled();
  });

  it("throws for missing required param (e.g., job_name for runs)", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => ({}));

    const tool = createCronTool(mockRpcCall);

    await expect(
      tool.execute("call-9", { action: "runs" } as never),
    ).rejects.toThrow("Missing required parameter: job_name");
    expect(mockRpcCall).not.toHaveBeenCalled();
  });

  it("re-throws when rpcCall throws Error", async () => {
    const mockRpcCall: RpcCall = vi.fn(async () => {
      throw new Error("Connection refused");
    });

    const tool = createCronTool(mockRpcCall);

    await expect(
      tool.execute("call-10", { action: "list" } as never),
    ).rejects.toThrow("Connection refused");
  });

  describe("cron tool — wake action", () => {
    it("wake action calls scheduler.wake with default source", async () => {
      const mockRpcCall: RpcCall = vi.fn(async (method, params) => {
        if (method === "scheduler.wake") {
          return { woken: true, source: params.source };
        }
        throw new Error(`Unexpected method: ${method}`);
      });

      const tool = createCronTool(mockRpcCall);
      const result = await tool.execute("call-wake-1", { action: "wake" } as never);

      const parsed = parseResult(result) as { woken: boolean; source: string };
      expect(parsed.woken).toBe(true);
      expect(parsed.source).toBe("agent");
      expect(mockRpcCall).toHaveBeenCalledWith("scheduler.wake", { source: "agent" });
    });

    it("wake action passes custom source", async () => {
      const mockRpcCall: RpcCall = vi.fn(async (method, params) => {
        if (method === "scheduler.wake") {
          return { woken: true, source: params.source };
        }
        throw new Error(`Unexpected method: ${method}`);
      });

      const tool = createCronTool(mockRpcCall);
      const result = await tool.execute("call-wake-2", {
        action: "wake",
        source: "cron-monitor",
      } as never);

      const parsed = parseResult(result) as { woken: boolean; source: string };
      expect(parsed.source).toBe("cron-monitor");
      expect(mockRpcCall).toHaveBeenCalledWith("scheduler.wake", { source: "cron-monitor" });
    });

    it("wake action re-throws rpcCall error", async () => {
      const mockRpcCall: RpcCall = vi.fn(async () => {
        throw new Error("Scheduler unavailable");
      });

      const tool = createCronTool(mockRpcCall);

      await expect(
        tool.execute("call-wake-3", { action: "wake" } as never),
      ).rejects.toThrow("Scheduler unavailable");
    });
  });
});
