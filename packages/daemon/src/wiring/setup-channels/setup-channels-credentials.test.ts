// SPDX-License-Identifier: Apache-2.0
/**
 * Compile-time regression pin for the credentials leaf of the
 * setup-channels module. Hosts `registerCronEventListeners` (cron-driven
 * API-key + model resolution + event dispatch). The integration matrix
 * (memory review, agent_turn, systemEvent, suspend notification) is
 * exercised by setup-channels-registry.test.ts which invokes
 * setupChannels end-to-end with mocks; this neighbor test pins the
 * symbol-export shape and the deps interface key set.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import {
  registerCronEventListeners,
  type CronEventListenerDeps,
} from "./setup-channels-credentials.js";

describe("setup-channels-credentials", () => {
  it("registerCronEventListeners: exported as a callable function", () => {
    expect(typeof registerCronEventListeners).toBe("function");
    expect(registerCronEventListeners.length).toBeGreaterThanOrEqual(1);
  });

  it("CronEventListenerDeps witness pins the closure-captured key set", () => {
    // The witness's `Record<keyof T, true>` compile-checks exhaustiveness;
    // if a closure capture is added/renamed without updating the deps
    // surface, the literal stops type-checking.
    const witness: Record<keyof CronEventListenerDeps, true> = {
      container: true,
      executors: true,
      defaultAgentId: true,
      sessionManager: true,
      sessionStore: true,
      logger: true,
      // Composition-root clock threaded to runMemoryReview for relative-date
      // resolution (EXTR-02) — pins the new closure capture into the deps surface.
      clock: true,
      adaptersByType: true,
      deliveryService: true,
      assembleToolsForAgent: true,
      transcriber: true,
      workspaceDirs: true,
      memoryAdapter: true,
      tenantId: true,
      piSessionAdapters: true,
      cronExecutionTrackers: true,
      activeRunRegistry: true,
    };
    expect(Object.keys(witness).length).toBe(17);
  });
});
