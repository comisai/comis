// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TypedEventBus,
  conversationScopeToSessionKey,
  formatSessionKey,
} from "@comis/core";
import { ok } from "@comis/shared";
import { createSessionTrajectoryHandleRegistry } from "@comis/observability";
import { createDeadLetterRecoveryObserver } from "./dead-letter-recovery-observer.js";

function makeSession() {
  const projected = conversationScopeToSessionKey({
    tenantId: "default",
    agentId: "agent-a",
    partition: {
      kind: "endpoint-conversation-principal",
      endpoint: {
        channelType: "telegram",
        channelInstanceId: "telegram-test",
        conversationId: "conversation-a",
        conversationKind: "direct",
      },
      principalId: "user_a",
    },
  });
  if (!projected.ok) throw projected.error;
  return {
    projected: projected.value,
    formatted: formatSessionKey(projected.value),
  };
}

describe("dead-letter recovery trajectory observer", () => {
  it("is constructed and injected by the daemon composition root", () => {
    const daemonSource = readFileSync(new URL("../daemon.ts", import.meta.url), "utf8");

    expect(daemonSource).toMatch(
      /const ensureDeadLetterRecoveryObservation = createDeadLetterRecoveryObserver\(\{[\s\S]*?setupCrossSession\(\{[\s\S]*?ensureDeadLetterRecoveryObservation/,
    );
  });

  it("materializes the owning trajectory before off-turn recovery emits", () => {
    const session = makeSession();
    const getSessionPath = vi.fn(() => "/data/session.jsonl");
    const getOrCreate = vi.fn(() => ok({ recorder: {} as never }));
    const eventBus = new TypedEventBus();
    const observer = createDeadLetterRecoveryObserver({
      dataDir: "/data",
      eventBus,
      logger: {} as never,
      trajectoryConfig: {
        enabled: true,
        maxFileBytes: 4_096,
        eventTypes: ["delivery.outward_ledger_transition"],
      },
      sessionAdapters: new Map([["agent-a", { getSessionPath }]]),
      trajectoryRegistry: { getOrCreate } as never,
    });

    expect(observer({
      agentId: "agent-a",
      sessionKey: session.formatted,
    })).toEqual(ok(undefined));
    expect(getSessionPath).toHaveBeenCalledWith(session.projected);
    expect(getOrCreate).toHaveBeenCalledWith(
      session.formatted,
      expect.objectContaining({
        agentId: "agent-a",
        sessionFile: "/data/session.jsonl",
        confinedBaseDir: "/data",
      }),
      eventBus,
      expect.any(Function),
    );
    const filter = getOrCreate.mock.calls[0]?.[3];
    expect(filter?.("delivery:outward_ledger_transition")).toBe(true);
    expect(filter?.("tool:executed")).toBe(false);
  });

  it("captures a boot-time committed receipt through the newly attached bridge", async () => {
    const directory = mkdtempSync(join(tmpdir(), "comis-dlq-observer-"));
    try {
      const session = makeSession();
      const eventBus = new TypedEventBus();
      const trajectoryRegistry = createSessionTrajectoryHandleRegistry();
      const observer = createDeadLetterRecoveryObserver({
        dataDir: directory,
        eventBus,
        logger: {} as never,
        trajectoryConfig: {
          enabled: true,
          dir: directory,
          maxFileBytes: 64_000,
        },
        sessionAdapters: new Map([[
          "agent-a",
          { getSessionPath: vi.fn(() => join(directory, "session.jsonl")) },
        ]]),
        trajectoryRegistry,
      });

      expect(observer({
        agentId: "agent-a",
        sessionKey: session.formatted,
      })).toEqual(ok(undefined));
      eventBus.emit("delivery:outward_ledger_transition", {
        rootRunId: "root-recovery",
        runId: "run-recovery",
        stepIndex: 2,
        transition: "commit",
        outcome: "committed",
        sessionKey: session.formatted,
        platformMessageId: "receipt-2",
        timestamp: 10,
      });

      const recorder = trajectoryRegistry.getRecorder(session.formatted);
      expect(recorder).toBeDefined();
      expect(recorder).not.toBeNull();
      if (!recorder) throw new Error("recovery trajectory recorder was not created");
      await recorder.flush();
      const rows = readFileSync(recorder.filePath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(rows).toMatchObject([{
        type: "delivery.outward_ledger_transition",
        data: {
          rootRunId: "root-recovery",
          runId: "run-recovery",
          stepIndex: 2,
          transition: "commit",
          outcome: "committed",
          platformMessageId: "receipt-2",
        },
      }]);
      await trajectoryRegistry.closeAll();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an invalid or cross-agent recovery session authority", () => {
    const session = makeSession();
    const observer = createDeadLetterRecoveryObserver({
      dataDir: "/data",
      eventBus: new TypedEventBus(),
      logger: {} as never,
      trajectoryConfig: { enabled: true, maxFileBytes: 4_096 },
      sessionAdapters: new Map(),
      trajectoryRegistry: { getOrCreate: vi.fn() } as never,
    });

    expect(observer({ agentId: "agent-a", sessionKey: "invalid" }).ok).toBe(false);
    expect(observer({ agentId: "agent-b", sessionKey: session.formatted }).ok).toBe(false);
  });

  it("does not initialize a disabled or filtered trajectory", () => {
    const session = makeSession();
    const getOrCreate = vi.fn();
    const base = {
      dataDir: "/data",
      eventBus: new TypedEventBus(),
      logger: {} as never,
      sessionAdapters: new Map(),
      trajectoryRegistry: { getOrCreate } as never,
    };
    const disabled = createDeadLetterRecoveryObserver({
      ...base,
      trajectoryConfig: { enabled: false, maxFileBytes: 4_096 },
    });
    const filtered = createDeadLetterRecoveryObserver({
      ...base,
      trajectoryConfig: {
        enabled: true,
        maxFileBytes: 4_096,
        eventTypes: ["tool.result"],
      },
    });

    expect(disabled({ agentId: "agent-a", sessionKey: session.formatted })).toEqual(ok(undefined));
    expect(filtered({ agentId: "agent-a", sessionKey: session.formatted })).toEqual(ok(undefined));
    expect(getOrCreate).not.toHaveBeenCalled();
  });
});
