// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 43 wave 8 split (FILE-SPLIT-08): setup-cross-session.ts →
 * setup-cross-session/ subdirectory. Events leaf neighbor test:
 * `registerProxyTypingListeners` registers handlers on the AppContainer's
 * event bus + schedules a TTL sweep timer. The integration behavior
 * (typing controller start/stop, TTL eviction, shutdown cleanup) is
 * covered by setup-cross-session-runtime.test.ts through the
 * setupCrossSession invocation; this neighbor test pins the symbol-export
 * shape and the deps interface key set for compile-time regression coverage.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import {
  registerProxyTypingListeners,
  type ProxyTypingListenerDeps,
} from "./setup-cross-session-events.js";

describe("setup-cross-session-events", () => {
  it("registerProxyTypingListeners: exported as a callable function", () => {
    expect(typeof registerProxyTypingListeners).toBe("function");
    expect(registerProxyTypingListeners.length).toBeGreaterThanOrEqual(1);
  });

  it("ProxyTypingListenerDeps witness pins the closure-captured key set", () => {
    const witness: Record<keyof ProxyTypingListenerDeps, true> = {
      container: true,
      adaptersByType: true,
      logger: true,
    };
    expect(Object.keys(witness).length).toBe(3);
  });
});
