// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, expectTypeOf } from "vitest";
import type { AuditEvent, AuditKind, CreateAuditEventParams } from "./audit.js";
import { AuditEventSchema, createAuditEvent } from "./audit.js";
import type { EventMap } from "../event-bus/events.js";

const VALID_PARAMS: CreateAuditEventParams = {
  tenantId: "tenant-1",
  agentId: "agent-1",
  userId: "user-1",
  actionType: "file.read",
  kind: "audit",
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
      kind: "audit",
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
      kind: "audit",
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
      kind: "audit",
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
      kind: "audit",
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
      kind: "audit",
      classification: "read",
      outcome: "success",
      metadata: {},
      duration: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid classification (still a closed enum when present)", () => {
    const result = AuditEventSchema.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: "2026-01-01T00:00:00.000Z",
      tenantId: "t",
      agentId: "a",
      userId: "u",
      actionType: "file.read",
      kind: "audit",
      classification: "unknown",
      outcome: "success",
      metadata: {},
    });
    expect(result.success).toBe(false);
  });
});

// =====================================================================
// AUDIT-03 / E4 — the schema↔pipeline reshape (RED-first).
//
// The required `classification: read|mutate|destructive` enum was VIOLATED
// by 6 live `audit:event` emit sites passing "security"×3 / "write" /
// "neutral"×2. The reshape splits a closed `kind` (event family) from an
// OPTIONAL `classification`. These tests pin every live value so the
// schema/pipeline can never re-divorce (T-176-05/T-176-06).
// =====================================================================
describe("AuditEventSchema reshape (kind union + optional classification)", () => {
  // Test 1: a record with a kind and NO classification parses (optional).
  it("Test 1 — parses with a kind and NO classification (classification is optional)", () => {
    const event = createAuditEvent({
      tenantId: "t",
      agentId: "a",
      userId: "u",
      actionType: "injection_rate_exceeded",
      kind: "injection_rate_exceeded",
      outcome: "failure",
    });
    expect(event.kind).toBe("injection_rate_exceeded");
    expect(event.classification).toBeUndefined();
    // Schema accepts the constructed event with no classification key.
    expect(AuditEventSchema.safeParse(event).success).toBe(true);
  });

  // Test 2: the `audit` kind keeps an access-class classification.
  it("Test 2 — the audit kind keeps an optional classification (audit + destructive)", () => {
    const event = createAuditEvent({
      tenantId: "t",
      agentId: "a",
      userId: "u",
      actionType: "config.write",
      kind: "audit",
      classification: "destructive",
      outcome: "success",
    });
    expect(event.kind).toBe("audit");
    expect(event.classification).toBe("destructive");
  });

  // Test 3 (load-bearing): every one of the 6 live violating values
  // round-trips through createAuditEvent mapped to a kind, classification
  // UNSET, with NO schema throw. Re-grep-confirmed against HEAD.
  it("Test 3 — all 6 live violating classification values round-trip as a kind with no throw", () => {
    const liveSites: { actionType: string; kind: AuditKind }[] = [
      // classification:"security" ×3
      { actionType: "injection_rate_exceeded", kind: "injection_rate_exceeded" }, // executor-input-guard.ts:189
      { actionType: "output_guard", kind: "injection_detected" }, // executor-response-filter.ts:123
      { actionType: "hook_modification", kind: "hook_blocked" }, // hook-runner.ts:119
      // classification:"write"
      { actionType: "auth.set", kind: "auth_mutation" }, // auth-handlers.ts:402
      // classification:"neutral" ×2
      { actionType: "secrets.get", kind: "secret_access" }, // secrets-handlers.ts:202
      { actionType: "secrets.get", kind: "secret_access" }, // secrets-handlers.ts:226
    ];
    expect(liveSites).toHaveLength(6);
    for (const site of liveSites) {
      const event = createAuditEvent({
        tenantId: "t",
        agentId: "a",
        userId: "u",
        actionType: site.actionType,
        kind: site.kind,
        outcome: "failure",
      });
      expect(event.kind).toBe(site.kind);
      expect(event.classification).toBeUndefined();
      // The reshaped schema MUST NOT throw on any of the 6 live values.
      expect(() => AuditEventSchema.parse(event)).not.toThrow();
    }
  });

  // Test 4: kind is a CLOSED union — an unknown string is rejected.
  it("Test 4 — kind rejects an unknown string (closed union, not kind: string)", () => {
    const result = AuditEventSchema.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: "2026-01-01T00:00:00.000Z",
      tenantId: "t",
      agentId: "a",
      userId: "u",
      actionType: "file.read",
      kind: "totally-made-up",
      outcome: "success",
      metadata: {},
    });
    expect(result.success).toBe(false);
  });

  // Test 5: createAuditEvent remains the sole constructor — VALID_PARAMS
  // still produces a parsed event with the reshaped params.
  it("Test 5 — createAuditEvent remains the sole constructor (reshaped VALID_PARAMS)", () => {
    const event = createAuditEvent(VALID_PARAMS);
    expect(event.kind).toBe("audit");
    expect(event.classification).toBe("read");
    expect(AuditEventSchema.safeParse(event).success).toBe(true);
  });

  // Test 6 (type-level): the audit:event event-bus payload accepts an
  // optional kind?: AuditKind, and kind is the closed AuditKind union
  // (NOT string). Co-located here (the events-agent payload has no test).
  it("Test 6 — the audit:event payload accepts an optional kind?: AuditKind (closed union)", () => {
    type AuditEventPayload = EventMap["audit:event"];
    // The payload carries an optional `kind` typed as the closed AuditKind.
    expectTypeOf<AuditEventPayload>().toHaveProperty("kind");
    expectTypeOf<AuditEventPayload["kind"]>().toEqualTypeOf<AuditKind | undefined>();
    // Emitting a payload WITH a kind type-checks.
    const payload: AuditEventPayload = {
      timestamp: 1,
      agentId: "a",
      tenantId: "t",
      actionType: "secrets.get",
      kind: "secret_access",
      outcome: "success",
    };
    expect(payload.kind).toBe("secret_access");
  });
});
