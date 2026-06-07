// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for resolveMemoryOpsCapability (CR-01).
 *
 * The helper derives the R6 { capabilityClass, hasCapableModelOverride } the
 * three daemon memory-job sites thread into their deps so the abstain branch is
 * reachable in production. It keys on the CRON/MEMORY model (not the agent
 * primary) and mirrors pi-executor's resolveModelProfile heuristic + the
 * operator capabilityClass override.
 */
import { describe, it, expect } from "vitest";
import type { ProviderCapabilities } from "@comis/core";
import { resolveMemoryOpsStrategy } from "@comis/agent";
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

describe("resolveMemoryOpsCapability (CR-01)", () => {
  it("a local/ollama cron model with NO override → small + no override → ABSTAIN", () => {
    const cap = resolveMemoryOpsCapability({ provider: "ollama", modelId: "qwen3.6:35b" }, undefined);
    expect(cap.capabilityClass).toBe("small");
    expect(cap.hasCapableModelOverride).toBe(false);
    // The whole point: the abstain branch is now reachable in production.
    expect(resolveMemoryOpsStrategy(cap.capabilityClass, cap.hasCapableModelOverride)).toBe("abstain");
  });

  it("an anthropic cron model → frontier → CAPABLE (behavior-neutral for frontier deployments)", () => {
    const cap = resolveMemoryOpsCapability(
      { provider: "anthropic", modelId: "claude-haiku" },
      caps(),
    );
    expect(cap.capabilityClass).toBe("frontier");
    expect(resolveMemoryOpsStrategy(cap.capabilityClass, cap.hasCapableModelOverride)).toBe("capable");
  });

  it("an operator pinning capabilityClass='mid' on the cron provider → CAPABLE + override flag set", () => {
    const cap = resolveMemoryOpsCapability({ provider: "ollama", modelId: "qwen3.6:35b" }, caps("mid"));
    // The explicit override wins the class AND lights the operator-override flag.
    expect(cap.capabilityClass).toBe("mid");
    expect(cap.hasCapableModelOverride).toBe(true);
    expect(resolveMemoryOpsStrategy(cap.capabilityClass, cap.hasCapableModelOverride)).toBe("capable");
  });

  it("an operator pinning capabilityClass='nano' does NOT light the override flag → still ABSTAIN (fail-closed)", () => {
    const cap = resolveMemoryOpsCapability({ provider: "ollama", modelId: "tiny" }, caps("nano"));
    expect(cap.capabilityClass).toBe("nano");
    // A small/nano pin is NOT a "capable model override".
    expect(cap.hasCapableModelOverride).toBe(false);
    expect(resolveMemoryOpsStrategy(cap.capabilityClass, cap.hasCapableModelOverride)).toBe("abstain");
  });

  it("an operator pinning capabilityClass='frontier' on a local model → CAPABLE (the stronger-cron-model override)", () => {
    const cap = resolveMemoryOpsCapability({ provider: "ollama", modelId: "qwen3.6:35b" }, caps("frontier"));
    expect(cap.capabilityClass).toBe("frontier");
    expect(cap.hasCapableModelOverride).toBe(true);
    expect(resolveMemoryOpsStrategy(cap.capabilityClass, cap.hasCapableModelOverride)).toBe("capable");
  });
});
