// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  TypedEventBus,
  conversationScopeToSessionKey,
} from "@comis/core";
import { ok } from "@comis/shared";
import { createBackgroundRecoveryRecorder } from "./background-recovery-recorder.js";
import { resolveEffectiveTrajectoryConfig } from "./trajectory-runtime-config.js";

function makeInput() {
  const endpoint = {
    channelType: "echo",
    channelInstanceId: "echo-main",
    conversationId: "conversation-a",
    conversationKind: "direct" as const,
  };
  const projected = conversationScopeToSessionKey({
    tenantId: "default",
    agentId: "agent-a",
    partition: {
      kind: "endpoint-conversation-principal",
      endpoint,
      principalId: "user_a",
    },
  });
  if (!projected.ok) throw projected.error;
  return {
    agentId: "agent-a",
    taskId: "task-a",
    toolName: "report",
    sessionKey: "default:agent-a:echo:conversation-a:user_a",
    projectedSessionKey: projected.value,
    traceId: null,
    timestamp: 10,
    reason: "recovery_retry_required" as const,
  };
}

describe("background recovery trajectory recorder", () => {
  it("wires the resolved boot data directory into recovery recording", () => {
    const daemonSource = readFileSync(
      new URL("../daemon.ts", import.meta.url),
      "utf-8",
    );

    expect(daemonSource).toMatch(
      /createBackgroundRecoveryRecorder\(\{[\s\S]*?dataDir:\s*boot\.dataDir/,
    );
  });

  it("uses the resolved data directory and acknowledges direct trajectory admission", () => {
    const recordEvent = vi.fn(() => "queued" as const);
    const getOrCreate = vi.fn(() => ok({
      recorder: { recordEvent } as never,
    }));
    const recorder = createBackgroundRecoveryRecorder({
      dataDir: "/resolved/data",
      eventBus: new TypedEventBus(),
      logger: {} as never,
      trajectoryConfig: {
        enabled: true,
        dir: "/resolved/trajectory",
        maxFileBytes: 4_096,
        eventTypes: ["background_task.notified"],
      },
      sessionAdapters: new Map([[
        "agent-a",
        { getSessionPath: vi.fn(() => "/resolved/data/session.jsonl") },
      ]]),
      trajectoryRegistry: { getOrCreate } as never,
    });

    const result = recorder(makeInput());

    expect(result).toEqual({ ok: true, value: "accepted" });
    expect(getOrCreate).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        trajectoryDir: "/resolved/trajectory",
        enabled: true,
        maxRuntimeFileBytes: 4_096,
      }),
      expect.any(TypedEventBus),
      expect.any(Function),
    );
    expect(recordEvent).toHaveBeenCalledWith("background_task.notified", {
      taskId: "task-a",
      toolName: "report",
      notified: false,
      reason: "recovery_retry_required",
    });
  });

  it("keeps recovery pending when direct trajectory admission is dropped", () => {
    const recorder = createBackgroundRecoveryRecorder({
      dataDir: "/resolved/data",
      eventBus: new TypedEventBus(),
      logger: {} as never,
      trajectoryConfig: {
        enabled: true,
        maxFileBytes: 4_096,
      },
      sessionAdapters: new Map([[
        "agent-a",
        { getSessionPath: vi.fn(() => "/resolved/data/session.jsonl") },
      ]]),
      trajectoryRegistry: {
        getOrCreate: vi.fn(() => ok({
          recorder: {
            recordEvent: vi.fn(() => "dropped" as const),
          },
        })),
      } as never,
    });

    const result = recorder(makeInput());

    expect(result.ok).toBe(false);
  });

  it("uses one effective configuration for normal and recovery trajectory creation", () => {
    const effective = resolveEffectiveTrajectoryConfig({
      diagnostics: {
        trajectory: {
          enabled: true,
          maxFileBytes: 8_192,
          eventTypes: ["background_task.notified"],
        },
      },
      observability: {
        trajectory: { dirOverride: "/configured/trajectory" },
      },
    } as never);
    const getOrCreate = vi.fn(() => ok({
      recorder: { recordEvent: vi.fn(() => "queued" as const) } as never,
    }));
    const recorder = createBackgroundRecoveryRecorder({
      dataDir: "/resolved/data",
      eventBus: new TypedEventBus(),
      logger: {} as never,
      trajectoryConfig: effective,
      sessionAdapters: new Map([[
        "agent-a",
        { getSessionPath: vi.fn(() => "/resolved/data/session.jsonl") },
      ]]),
      trajectoryRegistry: { getOrCreate } as never,
    });

    expect(recorder(makeInput())).toEqual({ ok: true, value: "accepted" });
    expect(effective).toEqual({
      enabled: true,
      dir: "/configured/trajectory",
      maxFileBytes: 8_192,
      eventTypes: ["background_task.notified"],
    });
    expect(getOrCreate).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        trajectoryDir: effective.dir,
        maxRuntimeFileBytes: effective.maxFileBytes,
      }),
      expect.any(TypedEventBus),
      expect.any(Function),
    );
  });

  it("returns suppressed without initializing a disabled or filtered recorder", () => {
    const getOrCreate = vi.fn();
    const base = {
      dataDir: "/resolved/data",
      eventBus: new TypedEventBus(),
      logger: {} as never,
      sessionAdapters: new Map(),
      trajectoryRegistry: { getOrCreate } as never,
    };

    const disabled = createBackgroundRecoveryRecorder({
      ...base,
      trajectoryConfig: { enabled: false, maxFileBytes: 4_096 },
    });
    const filtered = createBackgroundRecoveryRecorder({
      ...base,
      trajectoryConfig: {
        enabled: true,
        maxFileBytes: 4_096,
        eventTypes: ["tool.result"],
      },
    });

    expect(disabled(makeInput())).toEqual({ ok: true, value: "suppressed" });
    expect(filtered(makeInput())).toEqual({ ok: true, value: "suppressed" });
    expect(getOrCreate).not.toHaveBeenCalled();
  });

  it("uses documented trajectory event names for bridge filtering", () => {
    const getOrCreate = vi.fn(() => ok({
      recorder: {
        recordEvent: vi.fn(() => "queued" as const),
      },
    }));
    const recorder = createBackgroundRecoveryRecorder({
      dataDir: "/resolved/data",
      eventBus: new TypedEventBus(),
      logger: {} as never,
      trajectoryConfig: {
        enabled: true,
        maxFileBytes: 4_096,
        eventTypes: ["background_task.notified"],
      },
      sessionAdapters: new Map([[
        "agent-a",
        { getSessionPath: vi.fn(() => "/resolved/data/session.jsonl") },
      ]]),
      trajectoryRegistry: { getOrCreate } as never,
    });

    expect(recorder(makeInput())).toEqual({ ok: true, value: "accepted" });
    const filter = getOrCreate.mock.calls[0]?.[3];
    expect(filter?.("background_task:notified")).toBe(true);
    expect(filter?.("tool:executed")).toBe(false);
  });
});
