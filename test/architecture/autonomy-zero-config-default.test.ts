// SPDX-License-Identifier: Apache-2.0
/**
 * PROFILE-01 + MIG-01 (v8 §3.8 / T-210-15) — a zero-config agent resolves to the
 * `standard` posture and keeps reaching its orchestration tools once the
 * capability gate is enabled.
 *
 * An agent whose config has NO `autonomy` block must, by EXPLICIT GRANT, resolve
 * to the great-out-of-box `standard` posture (PROFILE-01) and receive exactly the
 * standard orchestration caps. Because Phase 210 now gates the orchestration
 * handlers on `requireCapability`, that explicit grant is what keeps
 * `session.spawn` / `graph.*` / `cron.*` REACHABLE for an agent that never opted
 * into an autonomy block: the gate finds the standard caps held, so it does not
 * throw. This is a positive grant via the `standard` default — not a special
 * carve-out and not an un-gated exception. The gate applies equally; the agent
 * simply HOLDS the caps the gate requires.
 *
 * RED COUNTERFACTUAL (the threat T-210-15 guards): if the resolver gave a
 * no-block agent an EMPTY (or assistant-equivalent) cap set instead of the
 * standard grant, `requireCapability(resolveAutonomy(undefined).capabilities,
 * "orch:spawn")` would THROW CapabilityDeniedError and the agent would lose
 * session.spawn / graph.* / cron.* the moment the gate turned on. This test
 * pins that the standard grant is in place, so the gate is reachable-by-grant,
 * not a break.
 *
 * Imports the COMPILED `resolveAutonomy` + `requireCapability` from `@comis/core`
 * (dist) — the runtime resolver + the runtime gate predicate, not their AST — so
 * a resolver change that drops the standard grant flips this test red. Mirrors
 * the compiled-runtime-value approach of `autonomy-profile-floor.test.ts`.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { resolveAutonomy, requireCapability, CapabilityDeniedError, type AgentCapability } from "@comis/core";

const DESIGN_REF = "v8 §3.8 (zero-config standard) / MIG-01 / T-210-15";

/**
 * The orchestration caps an agent must keep reaching after the gate turns on —
 * the explicit-grant target a no-block agent regains via `standard`. (The full
 * standard floor set is pinned by `autonomy-profile-floor.test.ts`; here we
 * assert the orchestration-reachability subset the gate enforces.)
 */
const REQUIRED_ORCH_CAPS: readonly AgentCapability[] = ["orch:spawn", "orch:graph", "orch:cron"];

describe("MIG-01 — a zero-config agent resolves to standard and keeps its orchestration tools", () => {
  it("PROFILE-01: resolveAutonomy(undefined) resolves to the `standard` profile (zero-config default)", () => {
    const resolved = resolveAutonomy(undefined);
    expect(resolved.profile, `See: ${DESIGN_REF}`).toBe("standard");
    expect(resolved.enabled, "the standard posture is enabled (orchestration surfaces on)").toBe(true);
  });

  it("MIG-01: the zero-config posture grants the orchestration caps the gate requires", () => {
    const held = resolveAutonomy(undefined).capabilities;
    for (const cap of REQUIRED_ORCH_CAPS) {
      expect(
        held.includes(cap),
        `zero-config (standard) posture must grant "${cap}" so the gate stays reachable. Held: [${held.join(", ")}]. See: ${DESIGN_REF}`,
      ).toBe(true);
    }
  });

  it("MIG-01: requireCapability does NOT throw for the zero-config posture's held orchestration caps (the tools stay reachable)", () => {
    const held = resolveAutonomy(undefined).capabilities;
    for (const cap of REQUIRED_ORCH_CAPS) {
      // The held-set is what createAgentRpcCall injects as `_capabilities`; the
      // gate reads it. A no-block agent HOLDS these via the standard grant, so
      // the gate passes — session.spawn / graph.* / cron.* remain reachable.
      expect(
        () => requireCapability(held, cap),
        `the gate must pass for "${cap}" under the zero-config standard grant (else the agent loses the tool the moment the gate turns on)`,
      ).not.toThrow();
    }
  });

  it("the gate is genuinely enforced (non-vacuity): an EMPTY held-set throws CapabilityDeniedError for the same caps", () => {
    // Proves the no-throw assertions above are load-bearing: the gate is NOT a
    // no-op. With no held caps (the counterfactual of a missing standard grant),
    // every required orchestration cap is DENIED.
    for (const cap of REQUIRED_ORCH_CAPS) {
      expect(() => requireCapability([], cap)).toThrow(CapabilityDeniedError);
      expect(() => requireCapability(undefined, cap)).toThrow(CapabilityDeniedError);
    }
  });
});
