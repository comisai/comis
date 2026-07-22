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
      payload_kind: "delivery",
      payload_text: "Hello",
    } as never);

    const parsed = parseResult(result) as { id: string; created: boolean };
    expect(parsed.created).toBe(true);
    expect(parsed.id).toBe("job-new");
    expect(mockRpcCall).toHaveBeenCalledWith("cron.add", {
      name: "test-job",
      schedule: { kind: "every", everyMs: 60000 },
      payload: { kind: "delivery", text: "Hello" },
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
      payload: { kind: "agent_turn", message: "Hello", model: "gemini-2.5-flash" },
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
      payload_kind: "delivery",
      payload_text: "Hello",
    } as never);

    const params = vi.mocked(mockRpcCall).mock.calls[0]![1] as Record<string, unknown>;
    expect(params.payload).toEqual({ kind: "delivery", text: "Hello" });
    expect(params).not.toHaveProperty("model");
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
      sessionPolicy: { strategy: "rolling", maxHistoryTurns: 5 },
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
      paused: true,
      name: "renamed-job",
    } as never);

    const parsed = parseResult(result) as { updated: boolean; jobName: string };
    expect(parsed.updated).toBe(true);
    expect(parsed.jobName).toBe("job-1");
    expect(mockRpcCall).toHaveBeenCalledWith("cron.update", {
      jobName: "job-1",
      paused: true,
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
    it("wake action calls scheduler.wake with the default agent target", async () => {
      const mockRpcCall: RpcCall = vi.fn(async (method, params) => {
        if (method === "scheduler.wake") {
          return { status: "accepted", correlationId: "wake-a", target: params.target };
        }
        throw new Error(`Unexpected method: ${method}`);
      });

      const tool = createCronTool(mockRpcCall);
      const result = await tool.execute("call-wake-1", { action: "wake" } as never);

      const parsed = parseResult(result) as { status: string; target: string };
      expect(parsed.status).toBe("accepted");
      expect(parsed.target).toBe("agent");
      expect(mockRpcCall).toHaveBeenCalledWith("scheduler.wake", { target: "agent" });
    });

    it("wake action passes the monitoring target", async () => {
      const mockRpcCall: RpcCall = vi.fn(async (method, params) => {
        if (method === "scheduler.wake") {
          return { status: "accepted", correlationId: "wake-a", target: params.target };
        }
        throw new Error(`Unexpected method: ${method}`);
      });

      const tool = createCronTool(mockRpcCall);
      const result = await tool.execute("call-wake-2", {
        action: "wake",
        wake_target: "monitoring",
      } as never);

      const parsed = parseResult(result) as { target: string };
      expect(parsed.target).toBe("monitoring");
      expect(mockRpcCall).toHaveBeenCalledWith("scheduler.wake", { target: "monitoring" });
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

  describe("cron tool — wake-gate authoring params", () => {
    it("add threads wake_gate_script and wake_gate_language onto the cron.add rpcCall", async () => {
      const mockRpcCall: RpcCall = vi.fn(async (method) => {
        if (method === "cron.add") {
          return { id: "job-gate", created: true };
        }
        throw new Error(`Unexpected method: ${method}`);
      });

      const tool = createCronTool(mockRpcCall);
      await tool.execute("call-gate-add", {
        action: "add",
        name: "ci-monitor",
        schedule_kind: "cron",
        schedule_expr: "* * * * *",
        payload_kind: "agent_turn",
        payload_text: "m",
        wake_gate_script: "await fetch(x)",
        wake_gate_language: "ts",
      } as never);

      expect(mockRpcCall).toHaveBeenCalledWith(
        "cron.add",
        expect.objectContaining({
          wakeGate: {
            script: "await fetch(x)",
            language: "ts",
            timeoutSeconds: 30,
          },
        }),
      );
    });

    it("rejects wake-gate scripts on non-agent payloads with a structured error", async () => {
      const mockRpcCall: RpcCall = vi.fn(async () => ({ created: true }));
      const tool = createCronTool(mockRpcCall);

      await expect(tool.execute("call-gate-invalid", {
        action: "add",
        name: "invalid-monitor",
        schedule_kind: "every",
        schedule_every_ms: 60_000,
        payload_kind: "delivery",
        payload_text: "status",
        wake_gate_script: "console.log('{}')",
      } as never)).rejects.toThrow(/\[invalid_value\].*agent_turn/);
      expect(mockRpcCall).not.toHaveBeenCalled();
    });

    it("update threads wake_gate_script onto the cron.update rpcCall", async () => {
      const mockRpcCall: RpcCall = vi.fn(async (method, params) => {
        if (method === "cron.update") {
          return { updated: true, jobName: params.jobName };
        }
        throw new Error(`Unexpected method: ${method}`);
      });

      const tool = createCronTool(mockRpcCall);
      await tool.execute("call-gate-update", {
        action: "update",
        job_name: "j",
        wake_gate_script: "s2",
      } as never);

      expect(mockRpcCall).toHaveBeenCalledWith(
        "cron.update",
        expect.objectContaining({
          wakeGate: { script: "s2", language: "js", timeoutSeconds: 30 },
        }),
      );
    });

    it("add without wake-gate params omits the wake-gate projection", async () => {
      const mockRpcCall = vi.fn(async () => ({ id: "job-plain", created: true }));

      const tool = createCronTool(mockRpcCall);
      await tool.execute("call-plain-add", {
        action: "add",
        name: "plain-job",
        schedule_kind: "every",
        schedule_every_ms: 60000,
        payload_kind: "delivery",
        payload_text: "Hello",
      } as never);

      const [method, params] = mockRpcCall.mock.calls[0]! as [string, Record<string, unknown>];
      expect(method).toBe("cron.add");
      expect(params).not.toHaveProperty("wakeGate");
    });
  });

  describe("cron tool — wake-gate monitoring pattern in the description", () => {
    // The tool description is how a model learns to author a monitor that runs
    // nearly free: a pre-run gate script that prints a JSON wake verdict, so the
    // model only runs when something actually changed.
    function getToolDescription(): string {
      const mockRpcCall: RpcCall = vi.fn(async () => ({}));
      return createCronTool(mockRpcCall).description;
    }

    it('teaches the skip verdict — print {"wake":false} when nothing changed', () => {
      expect(getToolDescription()).toContain('{"wake":false}');
    });

    it('teaches the wake verdict — {"wake":true,"context":"…"} with what changed', () => {
      const desc = getToolDescription();
      expect(desc).toContain('"wake":true');
      expect(desc).toContain("context");
    });

    it("states the model runs only when the gate wakes", () => {
      expect(getToolDescription().toLowerCase()).toContain("only when the gate wakes");
    });

    it("includes a worked gate example demonstrating the verdict", () => {
      const desc = getToolDescription();
      expect(desc.toLowerCase()).toContain("example");
      // The worked example demonstrates the skip verdict a second time (rule + example).
      const skipVerdicts = desc.split('{"wake":false}').length - 1;
      expect(skipVerdicts).toBeGreaterThanOrEqual(2);
    });

    it("disambiguates the wake-gate from the `wake` action (a scheduler-loop restart-replay)", () => {
      const desc = getToolDescription();
      expect(desc).toContain("`wake` action");
      expect(desc.toLowerCase()).toContain("not the");
    });
  });

  describe("session_strategy parameter description", () => {
    function getSessionStrategyDescription(): string {
      const mockRpcCall: RpcCall = vi.fn(async () => ({}));
      const tool = createCronTool(mockRpcCall);
      // CronToolParams is Type.Object; properties live under tool.parameters.properties.
      const params = tool.parameters as unknown as {
        properties: { session_strategy?: { description?: string } };
      };
      return params.properties.session_strategy?.description ?? "";
    }

    it("states that cron history strategies are bounded", () => {
      const desc = getSessionStrategyDescription();
      expect(desc).toContain("Bounded");
    });

    it("names the bounded rolling-history parameter", () => {
      const desc = getSessionStrategyDescription();
      expect(desc).toContain("max_history_turns");
    });

    it("does not advertise the removed unbounded strategy", () => {
      const desc = getSessionStrategyDescription();
      expect(desc).not.toContain("accumulate");
    });

    it("retains the fresh default and rolling alternative", () => {
      const desc = getSessionStrategyDescription();
      expect(desc).toContain("fresh");
      expect(desc).toContain("rolling");
      expect(desc.toLowerCase()).toContain("default");
    });
  });
});
