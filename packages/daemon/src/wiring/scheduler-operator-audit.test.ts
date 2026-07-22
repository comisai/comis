// SPDX-License-Identifier: Apache-2.0
import { TypedEventBus } from "@comis/core";
import { describe, expect, it, vi } from "vitest";
import { emitSchedulerOperatorAudit } from "./scheduler-operator-audit.js";

function setup() {
  const eventBus = new TypedEventBus();
  const auditEvent = vi.fn();
  const logger = { warn: vi.fn() };
  eventBus.on("audit:event", auditEvent);
  return { eventBus, auditEvent, logger };
}

describe("scheduler operator audit publisher", () => {
  it("publishes an accepted mutation through the durable audit-event seam", () => {
    const data = setup();

    emitSchedulerOperatorAudit({
      tenantId: "tenant-a",
      eventBus: data.eventBus,
      logger: data.logger,
      nowMs: () => 1_000,
    }, {
      agentId: "agent-a",
      actionType: "tasks.cancel",
      classification: "mutate",
      decision: "accepted",
      metadata: { targetTaskIds: ["task-a"] },
    });

    expect(data.auditEvent).toHaveBeenCalledWith({
      timestamp: 1_000,
      agentId: "agent-a",
      tenantId: "tenant-a",
      actionType: "tasks.cancel",
      kind: "audit",
      classification: "mutate",
      outcome: "success",
      metadata: {
        actorScope: "admin",
        decision: "accepted",
        targetTaskIds: ["task-a"],
      },
    });
  });

  it("isolates a broken durable-audit subscriber from an operator denial", () => {
    const data = setup();
    data.eventBus.on("audit:event", () => {
      throw new Error("subscriber failed");
    });

    expect(() => emitSchedulerOperatorAudit({
      tenantId: "tenant-a",
      eventBus: data.eventBus,
      logger: data.logger,
      nowMs: () => 2_000,
    }, {
      agentId: "agent-a",
      actionType: "tasks.reset",
      classification: "destructive",
      decision: "rejected",
      metadata: { code: "feature_enabled", expectedDigest: "a".repeat(64) },
    })).not.toThrow();
    expect(data.logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "audit:event",
      subscriberFailureCount: 1,
      errorKind: "internal",
    }), "Observational event subscriber failed");
  });
});
