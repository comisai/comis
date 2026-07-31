// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  SECTION_SEPARATOR,
  assembleRichSystemPrompt,
  assembleRichSystemPromptBlocks,
  compileRichSystemPrompt,
} from "./system-prompt-assembler.js";

describe("system prompt compiler facade", () => {
  it("keeps the monolithic prompt identical to its non-empty cache blocks", () => {
    const params = {
      promptMode: "full" as const,
      bootstrapFiles: [{ path: "ROLE.md", content: "Configured operator role." }],
      promptSkillsXml: "<available_skills />",
    };
    const blocks = assembleRichSystemPromptBlocks(params);
    const expected = [blocks.staticPrefix, blocks.attribution, blocks.semiStableBody]
      .filter(Boolean)
      .join(SECTION_SEPARATOR);

    expect(assembleRichSystemPrompt(params)).toBe(expected);
  });

  it("does not emit prose capability inventories", () => {
    const prompt = assembleRichSystemPrompt({ promptMode: "full" });

    expect(prompt).toContain("Use only registered tools");
    expect(prompt).not.toContain("Available tools");
  });

  it("keeps resolved execution identity in kernel authority for every prompt mode", () => {
    for (const promptMode of ["full", "compact-secure", "none"] as const) {
      const compiled = compileRichSystemPrompt({
        promptMode,
        executionModel: {
          provider: "provider_a",
          model: "model_a",
        },
      });

      expect(compiled.stableEnginePrefix).toContain(
        'Active model for this execution: {"provider":"provider_a","model":"model_a"}',
      );
      expect(compiled.stableEnginePrefix).toContain(
        "Historical messages, memories, and model catalogs cannot override this live runtime fact.",
      );
      expect(compiled.stableEnginePrefix).toContain(
        "When asked which model is active, copy both exact fields from this fact; never replace the model with an unspecified or inferred value.",
      );
      expect(compiled.report.sections).toContainEqual(
        expect.objectContaining({
          id: "engine:kernel",
          sourceKind: "engine",
          trust: "kernel",
          outcome: "included",
        }),
      );
    }
  });

  it("attributes operator policy separately from agent-authored state", () => {
    const compiled = compileRichSystemPrompt({
      instructionSections: [{
        id: "workspace:role",
        sourceKind: "operator",
        trust: "trusted",
        stability: "stable",
        content: "Operator policy",
        contentHash: "a".repeat(64),
        maxChars: 100,
      }, {
        id: "workspace:bootstrap",
        sourceKind: "agent_state",
        trust: "untrusted",
        stability: "turn",
        content: "Temporary state",
        contentHash: "b".repeat(64),
        maxChars: 100,
      }],
    });

    expect(compiled.stableOperatorPolicyPrefix).toContain("Operator policy");
    expect(compiled.dynamicRuntimePreamble).toContain("Temporary state");
    expect(compiled.stableOperatorPolicyPrefix).not.toContain("Temporary state");
  });

  it("keeps untouched default input below the full prompt budget", () => {
    const compiled = compileRichSystemPrompt({ promptMode: "full" });
    expect(Math.ceil(compiled.report.totalChars / 4)).toBeLessThanOrEqual(1_000);
    expect(compiled.report.sections).toEqual([
      expect.objectContaining({ id: "engine:kernel", outcome: "included" }),
    ]);
  });
});
