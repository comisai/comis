// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runBudgetContinuation } from "./budget-continuation.js";

describe("budget continuation module", () => {
  it("exports the bounded continuation step with terminal stop reasons", () => {
    const source = readFileSync(new URL("./budget-continuation.ts", import.meta.url), "utf8");

    expect(runBudgetContinuation).toBeTypeOf("function");
    expect(source).toContain('decision.action === "continue"');
    expect(source).toContain('"budget_exhausted"');
    expect(source).toContain("preserving response collected so far");
  });
});
