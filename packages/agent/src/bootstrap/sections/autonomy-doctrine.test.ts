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

  it("the doctrine teaches that a denial is a do-not-retry-loop signal (mode-accurate, Phase 217)", () => {
    // A denial must NOT trigger a retry-loop (the Phase-217 denial breaker aborts
    // a run that keeps hitting a floor block — the prompt must steer away from it).
    const prompt = assembleRichSystemPrompt({ promptMode: "full" });
    expect(prompt).toMatch(/do not retry|don't retry/i);
    // But it must NOT flatly forbid escalation: under the `unattended` profile the
    // PLATFORM escalates a blocked irreversible action to the operator, so the old
    // categorical "do not retry or escalate" misdescribed that path. Pin the
    // mode-accurate phrasing and assert the old over-restrictive clause is gone.
    expect(prompt).not.toMatch(/do not retry or escalate/i);
    expect(prompt).toMatch(/unattended/i);
    expect(prompt).toMatch(/the platform escalates/i);
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

  // COORD-02: the always-on paragraph carries a delegate-then-synthesize routing
  // rule — heavy / long / high-volume work goes to a FRESH-WINDOW child (its own
  // isolated context + budget), which returns a bounded SUMMARY + a `ResultRef`
  // handle to its full output; the lead SYNTHESIZES that summary and drills into
  // the handle on demand rather than doing the heavy work inline and burning its
  // own window. The sentence is profile-conditional by PHRASING (a coordinator
  // MUST delegate; any autonomy-bearing agent SHOULD), never threaded through
  // AssemblerParams — so it rides every bootstrap prompt without over-claiming.
  it("the doctrine routes heavy / long / high-volume work to a fresh-window child (COORD-02 delegate-then-synthesize)", () => {
    const text = buildAutonomyDoctrineSection().join("\n");
    // Names the fresh-window child as the destination for heavy work …
    expect(text).toMatch(/fresh-window/);
    // … and frames it as a delegate/route/offload, not inline work.
    expect(text).toMatch(/delegate|route|offload/i);
    // The shape that triggers the route is heavy / long / high-volume.
    expect(text).toMatch(/heavy/i);
    expect(text).toMatch(/long|high-volume/i);
    // The child runs in its own isolated window via sessions_spawn.
    expect(text).toMatch(/sessions_spawn/);
  });

  it("the doctrine has the lead synthesize the child's returned summary + ResultRef (COORD-02)", () => {
    const text = buildAutonomyDoctrineSection().join("\n");
    // The child returns a bounded summary …
    expect(text).toMatch(/summary/);
    // … plus a ResultRef handle to its full output …
    expect(text).toMatch(/ResultRef|handle/);
    // … which the lead SYNTHESIZES (not re-ingests) rather than working inline.
    expect(text).toMatch(/synthesize/i);
    expect(text).toMatch(/inline/i);
  });

  it("the COORD-02 sentence is profile-conditional by phrasing, not categorical (T-218-05)", () => {
    // The delegate-then-synthesize sentence rides EVERY bootstrap prompt,
    // including an `assistant`-profile agent that holds zero orch:* caps. It must
    // not assert a flat "you delegate" the way only a coordinator could — phrase
    // it conditionally (a coordinator MUST; any autonomy-bearing agent SHOULD),
    // matching the existing opener's pattern (the over-claim guard, T-218-05).
    const lines = buildAutonomyDoctrineSection();
    // Additive, not a rewrite: still exactly one `## Autonomy` heading …
    expect(lines.filter((l) => l === "## Autonomy")).toHaveLength(1);
    // … the profile-conditional opener is unchanged …
    const text = lines.join("\n");
    expect(text).toMatch(/When your agent profile grants autonomy capabilities/);
    // … and the new sentence gates the routing claim conditionally (coordinator
    // MUST; otherwise SHOULD), never categorically.
    expect(text).toMatch(/coordinator/i);
    expect(text).toMatch(/\bMUST\b/);
    expect(text).toMatch(/\bSHOULD\b/);
  });
});
