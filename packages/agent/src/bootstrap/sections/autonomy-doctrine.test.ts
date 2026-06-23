// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { assembleRichSystemPrompt } from "../system-prompt-assembler.js";
import { buildAutonomyDoctrineSection } from "./autonomy-doctrine.js";

// SKILL-02: a one-paragraph always-on autonomy doctrine is injected into every
// run's bootstrap system prompt (full/operational/minimal + compact-secure
// lockdown), stating BOTH the routing rule (single step -> direct tool;
// multi-step -> orchestrate(script)) AND the M1-accurate contract (workspace-
// confined; cannot read secrets/mint tokens/change config/reach the control
// plane; runs revocable/clamped, NOT durable; a denial -> don't retry-escalate).
//
// WR-01: the capability claim is PROFILE-CONDITIONAL ("When your agent profile
// grants autonomy capabilities (the `standard` default does; `assistant` does
// not), you can …") so this always-on paragraph is accurate for EVERY resolved
// profile — including `assistant` (enabled:false, capabilities:[]) — and never
// over-claims a cap the agent lacks. The dedicated test below pins that framing
// AND asserts the categorical opener is gone, so a revert to the over-claim is
// caught here (the regression WR-01 guards against).
//
// These assertions pin STABLE phrases the builder emits verbatim. They are
// RED before the builder + the SECTIONS descriptor entry exist (the assembled
// prompt does not contain the doctrine heading), GREEN after.

describe("autonomy doctrine — always-on bootstrap section (SKILL-02)", () => {
  it("the assembled full-mode prompt carries the doctrine heading", () => {
    const prompt = assembleRichSystemPrompt({ promptMode: "full" });
    expect(prompt).toContain("## Autonomy");
  });

  it("the doctrine states the routing rule (single -> direct tool; multi -> orchestrate(script))", () => {
    const prompt = assembleRichSystemPrompt({ promptMode: "full" });
    expect(prompt).toMatch(/orchestrate\(script\)/);
  });

  it("the doctrine states the contract truth (cannot read secrets / mint tokens / change config)", () => {
    const prompt = assembleRichSystemPrompt({ promptMode: "full" });
    expect(prompt).toMatch(/cannot read secrets|mint tokens/);
  });

  it("the capability claim is PROFILE-CONDITIONAL, not categorical (WR-01 — accurate for the assistant profile)", () => {
    // The always-on paragraph rides EVERY bootstrap prompt, including an
    // `assistant`-profile agent that holds zero orch:* caps
    // (schema-agent-autonomy.ts: enabled:false, capabilities:[]). A categorical
    // "You can spawn sub-agents, run DAGs …" opener would over-claim for that
    // profile (the exact "teaches a capability it doesn't have" bug this phase
    // guards against). The opener must instead GATE the claim on the profile.
    const prompt = assembleRichSystemPrompt({ promptMode: "full" });
    // Names the profile contrast explicitly (standard grants it; assistant does not).
    expect(prompt).toMatch(/standard/);
    expect(prompt).toMatch(/assistant/);
    // Conditional framing — the claim is gated on "When … profile grants …".
    expect(prompt).toMatch(/When your agent profile grants autonomy capabilities/);
    // And it must NOT open with the categorical over-claim.
    expect(prompt).not.toMatch(/You can act on your own within a bounded envelope/);
  });

  it("the doctrine teaches that a denial is not a retry-escalate signal", () => {
    const prompt = assembleRichSystemPrompt({ promptMode: "full" });
    expect(prompt).toMatch(/do not retry|don't retry/i);
  });

  it("the doctrine frames runs as revocable/clamped, NOT durable (M1 honesty)", () => {
    const prompt = assembleRichSystemPrompt({ promptMode: "full" });
    expect(prompt).toMatch(/revocable/i);
  });

  it("the doctrine survives the operational (sub-agent) prompt", () => {
    const prompt = assembleRichSystemPrompt({ promptMode: "operational" });
    expect(prompt).toContain("## Autonomy");
    expect(prompt).toMatch(/orchestrate\(script\)/);
  });

  it("the doctrine survives the compact-secure (lockdown) prompt", () => {
    const prompt = assembleRichSystemPrompt({ promptMode: "compact-secure" });
    expect(prompt).toContain("## Autonomy");
    expect(prompt).toMatch(/cannot read secrets|mint tokens/);
  });

  it("the builder returns a heading-first non-empty string[] paragraph", () => {
    const lines = buildAutonomyDoctrineSection();
    expect(Array.isArray(lines)).toBe(true);
    expect(lines[0]).toBe("## Autonomy");
    expect(lines.join("\n").length).toBeGreaterThan(30);
  });
});
