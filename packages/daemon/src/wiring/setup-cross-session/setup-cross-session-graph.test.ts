// SPDX-License-Identifier: Apache-2.0
/**
 * Graph leaf neighbor test for the setup-cross-session split. Pins the
 * symbol-export shape, the `SUB_AGENT_TOOL_DENYLIST` membership, and the
 * `MIN_SUB_AGENT_STEPS` integer constant for compile-time regression
 * coverage. The `buildExecuteSubAgent` closure-builder integration matrix
 * (parent intersection, ceiling, denylist, graph tool sort, spawn packet,
 * model resolution, cache retention) is exercised end-to-end by
 * setup-cross-session-runtime.test.ts through the setupCrossSession
 * invocation.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import {
  buildExecuteSubAgent,
  resolveGraphCacheRetention,
  SUB_AGENT_TOOL_DENYLIST,
  MIN_SUB_AGENT_STEPS,
  type ExecuteSubAgentDeps,
} from "./setup-cross-session-graph.js";

describe("setup-cross-session-graph", () => {
  it("buildExecuteSubAgent: exported as a callable function", () => {
    expect(typeof buildExecuteSubAgent).toBe("function");
    expect(buildExecuteSubAgent.length).toBeGreaterThanOrEqual(1);
  });

  it("ExecuteSubAgentDeps witness pins the closure-captured key set", () => {
    const witness: Record<keyof ExecuteSubAgentDeps, true> = {
      container: true,
      sessionStore: true,
      assembleToolsForAgent: true,
      getExecutor: true,
      fileLock: true,
      logger: true,
    };
    expect(Object.keys(witness).length).toBe(6);
  });

  it("MIN_SUB_AGENT_STEPS is a positive integer floor", () => {
    expect(Number.isInteger(MIN_SUB_AGENT_STEPS)).toBe(true);
    expect(MIN_SUB_AGENT_STEPS).toBeGreaterThan(0);
    expect(MIN_SUB_AGENT_STEPS).toBe(30);
  });

  it("SUB_AGENT_TOOL_DENYLIST contains the 10 documented management tools", () => {
    const expectedTools = [
      "gateway",
      "channels_manage",
      "agents_manage",
      "models_manage",
      "providers_manage",
      "tokens_manage",
      "skills_manage",
      "sessions_manage",
      "memory_manage",
      "heartbeat_manage",
    ];
    expect(SUB_AGENT_TOOL_DENYLIST.size).toBe(expectedTools.length);
    for (const tool of expectedTools) {
      expect(SUB_AGENT_TOOL_DENYLIST.has(tool)).toBe(true);
    }
  });

  it("resolveGraphCacheRetention: leaf node returns short", () => {
    expect(resolveGraphCacheRetention(0, true)).toBe("short");
    expect(resolveGraphCacheRetention(3, true)).toBe("short");
    expect(resolveGraphCacheRetention(undefined, true)).toBe("short");
  });

  it("resolveGraphCacheRetention: non-leaf node returns long", () => {
    expect(resolveGraphCacheRetention(0, false)).toBe("long");
    expect(resolveGraphCacheRetention(3, false)).toBe("long");
    expect(resolveGraphCacheRetention(undefined, undefined)).toBe("long");
  });
});
