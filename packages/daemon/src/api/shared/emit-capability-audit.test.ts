// SPDX-License-Identifier: Apache-2.0
/**
 * `emitCapabilityAudit` allow-path classification acceptance tests.
 *
 * The allow-path `audit:event` MUST carry a `classification` that is a member of
 * the `AuditEventSchema` enum (`read | mutate | destructive`) OR omit the field
 * entirely — NEVER an out-of-enum sentinel. The durable sink (`auditEventToRow`)
 * silently coerces any non-enum value to `null`, so a sentinel loses the action
 * class for every allowed capability call.
 *
 * Cases pinned:
 *   1. READ-class caps (orch:read/web/analyze/browse) → classification "read".
 *   2. MUTATE-class caps (orch:write/message/spawn/graph/cron/skill) → "mutate".
 *   3. An UNRECOGNIZED cap → classification OMITTED (never the dropped "neutral").
 *   4. GROUND TRUTH — the emitted allow payload fed through the REAL
 *      `auditEventToRow` yields a NON-NULL enum classification (proving the sink
 *      no longer drops it — not just the emit payload).
 *   5. Regression guard — a DENY still emits classification "destructive".
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import type { EventMap } from "@comis/core";
import { emitCapabilityAudit } from "./emit-capability-audit.js";
import type {
  CapabilityAuditRecord,
  EmitCapabilityAuditDeps,
} from "./emit-capability-audit.js";
import { auditEventToRow } from "../../observability/obs-audit-sink.js";

/** Run the emitter over a stub eventBus and return the durable `audit:event` payload. */
function emitAndGetAuditEvent(
  record: CapabilityAuditRecord,
): EventMap["audit:event"] {
  const emitted: Array<{
    event: "audit:event" | "capability:audited";
    payload: EventMap["audit:event"] | EventMap["capability:audited"];
  }> = [];
  const deps: EmitCapabilityAuditDeps = {
    container: {
      eventBus: {
        emit: (event, payload) => {
          emitted.push({ event, payload });
        },
      },
      config: { tenantId: "tenant-a" },
    },
  };
  emitCapabilityAudit(deps, record);
  const entry = emitted.find((e) => e.event === "audit:event");
  if (entry === undefined) throw new Error("no audit:event was emitted");
  return entry.payload as EventMap["audit:event"];
}

/** A minimal ALLOW record for the capability under test (content-free fields). */
function allowRecord(capability: string): CapabilityAuditRecord {
  return {
    agentId: "agent-1",
    capability,
    method: "tool.invoke",
    decision: "allow",
  };
}

const READ_CAPS = ["orch:read", "orch:web", "orch:analyze", "orch:browse"];
const MUTATE_CAPS = [
  "orch:write",
  "orch:message",
  "orch:spawn",
  "orch:graph",
  "orch:cron",
  "orch:skill",
];

describe("emitCapabilityAudit — allow-path classification", () => {
  it.each(READ_CAPS)("classifies the read-class cap %s as read", (capability) => {
    const evt = emitAndGetAuditEvent(allowRecord(capability));
    expect(evt.classification).toBe("read");
  });

  it.each(MUTATE_CAPS)(
    "classifies the mutate-class cap %s as mutate",
    (capability) => {
      const evt = emitAndGetAuditEvent(allowRecord(capability));
      expect(evt.classification).toBe("mutate");
    },
  );

  it("omits classification for an unrecognized cap (never the dropped neutral)", () => {
    const evt = emitAndGetAuditEvent(allowRecord("some:other"));
    expect(evt.classification).toBeUndefined();
    expect("classification" in evt).toBe(false);
    expect(evt.classification).not.toBe("neutral");
  });

  // GROUND TRUTH: prove the SINK row (not just the emit payload) carries a
  // non-null classification. The sink coerces any out-of-enum value to null, so
  // the pre-patch "neutral" is lost here for every allowed call.
  it("yields a NON-NULL read sink-row classification for a read cap (auditEventToRow)", () => {
    const evt = emitAndGetAuditEvent(allowRecord("orch:read"));
    const row = auditEventToRow(evt, "tenant-a", "agent-1", undefined);
    expect(row.classification).not.toBeNull();
    expect(row.classification).toBe("read");
  });

  it("yields a mutate sink-row classification for a mutate cap (auditEventToRow)", () => {
    const evt = emitAndGetAuditEvent(allowRecord("orch:write"));
    const row = auditEventToRow(evt, "tenant-a", "agent-1", undefined);
    expect(row.classification).toBe("mutate");
  });

  it("regression: a DENY still emits classification destructive", () => {
    const evt = emitAndGetAuditEvent({
      agentId: "agent-1",
      capability: "orch:web",
      method: "tool.invoke",
      decision: "deny",
    });
    expect(evt.classification).toBe("destructive");
    expect(evt.kind).toBe("capability_denied");
    expect(evt.outcome).toBe("denied");
  });
});
