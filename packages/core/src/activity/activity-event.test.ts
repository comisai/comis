// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, expectTypeOf } from "vitest";
import {
  parseActivityEvent,
  ActivityEventSchema,
  RedactedParamsSchema,
  type ActivityEvent,
  type ActivityParseError,
} from "./activity-event.js";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const VALID_UUID_2 = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const VALID_TS = "2026-05-26T06:00:00.000Z";

function validApproval() {
  return {
    shortId: "aB3xY9zK2mNp",
    expiresAt: 1700000000000,
    choices: [
      { id: "approve", defaultLabel: "Approve", style: "primary" },
      { id: "deny", defaultLabel: "Deny", style: "danger" },
    ],
  };
}

function validEvent(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    activityId: VALID_UUID,
    sessionKey: "sess-1",
    agentId: "agent-1",
    traceId: "trace-1",
    ts: VALID_TS,
    phase: "start",
    status: "running",
    kind: "tool",
    semanticPhase: "tool",
    ...overrides,
  };
}

describe("ActivityEvent", () => {
  describe("valid envelope", () => {
    it("parses a fully-valid minimal tool event into ok(event)", () => {
      const result = parseActivityEvent(validEvent());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.activityId).toBe(VALID_UUID);
        expect(result.value.kind).toBe("tool");
        expect(result.value.semanticPhase).toBe("tool");
        expect(result.value.schemaVersion).toBe(1);
      }
    });

    it("accepts optional envelope fields (parentActivityId, channelKey, toolCallId, toolName, action)", () => {
      const result = parseActivityEvent(
        validEvent({
          parentActivityId: VALID_UUID_2,
          channelKey: "telegram:123",
          toolCallId: "call-abc",
          toolName: "Bash",
          action: "run",
          durationMs: 0,
          defaultLabel: "running Bash",
          defaultDetail: "executing the command",
        }),
      );
      expect(result.ok).toBe(true);
    });
  });

  describe("z.strictObject rejects unknown keys (T-70-01-01)", () => {
    it("rejects an unknown top-level key", () => {
      const result = parseActivityEvent(validEvent({ bogus: 1 }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("schema");
        expect(result.error.issues.length).toBeGreaterThan(0);
      }
    });
  });

  describe("closed classification enums", () => {
    it("rejects an out-of-enum phase", () => {
      expect(parseActivityEvent(validEvent({ phase: "middle" })).ok).toBe(false);
    });
    it("rejects an out-of-enum status", () => {
      expect(parseActivityEvent(validEvent({ status: "pending" })).ok).toBe(false);
    });
    it("rejects an out-of-enum kind", () => {
      expect(parseActivityEvent(validEvent({ kind: "magic" })).ok).toBe(false);
    });
    it("rejects an out-of-enum semanticPhase", () => {
      expect(parseActivityEvent(validEvent({ semanticPhase: "dancing" })).ok).toBe(false);
    });
  });

  describe("errorKind closed 10-value union (T-70-01-04)", () => {
    it("accepts errorKind 'precondition'", () => {
      expect(parseActivityEvent(validEvent({ errorKind: "precondition" })).ok).toBe(true);
    });
    it("accepts all 10 ErrorKind values", () => {
      const all = [
        "config", "network", "auth", "validation", "precondition",
        "timeout", "resource", "dependency", "internal", "platform",
      ];
      for (const errorKind of all) {
        expect(parseActivityEvent(validEvent({ errorKind })).ok).toBe(true);
      }
    });
    it("rejects errorKind 'badkind'", () => {
      expect(parseActivityEvent(validEvent({ errorKind: "badkind" })).ok).toBe(false);
    });
  });

  describe("overlong label/detail surface too_big inside the single schema variant (T-70-01-03)", () => {
    it("surfaces a too_big issue for defaultLabel of length 121", () => {
      const result = parseActivityEvent(validEvent({ defaultLabel: "x".repeat(121) }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("schema");
        expect(result.error.issues.some((i) => i.code === "too_big")).toBe(true);
      }
    });
    it("surfaces a too_big issue for defaultDetail of length 281", () => {
      const result = parseActivityEvent(validEvent({ defaultDetail: "x".repeat(281) }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.issues.some((i) => i.code === "too_big")).toBe(true);
      }
    });
    it("accepts defaultLabel of length 120 and defaultDetail of length 280 (boundary)", () => {
      const result = parseActivityEvent(
        validEvent({ defaultLabel: "x".repeat(120), defaultDetail: "x".repeat(280) }),
      );
      expect(result.ok).toBe(true);
    });
  });

  describe("recursive RedactedParamsSchema (ACT-03)", () => {
    it("accepts a nested object with arrays of scalars", () => {
      const result = parseActivityEvent(validEvent({ params: { a: { b: [1, "x", true] } } }));
      expect(result.ok).toBe(true);
    });
    it("accepts null leaves and deeply nested records", () => {
      expect(
        RedactedParamsSchema.safeParse({ a: null, b: { c: { d: [["nested"], 2] } } }).success,
      ).toBe(true);
    });
    it("rejects a non-scalar leaf (function)", () => {
      const result = parseActivityEvent(validEvent({ params: { a: () => 1 } }));
      expect(result.ok).toBe(false);
    });
  });

  describe("approval refine: present iff kind === 'approval' (T-70-01-02)", () => {
    it("accepts kind 'approval' WITH an approval block", () => {
      const result = parseActivityEvent(
        validEvent({ kind: "approval", approval: validApproval() }),
      );
      expect(result.ok).toBe(true);
    });
    it("rejects kind 'approval' WITHOUT an approval block", () => {
      expect(parseActivityEvent(validEvent({ kind: "approval" })).ok).toBe(false);
    });
    it("rejects a non-approval kind that carries an approval block", () => {
      expect(
        parseActivityEvent(validEvent({ kind: "tool", approval: validApproval() })).ok,
      ).toBe(false);
    });
  });

  describe("parseActivityEvent NEVER throws (ACT-02)", () => {
    it("returns err({kind:'schema'}) for null without throwing", () => {
      const result = parseActivityEvent(null);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("schema");
        expect(Array.isArray(result.error.issues)).toBe(true);
      }
    });
    it("returns err for a bare number without throwing", () => {
      expect(parseActivityEvent(42).ok).toBe(false);
    });
    it("returns err for an empty object without throwing", () => {
      const result = parseActivityEvent({});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.issues.length).toBeGreaterThan(0);
      }
    });
  });

  describe("type inference", () => {
    it("infers ActivityEvent from the schema", () => {
      expectTypeOf<ActivityEvent>().toEqualTypeOf<typeof ActivityEventSchema._output>();
    });
    it("tags ActivityParseError with kind 'schema'", () => {
      expectTypeOf<ActivityParseError>().toMatchTypeOf<{ kind: "schema" }>();
    });
  });
});
