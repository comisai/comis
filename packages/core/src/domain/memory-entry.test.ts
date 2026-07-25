// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  parseMemoryEntry,
  MemorySourceSchema,
  // Structured-extraction schemas + resolved-entity domain target
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
    tenantId: "tenant-1",
    agentId: "agent-1",
    userId: "user-42",
    visibility: { kind: "agent-shared" },
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

    it("requires an explicit tenant and agent scope", () => {
      const { tenantId: _tenantId, ...withoutTenant } = validEntry();
      const { agentId: _agentId, ...withoutAgent } = validEntry();
      expect(parseMemoryEntry(withoutTenant).ok).toBe(false);
      expect(parseMemoryEntry(withoutAgent).ok).toBe(false);
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

    it("accepts an optional tags array on a memory", () => {
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

  describe("memoryType field (persisted classification)", () => {
    it("accepts MemoryEntry with an explicit memoryType", () => {
      const result = parseMemoryEntry(validEntry({ memoryType: "episodic" }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.memoryType).toBe("episodic");
      }
    });

    it("MemoryEntry without memoryType still parses (the field is optional — additive)", () => {
      const result = parseMemoryEntry(validEntry());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.memoryType).toBeUndefined();
      }
    });

    it("accepts all valid memoryType values (mirrors the column CHECK set)", () => {
      for (const memoryType of [
        "working",
        "episodic",
        "semantic",
        "procedural",
      ] as const) {
        const result = parseMemoryEntry(validEntry({ memoryType }));
        expect(result.ok).toBe(true);
      }
    });

    it("rejects an out-of-set memoryType value (the enum guards the CHECK constraint)", () => {
      const result = parseMemoryEntry(validEntry({ memoryType: "bogus" }));
      expect(result.ok).toBe(false);
    });
  });

  describe("observationKind + patternType fields (typed reasoning observations)", () => {
    it("accepts MemoryEntry with an inductive observationKind AND a patternType (both round-trip through safeParse)", () => {
      const result = parseMemoryEntry(
        validEntry({ observationKind: "inductive", patternType: "preference" }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.observationKind).toBe("inductive");
        expect(result.value.patternType).toBe("preference");
      }
    });

    it("MemoryEntry without observationKind/patternType still parses (the fields are optional — additive, existing callers unaffected)", () => {
      const result = parseMemoryEntry(validEntry());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.observationKind).toBeUndefined();
        expect(result.value.patternType).toBeUndefined();
      }
    });

    it("accepts all valid observationKind values (the closed reasoning-kind set)", () => {
      for (const observationKind of ["merge", "deductive", "inductive", "generalization"] as const) {
        const result = parseMemoryEntry(validEntry({ observationKind }));
        expect(result.ok).toBe(true);
      }
    });

    it("accepts the generalization observationKind (the higher-order synthesis kind)", () => {
      // The higher-order generalization kind — a
      // semantic memory abstracting a cross-context cluster, written by
      // runMemoryConsolidation.
      const result = parseMemoryEntry(validEntry({ observationKind: "generalization" }));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.observationKind).toBe("generalization");
    });

    it("accepts all valid patternType values (the closed inductive pattern class set)", () => {
      for (const patternType of [
        "preference",
        "behavior",
        "personality",
        "tendency",
        "correlation",
      ] as const) {
        const result = parseMemoryEntry(validEntry({ patternType }));
        expect(result.ok).toBe(true);
      }
    });

    it("rejects an out-of-set observationKind value (the enum is closed)", () => {
      const result = parseMemoryEntry(validEntry({ observationKind: "bogus" }));
      expect(result.ok).toBe(false);
    });

    it("rejects an out-of-set patternType value (the enum is closed)", () => {
      const result = parseMemoryEntry(validEntry({ patternType: "bogus" }));
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

  it("STRIPS a benign extra key like type instead of rejecting the entity", () => {
    // The extraction LLM naturally emits { name, type: "person" }. A
    // strictObject would reject it — failing the memory and discarding the WHOLE
    // extraction batch. There is still no `type` field in the domain
    // (the entity table is canonical_name-only); it is stripped, not carried.
    const result = ExtractedEntitySchema.safeParse({ name: "user", type: "person" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("user");
      expect("type" in result.data).toBe(false);
    }
  });
});

describe("StructuredMemorySchema (lenient LLM output)", () => {
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

  it("STRIPS a benign extra LLM key instead of rejecting the memory", () => {
    // The LLM may emit { confidence: 0.9 }; a lenient z.object must keep the valid
    // content and drop the unknown key — NOT discard the whole memory.
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

  it("accepts plain string entities and normalizes them to { name }", () => {
    // The extraction LLM emits "entities": ["user", "Biscuit"] — if only
    // objects were accepted, every memory in such a batch would fail on this field.
    const result = StructuredMemorySchema.safeParse({
      content: "User has a golden retriever named Biscuit.",
      entities: ["user", "Biscuit"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.entities).toEqual([{ name: "user" }, { name: "Biscuit" }]);
    }
  });

  it("accepts mixed string and object entities in one array", () => {
    const result = StructuredMemorySchema.safeParse({
      content: "x",
      entities: ["user", { name: "Maya", type: "person" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.entities).toEqual([{ name: "user" }, { name: "Maya" }]);
    }
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

  // -------------------------------------------------------------------------
  // The additive LENIENT `causes` field.
  //
  // The fact stated in `content` is the CAUSE; each `effect` string is a
  // consequence (the cause is the memory's own content). The field is
  // ADDITIVE (defaults to []) and the schema stays LENIENT (`z.object`): an
  // omitting LLM is unaffected, a benign extra key is still stripped (NOT
  // rejected), but the typed `{ effect: string.min(1) }` shape still REJECTS
  // garbage (injection-safe — a forged edge cannot smuggle a non-string body).
  // -------------------------------------------------------------------------

  it("accepts a causal pair on the additive `causes` field", () => {
    const result = StructuredMemorySchema.safeParse({ content: "x", causes: [{ effect: "y" }] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.causes).toEqual([{ effect: "y" }]);
    }
  });

  it("defaults `causes` to [] when omitted (additive — an extraction that omits it is unaffected)", () => {
    const result = StructuredMemorySchema.safeParse({ content: "x" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.causes).toEqual([]);
    }
  });

  it("STILL strips a benign extra LLM key alongside causes (LENIENT z.object preserved — NOT strictObject)", () => {
    // Adding `causes` must not flip StructuredMemorySchema to strict: an
    // unrequested top-level key (`confidence`) is dropped, not rejected.
    const result = StructuredMemorySchema.safeParse({
      content: "x",
      causes: [{ effect: "y" }],
      confidence: 0.9,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect("confidence" in result.data).toBe(false);
      expect(result.data.causes).toEqual([{ effect: "y" }]);
    }
  });

  it("rejects a causes entry with an empty effect (effect.min(1) — garbage still rejected)", () => {
    const result = StructuredMemorySchema.safeParse({ content: "x", causes: [{ effect: "" }] });
    expect(result.success).toBe(false);
  });

  it("rejects a causes entry whose effect is not a string (typed — a forged non-string edge is rejected)", () => {
    const result = StructuredMemorySchema.safeParse({ content: "x", causes: [{ effect: 42 }] });
    expect(result.success).toBe(false);
  });

  it("STRIPS an unknown key on a causes entry instead of rejecting the whole memory", () => {
    // Same lenient-parse contract as `entities`: an extra key on one cause must
    // not fail the memory and discard the whole extraction batch. `effect` stays
    // required + non-empty; the extra key is stripped.
    const result = StructuredMemorySchema.safeParse({
      content: "x",
      entities: [],
      causes: [{ effect: "y", cause: "z" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.causes).toEqual([{ effect: "y" }]);
    }
  });
});

describe("MemoryExtractionResultSchema (envelope)", () => {
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

describe("MemoryEntitySchema (resolved-entity domain target — strict)", () => {
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

describe("MemorySource type export (provenance shape)", () => {
  it("is importable as a type and round-trips through MemorySourceSchema", () => {
    const s: MemorySource = { who: "system", channel: "memory-review" };
    const result = MemorySourceSchema.parse(s);
    expect(result.who).toBe("system");
    expect(result.channel).toBe("memory-review");
  });
});
