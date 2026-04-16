import { describe, expect, it } from "vitest";
import { parseMemoryEntry } from "./memory-entry.js";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

function validEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: VALID_UUID,
    userId: "user-42",
    content: "The user prefers dark mode.",
    trustLevel: "learned",
    source: { who: "agent" },
    createdAt: 1700000000,
    ...overrides,
  };
}

describe("MemoryEntry", () => {
  describe("valid data", () => {
    it("parses a minimal valid entry", () => {
      const result = parseMemoryEntry(validEntry());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe(VALID_UUID);
        expect(result.value.userId).toBe("user-42");
        expect(result.value.trustLevel).toBe("learned");
      }
    });

    it("applies default tenantId", () => {
      const result = parseMemoryEntry(validEntry());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.tenantId).toBe("default");
      }
    });

    it("applies default tags", () => {
      const result = parseMemoryEntry(validEntry());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.tags).toEqual([]);
      }
    });

    it("accepts explicit tenantId override", () => {
      const result = parseMemoryEntry(validEntry({ tenantId: "acme-corp" }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.tenantId).toBe("acme-corp");
      }
    });

    it("accepts all trust levels", () => {
      for (const trustLevel of ["system", "learned", "external"] as const) {
        const result = parseMemoryEntry(validEntry({ trustLevel }));
        expect(result.ok).toBe(true);
      }
    });

    it("accepts optional embedding", () => {
      const result = parseMemoryEntry(validEntry({ embedding: [0.1, 0.2, 0.3] }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.embedding).toEqual([0.1, 0.2, 0.3]);
      }
    });

    it("allows omitting optional fields (embedding, updatedAt, expiresAt)", () => {
      const result = parseMemoryEntry(validEntry());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.embedding).toBeUndefined();
        expect(result.value.updatedAt).toBeUndefined();
        expect(result.value.expiresAt).toBeUndefined();
      }
    });

    it("accepts tags array", () => {
      const result = parseMemoryEntry(validEntry({ tags: ["preference", "ui"] }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.tags).toEqual(["preference", "ui"]);
      }
    });

    it("accepts source with channel and sessionKey", () => {
      const result = parseMemoryEntry(
        validEntry({
          source: {
            who: "agent",
            channel: "telegram",
            sessionKey: "default:user-42:general",
          },
        }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.source.channel).toBe("telegram");
        expect(result.value.source.sessionKey).toBe("default:user-42:general");
      }
    });
  });

  describe("invalid data", () => {
    it("rejects missing required fields", () => {
      const result = parseMemoryEntry({});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const paths = result.error.issues.map((i) => i.path[0]);
        expect(paths).toContain("id");
        expect(paths).toContain("userId");
        expect(paths).toContain("content");
        expect(paths).toContain("trustLevel");
        expect(paths).toContain("source");
        expect(paths).toContain("createdAt");
      }
    });

    it("rejects invalid UUID for id", () => {
      const result = parseMemoryEntry(validEntry({ id: "bad" }));
      expect(result.ok).toBe(false);
    });

    it("rejects empty userId", () => {
      const result = parseMemoryEntry(validEntry({ userId: "" }));
      expect(result.ok).toBe(false);
    });

    it("rejects empty content", () => {
      const result = parseMemoryEntry(validEntry({ content: "" }));
      expect(result.ok).toBe(false);
    });

    it("rejects invalid trustLevel", () => {
      const result = parseMemoryEntry(validEntry({ trustLevel: "untrusted" }));
      expect(result.ok).toBe(false);
    });

    it("rejects non-integer createdAt", () => {
      const result = parseMemoryEntry(validEntry({ createdAt: 1.5 }));
      expect(result.ok).toBe(false);
    });

    it("rejects zero createdAt", () => {
      const result = parseMemoryEntry(validEntry({ createdAt: 0 }));
      expect(result.ok).toBe(false);
    });

    it("rejects empty tenantId", () => {
      const result = parseMemoryEntry(validEntry({ tenantId: "" }));
      expect(result.ok).toBe(false);
    });

    it("strips extra/unknown fields", () => {
      const result = parseMemoryEntry(validEntry({ extraField: true }));
      expect(result.ok).toBe(false);
    });

    it("returns descriptive ZodError issues", () => {
      const result = parseMemoryEntry({ id: 42 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.issues.length).toBeGreaterThan(0);
        for (const issue of result.error.issues) {
          expect(issue.message).toBeTruthy();
        }
      }
    });
  });

  describe("taintLevel and sourceType fields", () => {
    it("accepts MemoryEntry with taintLevel and sourceType", () => {
      const result = parseMemoryEntry(
        validEntry({ taintLevel: "wrapped", sourceType: "web" }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.taintLevel).toBe("wrapped");
        expect(result.value.sourceType).toBe("web");
      }
    });

    it("MemoryEntry without taintLevel and sourceType still parses (fields are optional)", () => {
      const result = parseMemoryEntry(validEntry());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.taintLevel).toBeUndefined();
        expect(result.value.sourceType).toBeUndefined();
      }
    });

    it("accepts all valid taintLevel values", () => {
      for (const taintLevel of ["clean", "wrapped", "raw"] as const) {
        const result = parseMemoryEntry(validEntry({ taintLevel }));
        expect(result.ok).toBe(true);
      }
    });

    it("accepts all valid sourceType values", () => {
      for (const sourceType of [
        "system",
        "conversation",
        "tool",
        "web",
        "api",
        "unknown",
      ] as const) {
        const result = parseMemoryEntry(validEntry({ sourceType }));
        expect(result.ok).toBe(true);
      }
    });

    it("rejects invalid taintLevel value", () => {
      const result = parseMemoryEntry(validEntry({ taintLevel: "dirty" }));
      expect(result.ok).toBe(false);
    });

    it("rejects invalid sourceType value", () => {
      const result = parseMemoryEntry(validEntry({ sourceType: "magic" }));
      expect(result.ok).toBe(false);
    });
  });
});
