// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const target = readFileSync(
  resolve(repoRoot, "test/live/self-driving/targets/real-user-everyday-assistant.md"),
  "utf8",
);
const pipeline = readFileSync(
  resolve(repoRoot, "packages/skills/src/platform-tools/tools/pipeline-tool.ts"),
  "utf8",
);
const deepResearch = readFileSync(
  resolve(repoRoot, "skills/deep-research/SKILL.md"),
  "utf8",
);

describe("real-user target source claims", () => {
  it("states the complete pipeline action count including from_intent", () => {
    const actionBlock = pipeline.match(
      /action: Type\.Optional\([\s\S]*?\{ description: "Pipeline action/,
    )?.[0];

    expect(actionBlock).toBeDefined();
    expect(actionBlock?.match(/Type\.Literal\("/g)).toHaveLength(10);
    expect(pipeline).toContain("Supports 10 actions:");
    expect(target).toContain("Ten actions total:");
    expect(target).toContain("`pipeline` (10 actions incl. `from_intent`)");
    expect(target).not.toContain(
      "`from_intent` returns a validated graph without\nexecuting it",
    );
    expect(target).toContain(
      "`from_intent` synthesizes a validated graph and dispatches it through `graph.execute`",
    );
  });

  it("does not claim a requirements block for the dependency-free research skill", () => {
    expect(deepResearch).not.toContain("comis:\n  requires:");
    expect(target).toContain(
      "`deep-research` is dependency-free; every skill with external requirements declares its own `comis.requires`",
    );
  });
});
