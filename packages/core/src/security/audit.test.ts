// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import type { AuditEvent, CreateAuditEventParams } from "./audit.js";
import { AuditEventSchema, createAuditEvent } from "./audit.js";

const VALID_PARAMS: CreateAuditEventParams = {
  tenantId: "tenant-1",
  agentId: "agent-1",
  userId: "user-1",
  actionType: "file.read",
  classification: "read",
  outcome: "success",
};

describe("createAuditEvent", () => {
  it("creates a valid audit event with auto-generated id and timestamp", () => {
    const event = createAuditEvent(VALID_PARAMS);

    expect(event.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(event.tenantId).toBe("tenant-1");
    expect(event.agentId).toBe("agent-1");
    expect(event.userId).toBe("user-1");
    expect(event.actionType).toBe("file.read");
    expect(event.classification).toBe("read");
    expect(event.outcome).toBe("success");
  });

  it("defaults metadata to empty object when not provided", () => {
    const event = createAuditEvent(VALID_PARAMS);
    expect(event.metadata).toEqual({});
  });

  it("includes metadata when provided", () => {
    const event = createAuditEvent({
      ...VALID_PARAMS,
      metadata: { filePath: "/tmp/test.txt", size: 1024 },
    });
    expect(event.metadata).toEqual({ filePath: "/tmp/test.txt", size: 1024 });
  });

  it("includes optional traceId when provided", () => {
    const event = createAuditEvent({
      ...VALID_PARAMS,
      traceId: "trace-abc-123",
    });
    expect(event.traceId).toBe("trace-abc-123");
  });

  it("includes optional duration when provided", () => {
    const event = createAuditEvent({
      ...VALID_PARAMS,
      duration: 42.5,
    });
    expect(event.duration).toBe(42.5);
  });

  it("generates unique ids for each event", () => {
    const event1 = createAuditEvent(VALID_PARAMS);
    const event2 = createAuditEvent(VALID_PARAMS);
    expect(event1.id).not.toBe(event2.id);
  });

  it("supports all classification types", () => {
    for (const classification of ["read", "mutate", "destructive"] as const) {
      const event = createAuditEvent({ ...VALID_PARAMS, classification });
      expect(event.classification).toBe(classification);
    }
  });

  it("supports all outcome types", () => {
    for (const outcome of ["success", "failure", "denied"] as const) {
      const event = createAuditEvent({ ...VALID_PARAMS, outcome });
      expect(event.outcome).toBe(outcome);
    }
  });
});

describe("AuditEventSchema", () => {
  it("validates a complete audit event", () => {
    const event: AuditEvent = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: "2026-01-01T00:00:00.000Z",
      tenantId: "tenant-1",
      agentId: "agent-1",
      userId: "user-1",
      actionType: "file.read",
      classification: "read",
      outcome: "success",
      metadata: {},
    };

    const result = AuditEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });

  it("rejects invalid UUID", () => {
    const result = AuditEventSchema.safeParse({
      id: "not-a-uuid",
      timestamp: "2026-01-01T00:00:00.000Z",
      tenantId: "t",
      agentId: "a",
      userId: "u",
      actionType: "file.read",
      classification: "read",
      outcome: "success",
      metadata: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty tenantId", () => {
    const result = AuditEventSchema.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: "2026-01-01T00:00:00.000Z",
      tenantId: "",
      agentId: "a",
      userId: "u",
      actionType: "file.read",
      classification: "read",
      outcome: "success",
      metadata: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields (strict mode)", () => {
    const result = AuditEventSchema.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: "2026-01-01T00:00:00.000Z",
      tenantId: "t",
      agentId: "a",
      userId: "u",
      actionType: "file.read",
      classification: "read",
      outcome: "success",
      metadata: {},
      extraField: "should-fail",
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative duration", () => {
    const result = AuditEventSchema.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: "2026-01-01T00:00:00.000Z",
      tenantId: "t",
      agentId: "a",
      userId: "u",
      actionType: "file.read",
      classification: "read",
      outcome: "success",
      metadata: {},
      duration: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid classification", () => {
    const result = AuditEventSchema.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: "2026-01-01T00:00:00.000Z",
      tenantId: "t",
      agentId: "a",
      userId: "u",
      actionType: "file.read",
      classification: "unknown",
      outcome: "success",
      metadata: {},
    });
    expect(result.success).toBe(false);
  });
});
