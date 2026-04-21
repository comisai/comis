// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for extracted tool schema cache module.
 *
 * Verifies that the tool schema cache leaf module provides byte-identical
 * references for unchanged tools, proper invalidation on schema changes,
 * session-scoped clearing, and zero imports from request-body-injector.ts.
 *
 * @module
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  getOrCacheRenderedTool,
  clearSessionRenderedToolCache,
  clearSessionPerToolCache,
  sessionRenderedToolCache,
  sessionPerToolCache,
} from "./tool-schema-cache.js";

describe("tool-schema-cache leaf module", () => {
  const SESSION_KEY = "test-session-cache";

  beforeEach(() => {
    clearSessionPerToolCache(SESSION_KEY);
    clearSessionRenderedToolCache(SESSION_KEY);
  });

  // -------------------------------------------------------------------------
  // getOrCacheRenderedTool
  // -------------------------------------------------------------------------

  describe("getOrCacheRenderedTool", () => {
    it("returns byte-identical reference on second call with same tool content", () => {
      const tool = { name: "bash", description: "run commands", input_schema: { type: "object" } };
      const first = getOrCacheRenderedTool(SESSION_KEY, tool);
      const second = getOrCacheRenderedTool(SESSION_KEY, tool);
      expect(first).toBe(second);
    });

    it("returns new snapshot when tool schema changes (different input_schema)", () => {
      const toolV1 = { name: "bash", description: "run commands", input_schema: { type: "object" } };
      const toolV2 = { name: "bash", description: "run commands", input_schema: { type: "object", properties: { cmd: { type: "string" } } } };

      const cached1 = getOrCacheRenderedTool(SESSION_KEY, toolV1);
      const cached2 = getOrCacheRenderedTool(SESSION_KEY, toolV2);

      expect(cached2).not.toBe(cached1);
    });

    it("returns new snapshot when description changes", () => {
      const toolV1 = { name: "bash", description: "run commands", input_schema: { type: "object" } };
      const toolV2 = { name: "bash", description: "run shell commands (updated)", input_schema: { type: "object" } };

      const cached1 = getOrCacheRenderedTool(SESSION_KEY, toolV1);
      const cached2 = getOrCacheRenderedTool(SESSION_KEY, toolV2);

      expect(cached2).not.toBe(cached1);
    });

    it("isolates per-tool cache entries (changing one tool does not invalidate others)", () => {
      const toolA = { name: "bash", description: "run commands", input_schema: { type: "object" } };
      const toolB = { name: "search", description: "search web", input_schema: { type: "object", properties: { q: { type: "string" } } } };

      const cachedA1 = getOrCacheRenderedTool(SESSION_KEY, toolA);
      getOrCacheRenderedTool(SESSION_KEY, toolB);

      // Change tool B
      const toolBChanged = { ...toolB, input_schema: { type: "object", properties: { query: { type: "string" } } } };
      getOrCacheRenderedTool(SESSION_KEY, toolBChanged);

      // Tool A should still return same reference
      const cachedA2 = getOrCacheRenderedTool(SESSION_KEY, toolA);
      expect(cachedA2).toBe(cachedA1);
    });
  });

  // -------------------------------------------------------------------------
  // clearSessionRenderedToolCache
  // -------------------------------------------------------------------------

  describe("clearSessionRenderedToolCache", () => {
    it("removes the session entry from sessionRenderedToolCache", () => {
      sessionRenderedToolCache.set(SESSION_KEY, {
        hash: 12345,
        featureFlagHash: "",
        tools: [{ name: "test" }],
      });
      expect(sessionRenderedToolCache.has(SESSION_KEY)).toBe(true);

      clearSessionRenderedToolCache(SESSION_KEY);
      expect(sessionRenderedToolCache.has(SESSION_KEY)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // clearSessionPerToolCache
  // -------------------------------------------------------------------------

  describe("clearSessionPerToolCache", () => {
    it("removes the session entry from sessionPerToolCache", () => {
      const tool = { name: "bash", description: "run commands", input_schema: { type: "object" } };
      getOrCacheRenderedTool(SESSION_KEY, tool);
      expect(sessionPerToolCache.has(SESSION_KEY)).toBe(true);

      clearSessionPerToolCache(SESSION_KEY);
      expect(sessionPerToolCache.has(SESSION_KEY)).toBe(false);
    });

    it("causes next getOrCacheRenderedTool to return a new snapshot", () => {
      const tool = { name: "bash", description: "run commands", input_schema: { type: "object" } };
      const first = getOrCacheRenderedTool(SESSION_KEY, tool);

      clearSessionPerToolCache(SESSION_KEY);
      const second = getOrCacheRenderedTool(SESSION_KEY, tool);

      expect(second).not.toBe(first);
    });
  });

  // -------------------------------------------------------------------------
  // Zero circular imports
  // -------------------------------------------------------------------------

  describe("module isolation", () => {
    it("tool-schema-cache.ts has zero imports from request-body-injector.ts", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const filePath = path.default.resolve(
        import.meta.dirname,
        "tool-schema-cache.ts",
      );
      const content = fs.default.readFileSync(filePath, "utf-8");
      const matches = content.match(/from\s+["'].*request-body-injector/g);
      expect(matches).toBeNull();
    });
  });
});
