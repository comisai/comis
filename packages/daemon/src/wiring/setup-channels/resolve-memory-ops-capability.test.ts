// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for resolveMemoryOpsCapability.
 *
 * The helper derives the { capabilityClass, hasCapableModelOverride } the
 * three daemon memory-job sites thread into their deps so the abstain branch is
 * reachable in production. It keys on the CRON/MEMORY model (not the agent
 * primary) and mirrors pi-executor's resolveModelProfile heuristic + the
 * operator capabilityClass override.
 *
 * Scope: this test proves the DAEMON helper's contract — the (capabilityClass,
 * hasCapableModelOverride) pair it returns for each input. The downstream
 * strategy mapping (small/nano+no-override → abstain; frontier/mid/override →
 * capable) is the agent router's own contract, unit-tested in
 * packages/agent/src/memory/memory-capability-router.test.ts — not re-tested
 * here (that would couple the daemon test to an agent-internal export).
 */
import { describe, it, expect } from "vitest";
import type { ProviderCapabilities } from "@comis/core";
import { resolveMemoryOpsCapability } from "./resolve-memory-ops-capability.js";

/** A ProviderCapabilities with an explicit capabilityClass override. */
function caps(capabilityClass?: ProviderCapabilities["capabilityClass"]): ProviderCapabilities {
  return {
    providerFamily: "default",
    dropThinkingBlockModelHints: [],
    transcriptToolCallIdMode: "default",
    transcriptToolCallIdModelHints: [],
    ...(capabilityClass !== undefined ? { capabilityClass } : {}),
  } as ProviderCapabilities;
}

describe("resolveMemoryOpsCapability", () => {
  it("a local/ollama cron model with NO override → small + no override (abstain branch reachable)", () => {
    const cap = resolveMemoryOpsCapability({ provider: "ollama", modelId: "qwen3.6:35b" }, undefined);
    expect(cap.capabilityClass).toBe("small");
    expect(cap.hasCapableModelOverride).toBe(false);
  });

  it("an anthropic cron model → frontier + no override (behavior-neutral for frontier deployments)", () => {
    const cap = resolveMemoryOpsCapability(
      { provider: "anthropic", modelId: "claude-haiku" },
      caps(),
    );
    expect(cap.capabilityClass).toBe("frontier");
    expect(cap.hasCapableModelOverride).toBe(false);
  });

  it("an operator pinning capabilityClass='mid' on a local cron provider → mid + override flag set", () => {
    const cap = resolveMemoryOpsCapability({ provider: "ollama", modelId: "qwen3.6:35b" }, caps("mid"));
    // The explicit override wins the class AND lights the operator-override flag.
    expect(cap.capabilityClass).toBe("mid");
    expect(cap.hasCapableModelOverride).toBe(true);
  });

  it("an operator pinning capabilityClass='nano' does NOT light the override flag (fail-closed → still abstains)", () => {
    const cap = resolveMemoryOpsCapability({ provider: "ollama", modelId: "tiny" }, caps("nano"));
    expect(cap.capabilityClass).toBe("nano");
    // A small/nano pin is NOT a "capable model override".
    expect(cap.hasCapableModelOverride).toBe(false);
  });

  it("an operator pinning capabilityClass='frontier' on a local model → frontier + override (stronger-cron-model)", () => {
    const cap = resolveMemoryOpsCapability({ provider: "ollama", modelId: "qwen3.6:35b" }, caps("frontier"));
    expect(cap.capabilityClass).toBe("frontier");
    expect(cap.hasCapableModelOverride).toBe(true);
  });
});
