// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { createCronTool, type RpcCall } from "./cron-tool.js";

describe("cron tool strict scheduler RPC projection", () => {
  it("states that agent-origin delivery authority is bound and cannot be omitted", () => {
    const tool = createCronTool(vi.fn(async () => ({})));

    expect(tool.description).toContain("trusted originating conversation");
    expect(tool.description).toContain("cannot create an unbound agent_turn or delivery job");
  });

  it("projects agent-turn authoring into nested strict schedule and payload objects", async () => {
    const rpcCall: RpcCall = vi.fn(async () => ({ jobId: "job-a" }));
    const tool = createCronTool(rpcCall);

    await tool.execute("call-a", {
      action: "add",
      name: "Status",
      schedule_kind: "every",
      schedule_every_ms: 60_000,
      payload_kind: "agent_turn",
      payload_text: "Summarize status",
      model: "model-a",
      session_strategy: "rolling",
      max_history_turns: 4,
    } as never);

    expect(rpcCall).toHaveBeenCalledWith("cron.add", {
      name: "Status",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "agent_turn", message: "Summarize status", model: "model-a" },
      sessionPolicy: { strategy: "rolling", maxHistoryTurns: 4 },
      continuationMode: "none",
    });
  });

  it("projects heartbeat events with an explicit closed wake mode", async () => {
    const rpcCall: RpcCall = vi.fn(async () => ({ jobId: "job-a" }));
    const tool = createCronTool(rpcCall);

    await tool.execute("call-a", {
      action: "add",
      name: "Heartbeat event",
      schedule_kind: "in",
      schedule_in_seconds: 90,
      payload_kind: "heartbeat_event",
      payload_text: "Check the queued event",
      wake_mode: "next-heartbeat",
    } as never);

    expect(rpcCall).toHaveBeenCalledWith("cron.add", {
      name: "Heartbeat event",
      schedule: { kind: "in", seconds: 90 },
      payload: {
        kind: "heartbeat_event",
        text: "Check the queued event",
        wakeMode: "next-heartbeat",
      },
    });
  });

  it("uses the typed target discriminator for scheduler wake admission", async () => {
    const rpcCall: RpcCall = vi.fn(async () => ({
      status: "accepted",
      disposition: "new_occurrence",
      correlationId: "wake-a",
      lane: "normal",
      retainedReason: "wake",
    }));
    const tool = createCronTool(rpcCall);

    await tool.execute("call-a", { action: "wake", wake_target: "monitoring" } as never);

    expect(rpcCall).toHaveBeenCalledWith("scheduler.wake", { target: "monitoring" });
  });

  it("projects the reversible paused mutation instead of a removed enabled field", async () => {
    const rpcCall: RpcCall = vi.fn(async () => ({ updated: true }));
    const tool = createCronTool(rpcCall);

    await tool.execute("call-a", {
      action: "update",
      job_name: "Status",
      paused: true,
      name: "Status paused",
    } as never);

    expect(rpcCall).toHaveBeenCalledWith("cron.update", {
      jobName: "Status",
      name: "Status paused",
      paused: true,
    });
  });
});
