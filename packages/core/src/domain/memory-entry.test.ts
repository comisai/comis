// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  parseMemoryEntry,
  MemorySourceSchema,
  // Phase 82 — structured-extraction schemas (EXTR-01) + Phase-83 domain target
  MemoryExtractionResultSchema,
  StructuredMemorySchema,
  ExtractedEntitySchema,
  MemoryEntitySchema,
  type MemorySource,
} from "./memory-entry.js";

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

describe("ExtractedEntitySchema", () => {
  it("accepts a minimal entity mention { name }", () => {
    const result = ExtractedEntitySchema.safeParse({ name: "user" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("user");
    }
  });

  it("rejects an empty name (min(1))", () => {
    const result = ExtractedEntitySchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown key (strict internal contract)", () => {
    // ExtractedEntitySchema is strict — there is NO `type` field (design §4.2 canonical_name-only).
    const result = ExtractedEntitySchema.safeParse({ name: "user", type: "person" });
    expect(result.success).toBe(false);
  });
});

describe("StructuredMemorySchema (lenient LLM output — EXTR-01)", () => {
  it("parses a valid structured memory", () => {
    const result = StructuredMemorySchema.safeParse({
      content: "X",
      entities: [],
      occurredAt: "2024-01-01T00:00:00Z",
      memoryType: "semantic",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.content).toBe("X");
      expect(result.data.occurredAt).toBe("2024-01-01T00:00:00Z");
    }
  });

  it("STRIPS a benign extra LLM key instead of rejecting (Pitfall 5)", () => {
    // The LLM may emit { confidence: 0.9 }; a lenient z.object must keep the valid
    // content and drop the unknown key — NOT discard the whole memory (EXTR-01).
    const result = StructuredMemorySchema.safeParse({
      content: "X",
      entities: [],
      confidence: 0.9,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.content).toBe("X");
      // unknown key is stripped, not carried through
      expect("confidence" in result.data).toBe(false);
    }
  });

  it("rejects a memory missing content", () => {
    const result = StructuredMemorySchema.safeParse({ entities: [] });
    expect(result.success).toBe(false);
  });

  it("rejects empty content (min(1))", () => {
    const result = StructuredMemorySchema.safeParse({ content: "", entities: [] });
    expect(result.success).toBe(false);
  });

  it("defaults entities to [] when omitted", () => {
    const result = StructuredMemorySchema.safeParse({ content: "X" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.entities).toEqual([]);
    }
  });

  it("defaults memoryType to 'semantic' when omitted", () => {
    const result = StructuredMemorySchema.safeParse({ content: "X" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.memoryType).toBe("semantic");
    }
  });

  it("treats occurredAt as an OPTIONAL string (ISO 8601 from the LLM, not yet epoch ms)", () => {
    const omitted = StructuredMemorySchema.safeParse({ content: "X" });
    expect(omitted.success).toBe(true);
    if (omitted.success) {
      expect(omitted.data.occurredAt).toBeUndefined();
    }
    // A number must NOT satisfy the string-typed output field.
    const numeric = StructuredMemorySchema.safeParse({ content: "X", occurredAt: 1_700_000_000_000 });
    expect(numeric.success).toBe(false);
  });

  it("validates nested entities", () => {
    const ok = StructuredMemorySchema.safeParse({ content: "X", entities: [{ name: "user" }] });
    expect(ok.success).toBe(true);
    const bad = StructuredMemorySchema.safeParse({ content: "X", entities: [{ name: "" }] });
    expect(bad.success).toBe(false);
  });
});

describe("MemoryExtractionResultSchema (envelope — EXTR-01)", () => {
  it("parses { memories: [...] }", () => {
    const result = MemoryExtractionResultSchema.safeParse({
      memories: [
        { content: "X", entities: [], occurredAt: "2024-01-01T00:00:00Z", memoryType: "semantic" },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.memories[0]?.content).toBe("X");
    }
  });

  it("parses an empty memories array", () => {
    const result = MemoryExtractionResultSchema.safeParse({ memories: [] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.memories).toEqual([]);
    }
  });

  it("tolerates a benign extra key at the envelope level (lenient)", () => {
    const result = MemoryExtractionResultSchema.safeParse({
      memories: [{ content: "X" }],
      note: "extra-from-llm",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect("note" in result.data).toBe(false);
    }
  });

  it("rejects a missing memories array", () => {
    const result = MemoryExtractionResultSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("MemoryEntitySchema (Phase-83 domain target — strict)", () => {
  function validEntity(overrides: Record<string, unknown> = {}) {
    return {
      id: VALID_UUID,
      tenantId: "default",
      agentId: "default",
      canonicalName: "user",
      mentionCount: 1,
      firstSeen: 1_700_000_000_000,
      lastSeen: 1_700_000_000_000,
      ...overrides,
    };
  }

  it("parses a full valid entity", () => {
    const result = MemoryEntitySchema.safeParse(validEntity());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.canonicalName).toBe("user");
      expect(result.data.mentionCount).toBe(1);
    }
  });

  it("rejects mentionCount: 0 (must be a positive int)", () => {
    const result = MemoryEntitySchema.safeParse(validEntity({ mentionCount: 0 }));
    expect(result.success).toBe(false);
  });

  it("rejects an invalid id (must be a guid)", () => {
    const result = MemoryEntitySchema.safeParse(validEntity({ id: "bad" }));
    expect(result.success).toBe(false);
  });

  it("rejects an empty canonicalName", () => {
    const result = MemoryEntitySchema.safeParse(validEntity({ canonicalName: "" }));
    expect(result.success).toBe(false);
  });

  it("rejects an unknown key (strict domain contract)", () => {
    const result = MemoryEntitySchema.safeParse(validEntity({ extra: true }));
    expect(result.success).toBe(false);
  });
});

describe("MemorySource type export (provenance shape — EXTR-04)", () => {
  it("is importable as a type and round-trips through MemorySourceSchema", () => {
    const s: MemorySource = { who: "system", channel: "memory-review" };
    const result = MemorySourceSchema.parse(s);
    expect(result.who).toBe("system");
    expect(result.channel).toBe("memory-review");
  });
});
