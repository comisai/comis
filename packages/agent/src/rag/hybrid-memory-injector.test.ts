// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import type { MemorySearchResult } from "@comis/core";
import { createHybridMemoryInjector } from "./hybrid-memory-injector.js";

/** Helper to create a mock MemorySearchResult. */
function mockResult(
  content: string,
  score: number,
  date?: string,
  occurredDate?: string,
  userId = "memory-owner",
): MemorySearchResult {
  return {
    entry: {
      id: `mem-${Math.random().toString(36).slice(2, 8)}`,
      tenantId: "test-tenant",
      agentId: "test-agent",
      userId,
      content,
      createdAt: date ? new Date(date).getTime() : Date.now(),
      ...(occurredDate !== undefined ? { occurredAt: new Date(occurredDate).getTime() } : {}),
      tags: [],
      trustLevel: "learned",
      source: { channel: "test" },
    },
    score,
  };
}

describe("hybrid-memory-injector", () => {
  describe("createHybridMemoryInjector", () => {
    it("returns empty results for no memories", () => {
      const injector = createHybridMemoryInjector();
      const result = injector.split([], 5000);
      expect(result.inlineMemory).toBeUndefined();
      expect(result.systemPromptSections).toEqual([]);
    });

    it("inlines top-1 when score meets threshold", () => {
      const injector = createHybridMemoryInjector();
      const results = [mockResult("User prefers dark mode", 0.85, "2026-01-15")];
      const result = injector.split(results, 5000);

      expect(result.inlineMemory).toBeDefined();
      expect(result.inlineMemory).toContain("User prefers dark mode");
      expect(result.inlineMemory).toContain("recorded 2026-01-15");
      // No occurredAt → no "occurred" segment (recorded-only inline format unchanged).
      expect(result.inlineMemory).not.toContain("occurred ");
      expect(result.systemPromptSections).toEqual([]);
    });

    it("keeps cross-sender memory out of the user-message inline position", () => {
      const injector = createHybridMemoryInjector({ requesterUserId: "current-user" });
      const results = [
        mockResult("Vehicle 16333301 belongs to the other sender", 0.85, "2026-01-15"),
      ];

      const result = injector.split(results, 5000);

      expect(result.inlineMemory).toBeUndefined();
      expect(result.systemPromptSections).toHaveLength(1);
      expect(result.systemPromptSections[0]).toContain("another sender");
      expect(result.systemPromptSections[0]).toContain("Do not attribute personal facts");
      expect(result.systemPromptSections[0]).toContain("identity, ownership, preferences, or authorization");
      expect(result.systemPromptSections[0]).toContain("Vehicle 16333301 belongs to the other sender");
    });

    it("keeps same-sender inline memory free of a foreign-provenance warning", () => {
      const injector = createHybridMemoryInjector({ requesterUserId: "memory-owner" });
      const result = injector.split([mockResult("User prefers dark mode", 0.85)], 5000);

      expect(result.inlineMemory).not.toContain("another sender");
    });

    it("inlines BOTH recorded and occurred dates when occurredAt is present", () => {
      const injector = createHybridMemoryInjector();
      const results = [
        mockResult("Discussed the launch on the 3rd", 0.85, "2026-01-15", "2026-01-03"),
      ];
      const result = injector.split(results, 5000);

      expect(result.inlineMemory).toBeDefined();
      expect(result.inlineMemory).toContain("recorded 2026-01-15");
      expect(result.inlineMemory).toContain("occurred 2026-01-03");
    });

    it("puts top-1 in system prompt when score below threshold", () => {
      const injector = createHybridMemoryInjector();
      const results = [mockResult("Some vague memory", 0.5)];
      const result = injector.split(results, 5000);

      expect(result.inlineMemory).toBeUndefined();
      expect(result.systemPromptSections.length).toBe(1);
      expect(result.systemPromptSections[0]).toContain("Some vague memory");
    });

    it("splits 3 results: top-1 inline, rest in system prompt", () => {
      const injector = createHybridMemoryInjector();
      const results = [
        mockResult("Most relevant memory", 0.9),
        mockResult("Second memory", 0.75),
        mockResult("Third memory", 0.6),
      ];
      const result = injector.split(results, 5000);

      expect(result.inlineMemory).toContain("Most relevant memory");
      expect(result.systemPromptSections.length).toBe(1);
      expect(result.systemPromptSections[0]).toContain("Second memory");
      expect(result.systemPromptSections[0]).toContain("Third memory");
    });

    it("respects custom inlineMinScore", () => {
      const injector = createHybridMemoryInjector({ inlineMinScore: 0.95 });
      const results = [mockResult("High relevance memory", 0.9)];
      const result = injector.split(results, 5000);

      // 0.9 < 0.95, so should NOT be inlined
      expect(result.inlineMemory).toBeUndefined();
      expect(result.systemPromptSections.length).toBe(1);
    });

    it("enforces maxChars budget on system prompt sections", () => {
      const injector = createHybridMemoryInjector();
      const results = [
        mockResult("Top memory", 0.9),
        mockResult("A".repeat(500), 0.8),
        mockResult("B".repeat(500), 0.7),
      ];
      // Very small budget -- may not fit all remaining
      const result = injector.split(results, 100);

      expect(result.inlineMemory).toContain("Top memory");
      // System prompt sections may be empty if budget too small for header
      // The important thing is it doesn't crash
      expect(result.systemPromptSections.length).toBeLessThanOrEqual(1);
    });

    it("enforces maxChars across inline and system recall together", () => {
      const injector = createHybridMemoryInjector({ requesterUserId: "memory-owner" });
      const maxChars = 4000;
      const result = injector.split(
        [
          mockResult("T".repeat(1000), 0.9),
          mockResult("A".repeat(1500), 0.8),
          mockResult("B".repeat(1500), 0.7),
        ],
        maxChars,
      );

      const injectedChars =
        (result.inlineMemory?.length ?? 0) +
        result.systemPromptSections.reduce((total, section) => total + section.length, 0);
      expect(injectedChars).toBeLessThanOrEqual(maxChars);
    });

    it("does not emit an inline block larger than the total recall budget", () => {
      const injector = createHybridMemoryInjector({ requesterUserId: "memory-owner" });
      const maxChars = 400;
      const result = injector.split([mockResult("T".repeat(1000), 0.9)], maxChars);

      const injectedChars =
        (result.inlineMemory?.length ?? 0) +
        result.systemPromptSections.reduce((total, section) => total + section.length, 0);
      expect(injectedChars).toBeLessThanOrEqual(maxChars);
    });

    it("handles results with undefined score (treats as 0)", () => {
      const injector = createHybridMemoryInjector();
      const result: MemorySearchResult = {
        entry: {
          id: "mem-1",
          tenantId: "test",
          content: "No score memory",
          createdAt: Date.now(),
          tags: [],
          trustLevel: "learned",
          source: { channel: "test" },
        },
        // score is undefined
      };
      const injection = injector.split([result], 5000);

      // undefined score -> 0, which is below 0.7 threshold
      expect(injection.inlineMemory).toBeUndefined();
      expect(injection.systemPromptSections.length).toBe(1);
    });

    it("all results go to system prompt when none meet threshold", () => {
      const injector = createHybridMemoryInjector({ inlineMinScore: 0.95 });
      const results = [
        mockResult("Memory A", 0.8),
        mockResult("Memory B", 0.7),
      ];
      const result = injector.split(results, 5000);

      expect(result.inlineMemory).toBeUndefined();
      expect(result.systemPromptSections.length).toBe(1);
      expect(result.systemPromptSections[0]).toContain("Memory A");
      expect(result.systemPromptSections[0]).toContain("Memory B");
    });
  });
});
