// SPDX-License-Identifier: Apache-2.0
/**
 * Pin that the circuit breaker is reset to "closed" in reconnectionLoop's
 * success block. Without this, an "open" breaker from generation N would
 * survive into generation N+1 and tool calls would keep returning
 * [server_unavailable] against a healthy reconnected server.
 *
 * Negative invariant: wireClientLifecycleCallbacks (onclose/onerror) must
 * NOT reset the breaker -- it should stay open during the reconnect window
 * so half-open probes don't fire spuriously while the engine is mid-recovery.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const RECONNECT_PATH = resolve(
  "packages/skills/src/skills/integrations/mcp-client/mcp-client-reconnect.ts",
);

describe("circuit breaker resets on reconnect success", () => {
  it("reconnectionLoop success block resets state.circuitBreakers", () => {
    const src = readFileSync(RECONNECT_PATH, "utf8");
    const successBlockMatch = src.match(/state\.connections\.set\(serverName, newConnection\);[\s\S]*?return;/);
    expect(successBlockMatch, "reconnectionLoop success block not found").not.toBeNull();
    const successBlock = successBlockMatch![0];
    expect(
      successBlock,
      "Breaker reset (state.circuitBreakers.set with status: 'closed') MUST appear in the reconnect success block.",
    ).toMatch(/state\.circuitBreakers\.set\([\s\S]*?status:\s*["']closed["']/);
  });

  it("wireClientLifecycleCallbacks does NOT reset the breaker", () => {
    const src = readFileSync(RECONNECT_PATH, "utf8");
    const wireFnMatch = src.match(/export function wireClientLifecycleCallbacks[\s\S]*?\n\}/);
    expect(wireFnMatch, "wireClientLifecycleCallbacks not found").not.toBeNull();
    const wireFn = wireFnMatch![0];
    expect(
      wireFn,
      "Breaker reset MUST NOT appear in wireClientLifecycleCallbacks -- onclose/onerror should preserve the open state so half-open probes do not fire spuriously during the reconnect window.",
    ).not.toMatch(/state\.circuitBreakers\.set\([\s\S]*?status:\s*["']closed["']/);
  });
});
