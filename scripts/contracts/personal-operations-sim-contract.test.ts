// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const simRoot = resolve(repoRoot, "test/live/self-driving/sim");
const workloadRoot = resolve(simRoot, "personal-operations");
const requiredFiles = ["tools.json", "world.seed.json", "handlers.mjs", "SKILL.md"];

describe("personal operations simulator contract", () => {
  it("ships the complete stateful workload and driver registration", async () => {
    for (const file of requiredFiles) {
      expect(existsSync(resolve(workloadRoot, file)), `${file} must exist`).toBe(true);
    }

    const tools = JSON.parse(readFileSync(resolve(workloadRoot, "tools.json"), "utf8")) as {
      server: string;
      tools: Array<{ name: string; kind: string; terminal: boolean }>;
    };
    const world = JSON.parse(readFileSync(resolve(workloadRoot, "world.seed.json"), "utf8")) as {
      truth?: { requiredReads?: string[] };
      variants?: Record<string, unknown>;
    };
    const skill = readFileSync(resolve(workloadRoot, "SKILL.md"), "utf8");
    const driver = readFileSync(
      resolve(repoRoot, "test/live/self-driving/scripts/drive-sim-workload.sh"),
      "utf8",
    );
    const readme = readFileSync(resolve(simRoot, "README.md"), "utf8");

    expect(tools.server).toBe("personal-ops-sim");
    expect(tools.tools.filter((tool) => tool.kind === "observe")).toHaveLength(6);
    expect(tools.tools.filter((tool) => tool.kind === "act")).toHaveLength(6);
    expect(tools.tools.filter((tool) => tool.terminal)).toEqual([
      expect.objectContaining({ name: "finish_review" }),
    ]);
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "begin_review",
        "read_inbox",
        "read_calendar",
        "read_tasks",
        "read_decisions",
        "stage_draft",
        "create_task",
        "send_draft",
        "finish_review",
      ]),
    );

    expect(world.truth?.requiredReads).toEqual([
      "inbox",
      "calendar",
      "tasks",
      "decisions",
    ]);
    expect(Object.keys(world.variants ?? {})).toEqual(["A", "B", "C"]);
    expect(skill).toContain("teaches the tool mechanics");
    expect(skill).toContain("never send a staged draft unless the user explicitly asks");
    expect(driver).toContain("personal-operations");
    expect(driver).toContain("personal-ops-sim");
    expect(readme).toContain("all 15");
    expect(readme).toContain("`personal-operations`");

    const { loadWorkload } = await import(
      "../../test/live/self-driving/sim/shared/registry.mjs"
    );
    for (const variant of ["A", "B", "C"]) {
      const workload = await loadWorkload("personal-operations", { seed: "contract", variant });
      expect(workload.selftest, `variant ${variant} must expose selftest`).not.toBeNull();
      expect(workload.selftest()).toMatchObject({
        pass: true,
        golden: "success",
        naive: "failure",
      });
    }
  });
});
