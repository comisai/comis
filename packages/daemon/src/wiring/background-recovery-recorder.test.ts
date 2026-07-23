// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  TypedEventBus,
  conversationScopeToSessionKey,
} from "@comis/core";
import { ok } from "@comis/shared";
import { createBackgroundRecoveryRecorder } from "./background-recovery-recorder.js";

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
      sessionAdapters: new Map([[
        "agent-a",
        { getSessionPath: vi.fn(() => "/resolved/data/session.jsonl") },
      ]]),
      trajectoryRegistry: { getOrCreate } as never,
    });

    const result = recorder(makeInput());

    expect(result.ok).toBe(true);
    expect(getOrCreate).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ confinedBaseDir: "/resolved/data" }),
      expect.any(TypedEventBus),
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
});
