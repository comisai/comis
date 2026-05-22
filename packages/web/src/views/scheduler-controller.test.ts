// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { ReactiveControllerHost } from "lit";
import { createMockRpcClient } from "../test-support/mock-rpc-client.js";
import { createSchedulerController } from "./scheduler-controller.js";

function makeHost(): ReactiveControllerHost & { _updates: number } {
  return {
    _updates: 0,
    addController: vi.fn(),
    removeController: vi.fn(),
    requestUpdate(): void {
      (this as { _updates: number })._updates += 1;
    },
    updateComplete: Promise.resolve(true),
  } as unknown as ReactiveControllerHost & { _updates: number };
}

describe("SchedulerController", () => {
  it("listJobs: returns cron.list response (array form)", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      const method = args[0] as string;
      if (method === "cron.list") return [{ id: "j1", name: "Job 1" }];
      return {};
    });
    const controller = createSchedulerController(host, rpc);
    const result = await controller.listJobs("default");
    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown[]).length).toBe(1);
  });

  it("listJobs: returns cron.list response ({ jobs } form)", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      const method = args[0] as string;
      if (method === "cron.list") return { jobs: [{ id: "j2" }, { id: "j3" }] };
      return {};
    });
    const controller = createSchedulerController(host, rpc);
    const result = await controller.listJobs();
    expect(Array.isArray(result)).toBe(false);
    expect((result as { jobs: unknown[] }).jobs.length).toBe(2);
  });

  it("readConfig / getStatus / getHeartbeatStates: forward to matching RPC methods", async () => {
    const host = makeHost();
    const calls: Array<{ method: string; params: unknown }> = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      const method = args[0] as string;
      const params = args[1];
      calls.push({ method, params });
      if (method === "config.read") return { heartbeat: { enabled: true, intervalMs: 60000 } };
      if (method === "cron.status") return { running: true, jobCount: 5 };
      if (method === "heartbeat.states") return { agents: [{ agentId: "alpha" }] };
      return {};
    });
    const controller = createSchedulerController(host, rpc);
    const cfg = await controller.readConfig("scheduler");
    expect((cfg.heartbeat as { enabled: boolean }).enabled).toBe(true);
    const status = await controller.getStatus("default");
    expect(status.running).toBe(true);
    expect(status.jobCount).toBe(5);
    const hb = await controller.getHeartbeatStates();
    expect(hb.agents?.length).toBe(1);
    expect(calls.map((c) => c.method)).toEqual(["config.read", "cron.status", "heartbeat.states"]);
  });

  it("addJob: forwards jobInput + injects _agentId + _deliveryTarget", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return { jobId: "created-1" };
    });
    const controller = createSchedulerController(host, rpc);
    const result = await controller.addJob("alpha", {
      name: "Test",
      enabled: true,
      deliveryTarget: { channelId: "c1", userId: "u1", tenantId: "t1" },
    });
    expect(result.jobId).toBe("created-1");
    const sentArgs = seen[0] as unknown[];
    expect(sentArgs[0]).toBe("cron.add");
    const sentParams = sentArgs[1] as Record<string, unknown>;
    expect(sentParams.name).toBe("Test");
    expect(sentParams._agentId).toBe("alpha");
    expect(sentParams._deliveryTarget).toEqual({ channelId: "c1", userId: "u1", tenantId: "t1" });
  });

  it("updateJob / removeJob: forward jobId + agentId", async () => {
    const host = makeHost();
    const calls: Array<{ method: string; params: unknown }> = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      calls.push({ method: args[0] as string, params: args[1] });
      return {};
    });
    const controller = createSchedulerController(host, rpc);
    await controller.updateJob("j1", "alpha", { name: "Updated" });
    await controller.removeJob("j1", "alpha");
    expect(calls[0]?.method).toBe("cron.update");
    expect(calls[0]?.params).toMatchObject({ jobId: "j1", _agentId: "alpha", name: "Updated" });
    expect(calls[1]?.method).toBe("cron.remove");
    expect(calls[1]?.params).toEqual({ jobId: "j1", _agentId: "alpha" });
  });

  it("setConfig: forwards section + key + value to config.set (canonical shape)", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {};
    });
    const controller = createSchedulerController(host, rpc);
    await controller.setConfig("scheduler", "heartbeat.enabled", true);
    expect((seen[0] as unknown[])[0]).toBe("config.set");
    expect((seen[0] as unknown[])[1]).toEqual({
      section: "scheduler",
      key: "heartbeat.enabled",
      value: true,
    });
  });

  it("runJob / triggerHeartbeat: invoke matching action RPCs", async () => {
    const host = makeHost();
    const calls: string[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      calls.push(args[0] as string);
      return {};
    });
    const controller = createSchedulerController(host, rpc);
    await controller.runJob("daily-report", "default");
    await controller.triggerHeartbeat("default");
    expect(calls).toEqual(["cron.run", "heartbeat.trigger"]);
  });

  it("RPC errors propagate to caller", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async () => {
      throw new Error("cron not enabled");
    });
    const controller = createSchedulerController(host, rpc);
    await expect(controller.listJobs()).rejects.toThrow("cron not enabled");
    await expect(controller.removeJob("j1", "alpha")).rejects.toThrow("cron not enabled");
  });
});
