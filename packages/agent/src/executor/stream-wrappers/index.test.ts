// SPDX-License-Identifier: Apache-2.0
/**
 * Smoke test for `stream-wrappers/index.ts` barrel.
 *
 * Asserts the public export surface matches the source-of-truth — catches
 * silent export deletion / shadowing. Mirrors the gateway sub-barrel smoke
 * tests at `packages/gateway/src/web/index.test.ts`.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import * as barrel from "./index.js";

describe("stream-wrappers/index — barrel exports smoke contract", () => {
  it("exports composeStreamWrappers as a function", () => {
    expect(typeof barrel.composeStreamWrappers).toBe("function");
  });

  it("exports createToolResultSizeBouncer as a function", () => {
    expect(typeof barrel.createToolResultSizeBouncer).toBe("function");
  });

  it("exports createTurnResultBudgetWrapper as a function", () => {
    expect(typeof barrel.createTurnResultBudgetWrapper).toBe("function");
  });

  it("exports createValidationErrorFormatter as a function", () => {
    expect(typeof barrel.createValidationErrorFormatter).toBe("function");
  });

  it("exports createConfigResolver, resolveBreakpointStrategy as functions and SYSTEM_PROMPT_DYNAMIC_BOUNDARY as a value", () => {
    expect(typeof barrel.createConfigResolver).toBe("function");
    expect(typeof barrel.resolveBreakpointStrategy).toBe("function");
    expect(barrel.SYSTEM_PROMPT_DYNAMIC_BOUNDARY).toBeDefined();
  });

  it("cache-trace helpers (createCacheTraceWriter, parseSize, rotateIfNeeded, CacheTraceConfig) are not exported from this barrel", () => {
    expect((barrel as Record<string, unknown>).createCacheTraceWriter).toBeUndefined();
    expect((barrel as Record<string, unknown>).parseSize).toBeUndefined();
    expect((barrel as Record<string, unknown>).rotateIfNeeded).toBeUndefined();
    expect((barrel as Record<string, unknown>).CacheTraceConfig).toBeUndefined();
  });

  it("exports createApiPayloadTraceWriter as a function", () => {
    expect(typeof barrel.createApiPayloadTraceWriter).toBe("function");
  });

  it("exports request-body-injector helpers (createRequestBodyInjector, addCacheControlToLastBlock, CACHEABLE_BLOCK_TYPES, getMinCacheableTokens, resolveCacheRetention, clearSessionBetaHeaderLatches)", () => {
    expect(typeof barrel.createRequestBodyInjector).toBe("function");
    expect(typeof barrel.addCacheControlToLastBlock).toBe("function");
    expect(barrel.CACHEABLE_BLOCK_TYPES).toBeInstanceOf(Set);
    expect(typeof barrel.getMinCacheableTokens).toBe("function");
    expect(typeof barrel.resolveCacheRetention).toBe("function");
    expect(typeof barrel.clearSessionBetaHeaderLatches).toBe("function");
  });

  it("exports tool-schema-cache helpers (sessionRenderedToolCache, getOrCacheRenderedTool, clearSessionRenderedToolCache, clearSessionPerToolCache)", () => {
    // sessionRenderedToolCache is a module-level value (mutable cache);
    // the other three are functions.
    expect(barrel.sessionRenderedToolCache).toBeDefined();
    expect(typeof barrel.getOrCacheRenderedTool).toBe("function");
    expect(typeof barrel.clearSessionRenderedToolCache).toBe("function");
    expect(typeof barrel.clearSessionPerToolCache).toBe("function");
  });

  it("exports createStubFilterInjector as a function", () => {
    expect(typeof barrel.createStubFilterInjector).toBe("function");
  });

  it("exports at least 19 named value exports (silent-deletion guard)", () => {
    // Count of value (not type-only) exports declared in index.ts. If a future
    // change drops one of the named exports below this threshold, the silent
    // regression is caught here.
    const exportKeys = Object.keys(barrel).filter((k) => barrel[k as keyof typeof barrel] !== undefined);
    expect(exportKeys.length).toBeGreaterThanOrEqual(19);
  });
});
